import type {
  DownloadUrlResponse,
  FileDto,
  ListFilesResponse,
  ListStatusFilter,
  MultipartStatusResponse,
  PartUrlsResponse,
  PresignUploadResponse,
  SortField,
  SortOrder,
} from "@/types/api"
import type { UploadOptions } from "./client"
import {
  ApiError,
  apiRequest,
  apiUpload,
  buildQuery,
  isAbortError,
  parseErrorBody,
  xhrSend,
} from "./client"

export interface ListFilesParams {
  directory?: string
  recursive?: boolean
  search?: string
  status?: ListStatusFilter
  page?: number
  limit?: number
  sort?: SortField
  order?: SortOrder
}

export function listFiles(
  params: ListFilesParams,
  signal?: AbortSignal,
): Promise<ListFilesResponse> {
  return apiRequest<ListFilesResponse>(`/files${buildQuery({ ...params })}`, { signal })
}

export function getFile(id: string, withUrl = false): Promise<FileDto> {
  return apiRequest<FileDto>(`/files/${id}${buildQuery({ withUrl })}`)
}

/** `options` даёт прогресс отправки и отмену: тело уходит через XHR, а не fetch. */
export function uploadViaServer(
  file: File,
  directory: string,
  options?: UploadOptions,
): Promise<FileDto> {
  const form = new FormData()

  // Имя поля ровно "file" — его ждёт `upload.single("file")` на сервере.
  form.append("file", file)
  form.append("directory", directory)

  // Content-Type намеренно не задаём: его вместе с boundary проставит браузер.
  return apiUpload<FileDto>("/files", form, options)
}

export function presignUpload(
  body: {
    filename: string
    directory?: string
    contentType?: string
    size?: number
  },
  signal?: AbortSignal,
): Promise<PresignUploadResponse> {
  return apiRequest<PresignUploadResponse>("/files/presign-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
}

/**
 * Голый XHR в обход `apiRequest`: это чужой origin (S3), туда не идут ни
 * `X-API-Key`, ни credentials. Заголовки — РОВНО те, что попали в подпись:
 * любой лишний браузеру пришлось бы воспроизвести байт-в-байт.
 */
async function putToS3(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  options: UploadOptions,
): Promise<void> {
  let response: { status: number; text: string }

  try {
    response = await xhrSend("PUT", url, body, { ...options, headers })
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }

    // Непрозрачный CORS-сбой приходит сюда же: подсказка про порт лежит в errors.ts.
    throw new ApiError(0, "S3_UPLOAD_FAILED", "Не удалось отправить файл в хранилище")
  }

  if (response.status < 200 || response.status >= 300) {
    const { message, details } = parseErrorBody(response.status, response.text)

    throw new ApiError(response.status, "S3_UPLOAD_FAILED", message, details)
  }
}

/** Весь файл одним PUT: заголовки берутся из `requiredHeaders` ответа сервера. */
export function putToPresignedUrl(
  url: string,
  file: File,
  headers: Record<string, string>,
  options: UploadOptions = {},
): Promise<void> {
  return putToS3(url, file, headers, options)
}

/**
 * Одна часть multipart-загрузки. Заголовков нет ни одного, и это не упущение:
 * сервер подписывает часть голой (`Bucket`, `Key`, `UploadId`, `PartNumber`), а
 * Content-Type объекта зафиксирован ещё при открытии загрузки. Срез
 * `file.slice()` отдаёт Blob с пустым `type`, поэтому Content-Type браузер тоже
 * не подставит — подпись сходится.
 */
export function putPart(
  url: string,
  part: Blob,
  options: UploadOptions = {},
): Promise<void> {
  return putToS3(url, part, {}, options)
}

/**
 * Следующая пачка ссылок на части — и она же способ заменить протухшую: подписи
 * живут `PRESIGN_PART_TTL_SECONDS`, а загрузка может идти дольше. Больше
 * `MULTIPART_URL_BATCH` номеров за раз сервер не примет (422).
 */
export function fetchPartUrls(
  id: string,
  partNumbers: number[],
  signal?: AbortSignal,
): Promise<PartUrlsResponse> {
  return apiRequest<PartUrlsResponse>(`/files/${id}/multipart/part-urls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ partNumbers }),
    signal,
  })
}

/** Что из частей реально долетело: ответ строится по `ListParts`, а не по базе. */
export function getMultipartStatus(
  id: string,
  signal?: AbortSignal,
): Promise<MultipartStatusResponse> {
  return apiRequest<MultipartStatusResponse>(`/files/${id}/multipart`, { signal })
}

export function completeUpload(id: string): Promise<FileDto> {
  return apiRequest<FileDto>(`/files/${id}/complete`, { method: "POST" })
}

export function getDownloadUrl(
  id: string,
  disposition: "attachment" | "inline" = "attachment",
): Promise<DownloadUrlResponse> {
  return apiRequest<DownloadUrlResponse>(
    `/files/${id}/download-url${buildQuery({ disposition })}`,
  )
}

export function deleteFile(id: string): Promise<void> {
  // 204 без тела — `apiRequest` возвращает undefined, не пытаясь его парсить.
  return apiRequest<void>(`/files/${id}`, { method: "DELETE" })
}
