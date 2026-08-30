/**
 * Зеркало `server/src/modules/files/files.types.ts`. Без `enum` — его запрещает
 * `erasableSyntaxOnly` в tsconfig.
 */

export type FileStatus = "pending" | "ready" | "failed"
export type UploadSource = "server" | "presigned" | "multipart"
export type SortField = "created_at" | "original_name" | "size_bytes"
export type SortOrder = "asc" | "desc"
export type ListStatusFilter = FileStatus | "any"

export interface FileDto {
  id: string
  name: string
  directory: string
  extension: string
  contentType: string
  /** null, пока presigned-загрузка не подтверждена через /complete. */
  size: number | null
  etag: string | null
  status: FileStatus
  uploadSource: UploadSource
  bucket: string
  key: string
  createdAt: string
  updatedAt: string
  /** Ключ отсутствует, а не равен null, когда запрошено без `withUrl`. */
  downloadUrl?: string
}

export interface DirectoryDto {
  name: string
  path: string
  fileCount: number
}

export interface Pagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

export interface ListFilesResponse {
  items: FileDto[]
  pagination: Pagination
}

export interface DirectoriesResponse {
  parent: string
  items: DirectoryDto[]
}

/**
 * Одна часть плана. `offset`/`size` считает сервер — клиент подставляет их прямо
 * в `file.slice(offset, offset + size)` и ничего не пересчитывает.
 */
export interface MultipartPartDto {
  partNumber: number
  offset: number
  size: number
  url: string
}

export interface PresignSingleResponse {
  strategy: "single"
  id: string
  key: string
  directory: string
  uploadUrl: string
  expiresAt: string
  /** Фактически `{ "Content-Type": string }` — эти заголовки входят в подпись. */
  requiredHeaders: Record<string, string>
}

export interface PresignMultipartResponse {
  strategy: "multipart"
  id: string
  key: string
  directory: string
  uploadId: string
  size: number
  partSize: number
  partCount: number
  /**
   * Сколько частей держать в полёте. Число назначает сервер: он один знает и
   * лимиты хранилища, и сколько загрузок идёт прямо сейчас. Своей константы у
   * клиента быть не должно — иначе потолок меняется только релизом фронтенда.
   */
  maxConcurrency: number
  /** Общий срок жизни всей пачки ссылок. */
  expiresAt: string
  /** Первая пачка — `min(partCount, MULTIPART_URL_BATCH)` ссылок. */
  parts: MultipartPartDto[]
}

/**
 * Стратегию выбирает сервер по присланному `size`; дискриминатор — `strategy`.
 * Ответ без него (сервер до multipart) разбирается как `single`, потому что
 * ветвление идёт по `strategy === "multipart"`.
 */
export type PresignUploadResponse = PresignSingleResponse | PresignMultipartResponse

export interface PartUrlsResponse {
  expiresAt: string
  parts: MultipartPartDto[]
}

/** Что реально лежит в S3: по нему догружаются недостающие части. */
export interface MultipartStatusResponse {
  id: string
  uploadId: string
  size: number | null
  partSize: number | null
  partCount: number | null
  uploadedParts: number[]
  uploadedBytes: number
}

export interface DownloadUrlResponse {
  url: string
  expiresAt: string
  name: string
}

export interface ApiErrorBody {
  /** `requestId` присваивает `pino-http` — по нему ошибка ищется в логе сервера. */
  error: { code: string; message: string; details?: unknown; requestId?: string | number }
}

/** Форма `details` у 422 VALIDATION_ERROR — это `z.flattenError()`. */
export interface ValidationDetails {
  formErrors: string[]
  fieldErrors: Record<string, string[]>
}
