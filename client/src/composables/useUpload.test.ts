import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { flushPromises } from "@vue/test-utils";
import type { UploadOptions } from "@/api/client";
import type {
  FileDto,
  MultipartPartDto,
  PresignMultipartResponse,
} from "@/types/api";
import { ApiError } from "@/api/client";

// Мокается весь модуль API: проверяем оркестровку частей, а не транспорт.
vi.mock("@/api/files", () => ({
  resolveUploadOperation: vi.fn(),
  cancelUploadOperation: vi.fn(),
  uploadViaServer: vi.fn(),
  presignUpload: vi.fn(),
  putToPresignedUrl: vi.fn(),
  putPart: vi.fn(),
  fetchPartUrls: vi.fn(),
  getMultipartStatus: vi.fn(),
  completeUpload: vi.fn(),
  deleteFile: vi.fn(),
}));

import {
  resolveUploadOperation,
  cancelUploadOperation,
  completeUpload,
  deleteFile,
  fetchPartUrls,
  getMultipartStatus,
  presignUpload,
  putPart,
  putToPresignedUrl,
  uploadViaServer,
} from "@/api/files";
import { createUploadOperation } from "./createUploadOperation";

const PART_SIZE = 8;

const mocked = <T extends (...args: never[]) => unknown>(fn: T) =>
  fn as unknown as Mock;

/** Часть плана: ссылка кодирует номер, чтобы в проверках было видно, какая ушла. */
function part(partNumber: number, size = PART_SIZE): MultipartPartDto {
  return {
    partNumber,
    offset: (partNumber - 1) * PART_SIZE,
    size,
    url: `https://s3.test/part-${partNumber}`,
  };
}

function plan(
  partCount: number,
  batch = partCount,
  maxConcurrency = 2,
): PresignMultipartResponse {
  return {
    strategy: "multipart",
    id: "file-1",
    key: "docs/file-1.bin",
    directory: "docs",
    uploadId: "upload-1",
    size: partCount * PART_SIZE,
    partSize: PART_SIZE,
    partCount,
    maxConcurrency,
    expiresAt: "2026-08-30T13:00:00.000Z",
    // Первая пачка — ровно `min(partCount, MULTIPART_URL_BATCH)` ссылок.
    parts: Array.from({ length: Math.min(partCount, batch) }, (_, index) =>
      part(index + 1),
    ),
  };
}

function readyFile(): FileDto {
  return {
    id: "file-1",
    name: "big.bin",
    directory: "docs",
    extension: "bin",
    contentType: "application/octet-stream",
    size: 24,
    etag: '"abc-3"',
    status: "ready",
    uploadSource: "multipart",
    bucket: "files",
    key: "docs/file-1.bin",
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:01:00.000Z",
  };
}

function bigFile(partCount: number): File {
  return new File([new Uint8Array(partCount * PART_SIZE)], "big.bin");
}

/** Номера частей в том порядке, в каком они ушли в S3. */
function sentPartNumbers(): number[] {
  return mocked(putPart).mock.calls.map((call) =>
    Number((call[0] as string).replace("https://s3.test/part-", "")),
  );
}

beforeEach(() => {
  mocked(putPart).mockResolvedValue(undefined);
  mocked(completeUpload).mockResolvedValue(readyFile());
  mocked(deleteFile).mockResolvedValue(undefined);
  vi.mocked(cancelUploadOperation).mockResolvedValue({ status: "failed" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("multipart-загрузка", () => {
  it("заливает все части плана и подтверждает загрузку", async () => {
    mocked(presignUpload).mockResolvedValue(plan(3));

    const operation = createUploadOperation(bigFile(3), "docs", "presigned");
    const result = await operation.start();

    expect(sentPartNumbers().sort()).toEqual([1, 2, 3]);
    // Тело каждой части — срез ровно по `offset`/`size` из плана.
    for (const call of mocked(putPart).mock.calls) {
      expect((call[1] as Blob).size).toBe(PART_SIZE);
    }
    expect(mocked(completeUpload)).toHaveBeenCalledWith(
      "file-1",
      expect.any(AbortSignal),
    );
    expect(result.status).toBe("ready");
    expect(operation.percent.value).toBe(100);
    expect(operation.partsDone.value).toBe(3);
    // Ссылок на все части хватило — за добавкой не ходили.
    expect(mocked(fetchPartUrls)).not.toHaveBeenCalled();
  });

  it("берёт следующую пачку ссылок пачкой того же размера", async () => {
    mocked(presignUpload).mockResolvedValue(plan(5, 2));
    mocked(fetchPartUrls).mockImplementation(
      async (_id: string, partNumbers: number[]) => ({
        expiresAt: "2026-08-30T13:00:00.000Z",
        parts: partNumbers.map((partNumber) => part(partNumber)),
      }),
    );

    await createUploadOperation(bigFile(5), "docs", "presigned").start();

    expect(mocked(fetchPartUrls).mock.calls.map((call) => call[1])).toEqual([
      [3, 4],
      [5],
    ]);
    expect(sentPartNumbers().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("держит в полёте не больше назначенной сервером параллельности", async () => {
    mocked(presignUpload).mockResolvedValue(plan(6, 6, 2));

    let inFlight = 0;
    let peak = 0;

    mocked(putPart).mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
    });

    await createUploadOperation(bigFile(6), "docs", "presigned").start();

    expect(peak).toBe(2);
  });

  it("повторяет упавшую часть со свежей ссылкой", async () => {
    vi.useFakeTimers();
    mocked(presignUpload).mockResolvedValue(plan(1));
    mocked(putPart)
      .mockRejectedValueOnce(new ApiError(403, "S3_UPLOAD_FAILED", "Expired"))
      .mockResolvedValue(undefined);
    mocked(fetchPartUrls).mockResolvedValue({
      expiresAt: "2026-08-30T13:00:00.000Z",
      parts: [{ ...part(1), url: "https://s3.test/part-1-fresh" }],
    });

    const running = createUploadOperation(
      bigFile(1),
      "docs",
      "presigned",
    ).start();

    await vi.advanceTimersByTimeAsync(2000);
    await running;

    expect(mocked(fetchPartUrls)).toHaveBeenCalledWith(
      "file-1",
      [1],
      expect.anything(),
    );
    // Вторая попытка ушла именно по перевыпущенной ссылке.
    expect(mocked(putPart).mock.calls[1]?.[0]).toBe(
      "https://s3.test/part-1-fresh",
    );
    expect(mocked(completeUpload)).toHaveBeenCalledOnce();
  });

  it("прерывает передачу и передаёт очистку уровню управления загрузками", async () => {
    mocked(presignUpload).mockResolvedValue(plan(2, 2, 1));
    mocked(putPart).mockRejectedValue(
      new DOMException("The operation was aborted.", "AbortError"),
    );

    await expect(
      createUploadOperation(bigFile(2), "docs", "presigned").start(),
    ).rejects.toThrow(DOMException);

    expect(cancelUploadOperation).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
    expect(mocked(completeUpload)).not.toHaveBeenCalled();
  });

  it("досылает недостающие части, если complete ответил MULTIPART_INCOMPLETE", async () => {
    mocked(presignUpload).mockResolvedValue(plan(3));
    mocked(completeUpload)
      .mockRejectedValueOnce(
        new ApiError(409, "MULTIPART_INCOMPLETE", "Not every part", {
          uploaded: 2,
          expected: 3,
        }),
      )
      .mockResolvedValue(readyFile());
    mocked(getMultipartStatus).mockResolvedValue({
      id: "file-1",
      uploadId: "upload-1",
      size: 24,
      partSize: PART_SIZE,
      partCount: 3,
      uploadedParts: [1, 2],
      uploadedBytes: 16,
    });
    mocked(fetchPartUrls).mockResolvedValue({
      expiresAt: "2026-08-30T13:00:00.000Z",
      parts: [part(3)],
    });

    const operation = createUploadOperation(bigFile(3), "docs", "presigned");
    const result = await operation.start();

    // Чего не хватает, знает S3, а не клиент: досылается ровно третья часть.
    expect(mocked(fetchPartUrls)).toHaveBeenCalledWith(
      "file-1",
      [3],
      expect.anything(),
    );
    expect(sentPartNumbers()).toEqual([1, 2, 3, 3]);
    expect(mocked(completeUpload)).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("ready");
  });

  it("не трогает загрузку, если сорвалось только подтверждение", async () => {
    mocked(presignUpload).mockResolvedValue(plan(2));
    mocked(completeUpload).mockRejectedValue(
      new ApiError(502, "STORAGE_ERROR", "S3 отказал"),
    );

    await expect(
      createUploadOperation(bigFile(2), "docs", "presigned").start(),
    ).rejects.toThrow(ApiError);

    // Части на месте — повторный complete ещё соберёт объект, DELETE их бы снёс.
    expect(mocked(deleteFile)).not.toHaveBeenCalled();
  });
});

describe("single-загрузка", () => {
  it("остаётся сценарием по умолчанию для ответа без multipart-плана", async () => {
    mocked(presignUpload).mockResolvedValue({
      strategy: "single",
      id: "file-2",
      key: "docs/file-2.bin",
      directory: "docs",
      uploadUrl: "https://s3.test/put",
      expiresAt: "2026-08-30T13:00:00.000Z",
      requiredHeaders: { "Content-Type": "application/octet-stream" },
    });

    await createUploadOperation(bigFile(1), "docs", "presigned").start();

    expect(mocked(putPart)).not.toHaveBeenCalled();
    expect(mocked(completeUpload)).toHaveBeenCalledWith(
      "file-2",
      expect.any(AbortSignal),
    );
  });
});

describe("независимая операция загрузки", () => {
  it("сохраняет прогресс и контроллер второй операции после завершения первой", async () => {
    const requests: {
      options: UploadOptions;
      resolve: (file: FileDto) => void;
    }[] = [];
    vi.mocked(uploadViaServer).mockImplementation(
      (_file, _directory, options = {}) =>
        new Promise((resolve, reject) => {
          requests.push({ options, resolve });
          options.signal?.addEventListener("abort", () =>
            reject(new DOMException("Отменено", "AbortError")),
          );
        }),
    );
    const first = createUploadOperation(bigFile(2), "docs", "server");
    const second = createUploadOperation(bigFile(3), "other", "server");
    const firstRun = first.start();
    const secondRun = second.start();
    const cancelled = expect(secondRun).rejects.toThrow(DOMException);

    requests[0]!.options.onProgress?.({ loaded: 16, total: 16 });
    requests[1]!.options.onProgress?.({ loaded: 6, total: 24 });
    requests[0]!.resolve(readyFile());
    await firstRun;

    expect(first.outcome.value).toEqual({
      status: "succeeded",
      file: readyFile(),
    });
    expect(second.percent.value).toBe(25);
    expect(second.stage.value).toBe("sending");
    expect(second.uploading.value).toBe(true);
    expect(second.outcome.value).toBeNull();
    second.cancel();
    await cancelled;
    expect(requests[1]!.options.signal?.aborted).toBe(true);
    expect(second.outcome.value).toEqual({ status: "cancelled" });
    expect(first.outcome.value?.status).toBe("succeeded");
    expect(first.percent.value).toBe(100);
  });

  it("отменяет только свою подготовку и не меняет подтверждение другой операции", async () => {
    let finish!: (file: FileDto) => void;
    vi.mocked(completeUpload).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.mocked(presignUpload)
      .mockResolvedValueOnce(plan(1))
      .mockImplementationOnce(
        (_body, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new DOMException("Отменено", "AbortError")),
            );
          }),
      );
    const first = createUploadOperation(bigFile(1), "docs", "presigned");
    const second = createUploadOperation(bigFile(2), "docs", "presigned");
    const firstRun = first.start();
    await flushPromises();
    const secondRun = second.start();
    const cancelled = expect(secondRun).rejects.toThrow(DOMException);
    second.cancel();
    await cancelled;

    expect(first.stage.value).toBe("completing");
    expect(first.uploading.value).toBe(true);
    expect(first.partsDone.value).toBe(1);
    expect(first.percent.value).toBe(100);
    expect(first.outcome.value).toBeNull();
    expect(first.cancellable.value).toBe(true);
    finish(readyFile());
    await firstRun;
    expect(first.outcome.value?.status).toBe("succeeded");
  });

  it("сохраняет резервирование, стадию и причину ошибки подтверждения", async () => {
    const failure = new ApiError(502, "STORAGE_ERROR", "Ошибка хранилища");
    vi.mocked(presignUpload).mockResolvedValue(plan(2));
    vi.mocked(completeUpload).mockRejectedValue(failure);
    const operation = createUploadOperation(bigFile(2), "docs", "presigned");

    await expect(operation.start()).rejects.toBe(failure);

    expect(operation.stage.value).toBe("completing");
    expect(operation.reservation.value).toEqual(plan(2));
    expect(operation.outcome.value).toEqual({
      status: "failed",
      error: failure,
      message: "Ошибка хранилища — операция не выполнена",
    });
    expect(operation.file.name).toBe("big.bin");
    expect(operation.directory).toBe("docs");
    expect(operation.mode).toBe("presigned");
    expect(operation.uploading.value).toBe(false);
  });

  it("не создаёт вторую передачу при повторном запуске той же операции", async () => {
    vi.mocked(uploadViaServer).mockResolvedValue(readyFile());
    const operation = createUploadOperation(bigFile(1), "docs", "server");

    await Promise.all([operation.start(), operation.start()]);
    await operation.start();

    expect(uploadViaServer).toHaveBeenCalledOnce();
  });

  it("повторяет подтверждение после временной ошибки без новой передачи", async () => {
    vi.useFakeTimers();
    vi.mocked(presignUpload).mockResolvedValue({
      strategy: "single",
      id: "file-2",
      key: "docs/file-2.bin",
      directory: "docs",
      uploadUrl: "https://s3.test/put",
      expiresAt: "2026-08-30T13:00:00.000Z",
      requiredHeaders: { "Content-Type": "application/octet-stream" },
    });
    vi.mocked(completeUpload)
      .mockRejectedValueOnce(
        new ApiError(409, "UPLOAD_NOT_COMPLETED", "Пока не видно"),
      )
      .mockResolvedValue(readyFile());
    const operation = createUploadOperation(bigFile(1), "docs", "presigned");
    const running = operation.start();

    await vi.advanceTimersByTimeAsync(800);
    await running;

    expect(completeUpload).toHaveBeenCalledTimes(2);
    expect(putToPresignedUrl).toHaveBeenCalledOnce();
    expect(operation.outcome.value?.status).toBe("succeeded");
  });
});

describe("ручной повтор серверной операции", () => {
  it("выясняет потерянный результат без второй передачи и сохраняет идентичность", async () => {
    vi.mocked(uploadViaServer).mockRejectedValue(new Error("Ответ потерян"));
    vi.mocked(resolveUploadOperation).mockResolvedValue({
      status: "succeeded",
      file: readyFile(),
    });
    const operation = createUploadOperation(bigFile(1), "docs", "server");
    await expect(operation.start()).rejects.toThrow();
    expect(operation.outcome.value).toMatchObject({
      status: "failed",
      message: "Не удалось выяснить результат",
    });
    await expect(operation.retry()).resolves.toEqual(readyFile());
    expect(resolveUploadOperation).toHaveBeenCalledWith(
      operation.operationId,
      expect.any(AbortSignal),
    );
    expect(uploadViaServer).toHaveBeenCalledOnce();
    expect(vi.mocked(uploadViaServer).mock.calls[0]?.[3]).toBe(
      operation.operationId,
    );
  });

  it("повторяет передачу только после подтверждённой неудачи", async () => {
    vi.mocked(uploadViaServer)
      .mockRejectedValueOnce(new Error("Нет связи"))
      .mockResolvedValue(readyFile());
    vi.mocked(resolveUploadOperation).mockResolvedValue({ status: "failed" });
    const operation = createUploadOperation(bigFile(1), "docs", "server");
    await expect(operation.start()).rejects.toThrow();
    await operation.retry();
    expect(uploadViaServer).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(uploadViaServer).mock.calls.map((args) => args[3]),
    ).toEqual([operation.operationId, operation.operationId]);
  });

  it.each([
    "pending",
    "processing",
    "deleted",
    "cancelled",
    "discarded",
    "unavailable",
  ])("не отправляет файл при результате %s", async (status) => {
    vi.mocked(uploadViaServer).mockRejectedValue(new Error("Нет связи"));
    if (status === "unavailable")
      vi.mocked(resolveUploadOperation).mockRejectedValue(
        new Error("Нет связи"),
      );
    else
      vi.mocked(resolveUploadOperation).mockResolvedValue({
        status: status as
          "pending" | "processing" | "deleted" | "cancelled" | "discarded",
      });
    const operation = createUploadOperation(bigFile(1), "docs", "server");
    await expect(operation.start()).rejects.toThrow();
    await expect(operation.retry()).rejects.toThrow();
    expect(uploadViaServer).toHaveBeenCalledOnce();
  });
});

describe.each(["single", "multipart"] as const)(
  "безопасный повтор прямой загрузки %s",
  (strategy) => {
    function reservation() {
      return strategy === "multipart"
        ? plan(2)
        : {
            strategy: "single" as const,
            id: "file-1",
            key: "docs/file-1.bin",
            directory: "docs",
            uploadUrl: "https://s3.test/put",
            expiresAt: "2026-08-30T13:00:00.000Z",
            requiredHeaders: { "Content-Type": "application/octet-stream" },
          };
    }

    it("после потери резервирования выясняет исход и сохраняет идентичность повтора", async () => {
      vi.mocked(presignUpload)
        .mockRejectedValueOnce(new Error("Ответ потерян"))
        .mockResolvedValue(reservation());
      vi.mocked(resolveUploadOperation).mockResolvedValue({ status: "failed" });
      vi.mocked(getMultipartStatus).mockResolvedValue({
        id: "file-1",
        uploadId: "upload-1",
        size: 16,
        partSize: 8,
        partCount: 2,
        uploadedParts: [],
        uploadedBytes: 0,
      });
      const operation = createUploadOperation(bigFile(2), "docs", "presigned");
      await expect(operation.start()).rejects.toThrow("Ответ потерян");
      expect(operation.unresolved.value).toBe(true);
      operation.changeMode("server");
      expect(operation.mode).toBe("presigned");
      await operation.retry();
      expect(presignUpload).toHaveBeenCalledTimes(2);
      expect(
        vi.mocked(presignUpload).mock.calls.map(([body]) => body.operationId),
      ).toEqual([operation.operationId, operation.operationId]);
      expect(resolveUploadOperation).toHaveBeenCalledWith(
        operation.operationId,
        expect.any(AbortSignal),
      );
      expect(operation.outcome.value?.status).toBe("succeeded");
    });

    it("повторяет подтверждение с прежним файлом без резервирования и передачи", async () => {
      vi.mocked(presignUpload).mockResolvedValue(reservation());
      vi.mocked(completeUpload)
        .mockRejectedValueOnce(new Error("Нет связи"))
        .mockResolvedValue(readyFile());
      vi.mocked(resolveUploadOperation).mockResolvedValue({ status: "failed" });
      const operation = createUploadOperation(bigFile(2), "docs", "presigned");
      await expect(operation.start()).rejects.toThrow("Нет связи");
      await operation.retry();
      expect(presignUpload).toHaveBeenCalledOnce();
      expect(putToPresignedUrl).toHaveBeenCalledTimes(
        strategy === "single" ? 1 : 0,
      );
      expect(putPart).toHaveBeenCalledTimes(strategy === "multipart" ? 2 : 0);
      expect(completeUpload).toHaveBeenNthCalledWith(
        2,
        "file-1",
        expect.any(AbortSignal),
      );
    });

    it.each([
      "pending",
      "processing",
      "deleted",
      "cancelled",
      "discarded",
      "unavailable",
    ])(
      "не передаёт байты при невыясненном или удалённом результате %s",
      async (status) => {
        vi.mocked(presignUpload).mockRejectedValue(new Error("Нет связи"));
        if (status === "unavailable")
          vi.mocked(resolveUploadOperation).mockRejectedValue(
            new Error("Нет связи"),
          );
        else
          vi.mocked(resolveUploadOperation).mockResolvedValue({
            status: status as
              "pending" | "processing" | "deleted" | "cancelled" | "discarded",
          });
        const operation = createUploadOperation(
          bigFile(2),
          "docs",
          "presigned",
        );
        await expect(operation.start()).rejects.toThrow();
        await expect(operation.retry()).rejects.toThrow();
        expect(presignUpload).toHaveBeenCalledOnce();
        expect(putPart).not.toHaveBeenCalled();
        expect(putToPresignedUrl).not.toHaveBeenCalled();
      },
    );

    it("узнаёт готовый результат без повторного подтверждения", async () => {
      vi.mocked(presignUpload).mockResolvedValue(reservation());
      vi.mocked(completeUpload).mockRejectedValueOnce(
        new Error("Ответ потерян"),
      );
      vi.mocked(resolveUploadOperation).mockResolvedValue({
        status: "succeeded",
        file: readyFile(),
      });
      const operation = createUploadOperation(bigFile(2), "docs", "presigned");
      await expect(operation.start()).rejects.toThrow();
      await operation.retry();
      expect(presignUpload).toHaveBeenCalledOnce();
      expect(completeUpload).toHaveBeenCalledOnce();
      expect(operation.outcome.value?.status).toBe("succeeded");
    });

    it("разрешает другой режим только после выяснения неудачи", async () => {
      vi.mocked(presignUpload).mockRejectedValue(new Error("Ответ потерян"));
      vi.mocked(resolveUploadOperation).mockResolvedValue({ status: "failed" });
      vi.mocked(uploadViaServer).mockResolvedValue(readyFile());
      const operation = createUploadOperation(bigFile(2), "docs", "presigned");
      await expect(operation.start()).rejects.toThrow();
      operation.changeMode("server");
      expect(operation.mode).toBe("presigned");
      await operation.checkResult();
      operation.changeMode("server");
      await operation.retry();
      expect(uploadViaServer).toHaveBeenCalledWith(
        operation.file,
        "docs",
        expect.anything(),
        operation.operationId,
      );
    });

    it("вручную возобновляет отменённую операцию в той же строке", async () => {
      vi.mocked(presignUpload).mockResolvedValue(reservation());
      const failure = new DOMException("Отменено", "AbortError");
      if (strategy === "single")
        vi.mocked(putToPresignedUrl)
          .mockRejectedValueOnce(failure)
          .mockResolvedValue(undefined);
      else
        vi.mocked(putPart)
          .mockRejectedValueOnce(failure)
          .mockResolvedValue(undefined);
      vi.mocked(resolveUploadOperation).mockResolvedValue({ status: "failed" });
      vi.mocked(getMultipartStatus).mockResolvedValue({
        id: "file-1",
        uploadId: "upload-1",
        size: 16,
        partSize: 8,
        partCount: 2,
        uploadedParts: [],
        uploadedBytes: 0,
      });
      const operation = createUploadOperation(bigFile(2), "docs", "presigned");
      await expect(operation.start()).rejects.toThrow(DOMException);
      expect(operation.outcome.value?.status).toBe("cancelled");
      expect(cancelUploadOperation).not.toHaveBeenCalled();
      await operation.retry();
      expect(operation.outcome.value?.status).toBe("succeeded");
    });
  },
);

it("сохраняет части после ошибки и при ручном повторе досылает только недостающие", async () => {
  vi.useFakeTimers();
  vi.mocked(presignUpload).mockResolvedValue(plan(2, 2, 1));
  vi.mocked(putPart).mockImplementation(async (url) => {
    if (url.endsWith("2")) throw new Error("Нет связи");
  });
  vi.mocked(fetchPartUrls).mockResolvedValue({
    expiresAt: "2026-08-30T13:00:00.000Z",
    parts: [part(2)],
  });
  const operation = createUploadOperation(bigFile(2), "docs", "presigned");
  const first = expect(operation.start()).rejects.toThrow("Нет связи");
  await vi.runAllTimersAsync();
  await first;
  expect(cancelUploadOperation).not.toHaveBeenCalled();
  vi.mocked(resolveUploadOperation).mockResolvedValue({ status: "failed" });
  vi.mocked(getMultipartStatus).mockResolvedValue({
    id: "file-1",
    uploadId: "upload-1",
    size: 16,
    partSize: 8,
    partCount: 2,
    uploadedParts: [1],
    uploadedBytes: 8,
  });
  vi.mocked(putPart).mockResolvedValue(undefined);
  const count = vi.mocked(putPart).mock.calls.length;
  await operation.retry();
  expect(
    vi
      .mocked(putPart)
      .mock.calls.slice(count)
      .map(([url]) => url),
  ).toEqual([part(2).url]);
  expect(operation.percent.value).toBe(100);
});

it("показывает общий лимит конкретного файла и ждёт ручного повтора", async () => {
  vi.mocked(presignUpload).mockRejectedValue(
    new ApiError(429, "TOO_MANY_ACTIVE_UPLOADS", "Нет свободного места"),
  );
  const operation = createUploadOperation(bigFile(2), "docs", "presigned");
  await expect(operation.start()).rejects.toThrow();
  expect(operation.unresolved.value).toBe(false);
  expect(operation.outcome.value).toMatchObject({ status: "failed" });
  expect(presignUpload).toHaveBeenCalledOnce();
  expect(resolveUploadOperation).not.toHaveBeenCalled();
});

it.each([
  [409, "UPLOAD_NOT_COMPLETED", "UPLOAD_NOT_COMPLETED"],
  [503, "STORAGE_UNAVAILABLE", "MULTIPART_NOT_FOUND"],
])(
  "после двух ошибок подтверждения %s повторяет передачу отсутствующих байтов",
  async (status, firstCode, secondCode) => {
    vi.useFakeTimers();
    vi.mocked(presignUpload).mockResolvedValue({
      strategy: "single",
      id: "file-1",
      key: "docs/file-1.bin",
      directory: "docs",
      uploadUrl: "https://s3.test/put",
      expiresAt: "2026-08-30T13:00:00.000Z",
      requiredHeaders: { "Content-Type": "application/octet-stream" },
    });
    vi.mocked(completeUpload)
      .mockRejectedValueOnce(new ApiError(status, firstCode, "Не подтверждено"))
      .mockRejectedValueOnce(new ApiError(409, secondCode, "Объекта нет"))
      .mockResolvedValue(readyFile());
    vi.mocked(resolveUploadOperation).mockResolvedValue({ status: "failed" });
    const operation = createUploadOperation(bigFile(2), "docs", "presigned");
    const failed = expect(operation.start()).rejects.toThrow("Объекта нет");
    await vi.runAllTimersAsync();
    await failed;
    await operation.retry();
    expect(presignUpload).toHaveBeenCalledTimes(2);
    expect(putToPresignedUrl).toHaveBeenCalledTimes(2);
    expect(completeUpload).toHaveBeenCalledTimes(3);
    expect(operation.outcome.value?.status).toBe("succeeded");
  },
);

it("после подтверждения несоответствия размера повторяет байты вместо подтверждения прежнего объекта", async () => {
  vi.mocked(presignUpload).mockResolvedValue({
    strategy: "single",
    id: "file-1",
    key: "docs/file-1.bin",
    directory: "docs",
    uploadUrl: "https://s3.test/put",
    expiresAt: "2026-08-30T13:00:00.000Z",
    requiredHeaders: { "Content-Type": "application/octet-stream" },
  });
  vi.mocked(completeUpload)
    .mockRejectedValueOnce(new Error("Ответ потерян"))
    .mockResolvedValue(readyFile());
  vi.mocked(resolveUploadOperation).mockResolvedValue({
    status: "failed",
    reason: "size_mismatch",
  });
  const operation = createUploadOperation(bigFile(2), "docs", "presigned");
  await expect(operation.start()).rejects.toThrow("Ответ потерян");
  await operation.retry();
  expect(putToPresignedUrl).toHaveBeenCalledTimes(2);
  expect(presignUpload).toHaveBeenCalledTimes(2);
});
