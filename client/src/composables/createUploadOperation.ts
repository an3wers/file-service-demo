import { computed, readonly, ref, shallowReadonly, shallowRef } from "vue";
import type { UploadOptions } from "@/api/client";
import type {
  FileDto,
  MultipartPartDto,
  PresignMultipartResponse,
  PresignSingleResponse,
  PresignUploadResponse,
} from "@/types/api";
import {
  getUploadOperation,
  completeUpload,
  cancelUploadOperation,
  fetchPartUrls,
  getMultipartStatus,
  presignUpload,
  putPart,
  putToPresignedUrl,
  uploadViaServer,
} from "@/api/files";
import { isAbortError, isApiError } from "@/api/client";
import { chunk, range, runPool } from "@/lib/parts";
import { errorMessage } from "@/lib/errors";
import { serverUploadSizeError } from "@/lib/uploadLimits";

export type UploadMode = "server" | "presigned";
export type UploadStage =
  | "idle"
  | "presigning"
  | "sending"
  | "processing"
  | "completing"
  | "cancelling";
export type UploadOutcome =
  | { status: "succeeded"; file: FileDto }
  | { status: "failed"; error: unknown; message: string }
  | { status: "cancelled" };

const PART_ATTEMPTS = 3;

export function createUploadOperation(
  file: File,
  directory: string,
  initialMode: UploadMode,
  operationId: string = crypto.randomUUID(),
) {
  const currentMode = ref(initialMode);
  const uploading = ref(false);
  const stage = ref<UploadStage>("idle");
  const sentBytes = ref(0);
  const totalBytes = ref(file.size);
  const partsTotal = ref(0);
  const partsDone = ref(0);
  const outcome = shallowRef<UploadOutcome | null>(null);
  const reservationState = shallowRef<PresignUploadResponse | null>(null);
  let controller = new AbortController();
  let cancellationController = new AbortController();
  let generation = 0;
  let attempted = false;
  let confirmationPending = false;
  let deleted = false;
  let resuming = false;
  const unresolved = ref(false);
  let running: Promise<FileDto> | null = null;

  const percent = computed(() =>
    totalBytes.value > 0
      ? Math.min(100, Math.round((sentBytes.value / totalBytes.value) * 100))
      : 100,
  );
  const cancellable = computed(
    () =>
      uploading.value &&
      (stage.value === "presigning" || stage.value === "sending"),
  );

  const delay = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  function trackSending(signal: AbortSignal, next: UploadStage): UploadOptions {
    return {
      signal,
      onProgress: ({ loaded, total }) => {
        if (signal.aborted) return;
        sentBytes.value = loaded;
        if (total !== null) {
          totalBytes.value = total;
        }
      },
      onSent: () => {
        if (!signal.aborted) stage.value = next;
      },
    };
  }

  async function confirmUpload(
    id: string,
    signal: AbortSignal,
  ): Promise<FileDto> {
    confirmationPending = true;
    unresolved.value = true;
    for (let attempt = 1; ; attempt += 1) {
      signal.throwIfAborted();
      try {
        return await completeUpload(id, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (
          attempt === 1 &&
          isApiError(error) &&
          (error.code === "UPLOAD_NOT_COMPLETED" || error.status === 503)
        ) {
          await delay(800);
          continue;
        }
        if (
          isApiError(error) &&
          (error.code === "UPLOAD_NOT_COMPLETED" ||
            error.code === "MULTIPART_NOT_FOUND")
        ) {
          confirmationPending = false;
        }
        throw error;
      }
    }
  }

  async function uploadSingle(
    file: File,
    reservation: PresignSingleResponse,
    signal: AbortSignal,
  ): Promise<FileDto> {
    stage.value = "sending";
    await putToPresignedUrl(
      reservation.uploadUrl,
      file,
      reservation.requiredHeaders,
      trackSending(signal, "processing"),
    );

    signal.throwIfAborted();
    stage.value = "completing";

    return await confirmUpload(reservation.id, signal);
  }

  type PartProgress = (partNumber: number, loaded: number) => void;

  async function sendPart(
    file: File,
    id: string,
    part: MultipartPartDto,
    signal: AbortSignal,
    report: PartProgress,
  ): Promise<void> {
    let current = part;

    for (let attempt = 1; ; attempt += 1) {
      signal.throwIfAborted();
      const { partNumber, offset, size, url } = current;

      try {
        await putPart(url, file.slice(offset, offset + size), {
          signal,
          onProgress: ({ loaded }) => report(partNumber, loaded),
        });
        signal.throwIfAborted();
        report(partNumber, size);
        partsDone.value += 1;

        return;
      } catch (error) {
        signal.throwIfAborted();
        if (isAbortError(error) || attempt >= PART_ATTEMPTS) {
          throw error;
        }
        report(partNumber, 0);
        await delay(attempt * 500);
        signal.throwIfAborted();

        const refreshed = await fetchPartUrls(id, [partNumber], signal);

        current = refreshed.parts[0] ?? current;
      }
    }
  }

  async function uploadParts(
    file: File,
    plan: PresignMultipartResponse,
    numbers: number[],
    known: Map<number, MultipartPartDto>,
    signal: AbortSignal,
    report: PartProgress,
  ): Promise<void> {
    const batchSize = Math.max(1, plan.parts.length);

    for (const batch of chunk(numbers, batchSize)) {
      signal.throwIfAborted();
      const parts = batch.every((partNumber) => known.has(partNumber))
        ? batch.map((partNumber) => known.get(partNumber) as MultipartPartDto)
        : (await fetchPartUrls(plan.id, batch, signal)).parts;

      signal.throwIfAborted();
      await runPool(parts, plan.maxConcurrency, (part) =>
        sendPart(file, plan.id, part, signal, report),
      );
    }
  }

  async function uploadMultipart(
    file: File,
    plan: PresignMultipartResponse,
    signal: AbortSignal,
  ): Promise<FileDto> {
    const loaded = new Map<number, number>();
    const report: PartProgress = (partNumber, bytes) => {
      if (signal.aborted) return;
      loaded.set(partNumber, bytes);

      let total = 0;

      for (const value of loaded.values()) {
        total += value;
      }

      sentBytes.value = total;
    };

    const known = new Map(plan.parts.map((part) => [part.partNumber, part]));

    partsTotal.value = plan.partCount;
    partsDone.value = 0;
    stage.value = "sending";

    let numbers = range(1, plan.partCount);
    if (attempted && reservationState.value?.id === plan.id && resuming) {
      const status = await getMultipartStatus(plan.id, signal);
      signal.throwIfAborted();
      const uploaded = new Set(status.uploadedParts);
      numbers = numbers.filter((number) => !uploaded.has(number));
      partsDone.value = uploaded.size;
      sentBytes.value = status.uploadedBytes;
      for (const number of uploaded)
        loaded.set(
          number,
          Math.min(plan.partSize, plan.size - (number - 1) * plan.partSize),
        );
    }
    await uploadParts(file, plan, numbers, known, signal, report);

    signal.throwIfAborted();
    stage.value = "completing";

    try {
      return await confirmUpload(plan.id, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (!isApiError(error) || error.code !== "MULTIPART_INCOMPLETE") {
        throw error;
      }
      const status = await getMultipartStatus(plan.id, signal);
      signal.throwIfAborted();
      const uploaded = new Set(status.uploadedParts);
      const missing = range(1, plan.partCount).filter(
        (partNumber) => !uploaded.has(partNumber),
      );

      partsDone.value = plan.partCount - missing.length;
      stage.value = "sending";
      await uploadParts(file, plan, missing, new Map(), signal, report);

      signal.throwIfAborted();
      stage.value = "completing";

      return await confirmUpload(plan.id, signal);
    }
  }

  async function uploadPresigned(
    file: File,
    directory: string,
    signal: AbortSignal,
  ): Promise<FileDto> {
    if (confirmationPending && reservationState.value) {
      stage.value = "completing";
      try {
        return await confirmUpload(reservationState.value.id, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (
          !isApiError(error) ||
          error.code !== "MULTIPART_INCOMPLETE" ||
          reservationState.value.strategy !== "multipart"
        )
          throw error;
        resuming = true;
        return await uploadMultipart(file, reservationState.value, signal);
      }
    }
    stage.value = "presigning";
    unresolved.value = true;
    const reservation = await presignUpload(
      {
        operationId,
        filename: file.name,
        directory,
        contentType: file.type || undefined,
        size: file.size,
      },
      signal,
    );

    signal.throwIfAborted();
    if (reservation.strategy === "ready") return reservation.file;
    reservationState.value = reservation;

    return reservation.strategy === "multipart"
      ? await uploadMultipart(file, reservation, signal)
      : await uploadSingle(file, reservation, signal);
  }

  async function uploadServer(signal: AbortSignal): Promise<FileDto> {
    unresolved.value = true;
    stage.value = "sending";
    return await uploadViaServer(
      file,
      directory,
      trackSending(signal, "processing"),
      operationId,
    );
  }

  async function run(): Promise<FileDto> {
    const started = generation;
    const signal = controller.signal;
    const cancellationSignal = cancellationController.signal;
    uploading.value = true;
    stage.value = currentMode.value === "server" ? "sending" : "presigning";

    try {
      if (deleted) throw new Error("Результат операции удалён");
      if (attempted) {
        const result = await resolveResult(signal);
        signal.throwIfAborted();
        if (result) {
          outcome.value = { status: "succeeded", file: result };
          return result;
        }
      }
      resuming = attempted;
      const sizeError =
        currentMode.value === "server" ? serverUploadSizeError(file) : null;
      if (sizeError) throw new Error(sizeError);
      attempted = true;
      const result =
        currentMode.value === "server"
          ? await uploadServer(signal)
          : await uploadPresigned(file, directory, signal);

      signal.throwIfAborted();
      unresolved.value = false;
      outcome.value = { status: "succeeded", file: result };
      return result;
    } catch (error) {
      if (started !== generation) throw error;
      if (isAbortError(error) && currentMode.value === "presigned") {
        try {
          const result = await cancelUploadOperation(
            operationId,
            cancellationSignal,
          );
          if (started !== generation) throw error;
          unresolved.value = result.status === "processing";
          confirmationPending = false;
          reservationState.value = null;
          if (result.status === "succeeded") {
            outcome.value = { status: "succeeded", file: result.file };
            return result.file;
          }
        } catch {
          if (started !== generation) throw error;
          unresolved.value = true;
        }
      }
      if (
        isApiError(error) &&
        (error.code === "TOO_MANY_ACTIVE_UPLOADS" ||
          error.code === "PAYLOAD_TOO_LARGE")
      ) {
        unresolved.value = false;
      }
      outcome.value = isAbortError(error)
        ? { status: "cancelled" }
        : {
            status: "failed",
            error,
            message:
              currentMode.value === "server" && unresolved.value
                ? "Не удалось выяснить результат"
                : errorMessage(error, "Не удалось загрузить файл"),
          };
      throw error;
    } finally {
      if (started === generation) uploading.value = false;
    }
  }

  async function resolveResult(signal: AbortSignal): Promise<FileDto | null> {
    unresolved.value = true;
    stage.value = "processing";
    const result = await getUploadOperation(operationId, signal);
    signal.throwIfAborted();
    if (result.status === "processing")
      throw new Error("Не удалось выяснить результат");
    unresolved.value = false;
    if (result.status === "succeeded") return result.file;
    if (result.status === "deleted") {
      deleted = true;
      throw new Error("Результат операции удалён");
    }
    return null;
  }

  async function checkResult(): Promise<void> {
    if (uploading.value) return;
    const started = generation;
    controller = new AbortController();
    const signal = controller.signal;
    uploading.value = true;
    try {
      const file = await resolveResult(signal);
      if (file) outcome.value = { status: "succeeded", file };
      else
        outcome.value = {
          status: "failed",
          error: null,
          message: "Загрузка не завершена. Можно повторить операцию.",
        };
    } catch (error) {
      if (started !== generation) return;
      outcome.value = {
        status: "failed",
        error,
        message: errorMessage(error, "Не удалось выяснить результат"),
      };
    } finally {
      if (started === generation) uploading.value = false;
    }
  }

  function changeMode(next: UploadMode): void {
    if (
      uploading.value ||
      unresolved.value ||
      deleted ||
      outcome.value?.status === "succeeded"
    )
      return;
    if (next === currentMode.value) return;
    currentMode.value = next;
    confirmationPending = false;
    reservationState.value = null;
  }

  function start(): Promise<FileDto> {
    if (outcome.value?.status === "succeeded")
      return Promise.resolve(outcome.value.file);
    running ??= run();
    return running;
  }

  function retry(): Promise<FileDto> {
    if (uploading.value || outcome.value?.status === "succeeded")
      return start();
    controller = new AbortController();
    cancellationController = new AbortController();
    outcome.value = null;
    sentBytes.value = 0;
    running = run();
    return running;
  }

  function cancel(): void {
    if (cancellable.value) {
      stage.value = "cancelling";
      controller.abort();
    }
  }

  function stop(): void {
    generation += 1;
    controller.abort();
    cancellationController.abort();
    uploading.value = false;
    stage.value = "idle";
    unresolved.value = attempted;
    outcome.value = {
      status: "failed",
      error: null,
      message:
        "Загрузка остановлена: сессия истекла. Войдите снова и повторите вручную. Уже принятая сервером работа может завершиться.",
    };
  }

  return {
    file,
    directory,
    get mode() {
      return currentMode.value;
    },
    changeMode,
    checkResult,
    operationId,
    unresolved: shallowReadonly(unresolved),
    retry,
    uploading: shallowReadonly(uploading),
    stage: shallowReadonly(stage),
    sentBytes: shallowReadonly(sentBytes),
    totalBytes: shallowReadonly(totalBytes),
    partsTotal: shallowReadonly(partsTotal),
    partsDone: shallowReadonly(partsDone),
    outcome: readonly(outcome),
    reservation: readonly(reservationState),
    percent,
    cancellable,
    start,
    cancel,
    stop,
  } as const;
}

export type UploadOperation = ReturnType<typeof createUploadOperation>;
