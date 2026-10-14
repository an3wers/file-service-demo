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
  completeUpload,
  deleteFile,
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
  mode: UploadMode,
) {
  const uploading = ref(false);
  const stage = ref<UploadStage>("idle");
  const sentBytes = ref(0);
  const totalBytes = ref(file.size);
  const partsTotal = ref(0);
  const partsDone = ref(0);
  const outcome = shallowRef<UploadOutcome | null>(null);
  const reservationState = shallowRef<PresignUploadResponse | null>(null);
  const controller = new AbortController();
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

  async function confirmUpload(id: string): Promise<FileDto> {
    try {
      return await completeUpload(id);
    } catch (error) {
      if (
        isApiError(error) &&
        (error.code === "UPLOAD_NOT_COMPLETED" || error.status === 503)
      ) {
        await delay(800);

        return await completeUpload(id);
      }

      throw error;
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

    stage.value = "completing";

    return await confirmUpload(reservation.id);
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
      const { partNumber, offset, size, url } = current;

      try {
        await putPart(url, file.slice(offset, offset + size), {
          signal,
          onProgress: ({ loaded }) => report(partNumber, loaded),
        });
        report(partNumber, size);
        partsDone.value += 1;

        return;
      } catch (error) {
        if (isAbortError(error) || attempt >= PART_ATTEMPTS) {
          throw error;
        }
        report(partNumber, 0);
        await delay(attempt * 500);

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
      const parts = batch.every((partNumber) => known.has(partNumber))
        ? batch.map((partNumber) => known.get(partNumber) as MultipartPartDto)
        : (await fetchPartUrls(plan.id, batch, signal)).parts;

      await runPool(parts, plan.maxConcurrency, (part) =>
        sendPart(file, plan.id, part, signal, report),
      );
    }
  }

  async function pumpParts(
    file: File,
    plan: PresignMultipartResponse,
    numbers: number[],
    known: Map<number, MultipartPartDto>,
    signal: AbortSignal,
    report: PartProgress,
  ): Promise<void> {
    try {
      await uploadParts(file, plan, numbers, known, signal, report);
    } catch (error) {
      await deleteFile(plan.id).catch(() => {});

      throw error;
    }
  }

  async function uploadMultipart(
    file: File,
    plan: PresignMultipartResponse,
    signal: AbortSignal,
  ): Promise<FileDto> {
    const loaded = new Map<number, number>();
    const report: PartProgress = (partNumber, bytes) => {
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

    await pumpParts(
      file,
      plan,
      range(1, plan.partCount),
      known,
      signal,
      report,
    );

    stage.value = "completing";

    try {
      return await confirmUpload(plan.id);
    } catch (error) {
      if (!isApiError(error) || error.code !== "MULTIPART_INCOMPLETE") {
        throw error;
      }
      const status = await getMultipartStatus(plan.id, signal);
      const uploaded = new Set(status.uploadedParts);
      const missing = range(1, plan.partCount).filter(
        (partNumber) => !uploaded.has(partNumber),
      );

      partsDone.value = plan.partCount - missing.length;
      stage.value = "sending";
      await pumpParts(file, plan, missing, new Map(), signal, report);

      stage.value = "completing";

      return await confirmUpload(plan.id);
    }
  }

  async function uploadPresigned(
    file: File,
    directory: string,
    signal: AbortSignal,
  ): Promise<FileDto> {
    stage.value = "presigning";

    const reservation = await presignUpload(
      {
        filename: file.name,
        directory,
        contentType: file.type || undefined,
        size: file.size,
      },
      signal,
    );

    signal.throwIfAborted();
    reservationState.value = reservation;

    return reservation.strategy === "multipart"
      ? await uploadMultipart(file, reservation, signal)
      : await uploadSingle(file, reservation, signal);
  }

  async function run(): Promise<FileDto> {
    uploading.value = true;
    stage.value = mode === "server" ? "sending" : "presigning";

    try {
      const result =
        mode === "server"
          ? await uploadViaServer(
              file,
              directory,
              trackSending(controller.signal, "processing"),
            )
          : await uploadPresigned(file, directory, controller.signal);

      controller.signal.throwIfAborted();
      outcome.value = { status: "succeeded", file: result };
      return result;
    } catch (error) {
      outcome.value = isAbortError(error)
        ? { status: "cancelled" }
        : {
            status: "failed",
            error,
            message: errorMessage(error, "Не удалось загрузить файл"),
          };
      throw error;
    } finally {
      uploading.value = false;
    }
  }

  function start(): Promise<FileDto> {
    running ??= run();
    return running;
  }

  function cancel(): void {
    if (cancellable.value) {
      stage.value = "cancelling";
      controller.abort();
    }
  }

  return {
    file,
    directory,
    mode,
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
  } as const;
}

export type UploadOperation = ReturnType<typeof createUploadOperation>;
