import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import type { Part } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../../config.js";
import { ERROR_CODES, badRequest, conflict, tooManyRequests } from "../../errors.js";
import { logger } from "../../logger.js";
import { bucket, s3 } from "../../s3/client.js";
import { isS3NoSuchUpload, storageError } from "../../s3/errors.js";
import { buildObjectKey, normalizeDirectory, sanitizeFileName } from "../../s3/keys.js";
import { partRange, planMultipart } from "../../s3/multipart.js";
import type { UploadPlan } from "../../s3/multipart.js";
import * as repo from "./files.repo.js";
import type { FileRow, MultipartPartDto, PresignMultipartResult } from "./files.types.js";
import type { PartUrlsBody } from "./files.schemas.js";

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

function expiresAt(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** A row is only a live multipart upload while it still carries an upload id. */
function requireLiveUpload(file: FileRow): string {
  if (!file.upload_id || file.status !== "pending") {
    throw conflict(
      ERROR_CODES.MULTIPART_NOT_FOUND,
      `File ${file.id} has no multipart upload in progress`,
      { status: file.status },
    );
  }

  return file.upload_id;
}

/** The plan as recorded at init, so part ranges never get recomputed differently. */
function storedPlan(file: FileRow): UploadPlan {
  const partSize = file.part_size ?? 0;
  const partCount = file.part_count ?? 0;
  const size = file.size_bytes ?? partSize * partCount;

  return { size, partSize, partCount, lastPartSize: size - (partCount - 1) * partSize };
}

/**
 * Signs one part URL. Deliberately bare: only what identifies the part goes into
 * the signature. Content-Type belongs to the object and is fixed by
 * CreateMultipartUpload; anything else signed here would have to be reproduced
 * by the browser byte for byte.
 */
async function signPart(
  file: { bucket: string; object_key: string; id: string },
  uploadId: string,
  partNumber: number,
): Promise<string> {
  try {
    return await getSignedUrl(
      s3,
      new UploadPartCommand({
        Bucket: file.bucket,
        Key: file.object_key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: config.uploads.presignPartTtlSeconds },
    );
  } catch (error) {
    throw storageError(error, {
      operation: "UploadPart(presign)",
      id: file.id,
      bucket: file.bucket,
      key: file.object_key,
      partNumber,
    });
  }
}

async function signParts(
  file: { bucket: string; object_key: string; id: string },
  uploadId: string,
  plan: UploadPlan,
  partNumbers: number[],
): Promise<MultipartPartDto[]> {
  // Signing is HMAC and never touches the network, so these run together; the
  // batch cap is what keeps the burst off the event loop for too long.
  return await Promise.all(
    partNumbers.map(async (partNumber) => ({
      partNumber,
      ...partRange(plan, partNumber),
      url: await signPart(file, uploadId, partNumber),
    })),
  );
}

/**
 * Every part S3 currently holds for this upload. Paginated on purpose: a page
 * carries at most 1000 parts, and an upload is allowed 10 000 of them.
 */
export async function listAllParts(
  file: FileRow,
  uploadId: string,
): Promise<Part[]> {
  const parts: Part[] = [];
  let marker: string | undefined;

  do {
    const page = await s3.send(
      new ListPartsCommand({
        Bucket: file.bucket,
        Key: file.object_key,
        UploadId: uploadId,
        PartNumberMarker: marker,
        MaxParts: 1000,
      }),
    );

    parts.push(...(page.Parts ?? []));
    // S3 returns parts in ascending PartNumber order and pages continue that
    // order, so the concatenation is already sorted for CompleteMultipartUpload.
    marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
  } while (marker);

  return parts;
}

/**
 * Reserves the key, opens the upload in S3 and hands back the split plan with a
 * first batch of signed URLs.
 */
export async function createMultipartUpload(body: {
  filename: string;
  directory?: string | undefined;
  contentType?: string | undefined;
  size: number;
}): Promise<PresignMultipartResult> {
  const directory = normalizeDirectory(body.directory);
  const originalName = sanitizeFileName(body.filename);
  const { id, key, extension } = buildObjectKey(directory, originalName);
  const contentType = body.contentType ?? DEFAULT_CONTENT_TYPE;

  // Both of these refuse before anything exists in S3 to roll back.
  const plan = planMultipart(body.size);
  const active = await repo.countActiveMultipart();

  if (active >= config.uploads.multipartMaxActiveUploads) {
    throw tooManyRequests(
      ERROR_CODES.TOO_MANY_ACTIVE_UPLOADS,
      "Too many multipart uploads are already in progress; finish or cancel one first",
      { active, limit: config.uploads.multipartMaxActiveUploads },
    );
  }

  let uploadId: string;

  try {
    const created = await s3.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    );

    if (!created.UploadId) {
      throw new Error("CreateMultipartUpload returned no UploadId");
    }

    uploadId = created.UploadId;
  } catch (error) {
    throw storageError(error, { operation: "CreateMultipartUpload", id, bucket, key });
  }

  try {
    const batch = Math.min(plan.partCount, config.uploads.multipartUrlBatch);
    const parts = await signParts(
      { bucket, object_key: key, id },
      uploadId,
      plan,
      Array.from({ length: batch }, (_, index) => index + 1),
    );

    await repo.insertFile({
      id,
      bucket,
      objectKey: key,
      directory,
      originalName,
      extension,
      contentType,
      sizeBytes: plan.size,
      etag: null,
      status: "pending",
      uploadSource: "multipart",
      uploadId,
      partSize: plan.partSize,
      partCount: plan.partCount,
    });

    return {
      strategy: "multipart",
      id,
      key,
      directory,
      uploadId,
      size: plan.size,
      partSize: plan.partSize,
      partCount: plan.partCount,
      maxConcurrency: config.uploads.multipartMaxConcurrency,
      expiresAt: expiresAt(config.uploads.presignPartTtlSeconds),
      parts,
    };
  } catch (error) {
    // Unlike the single-PUT flow, opening the upload is a side effect: without
    // this the bucket keeps an upload nobody can reach, and S3 bills for the
    // parts that land in it.
    await s3
      .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }))
      .catch((cleanupError: unknown) => {
        logger.error(
          { err: cleanupError, id, bucket, key, uploadId },
          "Failed to abort multipart upload after its metadata row could not be written",
        );
      });

    throw error;
  }
}

/** A further batch of part URLs, and the way an expired one is reissued. */
export async function createPartUrls(
  file: FileRow,
  body: PartUrlsBody,
): Promise<{ expiresAt: string; parts: MultipartPartDto[] }> {
  const uploadId = requireLiveUpload(file);
  const plan = storedPlan(file);
  const partNumbers = [...new Set(body.partNumbers)].sort((a, b) => a - b);

  for (const partNumber of partNumbers) {
    if (partNumber > plan.partCount) {
      throw badRequest(
        ERROR_CODES.INVALID_PART_NUMBER,
        `Part ${partNumber} is outside the 1..${plan.partCount} range of this upload`,
        { partCount: plan.partCount },
      );
    }
  }

  return {
    expiresAt: expiresAt(config.uploads.presignPartTtlSeconds),
    parts: await signParts(file, uploadId, plan, partNumbers),
  };
}

/** What S3 already holds, so an interrupted upload can pick up where it stopped. */
export async function getMultipartStatus(file: FileRow): Promise<{
  id: string;
  uploadId: string;
  size: number | null;
  partSize: number | null;
  partCount: number | null;
  uploadedParts: number[];
  uploadedBytes: number;
}> {
  const uploadId = requireLiveUpload(file);
  let parts: Part[];

  try {
    parts = await listAllParts(file, uploadId);
  } catch (error) {
    if (isS3NoSuchUpload(error)) {
      throw conflict(
        ERROR_CODES.MULTIPART_NOT_FOUND,
        `Object storage has no multipart upload for file ${file.id}`,
      );
    }

    throw storageError(error, {
      operation: "ListParts",
      id: file.id,
      bucket: file.bucket,
      key: file.object_key,
      uploadId,
    });
  }

  return {
    id: file.id,
    uploadId,
    size: file.size_bytes,
    partSize: file.part_size,
    partCount: file.part_count,
    uploadedParts: parts.map((part) => part.PartNumber ?? 0),
    uploadedBytes: parts.reduce((total, part) => total + (part.Size ?? 0), 0),
  };
}

/**
 * Assembles the object from the parts S3 reports. The part list comes from
 * `ListParts` rather than from the client, so the result reflects the bytes that
 * were actually stored.
 *
 * Returns `false` when the upload turned out to be gone but the object is there,
 * which is what a lost response or a concurrent `complete` looks like: the
 * caller then finishes with the same `HeadObject` path as any other upload.
 */
export async function completeMultipartUpload(file: FileRow): Promise<void> {
  const uploadId = requireLiveUpload(file);
  const context = {
    id: file.id,
    bucket: file.bucket,
    key: file.object_key,
    uploadId,
  };

  let parts: Part[];

  try {
    parts = await listAllParts(file, uploadId);
  } catch (error) {
    if (isS3NoSuchUpload(error)) {
      return; // Already assembled, or never existed; HeadObject decides which.
    }

    throw storageError(error, { operation: "ListParts", ...context });
  }

  if (parts.length === 0 || (file.part_count !== null && parts.length !== file.part_count)) {
    throw conflict(
      ERROR_CODES.MULTIPART_INCOMPLETE,
      "Not every part has been uploaded yet; upload the missing parts before completing",
      { uploaded: parts.length, expected: file.part_count },
    );
  }

  try {
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: file.bucket,
        Key: file.object_key,
        UploadId: uploadId,
        MultipartUpload: {
          // ETags go back exactly as S3 gave them, quotes included.
          Parts: parts.map((part) => ({
            PartNumber: part.PartNumber,
            ETag: part.ETag,
          })),
        },
      }),
    );
  } catch (error) {
    if (isS3NoSuchUpload(error)) {
      // Two `complete` calls raced. S3 settled it; the loser reads the winner's
      // result through HeadObject instead of failing.
      return;
    }

    throw storageError(error, { operation: "CompleteMultipartUpload", ...context });
  }
}

/** Cancels an upload in flight. The object does not exist yet — the parts do. */
export async function abortMultipartUpload(
  file: Pick<FileRow, "id" | "bucket" | "object_key">,
  uploadId: string,
): Promise<void> {
  try {
    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: file.bucket,
        Key: file.object_key,
        UploadId: uploadId,
      }),
    );
  } catch (error) {
    if (isS3NoSuchUpload(error)) {
      return; // Nothing left to cancel.
    }

    throw storageError(error, {
      operation: "AbortMultipartUpload",
      id: file.id,
      bucket: file.bucket,
      key: file.object_key,
      uploadId,
    });
  }
}
