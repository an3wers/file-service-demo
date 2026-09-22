export type FileStatus = "pending" | "ready" | "failed";
export type UploadSource = "server" | "presigned" | "multipart";

export interface FileRow {
  id: string;
  bucket: string;
  object_key: string;
  directory: string;
  original_name: string;
  extension: string;
  content_type: string;
  size_bytes: number | null;
  etag: string | null;
  status: FileStatus;
  upload_source: UploadSource;
  /** Set only while a multipart upload is in flight; cleared once it settles. */
  upload_id: string | null;
  part_size: number | null;
  part_count: number | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface FileDto {
  id: string;
  name: string;
  directory: string;
  extension: string;
  contentType: string;
  size: number | null;
  etag: string | null;
  status: FileStatus;
  uploadSource: UploadSource;
  bucket: string;
  key: string;
  createdAt: string;
  updatedAt: string;
  downloadUrl?: string;
}

/** No `bucket` field: the row writer fills that column from its own construction, not per call. */
export interface InsertFileInput {
  id: string;
  objectKey: string;
  directory: string;
  originalName: string;
  extension: string;
  contentType: string;
  sizeBytes: number | null;
  etag: string | null;
  status: FileStatus;
  uploadSource: UploadSource;
  uploadId?: string | null;
  partSize?: number | null;
  partCount?: number | null;
}

export interface MultipartPartDto {
  partNumber: number;
  /** Byte range in the source file: the client slices exactly this. */
  offset: number;
  size: number;
  url: string;
}

export interface PresignSingleResult {
  strategy: "single";
  id: string;
  key: string;
  directory: string;
  uploadUrl: string;
  expiresAt: Date;
  requiredHeaders: Record<string, string>;
}

export interface PresignMultipartResult {
  strategy: "multipart";
  id: string;
  key: string;
  directory: string;
  uploadId: string;
  size: number;
  partSize: number;
  partCount: number;
  /** How many parts the client may keep in flight; the server owns this number. */
  maxConcurrency: number;
  expiresAt: Date;
  parts: MultipartPartDto[];
}

export type PresignUploadResult = PresignSingleResult | PresignMultipartResult;

export interface ListFilesParams {
  directory?: string;
  recursive: boolean;
  search?: string;
  status?: FileStatus;
  page: number;
  limit: number;
  sort: "created_at" | "original_name" | "size_bytes";
  order: "asc" | "desc";
}

export interface DirectoryDto {
  name: string;
  path: string;
  fileCount: number;
}
