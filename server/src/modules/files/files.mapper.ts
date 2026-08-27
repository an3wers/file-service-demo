import type { FileDto, FileRow } from "./files.types.js";

export function toFileDto(row: FileRow, downloadUrl?: string): FileDto {
  return {
    id: row.id,
    name: row.original_name,
    directory: row.directory,
    extension: row.extension,
    contentType: row.content_type,
    size: row.size_bytes,
    etag: row.etag,
    status: row.status,
    uploadSource: row.upload_source,
    bucket: row.bucket,
    key: row.object_key,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(downloadUrl ? { downloadUrl } : {}),
  };
}
