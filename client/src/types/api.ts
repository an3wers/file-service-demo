export type {
  DirectoriesResponse,
  DirectoryDto,
  DownloadUrlResponse,
  ErrorResponse as ApiErrorBody,
  FileDto,
  FileStatus,
  ListFilesResponse,
  ListStatusFilter,
  MultipartPartDto,
  MultipartStatusResponse,
  Pagination,
  PartUrlsResponse,
  PresignMultipartResponse,
  PresignSingleResponse,
  PresignUploadResponse,
  SortField,
  SortOrder,
  UploadSource,
} from "@/api/generated"

/** Форма `details` у 422 VALIDATION_ERROR — это `z.flattenError()`. */
export interface ValidationDetails {
  formErrors: string[]
  fieldErrors: Record<string, string[]>
}
