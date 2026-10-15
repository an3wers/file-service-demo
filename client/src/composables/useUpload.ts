import { computed, ref, shallowReadonly, shallowRef, type Ref } from "vue";
import {
  createUploadOperation,
  type UploadMode,
  type UploadOperation,
} from "./createUploadOperation";
import { useFileBrowser } from "./useFileBrowser";

export type { UploadMode, UploadStage } from "./createUploadOperation";

export const MAX_UPLOAD_SIZE_MB = Number(
  import.meta.env.VITE_MAX_UPLOAD_SIZE_MB ?? "50",
);
export const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;

export interface UploadRow {
  id: number;
  operationId: string;
  retryPending?: boolean;
  file: File;
  state: Ref<"selected" | "queued" | "active" | "finished" | "cancelled">;
  operation: Ref<UploadOperation | null>;
}

const mode = ref<UploadMode>("server");
const rows = shallowRef<UploadRow[]>([]);
let nextId = 0;
const active = new Set<UploadRow>();
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

function addFiles(files: readonly File[]): void {
  rows.value = [
    ...rows.value,
    ...files.map((file): UploadRow => ({
      id: ++nextId,
      operationId: crypto.randomUUID(),
      file,
      state: ref("selected"),
      operation: shallowRef(null),
    })),
  ];
}

function remove(row: UploadRow): void {
  if (row.state.value === "selected") {
    rows.value = rows.value.filter((item) => item !== row);
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
    active.delete(row);
    drain();
  }
}

function drain(): void {
  for (const row of rows.value) {
    if (active.size >= MAX_CONCURRENT_UPLOADS) return;
    if (row.state.value === "queued") void run(row);
  }
}

function submit(directory: string): void {
  for (const row of rows.value) {
    if (row.state.value !== "selected") continue;
    row.operation.value = createUploadOperation(
      row.file,
      directory,
      mode.value,
      row.operationId,
    );
    row.state.value = "queued";
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
  row.retryPending = true;
  row.state.value = "queued";
  drain();
}

function cancelRow(row: UploadRow): void {
  if (row.state.value === "queued") row.state.value = "cancelled";
  else if (row.state.value === "active") row.operation.value?.cancel();
}

function cancel(): void {
  for (const row of rows.value) cancelRow(row);
}

function reset(): void {
  cancel();
  rows.value = [];
  mode.value = "server";
}

export function useUpload() {
  return {
    mode,
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
      if (row.operation.value?.outcome.value?.status === "succeeded")
        useFileBrowser().refresh();
    },
    cancelRow,
    cancel,
    reset,
  };
}
