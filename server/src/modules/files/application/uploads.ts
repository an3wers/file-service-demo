import type { ConfirmationModule } from "./confirmation.js";
import { logger } from "../../../logger.js";
import { randomUUID } from "node:crypto";
import type {
  ExclusiveOptions,
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
import { attemptDeadline, statusOf } from "../domain/stored-file.js";
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
  fileRows: FileRowsForFiles;
  policy: UploadPolicy;
  /** Общие для всех сценариев часы, по которым задаётся `expiresAt` резервирования. */
  clock: Clock;
}

export interface MultipartPartDto {
  partNumber: number;
  /** Диапазон байтов исходного файла, который клиент должен вырезать. */
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
  /** Число одновременно передаваемых клиентом частей задаёт сервер. */
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

/** Файл считается живой составной загрузкой только в соответствующем состоянии. */
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
    options: ExclusiveOptions = {},
  ): Promise<T> {
    const result = await operations.exclusive(id, run, options);
    if (result.busy)
      throw new UploadOperationProcessingError(
        "Upload operation is still processing",
      );
    return result.value;
  }

  async function orProcessing(
    id: string,
    run: (session: UploadOperationSession) => Promise<UploadOperationResult>,
  ): Promise<UploadOperationResult> {
    const result = await operations.exclusive(id, run);
    return result.busy ? { status: "processing" } : result.value;
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
      status: "pending" as const,
      uploadSource: source,
    };
  }

  function attemptExpired(file: StoredFile): boolean {
    return attemptDeadline(file, policy.pendingTtlHours) < clock.now();
  }

  function linkSeconds(attemptStartedAt: Date, seconds: number): number {
    const deadline = attemptDeadline(
      { attemptStartedAt },
      policy.pendingTtlHours,
    );
    // Ссылка не должна пережить попытку: после её срока уборка вправе
    // отменить загрузку. Округление вниз сохраняет эту границу.
    const left = Math.floor(
      (deadline.getTime() - clock.now().getTime()) / 1000,
    );
    if (left < 1)
      throw new UploadOperationProcessingError(
        "Срок попытки истекает; результат выяснит сверка",
      );
    return Math.min(seconds, left);
  }

  async function currentAttempt(
    id: string,
    session?: UploadOperationSession,
  ): Promise<StoredFile | null> {
    const rows = session?.fileRows ?? fileRows;
    const file = await rows.findFileById(id);
    if (!file || statusOf(file) !== "pending" || !attemptExpired(file))
      return file;
    await confirmation.reconcile(id, session);
    return await rows.findFileById(id);
  }

  async function signParts(
    {
      key,
      uploadId,
      plan,
    }: Pick<LiveMultipartUpload, "key" | "uploadId" | "plan">,
    partNumbers: number[],
    expiresIn: number,
  ): Promise<MultipartPartDto[]> {
    // Подписывание использует HMAC без сетевых запросов, поэтому запускается вместе;
    // ограничение размера пакета не даёт надолго занять цикл событий.
    return await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        ...partRange(plan, partNumber),
        url: await objectStore.signPart(key, uploadId, partNumber, {
          expiresIn,
        }),
      })),
    );
  }

  async function presignMultipart(
    upload: Pick<
      LiveMultipartUpload,
      "id" | "key" | "directory" | "uploadId" | "plan" | "attemptStartedAt"
    >,
  ): Promise<PresignMultipartResult> {
    const { id, key, directory, uploadId, plan } = upload;
    const ttl = linkSeconds(
      upload.attemptStartedAt,
      policy.presignPartTtlSeconds,
    );
    const parts = await signParts(
      upload,
      Array.from(
        { length: Math.min(plan.partCount, policy.partUrlBatch) },
        (_, index) => index + 1,
      ),
      ttl,
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
      expiresAt: expiresAt(clock, ttl),
      parts,
    };
  }

  async function startMultipart(
    record: UploadOperationRecord,
    size: number,
    session: UploadOperationSession,
  ): Promise<PresignMultipartResult> {
    const { id, key, directory, contentType } = record.reservation;

    // Обе проверки отклоняют запрос до появления в хранилище данных для отката.
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
        attemptStartedAt: clock.now(),
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
      // Открытие составной загрузки создаёт состояние в хранилище.
      // При ошибке сохранения строки его нужно отменить, иначе останется сирота,
      // за части которой хранилище продолжит выставлять счёт.
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

    // Проверяем число запрошенных номеров и их наличие в плане загрузки.
    // Лимит применяется к исходному запросу до удаления дубликатов:
    // он ограничивает затраты на чтение запроса,
    // а также на последующее подписывание.
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

    const ttl = linkSeconds(
      upload.attemptStartedAt,
      policy.presignPartTtlSeconds,
    );
    return {
      expiresAt: expiresAt(clock, ttl),
      parts: await signParts(upload, partNumbers, ttl),
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
      return await orProcessing(id, async (session) => {
        const disposed = await confirmation.cleanup(session);
        if (disposed) return disposed;
        const record = await session.read();
        return record
          ? await confirmation.reconcile(
              record.reservation.id,
              session,
              stoppedUploadId,
            )
          : { status: "absent" };
      });
    },

    async cancelUploadOperation(id) {
      await operations.terminate(id, "cancelled");
      return await orProcessing(
        id,
        async (session) =>
          (await confirmation.cleanup(session)) ?? { status: "processing" },
      );
    },

    async failUploadOperation(id) {
      return await orProcessing(id, async (session) => {
        const disposed = await confirmation.cleanup(session);
        if (disposed) return disposed;
        const record = await session.read();
        if (record) {
          const outcome = await resolveOperation(record, session);
          if (outcome.status !== "failed") return outcome;
        }
        await session.terminate("failed");
        return (await confirmation.cleanup(session))!;
      });
    },

    async uploadThroughServer(input) {
      return await exclusive(
        input.operationId ?? randomUUID(),
        async (session) => {
          await requireDirectory(
            session.directories,
            normalizeDirectory(input.directory),
          );
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
      return await exclusive(
        input.operationId ?? randomUUID(),
        async (session) => {
          await requireDirectory(
            session.directories,
            normalizeDirectory(input.directory),
          );
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
          const file = await currentAttempt(record.reservation.id, session);
          if (file?.kind === "multipart") {
            if (await objectStore.listParts(file.key, file.uploadId)) {
              const resumed = await presignMultipart(file);
              await session.markMultipartStopped(null);
              return resumed;
            }
            await session.fileRows.markFileFailed(file.id);
          }
          if (needsMultipart(input.size, policy.multipartThresholdBytes)) {
            const result = await startMultipart(record, input.size!, session);
            await requireOpen(session);
            return result;
          }
          const { id, key, directory, contentType } = record.reservation;
          const continued = file?.kind === "reserved" ? file : null;
          const ttl = linkSeconds(
            continued?.attemptStartedAt ?? clock.now(),
            policy.presignUploadTtlSeconds,
          );
          const uploadUrl = await objectStore.signUpload(key, {
            contentType,
            expiresIn: ttl,
          });
          if (!continued)
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

    /** Следующий пакет подписанных ссылок на части уже начатой загрузки. */
    async getPartUrls(id, input) {
      const operationId = await operations.findIdByFileId(id);
      if (operationId)
        return await exclusive(operationId, async (session) => {
          await requireOpen(session);
          const file = await currentAttempt(id, session);
          if (!file) throw fileNotFound(id);
          return await signPartBatch(file, input);
        });
      const file = await currentAttempt(id);
      if (!file) throw fileNotFound(id);
      return await signPartBatch(file, input);
    },

    /** Части, уже сохранённые в хранилище, для продолжения прерванной загрузки. */
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
        { wait: true },
      );
    },
  };
}
