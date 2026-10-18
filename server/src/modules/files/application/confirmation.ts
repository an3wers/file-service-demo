import type { Clock } from "../domain/ports/clock.js";
import type { UploadPolicy } from "../domain/upload-policy.js";
import type { FileRowsForFiles } from "../domain/ports/file-rows.js";
import type {
  ObjectStoreForFiles,
  ObjectStoreForMultipart,
} from "../domain/ports/object-storage.js";
import type { UploadOperationSession } from "../domain/ports/upload-operations.js";
import { attemptDeadline } from "../domain/stored-file.js";
import type { LiveMultipartUpload, StoredFile } from "../domain/stored-file.js";
import {
  FileNotFoundError,
  MultipartIncompleteError,
  MultipartNotFoundError,
  UploadNotCompletedError,
} from "../domain/errors.js";

export type ConfirmationContext = Pick<
  UploadOperationSession,
  | "fileRows"
  | "read"
  | "termination"
  | "terminate"
  | "checked"
  | "markMultipartStopped"
>;
export type ReconciliationResult =
  | { status: "succeeded"; file: StoredFile }
  | { status: "pending" }
  | { status: "failed"; reason?: "size_mismatch"; aborted?: boolean }
  | CleanupResult;

export type CleanupResult = { status: "cancelled" | "discarded" | "deleted" };

export interface ConfirmationModule {
  prepareRetry(
    id: string,
    session: UploadOperationSession,
  ): Promise<ReconciliationResult>;
  cleanup(session: UploadOperationSession): Promise<CleanupResult | null>;
  confirm(id: string, context?: ConfirmationContext): Promise<StoredFile>;
  reconcile(
    id: string,
    context?: ConfirmationContext,
    stoppedUploadId?: string,
  ): Promise<ReconciliationResult>;
}

export function createConfirmationModule({
  objectStore,
  fileRows,
  clock,
  policy,
}: {
  clock: Clock;
  policy: Pick<UploadPolicy, "pendingTtlHours">;
  objectStore: Pick<ObjectStoreForFiles, "head" | "abortMultipart" | "remove"> &
    Pick<ObjectStoreForMultipart, "listParts" | "completeMultipart">;
  fileRows: Pick<
    FileRowsForFiles,
    "findFileById" | "isFileDeleted" | "markFileReady" | "failFileIfUnchanged"
  >;
}): ConfirmationModule {
  async function assemble({
    key,
    uploadId,
    plan,
  }: LiveMultipartUpload): Promise<void> {
    // Список частей берём из хранилища, чтобы результат соответствовал
    // действительно сохранённым байтам.
    const parts = await objectStore.listParts(key, uploadId);

    if (!parts) return; // Уже собрана или не существовала; результат определяется по объекту.

    if (parts.length !== plan.partCount) {
      throw new MultipartIncompleteError(
        "Not every part has been uploaded yet; upload the missing parts before completing",
        { uploaded: parts.length, expected: plan.partCount },
      );
    }

    await objectStore.completeMultipart(key, uploadId, parts);
  }

  async function cleanup(
    session: ConfirmationContext,
  ): Promise<CleanupResult | null> {
    let termination = await session.termination();
    if (!termination) return null;
    try {
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
      return {
        status:
          termination.reason === "failed" ? "discarded" : termination.reason,
      };
    } finally {
      await session.checked();
    }
  }

  async function failAttempt(
    file: StoredFile,
    rows: typeof fileRows,
  ): Promise<boolean> {
    if (!(await rows.failFileIfUnchanged(file))) return false;
    if (file.kind === "multipart")
      await objectStore.abortMultipart(file.key, file.uploadId);
    return true;
  }

  async function inspect(
    id: string,
    context?: ConfirmationContext,
    complete = false,
    stoppedUploadId?: string,
  ): Promise<ReconciliationResult> {
    const rows = context?.fileRows ?? fileRows;
    if (context) {
      const cleaned = await cleanup(context);
      if (cleaned) return cleaned;
    }
    const file = await rows.findFileById(id);
    if (file?.kind === "ready" && context) {
      const cleaned = await cleanup(context);
      if (cleaned) return cleaned;
    }
    if (!file)
      return { status: (await rows.isFileDeleted(id)) ? "deleted" : "failed" };
    if (file.kind === "ready") return { status: "succeeded", file };
    const expired = attemptDeadline(file, policy.pendingTtlHours) < clock.now();
    if (complete && file.kind === "multipart") await assemble(file);
    const stored = await objectStore.head(file.key);
    if (context) {
      const cleaned = await cleanup(context);
      if (cleaned) return cleaned;
    }
    const record = await context?.read();
    const expected = record
      ? record.size
      : file.kind === "multipart"
        ? file.plan.size
        : file.kind === "reserved"
          ? file.size
          : null;
    if (!stored || (expected !== null && stored.size !== expected)) {
      const liveParts =
        expired && file.kind === "multipart"
          ? await objectStore.listParts(file.key, file.uploadId)
          : null;
      if (complete)
        throw file.kind === "multipart" && !stored
          ? new MultipartNotFoundError("Объект составной загрузки не найден", {
              key: file.key,
            })
          : new UploadNotCompletedError(
              "Объект отсутствует или его размер не совпадает с ожидаемым",
              { key: file.key },
            );
      if (file.kind !== "failed" && (expired || stored)) {
        if (!(await failAttempt(file, rows))) return await inspect(id, context);
        if (file.kind === "multipart" && liveParts)
          return {
            status: "failed",
            aborted: true,
            ...(stored ? { reason: "size_mismatch" as const } : {}),
          };
      }
      if (!stored && !expired && file.kind === "multipart" && context) {
        if (stoppedUploadId === file.uploadId) {
          await objectStore.listParts(file.key, file.uploadId);
          const cleaned = await cleanup(context);
          if (cleaned) return cleaned;
          await context.markMultipartStopped(file.uploadId);
        }
        const current = await context.read();
        if (current?.stoppedMultipartUploadId === file.uploadId)
          return { status: "failed" };
      }
      return stored
        ? { status: "failed", reason: "size_mismatch" }
        : { status: !expired && file.kind !== "failed" ? "pending" : "failed" };
    }
    const ready = await rows.markFileReady(id, {
      sizeBytes: stored.size,
      etag: stored.etag,
      contentType: stored.contentType ?? file.contentType,
    });
    if (context) {
      const cleaned = await cleanup(context);
      if (cleaned) return cleaned;
    }
    return ready ? { status: "succeeded", file: ready } : { status: "deleted" };
  }
  return {
    cleanup,
    async prepareRetry(id, session) {
      const result = await inspect(id, session);
      if (result.status !== "failed") return result;
      const file = await session.fileRows.findFileById(id);
      if (file?.kind === "multipart") {
        if (!(await failAttempt(file, session.fileRows)))
          return await inspect(id, session);
      }
      return result;
    },
    reconcile: (id, context, stoppedUploadId) =>
      inspect(id, context, false, stoppedUploadId),
    async confirm(id, context) {
      const result = await inspect(id, context, true);
      if (result.status !== "succeeded")
        throw new FileNotFoundError(`File ${id} was not found`);
      return result.file;
    },
  };
}
