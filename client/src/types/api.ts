/**
 * Зеркало `server/src/modules/files/files.types.ts`. Без `enum` — его запрещает
 * `erasableSyntaxOnly` в tsconfig.
 */

export type FileStatus = "pending" | "ready" | "failed"
export type UploadSource = "server" | "presigned"
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

export interface PresignUploadResponse {
  id: string
  key: string
  directory: string
  uploadUrl: string
  expiresAt: string
  /** Фактически `{ "Content-Type": string }` — эти заголовки входят в подпись. */
  requiredHeaders: Record<string, string>
}

export interface DownloadUrlResponse {
  url: string
  expiresAt: string
  name: string
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown }
}

/** Форма `details` у 422 VALIDATION_ERROR — это `z.flatten()`. */
export interface ValidationDetails {
  formErrors: string[]
  fieldErrors: Record<string, string[]>
}
