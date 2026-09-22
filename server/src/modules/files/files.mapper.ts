import type { FileDto } from "./files.types.js";
import type { StoredFile } from "./stored-file.js";
import { statusOf } from "./stored-file.js";

function sizeOf(file: StoredFile): number | null {
  switch (file.kind) {
    case "reserved":
    case "ready":
      return file.size;
    case "multipart":
      return file.plan.size;
    case "failed":
      return null;
  }
}

function etagOf(file: StoredFile): string | null {
  return file.kind === "ready" ? file.etag : null;
}

export function toFileDto(file: StoredFile, downloadUrl?: string): FileDto {
  return {
    id: file.id,
    name: file.originalName,
    directory: file.directory,
    extension: file.extension,
    contentType: file.contentType,
    size: sizeOf(file),
    etag: etagOf(file),
    status: statusOf(file),
    uploadSource: file.uploadSource,
    bucket: file.bucket,
    key: file.key,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
    ...(downloadUrl ? { downloadUrl } : {}),
  };
}
