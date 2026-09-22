import { AppError, ERROR_CODES, badRequest, conflict, tooManyRequests } from "../../errors.js";
import { logger } from "../../logger.js";
import type { CompleteOutcome, ObjectStore } from "../../storage/object-store.js";
import type { FileRowsForMultipart } from "./file-rows.js";
import { expiresAt, reserveKey } from "./reservation.js";
import { partRange, planMultipart } from "./upload-plan.js";
import type { UploadPlan } from "./upload-plan.js";
import type { UploadPolicy } from "./upload-policy.js";
import type { FileRow, MultipartPartDto, PresignMultipartResult } from "./files.types.js";
import type { PartUrlsBody } from "./files.schemas.js";

export interface MultipartModuleDeps {
  objectStore: ObjectStore;
  fileRows: FileRowsForMultipart;
  policy: UploadPolicy;
  /**
   * Recorded on every row, so a row keeps saying where its object was put. It is
   * provenance only: every call goes to the bucket the object store was built
   * with, so a deployment that moves buckets does not reach its old rows through
   * this service. The assembly hands the same name to both.
   */
  bucket: string;
}

export interface MultipartStatus {
  id: string;
  uploadId: string;
  size: number | null;
  partSize: number | null;
  partCount: number | null;
  uploadedParts: number[];
  uploadedBytes: number;
}

export interface MultipartModule {
  createMultipartUpload(body: {
    filename: string;
    directory?: string | undefined;
    contentType?: string | undefined;
    size: number;
  }): Promise<PresignMultipartResult>;

  createPartUrls(
    file: FileRow,
    body: PartUrlsBody,
  ): Promise<{ expiresAt: string; parts: MultipartPartDto[] }>;

  getMultipartStatus(file: FileRow): Promise<MultipartStatus>;

  /**
   * Assembles the object from the parts storage reports, and says which of the
   * two things happened. `"gone"` means the upload was no longer there — a lost
   * response or a concurrent confirmation — and the caller settles it by reading
   * the object, exactly as it does for a single PUT.
   */
  completeMultipartUpload(file: FileRow): Promise<CompleteOutcome>;
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

/**
 * The plan as recorded when the upload was opened, so part ranges are never
 * recomputed differently. A live upload without one is not a case to recover
 * from by arithmetic — the row is impossible, the database forbids it, and
 * guessing the boundaries would hand the client ranges that do not match the
 * parts already stored.
 */
function requirePlan(file: FileRow): UploadPlan {
  const { size_bytes: size, part_size: partSize, part_count: partCount } = file;

  if (size === null || partSize === null || partCount === null) {
    throw new AppError(
      500,
      ERROR_CODES.INTERNAL_SERVER_ERROR,
      "An unexpected error occurred",
      undefined,
      {
        logContext: {
          reason: "A live multipart upload carries no plan",
          id: file.id,
          key: file.object_key,
          size,
          partSize,
          partCount,
        },
      },
    );
  }

  return { size, partSize, partCount, lastPartSize: size - (partCount - 1) * partSize };
}

export function createMultipartModule({
  objectStore,
  fileRows,
  policy,
  bucket,
}: MultipartModuleDeps): MultipartModule {
  async function signParts(
    key: string,
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
        url: await objectStore.signPart(key, uploadId, partNumber, {
          expiresIn: policy.presignPartTtlSeconds,
        }),
      })),
    );
  }

  return {
    async createMultipartUpload(body): Promise<PresignMultipartResult> {
      const { id, key, directory, originalName, extension, contentType } = reserveKey(body);

      // Both of these refuse before anything exists in storage to roll back.
      const plan = planMultipart(body.size, policy.planLimits);
      const active = await fileRows.countActiveMultipart();

      if (active >= policy.maxActiveUploads) {
        throw tooManyRequests(
          ERROR_CODES.TOO_MANY_ACTIVE_UPLOADS,
          "Too many multipart uploads are already in progress; finish or cancel one first",
          { active, limit: policy.maxActiveUploads },
        );
      }

      const uploadId = await objectStore.beginMultipart(key, { contentType });

      try {
        const batch = Math.min(plan.partCount, policy.partUrlBatch);
        const parts = await signParts(
          key,
          uploadId,
          plan,
          Array.from({ length: batch }, (_, index) => index + 1),
        );

        await fileRows.insertFile({
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
          maxConcurrency: policy.maxConcurrency,
          expiresAt: expiresAt(policy.presignPartTtlSeconds),
          parts,
        };
      } catch (error) {
        // Unlike the single-PUT flow, opening the upload is a side effect:
        // without this the bucket keeps an upload nobody can reach, and storage
        // bills for the parts that land in it.
        await objectStore.abortMultipart(key, uploadId).catch((cleanupError: unknown) => {
          logger.error(
            { err: cleanupError, id, key, uploadId },
            "Failed to abort multipart upload after its metadata row could not be written",
          );
        });

        throw error;
      }
    },

    async createPartUrls(file, body) {
      const uploadId = requireLiveUpload(file);
      const plan = requirePlan(file);

      // Both bounds on a part number live here: how many may be asked for at
      // once, and whether each one exists in this upload's plan. The cap is on
      // the request as sent, before duplicates are dropped — it is what bounds
      // the work of reading the request, not just the signing that follows.
      if (body.partNumbers.length > policy.partUrlBatch) {
        throw badRequest(
          ERROR_CODES.INVALID_PART_NUMBER,
          `At most ${policy.partUrlBatch} part URLs can be signed in one request`,
          { maxBatch: policy.partUrlBatch },
        );
      }

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
        expiresAt: expiresAt(policy.presignPartTtlSeconds),
        parts: await signParts(file.object_key, uploadId, plan, partNumbers),
      };
    },

    async getMultipartStatus(file): Promise<MultipartStatus> {
      const uploadId = requireLiveUpload(file);
      const plan = requirePlan(file);
      const parts = await objectStore.listParts(file.object_key, uploadId);

      if (!parts) {
        throw conflict(
          ERROR_CODES.MULTIPART_NOT_FOUND,
          `Object storage has no multipart upload for file ${file.id}`,
        );
      }

      return {
        id: file.id,
        uploadId,
        size: plan.size,
        partSize: plan.partSize,
        partCount: plan.partCount,
        uploadedParts: parts.map((part) => part.partNumber),
        uploadedBytes: parts.reduce((total, part) => total + part.size, 0),
      };
    },

    async completeMultipartUpload(file): Promise<CompleteOutcome> {
      const uploadId = requireLiveUpload(file);
      const plan = requirePlan(file);
      // The part list comes from storage rather than from the client, so the
      // result reflects the bytes that were actually stored.
      const parts = await objectStore.listParts(file.object_key, uploadId);

      if (!parts) {
        return "gone"; // Already assembled, or never existed; the object decides.
      }

      if (parts.length !== plan.partCount) {
        throw conflict(
          ERROR_CODES.MULTIPART_INCOMPLETE,
          "Not every part has been uploaded yet; upload the missing parts before completing",
          { uploaded: parts.length, expected: plan.partCount },
        );
      }

      return await objectStore.completeMultipart(file.object_key, uploadId, parts);
    },
  };
}
