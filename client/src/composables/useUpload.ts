import { computed, ref, shallowReadonly, shallowRef, type Ref } from "vue";
import {
  createUploadOperation,
  type UploadMode,
  type UploadOperation,
} from "./createUploadOperation";
import { useFileBrowser } from "./useFileBrowser";

export type { UploadMode, UploadStage } from "./createUploadOperation";

export { MAX_UPLOAD_SIZE_MB, MAX_UPLOAD_SIZE_BYTES } from "@/lib/uploadLimits";

export interface UploadRow {
  id: number;
  operationId: string;
  retryPending?: boolean;
  file: File;
  state: Ref<"selected" | "queued" | "active" | "finished" | "cancelled">;
  operation: Ref<UploadOperation | null>;
}

const mode = ref<UploadMode>("server");
const directory = ref<string | null>(null);
const rows = shallowRef<UploadRow[]>([]);
let nextId = 0;
const active = new Set<UploadRow>();
let queue: UploadRow[] = [];
const iterationFiles = new Set<string>();
const iterationRows = new Set<UploadRow>();
let iterationOpen = false;
const MAX_CONCURRENT_UPLOADS = 3;
const uploading = computed(() =>
  rows.value.some(
    (row) => row.state.value === "active" || row.state.value === "queued",
  ),
);
const hasSelected = computed(() =>
  rows.value.some((row) => row.state.value === "selected"),
);
const summary = computed(() => {
  let uploading = 0;
  let waiting = 0;
  let succeeded = 0;
  let cancelled = 0;
  let failed = 0;
  for (const row of rows.value) {
    const outcome = row.operation.value?.outcome.value;
    if (row.state.value === "active" || row.operation.value?.uploading.value)
      uploading++;
    else if (row.state.value === "selected" || row.state.value === "queued")
      waiting++;
    else if (outcome?.status === "succeeded") succeeded++;
    else if (row.state.value === "cancelled" || outcome?.status === "cancelled")
      cancelled++;
    else if (outcome?.status === "failed") failed++;
  }
  return `Загружаются: ${uploading} · Ожидают: ${waiting} · Готовы: ${succeeded} · Отменены: ${cancelled} · Ошибки: ${failed}`;
});

function finishIteration(): void {
  if (
    [...iterationRows].every(
      (row) =>
        row.state.value === "finished" || row.state.value === "cancelled",
    )
  ) {
    iterationOpen = false;
  }
}

function addFiles(files: readonly File[], targetDirectory = ""): void {
  if (!files.length) return;
  if (!uploading.value && !hasSelected.value) directory.value = targetDirectory;
  if (!iterationOpen) {
    iterationFiles.clear();
    iterationRows.clear();
    iterationOpen = true;
  }
  const added: UploadRow[] = [];
  for (const file of files) {
    const key = JSON.stringify([file.name, file.size]);
    if (iterationFiles.has(key)) continue;
    iterationFiles.add(key);
    const row: UploadRow = {
      id: ++nextId,
      operationId: crypto.randomUUID(),
      file,
      state: ref("selected"),
      operation: shallowRef(null),
    };
    iterationRows.add(row);
    added.push(row);
  }
  rows.value = [...rows.value, ...added];
}

function remove(row: UploadRow): void {
  if (row.state.value === "selected") {
    iterationRows.delete(row);
    rows.value = rows.value.filter((item) => item !== row);
    finishIteration();
  }
}

async function run(row: UploadRow): Promise<void> {
  const operation = row.operation.value!;
  row.state.value = "active";
  active.add(row);
  try {
    const retrying = row.retryPending;
    row.retryPending = false;
    await (retrying ? operation.retry() : operation.start());
    if (rows.value.includes(row)) useFileBrowser().refresh();
  } catch {
    return;
  } finally {
    row.state.value = "finished";
    finishIteration();
    active.delete(row);
    drain();
  }
}

function drain(): void {
  while (active.size < MAX_CONCURRENT_UPLOADS && queue.length) {
    const row = queue.shift()!;
    if (row.state.value === "queued" && rows.value.includes(row)) void run(row);
  }
}

function submit(targetDirectory: string): void {
  directory.value ??= targetDirectory;
  for (const row of rows.value) {
    if (row.state.value !== "selected") continue;
    row.operation.value = createUploadOperation(
      row.file,
      directory.value,
      mode.value,
      row.operationId,
    );
    row.state.value = "queued";
    queue.push(row);
  }
  drain();
}

function retry(row: UploadRow): void {
  if (
    (row.state.value !== "finished" && row.state.value !== "cancelled") ||
    !row.operation.value ||
    row.operation.value.outcome.value?.status === "succeeded"
  )
    return;
  row.operation.value.changeMode(mode.value);
  row.retryPending = true;
  row.state.value = "queued";
  queue.push(row);
  drain();
}

function cancelRow(row: UploadRow): void {
  if (row.state.value === "queued") {
    row.state.value = "cancelled";
    queue = queue.filter((item) => item !== row);
    finishIteration();
  } else if (row.state.value === "active") row.operation.value?.cancel();
}

function cancel(): void {
  for (const row of rows.value) cancelRow(row);
}

function setMode(next: UploadMode): void {
  if (uploading.value) return;
  mode.value = next;
  for (const row of rows.value) row.operation.value?.changeMode(next);
}

function reset(): void {
  cancel();
  rows.value = [];
  queue = [];
  iterationFiles.clear();
  iterationRows.clear();
  iterationOpen = false;
  mode.value = "server";
  directory.value = null;
}

export function useUpload() {
  return {
    mode,
    setMode,
    directory: shallowReadonly(directory),
    rows: shallowReadonly(rows),
    uploading,
    hasSelected,
    summary,
    addFiles,
    remove,
    submit,
    retry,
    async checkResult(row: UploadRow) {
      await row.operation.value?.checkResult();
      if (!uploading.value) row.operation.value?.changeMode(mode.value);
      if (row.operation.value?.outcome.value?.status === "succeeded")
        useFileBrowser().refresh();
    },
    cancelRow,
    cancel,
    reset,
  };
}
