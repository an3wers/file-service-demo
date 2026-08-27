import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../../config.js";
import { conflict, notFound } from "../../errors.js";
import { logger } from "../../logger.js";
import { bucket, s3 } from "../../s3/client.js";
import {
  buildObjectKey,
  contentDisposition,
  decodeOriginalName,
  normalizeDirectory,
  sanitizeFileName,
} from "../../s3/keys.js";
import { toFileDto } from "./files.mapper.js";
import * as repo from "./files.repo.js";
import type {
  DirectoryDto,
  FileDto,
  FileRow,
  ListFilesParams,
} from "./files.types.js";
import type {
  DownloadUrlQuery,
  ListFilesQuery,
  PresignUploadBody,
} from "./files.schemas.js";

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

async function requireFile(id: string): Promise<FileRow> {
  const file = await repo.findFileById(id);

  if (!file) {
    throw notFound("FILE_NOT_FOUND", `File ${id} was not found`);
  }

  return file;
}

function expiresAt(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function presignDownload(
  file: FileRow,
  options: { disposition: "attachment" | "inline"; expiresIn: number },
): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: file.bucket,
      Key: file.object_key,
      ResponseContentType: file.content_type,
      ResponseContentDisposition: contentDisposition(
        file.original_name,
        options.disposition,
      ),
    }),
    { expiresIn: options.expiresIn },
  );
}

/** Upload proxied through the server: the request body is already in memory. */
export async function uploadThroughServer(
  file: Express.Multer.File,
  rawDirectory: string | undefined,
): Promise<FileDto> {
  const directory = normalizeDirectory(rawDirectory);
  const originalName = sanitizeFileName(decodeOriginalName(file.originalname));
  const { id, key, extension } = buildObjectKey(directory, originalName);
  const contentType = file.mimetype || DEFAULT_CONTENT_TYPE;

  const result = await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: file.buffer,
      ContentType: contentType,
      ContentLength: file.size,
    }),
  );

  try {
    const row = await repo.insertFile({
      id,
      bucket,
      objectKey: key,
      directory,
      originalName,
      extension,
      contentType,
      sizeBytes: file.size,
      etag: result.ETag ?? null,
      status: "ready",
      uploadSource: "server",
    });

    return toFileDto(row);
  } catch (error) {
    // The object is already in S3 but has no metadata row, so nothing can ever
    // reach it again. Roll the storage side back rather than leak an orphan.
    await s3
      .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
      .catch((cleanupError: unknown) => {
        logger.error(
          { err: cleanupError, key },
          "Failed to remove orphaned object after metadata insert failed",
        );
      });

    throw error;
  }
}

/**
 * Reserves an id, key and metadata row, then hands back a URL the client can
 * PUT to directly. The row stays `pending` until `completeUpload` confirms the
 * object actually landed.
 */
export async function createPresignedUpload(body: PresignUploadBody): Promise<{
  id: string;
  key: string;
  directory: string;
  uploadUrl: string;
  expiresAt: string;
  requiredHeaders: Record<string, string>;
}> {
  const directory = normalizeDirectory(body.directory);
  const originalName = sanitizeFileName(body.filename);
  const { id, key, extension } = buildObjectKey(directory, originalName);
  const contentType = body.contentType ?? DEFAULT_CONTENT_TYPE;
  const ttl = config.uploads.presignUploadTtlSeconds;

  await repo.insertFile({
    id,
    bucket,
    objectKey: key,
    directory,
    originalName,
    extension,
    contentType,
    sizeBytes: body.size ?? null,
    etag: null,
    status: "pending",
    uploadSource: "presigned",
  });

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn: ttl },
  );

  return {
    id,
    key,
    directory,
    uploadUrl,
    expiresAt: expiresAt(ttl),
    // The signature covers Content-Type, so the client must send it verbatim.
    requiredHeaders: { "Content-Type": contentType },
  };
}

/**
 * Confirms a presigned upload against S3 itself. Size and ETag come from
 * HeadObject rather than from the client, so the metadata reflects the bytes
 * that were actually stored.
 */
export async function completeUpload(id: string): Promise<FileDto> {
  const file = await requireFile(id);

  if (file.status === "ready") {
    return toFileDto(file); // Idempotent: a retried confirmation is not an error.
  }

  let head;

  try {
    head = await s3.send(
      new HeadObjectCommand({ Bucket: file.bucket, Key: file.object_key }),
    );
  } catch (error) {
    if (error instanceof NotFound || (error as { name?: string }).name === "NotFound") {
      throw conflict(
        "UPLOAD_NOT_COMPLETED",
        "No object was found at the reserved key; upload the file before confirming",
        { key: file.object_key },
      );
    }

    throw error;
  }

  const row = await repo.markFileReady(id, {
    sizeBytes: head.ContentLength ?? null,
    etag: head.ETag ?? null,
    contentType: head.ContentType ?? file.content_type,
  });

  if (!row) {
    throw notFound("FILE_NOT_FOUND", `File ${id} was not found`);
  }

  return toFileDto(row);
}

export async function getDownloadUrl(
  id: string,
  query: DownloadUrlQuery,
): Promise<{ url: string; expiresAt: string; name: string }> {
  const file = await requireFile(id);

  if (file.status !== "ready") {
    throw conflict(
      "FILE_NOT_READY",
      `File ${id} is in status "${file.status}" and cannot be downloaded yet`,
    );
  }

  const expiresIn = query.expiresIn ?? config.uploads.presignDownloadTtlSeconds;

  return {
    url: await presignDownload(file, { disposition: query.disposition, expiresIn }),
    expiresAt: expiresAt(expiresIn),
    name: file.original_name,
  };
}

export async function getFileCard(id: string, withUrl: boolean): Promise<FileDto> {
  const file = await requireFile(id);

  if (!withUrl || file.status !== "ready") {
    return toFileDto(file);
  }

  const url = await presignDownload(file, {
    disposition: "attachment",
    expiresIn: config.uploads.presignDownloadTtlSeconds,
  });

  return toFileDto(file, url);
}

export async function listFiles(query: ListFilesQuery): Promise<{
  items: FileDto[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const params: ListFilesParams = {
    recursive: query.recursive,
    page: query.page,
    limit: query.limit,
    sort: query.sort,
    order: query.order,
    ...(query.directory !== undefined
      ? { directory: normalizeDirectory(query.directory) }
      : {}),
    ...(query.search ? { search: query.search } : {}),
    ...(query.status !== "any" ? { status: query.status } : {}),
  };

  const { items, total } = await repo.listFiles(params);

  return {
    items: items.map((row) => toFileDto(row)),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}

export async function deleteFile(id: string): Promise<void> {
  // The metadata row is the source of truth, so retire it first; a failed
  // storage delete then only leaves an unreferenced object behind.
  const file = await repo.softDeleteFile(id);

  if (!file) {
    throw notFound("FILE_NOT_FOUND", `File ${id} was not found`);
  }

  try {
    await s3.send(
      new DeleteObjectCommand({ Bucket: file.bucket, Key: file.object_key }),
    );
  } catch (error) {
    logger.error(
      { err: error, id, key: file.object_key },
      "File marked deleted but the S3 object could not be removed",
    );
  }
}

export async function listDirectories(
  rawParent: string | undefined,
): Promise<{ parent: string; items: DirectoryDto[] }> {
  const parent = normalizeDirectory(rawParent);

  return { parent, items: await repo.listChildDirectories(parent) };
}
