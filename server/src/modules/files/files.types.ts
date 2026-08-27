export type FileStatus = "pending" | "ready" | "failed";
export type UploadSource = "server" | "presigned";

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

export interface InsertFileInput {
  id: string;
  bucket: string;
  objectKey: string;
  directory: string;
  originalName: string;
  extension: string;
  contentType: string;
  sizeBytes: number | null;
  etag: string | null;
  status: FileStatus;
  uploadSource: UploadSource;
}

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
