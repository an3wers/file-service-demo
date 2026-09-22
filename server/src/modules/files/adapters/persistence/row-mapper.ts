import { AppError, ERROR_CODES } from "../../../../errors.js";
import type { StoredFile, FileStatus, UploadSource } from "../../domain/stored-file.js";

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

function impossibleRow(row: FileRow, reason: string): AppError {
  return new AppError(
    500,
    ERROR_CODES.INTERNAL_SERVER_ERROR,
    "An unexpected error occurred",
    undefined,
    {
      logContext: {
        reason,
        id: row.id,
        status: row.status,
        uploadId: row.upload_id,
        sizeBytes: row.size_bytes,
        partSize: row.part_size,
        partCount: row.part_count,
        etag: row.etag,
      },
    },
  );
}

function base(row: FileRow) {
  return {
    id: row.id,
    bucket: row.bucket,
    key: row.object_key,
    directory: row.directory,
    originalName: row.original_name,
    extension: row.extension,
    contentType: row.content_type,
    uploadSource: row.upload_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toStoredFile(row: FileRow): StoredFile {
  if (row.status === "ready") {
    if (row.upload_id !== null || row.part_size !== null || row.part_count !== null) {
      throw impossibleRow(row, "A ready file still carries a multipart upload");
    }

    return { ...base(row), kind: "ready", size: row.size_bytes, etag: row.etag };
  }

  if (row.status === "failed") {
    if (row.upload_id !== null) {
      throw impossibleRow(row, "A failed file still carries a live multipart upload");
    }

    return { ...base(row), kind: "failed" };
  }

  if (row.upload_id === null) {
    if (row.part_size !== null || row.part_count !== null) {
      throw impossibleRow(row, "A reservation carries a multipart plan without an upload id");
    }

    if (row.etag !== null) {
      throw impossibleRow(row, "A reservation carries an etag before any upload completed");
    }

    return { ...base(row), kind: "reserved", size: row.size_bytes };
  }

  if (row.size_bytes === null || row.part_size === null || row.part_count === null) {
    throw impossibleRow(row, "A live multipart upload carries no plan");
  }

  if (row.etag !== null) {
    throw impossibleRow(row, "A live multipart upload already carries an etag");
  }

  return {
    ...base(row),
    kind: "multipart",
    uploadId: row.upload_id,
    plan: {
      size: row.size_bytes,
      partSize: row.part_size,
      partCount: row.part_count,
      lastPartSize: row.size_bytes - (row.part_count - 1) * row.part_size,
    },
  };
}
