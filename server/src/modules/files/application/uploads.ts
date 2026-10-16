import { logger } from "../../../logger.js";
import { randomUUID } from "node:crypto";
import type {
  UploadOperations,
  UploadOperationRecord,
  UploadOperationFileRows,
  UploadOperationSession,
} from "../domain/ports/upload-operations.js";
import {
  UploadOperationConflictError,
  UploadOperationProcessingError,
} from "../domain/errors.js";
import { normalizeDirectory } from "../domain/keys.js";
import { requireDirectory } from "../domain/directories.js";
import type { DirectoriesForUpload } from "../domain/ports/directories.js";
import type { Clock } from "../domain/ports/clock.js";
import {
  FileNotFoundError,
  MultipartNotFoundError,
  UploadNotCompletedError,
} from "../domain/errors.js";
import type { FileRowsForFiles } from "../domain/ports/file-rows.js";
import type { ObjectStoreForFiles } from "../domain/ports/object-storage.js";
import type {
  MultipartModule,
  MultipartStatus,
  PartUrlsInput,
  PartUrlsResult,
  PresignMultipartResult,
} from "./multipart.js";
import { expiresAt, reserveKey } from "../domain/reservation.js";
import { needsMultipart } from "../domain/upload-plan.js";
import type { StoredFile } from "../domain/stored-file.js";
import type { UploadPolicy } from "../domain/upload-policy.js";

export interface UploadsModuleDeps {
  operations: UploadOperations;
  objectStore: ObjectStoreForFiles;
  directories: DirectoriesForUpload;
  fileRows: FileRowsForFiles;
  policy: UploadPolicy;
  /** Multipart is a separate module this one drives, not a branch inside it. */
  multipart: MultipartModule;
  /** The wall clock a reservation's `expiresAt` reads, shared with every other scenario. */
  clock: Clock;
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
  | {
      status:
        | "absent"
        | "failed"
        | "processing"
        | "deleted"
        | "cancelled"
        | "discarded";
    };

export interface UploadsModule {
  failUploadOperation(id: string): Promise<UploadOperationResult>;
  sweepTerminated(): Promise<void>;
  cancelUploadOperation(id: string): Promise<UploadOperationResult>;
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

export function createUploadsModule({
  operations,
  objectStore,
  fileRows,
  directories,
  policy,
  multipart,
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
    rows: UploadOperationFileRows,
  ): Promise<UploadOperationResult> {
    const file = await rows.findFileById(record.reservation.id);
    if (!file)
      return {
        status: (await rows.isFileDeleted(record.reservation.id))
          ? "deleted"
          : "failed",
      };
    if (file.kind === "ready") return { status: "succeeded", file };
    const stored = await objectStore.head(file.key);
    if (!stored || (record.size !== null && stored.size !== record.size)) {
      return { status: "failed" };
    }
    const ready = await rows.markFileReady(file.id, {
      sizeBytes: stored.size,
      etag: stored.etag,
      contentType: stored.contentType ?? file.contentType,
    });
    return ready ? { status: "succeeded", file: ready } : { status: "deleted" };
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
    source: "server" | "presigned",
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

  async function complete(
    file: StoredFile,
    rows: Pick<FileRowsForFiles, "markFileReady">,
  ): Promise<StoredFile> {
    if (file.kind === "ready") return file;
    if (file.kind === "multipart")
      await multipart.completeMultipartUpload(file);
    const stored = await objectStore.head(file.key);
    if (!stored) {
      const message =
        "No object was found at the reserved key; upload the file before confirming";
      throw file.kind === "multipart"
        ? new MultipartNotFoundError(message, { key: file.key })
        : new UploadNotCompletedError(message, { key: file.key });
    }
    const expectedSize =
      file.kind === "multipart"
        ? file.plan.size
        : file.kind === "reserved"
          ? file.size
          : null;
    if (expectedSize !== null && stored.size !== expectedSize)
      throw new UploadNotCompletedError(
        "Размер загруженного файла не совпадает с ожидаемым",
      );
    const ready = await rows.markFileReady(file.id, {
      sizeBytes: stored.size,
      etag: stored.etag,
      contentType: stored.contentType ?? file.contentType,
    });
    if (!ready) throw fileNotFound(file.id);
    return ready;
  }

  async function dispose(
    session: UploadOperationSession,
  ): Promise<UploadOperationResult | null> {
    let termination = await session.termination();
    if (!termination) return null;
    const record = await session.read();
    if (record) {
      const file = await session.fileRows.findFileById(record.reservation.id);
      if (file?.kind === "multipart") {
        await session.terminate(termination.reason, file.uploadId);
        termination = (await session.termination())!;
      }
      await session.fileRows.markFileFailed(record.reservation.id);
      if (termination.uploadId)
        await objectStore.abortMultipart(
          record.reservation.key,
          termination.uploadId,
        );
      await objectStore.remove(record.reservation.key);
    }
    await session.checked();
    return {
      status:
        termination.reason === "failed" ? "discarded" : termination.reason,
    };
  }

  async function requireOpen(session: UploadOperationSession): Promise<void> {
    if (await session.termination()) {
      await dispose(session);
      throw new FileNotFoundError(
        "Операция завершена и больше не принимает данные",
      );
    }
  }

  return {
    async sweepTerminated() {
      for (const id of await operations.listTerminated()) {
        try {
          await operations.exclusive(id, async (session) => {
            try {
              return await dispose(session);
            } finally {
              await session.checked();
            }
          });
        } catch (error) {
          logger.error(
            { err: error, operationId: id },
            "Не удалось очистить завершённую загрузку",
          );
        }
      }
    },
    async getUploadOperation(id) {
      return (
        (await operations.exclusive(id, async (session) => {
          const disposed = await dispose(session);
          if (disposed) return disposed;
          const record = await session.read();
          return record
            ? await resolveOperation(record, session.fileRows)
            : { status: "absent" as const };
        })) ?? { status: "processing" }
      );
    },

    async cancelUploadOperation(id) {
      await operations.terminate(id, "cancelled");
      return (
        (await operations.exclusive(id, dispose)) ?? { status: "processing" }
      );
    },

    async failUploadOperation(id) {
      return (
        (await operations.exclusive(id, async (session) => {
          const disposed = await dispose(session);
          if (disposed) return disposed;
          const record = await session.read();
          if (record) {
            const outcome = await resolveOperation(record, session.fileRows);
            if (outcome.status === "succeeded" || outcome.status === "deleted")
              return outcome;
          }
          await session.terminate("failed");
          return (await dispose(session))!;
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
          const outcome = await resolveOperation(record, session.fileRows);
          if (outcome.status === "succeeded") return outcome.file;
          if (outcome.status === "deleted")
            throw fileNotFound(record.reservation.id);
          const file = await session.fileRows.findFileById(
            record.reservation.id,
          );
          if (file?.kind === "multipart")
            await objectStore.abortMultipart(file.key, file.uploadId);
          await session.fileRows.reserveFile(pendingInput(record, "server"));
          const { key, contentType, id } = record.reservation;
          const { etag } = await objectStore.put(key, input.bytes, {
            contentType,
            contentLength: input.size,
          });
          await requireOpen(session);
          const ready = await session.fileRows.markFileReady(id, {
            sizeBytes: input.size,
            etag,
            contentType,
          });
          if (!ready) throw fileNotFound(id);
          return ready;
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
          const outcome = await resolveOperation(record, session.fileRows);
          if (outcome.status === "succeeded")
            return {
              strategy: "ready",
              directory: outcome.file.directory,
              id: outcome.file.id,
              key: outcome.file.key,
              file: outcome.file,
            };
          if (outcome.status === "deleted")
            throw fileNotFound(record.reservation.id);
          const file = await session.fileRows.findFileById(
            record.reservation.id,
          );
          if (file?.kind === "multipart") {
            try {
              return await multipart.resumeMultipartUpload(file);
            } catch (error) {
              if (!(error instanceof MultipartNotFoundError)) throw error;
              await session.fileRows.reserveFile(
                pendingInput(record, "presigned", "failed"),
              );
            }
          }
          if (needsMultipart(input.size, policy.multipartThresholdBytes)) {
            const result = await multipart.createMultipartUpload(
              { ...input, size: input.size! },
              record.reservation,
              session.fileRows,
            );
            await requireOpen(session);
            return result;
          }
          const { id, key, directory, contentType } = record.reservation;
          const ttl = policy.presignUploadTtlSeconds;
          const uploadUrl = await objectStore.signUpload(key, {
            contentType,
            expiresIn: ttl,
          });
          await session.fileRows.reserveFile(pendingInput(record, "presigned"));
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
          return await multipart.createPartUrls(file, input);
        });
      return await multipart.createPartUrls(await requireFile(id), input);
    },

    /** Which parts storage already holds, so an interrupted upload can resume. */
    async getMultipartStatus(id) {
      return await multipart.getMultipartStatus(await requireFile(id));
    },

    async completeUpload(id) {
      const operationId = await operations.findIdByFileId(id);
      if (!operationId) return await complete(await requireFile(id), fileRows);
      return await exclusive(
        operationId,
        async (session) => {
          await requireOpen(session);
          const file = await session.fileRows.findFileById(id);
          if (!file) throw fileNotFound(id);
          const result = await complete(file, session.fileRows);
          await requireOpen(session);
          return result;
        },
        true,
      );
    },
  };
}
