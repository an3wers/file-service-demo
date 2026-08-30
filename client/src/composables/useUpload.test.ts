import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"
import type {
  FileDto,
  MultipartPartDto,
  PresignMultipartResponse,
} from "@/types/api"
import { ApiError } from "@/api/client"

// Мокается весь модуль API: проверяем оркестровку частей, а не транспорт.
vi.mock("@/api/files", () => ({
  uploadViaServer: vi.fn(),
  presignUpload: vi.fn(),
  putToPresignedUrl: vi.fn(),
  putPart: vi.fn(),
  fetchPartUrls: vi.fn(),
  getMultipartStatus: vi.fn(),
  completeUpload: vi.fn(),
  deleteFile: vi.fn(),
}))

import {
  completeUpload,
  deleteFile,
  fetchPartUrls,
  getMultipartStatus,
  presignUpload,
  putPart,
} from "@/api/files"
import { useUpload } from "./useUpload"

const PART_SIZE = 8

const mocked = <T extends (...args: never[]) => unknown>(fn: T) =>
  fn as unknown as Mock

/** Часть плана: ссылка кодирует номер, чтобы в проверках было видно, какая ушла. */
function part(partNumber: number, size = PART_SIZE): MultipartPartDto {
  return {
    partNumber,
    offset: (partNumber - 1) * PART_SIZE,
    size,
    url: `https://s3.test/part-${partNumber}`,
  }
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
  }
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
  }
}

function bigFile(partCount: number): File {
  return new File([new Uint8Array(partCount * PART_SIZE)], "big.bin")
}

/** Номера частей в том порядке, в каком они ушли в S3. */
function sentPartNumbers(): number[] {
  return mocked(putPart).mock.calls.map((call) =>
    Number((call[0] as string).replace("https://s3.test/part-", "")),
  )
}

const upload = useUpload()

beforeEach(() => {
  upload.mode.value = "presigned"
  mocked(putPart).mockResolvedValue(undefined)
  mocked(completeUpload).mockResolvedValue(readyFile())
  mocked(deleteFile).mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("multipart-загрузка", () => {
  it("заливает все части плана и подтверждает загрузку", async () => {
    mocked(presignUpload).mockResolvedValue(plan(3))

    const result = await upload.upload(bigFile(3), "docs")

    expect(sentPartNumbers().sort()).toEqual([1, 2, 3])
    // Тело каждой части — срез ровно по `offset`/`size` из плана.
    for (const call of mocked(putPart).mock.calls) {
      expect((call[1] as Blob).size).toBe(PART_SIZE)
    }
    expect(mocked(completeUpload)).toHaveBeenCalledWith("file-1")
    expect(result.status).toBe("ready")
    expect(upload.percent.value).toBe(100)
    expect(upload.partsDone.value).toBe(3)
    // Ссылок на все части хватило — за добавкой не ходили.
    expect(mocked(fetchPartUrls)).not.toHaveBeenCalled()
  })

  it("берёт следующую пачку ссылок пачкой того же размера", async () => {
    mocked(presignUpload).mockResolvedValue(plan(5, 2))
    mocked(fetchPartUrls).mockImplementation(
      async (_id: string, partNumbers: number[]) => ({
        expiresAt: "2026-08-30T13:00:00.000Z",
        parts: partNumbers.map((partNumber) => part(partNumber)),
      }),
    )

    await upload.upload(bigFile(5), "docs")

    expect(mocked(fetchPartUrls).mock.calls.map((call) => call[1])).toEqual([
      [3, 4],
      [5],
    ])
    expect(sentPartNumbers().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it("держит в полёте не больше назначенной сервером параллельности", async () => {
    mocked(presignUpload).mockResolvedValue(plan(6, 6, 2))

    let inFlight = 0
    let peak = 0

    mocked(putPart).mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight -= 1
    })

    await upload.upload(bigFile(6), "docs")

    expect(peak).toBe(2)
  })

  it("повторяет упавшую часть со свежей ссылкой", async () => {
    vi.useFakeTimers()
    mocked(presignUpload).mockResolvedValue(plan(1))
    mocked(putPart)
      .mockRejectedValueOnce(new ApiError(403, "S3_UPLOAD_FAILED", "Expired"))
      .mockResolvedValue(undefined)
    mocked(fetchPartUrls).mockResolvedValue({
      expiresAt: "2026-08-30T13:00:00.000Z",
      parts: [{ ...part(1), url: "https://s3.test/part-1-fresh" }],
    })

    const running = upload.upload(bigFile(1), "docs")

    await vi.advanceTimersByTimeAsync(2000)
    await running

    expect(mocked(fetchPartUrls)).toHaveBeenCalledWith(
      "file-1",
      [1],
      expect.anything(),
    )
    // Вторая попытка ушла именно по перевыпущенной ссылке.
    expect(mocked(putPart).mock.calls[1]?.[0]).toBe(
      "https://s3.test/part-1-fresh",
    )
    expect(mocked(completeUpload)).toHaveBeenCalledOnce()
  })

  it("отменяет загрузку в хранилище, когда часть не долетела", async () => {
    mocked(presignUpload).mockResolvedValue(plan(2, 2, 1))
    mocked(putPart).mockRejectedValue(
      new DOMException("The operation was aborted.", "AbortError"),
    )

    await expect(upload.upload(bigFile(2), "docs")).rejects.toThrow(DOMException)

    // Без DELETE загрузка осталась бы открытой: S3 берёт деньги за залитые части.
    expect(mocked(deleteFile)).toHaveBeenCalledWith("file-1")
    expect(mocked(completeUpload)).not.toHaveBeenCalled()
  })

  it("досылает недостающие части, если complete ответил MULTIPART_INCOMPLETE", async () => {
    mocked(presignUpload).mockResolvedValue(plan(3))
    mocked(completeUpload)
      .mockRejectedValueOnce(
        new ApiError(409, "MULTIPART_INCOMPLETE", "Not every part", {
          uploaded: 2,
          expected: 3,
        }),
      )
      .mockResolvedValue(readyFile())
    mocked(getMultipartStatus).mockResolvedValue({
      id: "file-1",
      uploadId: "upload-1",
      size: 24,
      partSize: PART_SIZE,
      partCount: 3,
      uploadedParts: [1, 2],
      uploadedBytes: 16,
    })
    mocked(fetchPartUrls).mockResolvedValue({
      expiresAt: "2026-08-30T13:00:00.000Z",
      parts: [part(3)],
    })

    const result = await upload.upload(bigFile(3), "docs")

    // Чего не хватает, знает S3, а не клиент: досылается ровно третья часть.
    expect(mocked(fetchPartUrls)).toHaveBeenCalledWith(
      "file-1",
      [3],
      expect.anything(),
    )
    expect(sentPartNumbers()).toEqual([1, 2, 3, 3])
    expect(mocked(completeUpload)).toHaveBeenCalledTimes(2)
    expect(result.status).toBe("ready")
  })

  it("не трогает загрузку, если сорвалось только подтверждение", async () => {
    mocked(presignUpload).mockResolvedValue(plan(2))
    mocked(completeUpload).mockRejectedValue(
      new ApiError(502, "STORAGE_ERROR", "S3 отказал"),
    )

    await expect(upload.upload(bigFile(2), "docs")).rejects.toThrow(ApiError)

    // Части на месте — повторный complete ещё соберёт объект, DELETE их бы снёс.
    expect(mocked(deleteFile)).not.toHaveBeenCalled()
  })
})

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
    })

    await upload.upload(bigFile(1), "docs")

    expect(mocked(putPart)).not.toHaveBeenCalled()
    expect(mocked(completeUpload)).toHaveBeenCalledWith("file-2")
  })
})
