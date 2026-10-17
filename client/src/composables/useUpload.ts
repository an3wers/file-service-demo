import {
  computed,
  ref,
  shallowReadonly,
  shallowRef,
  watch,
  type Ref,
} from "vue";
import {
  createUploadOperation,
  type UploadMode,
  type UploadOperation,
} from "./createUploadOperation";
import { useFileBrowser } from "./useFileBrowser";
import { getSessionUser, onSessionChange } from "@/api/session";
import {
  cancelUploadOperation,
  failUploadOperation,
  resolveUploadOperation,
} from "@/api/files";
import { errorMessage, isRetryable } from "@/lib/errors";
import type { FileDto, UploadOperationResponse } from "@/types/api";

export type { UploadMode, UploadStage } from "./createUploadOperation";
export { MAX_UPLOAD_SIZE_MB, MAX_UPLOAD_SIZE_BYTES } from "@/lib/uploadLimits";

export type UploadFile = Pick<File, "name" | "size" | "type" | "lastModified">;
export type UploadStatus =
  "selected" | "uploading" | "succeeded" | "cancelled" | "failed";
type UploadIntent = "upload" | "cancel" | "remove" | "fail";

export interface UploadRow {
  id: number;
  operationId: string;
  file: UploadFile;
  source: File | null;
  targetDirectory: string;
  uploadMode: UploadMode;
  state: Ref<"selected" | "queued" | "active" | "finished" | "cancelled">;
  status: Ref<UploadStatus>;
  message: Ref<string | null>;
  intent: Ref<UploadIntent>;
  operation: Ref<UploadOperation | null>;
  result: Ref<FileDto | null>;
  attempts: number;
  retryable: boolean;
  pending: Ref<boolean>;
  recoveryStarted: number | null;
  retryPending?: boolean;
}

interface SavedRow {
  operationId: string;
  file: UploadFile;
  directory: string;
  mode: UploadMode;
  status: UploadStatus;
  intent: UploadIntent;
  result: FileDto | null;
  message: string | null;
  attempts: number;
  retryable: boolean;
  pending: boolean;
  recoveryStarted: number | null;
}

const STORAGE_KEY = "file-service.uploads.v1";
const RECOVERY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_AUTOMATIC_RETRIES = 2;
const mode = ref<UploadMode>("server");
const directory = ref<string | null>(null);
const rows = shallowRef<UploadRow[]>([]);
const active = new Set<UploadRow>();
const timers = new Map<UploadRow, ReturnType<typeof setTimeout>>();
const checking = new Map<UploadRow, AbortController>();
const deadlines = new Map<UploadRow, ReturnType<typeof setTimeout>>();
let queue: UploadRow[] = [];
let nextId = 0;
let generation = 0;
let stopped = false;
let restored = false;
const iterationFiles = new Set<string>();
const iterationRows = new Set<UploadRow>();
let iterationOpen = false;
const MAX_CONCURRENT_UPLOADS = 3;
const uploading = computed(() =>
  rows.value.some((row) => row.status.value === "uploading"),
);
const hasSelected = computed(() =>
  rows.value.some((row) => row.state.value === "selected"),
);
const summary = computed(() => {
  const count = (status: UploadStatus) =>
    rows.value.filter((row) => row.status.value === status).length;
  const queued = rows.value.filter(
    (row) => row.state.value === "queued",
  ).length;
  return `Загружаются: ${count("uploading") - queued} · Ожидают: ${count("selected") + queued} · Готовы: ${count("succeeded")} · Отменены: ${count("cancelled")} · Ошибки: ${count("failed")}`;
});

function finishIteration(): void {
  if (
    [...iterationRows].every(
      (row) =>
        !row.pending.value &&
        (row.state.value === "finished" || row.state.value === "cancelled"),
    )
  )
    iterationOpen = false;
}

function makeRow(
  file: UploadFile,
  targetDirectory: string,
  operationId: string = crypto.randomUUID(),
): UploadRow {
  return {
    id: ++nextId,
    operationId,
    file,
    source: file instanceof File ? file : null,
    targetDirectory,
    uploadMode: mode.value,
    state: ref("selected"),
    status: ref("selected"),
    message: ref(null),
    intent: ref("upload"),
    operation: shallowRef(null),
    result: shallowRef(null),
    attempts: 0,
    retryable: false,
    pending: ref(false),
    recoveryStarted: null,
  };
}

function savedRows(): SavedRow[] {
  return rows.value.map((row) => ({
    operationId: row.operationId,
    file: {
      name: row.file.name,
      size: row.file.size,
      type: row.file.type,
      lastModified: row.file.lastModified,
    },
    directory: row.targetDirectory,
    mode: row.operation.value?.mode ?? row.uploadMode,
    status: row.status.value,
    intent: row.intent.value,
    result: row.result.value,
    message: row.message.value,
    attempts: row.attempts,
    retryable: row.retryable,
    pending: row.pending.value,
    recoveryStarted: row.recoveryStarted,
  }));
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedRows()));
  } catch {
    return;
  }
}

watch(savedRows, persist, { flush: "sync" });

function detach(row: UploadRow): void {
  clearTimeout(timers.get(row));
  clearTimeout(deadlines.get(row));
  timers.delete(row);
  deadlines.delete(row);
  checking.get(row)?.abort();
  checking.delete(row);
}

function drop(row: UploadRow): void {
  detach(row);
  iterationRows.delete(row);
  queue = queue.filter((item) => item !== row);
  rows.value = rows.value.filter((item) => item !== row);
  finishIteration();
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
    const row = makeRow(file, directory.value ?? targetDirectory);
    iterationRows.add(row);
    added.push(row);
  }
  rows.value = [...rows.value, ...added];
}

function complete(
  row: UploadRow,
  status: UploadStatus,
  message: string | null = null,
): void {
  row.pending.value = false;
  row.recoveryStarted = null;
  row.message.value = message;
  row.status.value = status;
  row.state.value = status === "cancelled" ? "cancelled" : "finished";
  detach(row);
  persist();
  finishIteration();
}

function succeed(row: UploadRow, file: FileDto): void {
  row.result.value = file;
  complete(row, "succeeded");
  useFileBrowser().refresh();
}

function recoveryMessage(row: UploadRow): string {
  return row.intent.value === "cancel" || row.intent.value === "remove"
    ? "Не удалось подтвердить отмену. Повторим автоматически."
    : "Нет связи с сервером. Проверим загрузку автоматически.";
}

function beginRecovery(row: UploadRow): void {
  row.pending.value = true;
  row.recoveryStarted ??= Date.now();
  if (row.intent.value === "fail") {
    clearTimeout(deadlines.get(row));
    deadlines.delete(row);
    row.status.value = "failed";
    row.state.value = "finished";
    row.message.value ??= "Не удалось загрузить файл.";
    persist();
    return;
  }
  const remaining = Math.max(
    0,
    RECOVERY_TIMEOUT_MS - (Date.now() - row.recoveryStarted),
  );
  if (!remaining) {
    row.status.value = "failed";
    row.message.value = recoveryMessage(row);
    row.state.value = "finished";
  } else {
    row.status.value = "uploading";
    row.message.value = null;
    row.state.value = "active";
    if (!deadlines.has(row))
      deadlines.set(
        row,
        setTimeout(() => {
          deadlines.delete(row);
          if (!row.pending.value) return;
          row.status.value = "failed";
          row.message.value = recoveryMessage(row);
          row.state.value = "finished";
          persist();
        }, remaining),
      );
  }
  persist();
}

function schedule(row: UploadRow, delay = POLL_INTERVAL_MS): void {
  if (stopped || !getSessionUser() || timers.has(row) || checking.has(row))
    return;
  timers.set(
    row,
    setTimeout(() => {
      timers.delete(row);
      void recover(row);
    }, delay),
  );
}

function enqueue(row: UploadRow, automatic = false): void {
  if (!row.source) {
    complete(row, "failed", "Для повтора выберите исходный файл.");
    return;
  }
  detach(row);
  row.pending.value = false;
  row.recoveryStarted = null;
  row.intent.value = "upload";
  row.message.value = null;
  row.result.value = null;
  row.status.value = "uploading";
  row.state.value = "queued";
  if (automatic) row.attempts += 1;
  row.uploadMode = mode.value;
  row.operation.value ??= createUploadOperation(
    row.source,
    row.targetDirectory,
    mode.value,
    row.operationId,
  );
  row.operation.value.changeMode(mode.value);
  row.retryPending = automatic || row.attempts > 0;
  queue.push(row);
  persist();
  drain();
}

async function applyResult(
  row: UploadRow,
  result: UploadOperationResponse,
): Promise<void> {
  row.operation.value?.acceptResult(result);
  if (row.intent.value === "cancel" || row.intent.value === "remove") {
    if (result.status !== "cancelled" && result.status !== "deleted") return;
    useFileBrowser().refresh();
    if (row.intent.value === "remove") drop(row);
    else complete(row, "cancelled");
    return;
  }
  if (result.status === "succeeded") {
    succeed(row, result.file);
    return;
  }
  if (result.status === "processing" || result.status === "pending") return;
  if (
    result.status === "deleted" ||
    result.status === "cancelled" ||
    result.status === "discarded"
  ) {
    complete(
      row,
      result.status === "cancelled" ? "cancelled" : "failed",
      result.status === "cancelled"
        ? null
        : (row.message.value ??
            "Не удалось загрузить файл. Повторите попытку."),
    );
    row.retryPending = true;
    return;
  }
  if (row.intent.value === "fail") return;
  if (row.source && row.retryable && row.attempts < MAX_AUTOMATIC_RETRIES) {
    row.pending.value = false;
    row.recoveryStarted = null;
    detach(row);
    row.status.value = "uploading";
    timers.set(
      row,
      setTimeout(
        () => {
          timers.delete(row);
          if (!stopped && rows.value.includes(row)) enqueue(row, true);
        },
        (row.attempts + 1) * 1000,
      ),
    );
    return;
  }
  row.intent.value = "fail";
  beginRecovery(row);
}

async function recover(row: UploadRow): Promise<void> {
  if (
    stopped ||
    !getSessionUser() ||
    checking.has(row) ||
    !rows.value.includes(row)
  )
    return;
  beginRecovery(row);
  const started = generation;
  const controller = new AbortController();
  checking.set(row, controller);
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const result =
      row.intent.value === "cancel" || row.intent.value === "remove"
        ? await cancelUploadOperation(row.operationId, controller.signal)
        : row.intent.value === "fail"
          ? await failUploadOperation(row.operationId, controller.signal)
          : await resolveUploadOperation(
              row.operationId,
              controller.signal,
              row.operation.value?.stoppedUploadId,
            );
    if (
      started !== generation ||
      controller.signal.aborted ||
      !rows.value.includes(row)
    )
      return;
    const previousIntent = row.intent.value;
    await applyResult(row, result);
    if (
      previousIntent === "upload" &&
      row.intent.value === "fail" &&
      row.pending.value
    ) {
      const final = await failUploadOperation(
        row.operationId,
        controller.signal,
      );
      if (started === generation && !controller.signal.aborted)
        await applyResult(row, final);
    }
  } catch {
    if (started !== generation) return;
  } finally {
    clearTimeout(timeout);
    if (checking.get(row) === controller) checking.delete(row);
    if (started === generation && rows.value.includes(row) && row.pending.value)
      schedule(row);
  }
}

async function run(row: UploadRow): Promise<void> {
  const started = generation;
  const operation = row.operation.value!;
  row.state.value = "active";
  active.add(row);
  try {
    const retrying = row.retryPending;
    row.retryPending = false;
    const result = await (retrying ? operation.retry() : operation.start());
    if (started !== generation || !rows.value.includes(row)) return;
    if (row.intent.value === "upload") succeed(row, result);
  } catch (error) {
    if (started !== generation || !rows.value.includes(row)) return;
    if (row.intent.value !== "upload" && !row.pending.value) return;
    row.retryable = isRetryable(error);
    row.message.value = errorMessage(error, "Не удалось загрузить файл");
    if (
      row.intent.value === "upload" &&
      !operation.unresolved.value &&
      !row.retryable
    ) {
      complete(row, "failed", row.message.value);
    } else beginRecovery(row);
  } finally {
    if (started === generation) {
      active.delete(row);
      if (row.pending.value) void recover(row);
      finishIteration();
      drain();
    }
  }
}

function drain(): void {
  if (stopped) return;
  while (active.size < MAX_CONCURRENT_UPLOADS && queue.length) {
    const row = queue.shift()!;
    if (row.state.value === "queued" && rows.value.includes(row)) void run(row);
  }
}

function submit(targetDirectory: string): void {
  if (stopped && !getSessionUser()) return;
  stopped = false;
  directory.value ??= targetDirectory;
  for (const row of rows.value) {
    if (row.state.value !== "selected") continue;
    row.targetDirectory = directory.value;
    enqueue(row);
  }
}

async function retry(row: UploadRow, replacement?: File): Promise<void> {
  if (
    (stopped && !getSessionUser()) ||
    row.pending.value ||
    row.status.value === "uploading" ||
    row.status.value === "succeeded"
  )
    return;
  if (replacement) {
    if (
      replacement.name !== row.file.name ||
      replacement.size !== row.file.size ||
      replacement.lastModified !== row.file.lastModified ||
      replacement.type !== row.file.type
    ) {
      row.message.value =
        "Выберите исходный файл с тем же именем, размером и датой изменения.";
      return;
    }
    row.source = replacement;
  }
  if (!row.source) {
    row.message.value = "Для повтора выберите исходный файл.";
    return;
  }
  stopped = false;
  row.operationId = crypto.randomUUID();
  row.operation.value = null;
  row.attempts = 0;
  row.retryPending = false;
  enqueue(row);
}

function cancelRow(row: UploadRow): void {
  if (row.status.value === "selected" || row.status.value === "cancelled")
    return;
  if (row.intent.value === "remove" || row.intent.value === "cancel") return;
  detach(row);
  row.intent.value = "cancel";
  queue = queue.filter((item) => item !== row);
  row.operation.value?.cancel();
  row.recoveryStarted = null;
  beginRecovery(row);
  void recover(row);
}

function remove(row: UploadRow): void {
  if (row.status.value === "selected") {
    drop(row);
    return;
  }
  detach(row);
  row.intent.value = "remove";
  queue = queue.filter((item) => item !== row);
  row.operation.value?.cancel();
  row.recoveryStarted = null;
  beginRecovery(row);
  void recover(row);
}

function removeFile(id: string): void {
  for (const row of rows.value) if (row.result.value?.id === id) drop(row);
}

function setMode(next: UploadMode): void {
  if (uploading.value) return;
  mode.value = next;
}

function stop(): void {
  generation += 1;
  stopped = true;
  queue = [];
  active.clear();
  for (const row of rows.value) {
    detach(row);
    if (row.status.value === "uploading" || row.pending.value) {
      row.operation.value?.stop();
      row.pending.value = true;
      row.recoveryStarted ??= Date.now();
      row.state.value = "finished";
      row.status.value = "failed";
      row.message.value =
        "Сессия истекла. Войдите снова — проверка загрузки продолжится автоматически.";
    }
  }
  persist();
}

function reset(): void {
  stop();
  rows.value = [];
  iterationFiles.clear();
  iterationRows.clear();
  iterationOpen = false;
  mode.value = "server";
  directory.value = null;
  restored = true;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    return;
  }
}

function restore(): void {
  if (restored) return;
  restored = true;
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return;
  }
  if (!Array.isArray(saved)) return;
  const recovered: UploadRow[] = [];
  for (const value of saved) {
    const item = value as Partial<SavedRow>;
    if (
      !item ||
      typeof item.operationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        item.operationId,
      ) ||
      typeof item.directory !== "string" ||
      !item.file ||
      typeof item.file.name !== "string" ||
      typeof item.file.size !== "number" ||
      !Number.isSafeInteger(item.file.size) ||
      item.file.size < 0 ||
      typeof item.file.type !== "string" ||
      typeof item.file.lastModified !== "number"
    )
      continue;
    const row = makeRow(item.file, item.directory, item.operationId);
    row.uploadMode = item.mode === "presigned" ? "presigned" : "server";
    row.status.value = "failed";
    row.state.value = "finished";
    row.intent.value =
      item.intent === "cancel" ||
      item.intent === "remove" ||
      item.intent === "fail"
        ? item.intent
        : "upload";
    row.result.value = item.result ?? null;
    row.attempts = typeof item.attempts === "number" ? item.attempts : 0;
    row.retryable = item.retryable === true;
    row.pending.value =
      item.pending === true ||
      item.status === "uploading" ||
      item.intent === "remove" ||
      (item.intent === "cancel" && item.status !== "cancelled");
    row.message.value = item.message ?? "Для повтора выберите исходный файл.";
    row.recoveryStarted =
      typeof item.recoveryStarted === "number" ? item.recoveryStarted : null;
    if (item.status === "succeeded" || item.status === "cancelled")
      row.status.value = item.status;
    if (item.status === "selected") row.pending.value = false;
    recovered.push(row);
  }
  for (const row of recovered) {
    if (!row.pending.value) continue;
    iterationRows.add(row);
    iterationFiles.add(JSON.stringify([row.file.name, row.file.size]));
    iterationOpen = true;
  }
  rows.value = recovered;
  directory.value = recovered[0]?.targetDirectory ?? null;
}

function resume(): void {
  if (!getSessionUser()) return;
  restore();
  stopped = false;
  for (const row of rows.value) {
    if (row.pending.value) void recover(row);
  }
}

onSessionChange(() => {
  if (getSessionUser()) queueMicrotask(resume);
});
if (typeof window !== "undefined") window.addEventListener("online", resume);

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
    removeFile,
    submit,
    retry,
    cancelRow,
    cancel: () => rows.value.forEach(cancelRow),
    stop,
    reset,
    restore,
    resume,
  };
}
