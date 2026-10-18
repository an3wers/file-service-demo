import type { ConfirmationModule } from "./confirmation.js";
import { logger } from "../../../logger.js";
import { randomUUID } from "node:crypto";
import type {
  UploadOperations,
  UploadOperationRecord,
  UploadOperationSession,
} from "../domain/ports/upload-operations.js";
import {
  FileNotFoundError,
  InvalidPartNumberError,
  MultipartNotFoundError,
  TooManyActiveUploadsError,
  UploadOperationConflictError,
  UploadOperationProcessingError,
} from "../domain/errors.js";
import { normalizeDirectory } from "../domain/keys.js";
import { requireDirectory } from "../domain/directories.js";
import type { DirectoriesForUpload } from "../domain/ports/directories.js";
import type { Clock } from "../domain/ports/clock.js";
import type { FileRowsForFiles } from "../domain/ports/file-rows.js";
import type {
  ObjectStoreForFiles,
  ObjectStoreForMultipart,
} from "../domain/ports/object-storage.js";
import { expiresAt, reserveKey } from "../domain/reservation.js";
import {
  needsMultipart,
  partRange,
  planMultipart,
} from "../domain/upload-plan.js";
import { statusOf } from "../domain/stored-file.js";
import type { LiveMultipartUpload, StoredFile } from "../domain/stored-file.js";
import type { UploadPolicy } from "../domain/upload-policy.js";

export interface UploadsModuleDeps {
  confirmation: ConfirmationModule;
  operations: UploadOperations;
  objectStore: Pick<ObjectStoreForFiles, "put" | "signUpload"> &
    Pick<
      ObjectStoreForMultipart,
      "beginMultipart" | "signPart" | "listParts" | "abortMultipart"
    >;
  directories: DirectoriesForUpload;
  fileRows: FileRowsForFiles;
  policy: UploadPolicy;
  /** The wall clock a reservation's `expiresAt` reads, shared with every other scenario. */
  clock: Clock;
}

export interface MultipartPartDto {
  partNumber: number;
  /** Byte range in the source file: the client slices exactly this. */
  offset: number;
  size: number;
  url: string;
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

export interface PartUrlsInput {
  partNumbers: number[];
}

export interface PartUrlsResult {
  expiresAt: Date;
  parts: MultipartPartDto[];
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

export interface UploadThroughServerInput {
  operationId?: string | undefined;
  filename: string;
  directory?: string | undefined;
  contentType?: string | undefined;
  bytes: Buffer;
  size: number;
}

export interface CreatePresignedUploadInput {
  operationId?: string | undefined;
  filename: string;
  directory?: string | undefined;
  contentType?: string | undefined;
  size?: number | undefined;
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

export interface PresignReadyResult {
  strategy: "ready";
  directory: string;
  id: string;
  key: string;
  file: StoredFile;
}

export type PresignUploadResult =
  PresignSingleResult | PresignMultipartResult | PresignReadyResult;

export type UploadOperationResult =
  | { status: "succeeded"; file: StoredFile }
  | { status: "failed"; reason?: "size_mismatch" }
  | {
      status:
        | "pending"
        | "absent"
        | "processing"
        | "deleted"
        | "cancelled"
        | "discarded";
    };

export interface UploadsModule {
  failUploadOperation(id: string): Promise<UploadOperationResult>;
  sweepTerminated(): Promise<void>;
  cancelUploadOperation(id: string): Promise<UploadOperationResult>;
  resolveUploadOperation(
    id: string,
    stoppedUploadId?: string,
  ): Promise<UploadOperationResult>;
  getUploadOperation(id: string): Promise<UploadOperationResult>;
  uploadThroughServer(input: UploadThroughServerInput): Promise<StoredFile>;
  createPresignedUpload(
    input: CreatePresignedUploadInput,
  ): Promise<PresignUploadResult>;
  getPartUrls(id: string, input: PartUrlsInput): Promise<PartUrlsResult>;
  getMultipartStatus(id: string): Promise<MultipartStatus>;
  completeUpload(id: string): Promise<StoredFile>;
}

function fileNotFound(id: string) {
  return new FileNotFoundError(`File ${id} was not found`);
}

/** A file is only a live multipart upload while it is in that state. */
function requireLiveUpload(file: StoredFile): LiveMultipartUpload {
  if (file.kind !== "multipart") {
    throw new MultipartNotFoundError(
      `File ${file.id} has no multipart upload in progress`,
      {
        status: statusOf(file),
      },
    );
  }

  return file;
}

export function createUploadsModule({
  confirmation,
  operations,
  objectStore,
  fileRows,
  directories,
  policy,
  clock,
}: UploadsModuleDeps): UploadsModule {
  async function requireFile(id: string): Promise<StoredFile> {
    const file = await fileRows.findFileById(id);

    if (!file) {
      throw fileNotFound(id);
    }

    return file;
  }

  async function resolveOperation(
    record: UploadOperationRecord,
    session: UploadOperationSession,
  ): Promise<UploadOperationResult> {
    return await confirmation.reconcile(record.reservation.id, session);
  }

  async function exclusive<T>(
    id: string,
    run: (session: UploadOperationSession) => Promise<T>,
    wait = false,
  ): Promise<T> {
    const result = await operations.exclusive(id, run, wait);
    if (result === null)
      throw new UploadOperationProcessingError(
        "Upload operation is still processing",
      );
    return result;
  }

  async function requireOperation(
    session: UploadOperationSession,
    input: CreatePresignedUploadInput,
  ): Promise<UploadOperationRecord> {
    const reservation = reserveKey(input);
    const record = await session.read();
    if (record) {
      const previous = record.reservation;
      if (
        previous.originalName !== reservation.originalName ||
        previous.directory !== reservation.directory ||
        previous.contentType !== reservation.contentType ||
        record.size !== (input.size ?? null)
      ) {
        throw new UploadOperationConflictError(
          "Operation input differs from the original upload",
        );
      }
      return record;
    }
    const created = { reservation, size: input.size ?? null };
    await session.save(created);
    return created;
  }

  function pendingInput(
    record: UploadOperationRecord,
    source: "server" | "presigned" | "multipart",
    status: "pending" | "failed" = "pending",
  ) {
    const { id, key, directory, originalName, extension, contentType } =
      record.reservation;
    return {
      id,
      objectKey: key,
      directory,
      originalName,
      extension,
      contentType,
      sizeBytes: record.size,
      etag: null,
      status,
      uploadSource: source,
    };
  }

  async function signParts(
    {
      key,
      uploadId,
      plan,
    }: Pick<LiveMultipartUpload, "key" | "uploadId" | "plan">,
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

  async function presignMultipart(
    upload: Pick<
      LiveMultipartUpload,
      "id" | "key" | "directory" | "uploadId" | "plan"
    >,
  ): Promise<PresignMultipartResult> {
    const { id, key, directory, uploadId, plan } = upload;
    const parts = await signParts(
      upload,
      Array.from(
        { length: Math.min(plan.partCount, policy.partUrlBatch) },
        (_, index) => index + 1,
      ),
    );
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
      expiresAt: expiresAt(clock, policy.presignPartTtlSeconds),
      parts,
    };
  }

  async function startMultipart(
    record: UploadOperationRecord,
    size: number,
    session: UploadOperationSession,
  ): Promise<PresignMultipartResult> {
    const { id, key, directory, contentType } = record.reservation;

    // Both of these refuse before anything exists in storage to roll back.
    const plan = planMultipart(size, policy.planLimits);
    const active = await session.fileRows.countActiveMultipart();

    if (active >= policy.maxActiveUploads) {
      throw new TooManyActiveUploadsError(
        "Too many multipart uploads are already in progress; finish or cancel one first",
        { active, limit: policy.maxActiveUploads },
      );
    }

    const uploadId = await objectStore.beginMultipart(key, { contentType });

    try {
      const result = await presignMultipart({
        id,
        key,
        directory,
        uploadId,
        plan,
      });
      await session.fileRows.reserveFile({
        ...pendingInput(record, "multipart"),
        sizeBytes: plan.size,
        uploadId,
        partSize: plan.partSize,
        partCount: plan.partCount,
      });
      return result;
    } catch (error) {
      // Unlike the single-PUT flow, opening the upload is a side effect:
      // without this the bucket keeps an upload nobody can reach, and storage
      // bills for the parts that land in it.
      await objectStore
        .abortMultipart(key, uploadId)
        .catch((cleanupError: unknown) => {
          logger.error(
            { err: cleanupError, id, key, uploadId },
            "Failed to abort multipart upload after its metadata row could not be written",
          );
        });

      throw error;
    }
  }

  async function signPartBatch(
    file: StoredFile,
    { partNumbers: requested }: PartUrlsInput,
  ): Promise<PartUrlsResult> {
    const upload = requireLiveUpload(file);
    const { plan } = upload;

    // Both bounds on a part number live here: how many may be asked for at
    // once, and whether each one exists in this upload's plan. The cap is on
    // the request as sent, before duplicates are dropped — it is what bounds
    // the work of reading the request, not just the signing that follows.
    if (requested.length > policy.partUrlBatch) {
      throw new InvalidPartNumberError(
        `At most ${policy.partUrlBatch} part URLs can be signed in one request`,
        { maxBatch: policy.partUrlBatch },
      );
    }

    const partNumbers = [...new Set(requested)].sort((a, b) => a - b);

    for (const partNumber of partNumbers) {
      if (partNumber > plan.partCount) {
        throw new InvalidPartNumberError(
          `Part ${partNumber} is outside the 1..${plan.partCount} range of this upload`,
          { partCount: plan.partCount },
        );
      }
    }

    return {
      expiresAt: expiresAt(clock, policy.presignPartTtlSeconds),
      parts: await signParts(upload, partNumbers),
    };
  }

  async function requireOpen(session: UploadOperationSession): Promise<void> {
    if (await session.termination()) {
      await confirmation.cleanup(session);
      throw new FileNotFoundError(
        "Операция завершена и больше не принимает данные",
      );
    }
  }

  return {
    async sweepTerminated() {
      for (const id of await operations.listTerminated()) {
        try {
          await operations.exclusive(id, confirmation.cleanup);
        } catch (error) {
          logger.error(
            { err: error, operationId: id },
            "Не удалось очистить завершённую загрузку",
          );
        }
      }
    },
    async getUploadOperation(id) {
      const { record, termination } = await operations.read(id);
      if (termination)
        return {
          status:
            termination.reason === "failed" ? "discarded" : termination.reason,
        };
      if (!record) return { status: "absent" };
      const file = await fileRows.findFileById(record.reservation.id);
      if (!file)
        return {
          status: (await fileRows.isFileDeleted(record.reservation.id))
            ? "deleted"
            : "pending",
        };
      if (file.kind === "ready") return { status: "succeeded", file };
      return {
        status:
          file.kind === "failed" ||
          (file.kind === "multipart" &&
            record.stoppedMultipartUploadId === file.uploadId)
            ? "failed"
            : "pending",
      };
    },
    async resolveUploadOperation(id, stoppedUploadId) {
      return (
        (await operations.exclusive(id, async (session) => {
          const disposed = await confirmation.cleanup(session);
          if (disposed) return disposed;
          const record = await session.read();
          return record
            ? await confirmation.reconcile(
                record.reservation.id,
                session,
                stoppedUploadId,
              )
            : { status: "absent" as const };
        })) ?? { status: "processing" }
      );
    },

    async cancelUploadOperation(id) {
      await operations.terminate(id, "cancelled");
      return (
        (await operations.exclusive(id, confirmation.cleanup)) ?? {
          status: "processing",
        }
      );
    },

    async failUploadOperation(id) {
      return (
        (await operations.exclusive(id, async (session) => {
          const disposed = await confirmation.cleanup(session);
          if (disposed) return disposed;
          const record = await session.read();
          if (record) {
            const outcome = await resolveOperation(record, session);
            if (outcome.status !== "failed") return outcome;
          }
          await session.terminate("failed");
          return (await confirmation.cleanup(session))!;
        })) ?? { status: "processing" }
      );
    },

    async uploadThroughServer(input) {
      await requireDirectory(directories, normalizeDirectory(input.directory));
      return await exclusive(
        input.operationId ?? randomUUID(),
        async (session) => {
          await requireOpen(session);
          const record = await requireOperation(session, input);
          const outcome = await confirmation.prepareRetry(
            record.reservation.id,
            session,
          );
          if (outcome.status === "succeeded") return outcome.file;
          if (outcome.status === "pending")
            throw new UploadOperationProcessingError(
              "Результат загрузки ещё не установлен",
            );
          if (outcome.status !== "failed")
            throw fileNotFound(record.reservation.id);
          await session.fileRows.reserveFile(pendingInput(record, "server"));
          const { key, contentType, id } = record.reservation;
          await objectStore.put(key, input.bytes, {
            contentType,
            contentLength: input.size,
          });
          await requireOpen(session);
          return await confirmation.confirm(id, session);
        },
      );
    },

    async createPresignedUpload(input) {
      await requireDirectory(directories, normalizeDirectory(input.directory));
      return await exclusive(
        input.operationId ?? randomUUID(),
        async (session) => {
          await requireOpen(session);
          const record = await requireOperation(session, input);
          const outcome = await resolveOperation(record, session);
          if (outcome.status === "succeeded")
            return {
              strategy: "ready",
              directory: outcome.file.directory,
              id: outcome.file.id,
              key: outcome.file.key,
              file: outcome.file,
            };
          if (outcome.status !== "failed" && outcome.status !== "pending")
            throw fileNotFound(record.reservation.id);
          const file = await session.fileRows.findFileById(
            record.reservation.id,
          );
          if (file?.kind === "multipart") {
            if (await objectStore.listParts(file.key, file.uploadId)) {
              const resumed = await presignMultipart(file);
              await session.markMultipartStopped(null);
              return resumed;
            }
            await session.fileRows.reserveFile(
              pendingInput(record, "presigned", "failed"),
            );
          }
          if (needsMultipart(input.size, policy.multipartThresholdBytes)) {
            const result = await startMultipart(record, input.size!, session);
            await requireOpen(session);
            return result;
          }
          const { id, key, directory, contentType } = record.reservation;
          const ttl = policy.presignUploadTtlSeconds;
          const uploadUrl = await objectStore.signUpload(key, {
            contentType,
            expiresIn: ttl,
          });
          if (outcome.status !== "pending")
            await session.fileRows.reserveFile(
              pendingInput(record, "presigned"),
            );
          await requireOpen(session);
          return {
            strategy: "single",
            id,
            key,
            directory,
            uploadUrl,
            expiresAt: expiresAt(clock, ttl),
            requiredHeaders: { "Content-Type": contentType },
          };
        },
      );
    },

    /** A further batch of part URLs for an upload already in flight. */
    async getPartUrls(id, input) {
      const operationId = await operations.findIdByFileId(id);
      if (operationId)
        return await exclusive(operationId, async (session) => {
          await requireOpen(session);
          const file = await session.fileRows.findFileById(id);
          if (!file) throw fileNotFound(id);
          return await signPartBatch(file, input);
        });
      return await signPartBatch(await requireFile(id), input);
    },

    /** Which parts storage already holds, so an interrupted upload can resume. */
    async getMultipartStatus(id) {
      const { key, uploadId, plan } = requireLiveUpload(await requireFile(id));
      const parts = await objectStore.listParts(key, uploadId);

      if (!parts) {
        throw new MultipartNotFoundError(
          `Object storage has no multipart upload for file ${id}`,
        );
      }

      return {
        id,
        uploadId,
        size: plan.size,
        partSize: plan.partSize,
        partCount: plan.partCount,
        uploadedParts: parts.map((part) => part.partNumber),
        uploadedBytes: parts.reduce((total, part) => total + part.size, 0),
      };
    },

    async completeUpload(id) {
      const operationId = await operations.findIdByFileId(id);
      if (!operationId) return await confirmation.confirm(id);
      return await exclusive(
        operationId,
        async (session) => {
          await requireOpen(session);
          const file = await session.fileRows.findFileById(id);
          if (!file) throw fileNotFound(id);
          if (file.kind === "multipart")
            await session.markMultipartStopped(null);
          const result = await confirmation.confirm(id, session);
          await requireOpen(session);
          return result;
        },
        true,
      );
    },
  };
}
