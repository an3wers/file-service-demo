import type { Clock } from "../domain/ports/clock.js";
import type { UploadPolicy } from "../domain/upload-policy.js";
import type { FileRowsForFiles } from "../domain/ports/file-rows.js";
import type {
  ObjectStoreForFiles,
  ObjectStoreForMultipart,
} from "../domain/ports/object-storage.js";
import type { UploadOperationSession } from "../domain/ports/upload-operations.js";
import type { StoredFile } from "../domain/stored-file.js";
import {
  FileNotFoundError,
  MultipartNotFoundError,
  UploadNotCompletedError,
} from "../domain/errors.js";
import type { MultipartModule } from "./multipart.js";

export type ConfirmationContext = Pick<
  UploadOperationSession,
  "fileRows" | "read" | "termination" | "terminate" | "checked"
>;
export type ReconciliationResult =
  | { status: "succeeded"; file: StoredFile }
  | { status: "failed"; aborted?: boolean }
  | CleanupResult;

export type CleanupResult = { status: "cancelled" | "discarded" | "deleted" };

export interface ConfirmationModule {
  cleanup(session: UploadOperationSession): Promise<CleanupResult | null>;
  confirm(id: string, context?: ConfirmationContext): Promise<StoredFile>;
  reconcile(
    id: string,
    context?: ConfirmationContext,
  ): Promise<ReconciliationResult>;
}

export function createConfirmationModule({
  objectStore,
  fileRows,
  multipart,
  clock,
  policy,
}: {
  clock: Clock;
  policy: Pick<UploadPolicy, "pendingTtlHours">;
  objectStore: Pick<ObjectStoreForFiles, "head" | "abortMultipart" | "remove"> &
    Pick<ObjectStoreForMultipart, "listParts">;
  fileRows: Pick<
    FileRowsForFiles,
    "findFileById" | "isFileDeleted" | "markFileReady" | "failFileIfUnchanged"
  >;
  multipart: Pick<MultipartModule, "completeMultipartUpload">;
}): ConfirmationModule {
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

  async function inspect(
    id: string,
    context?: ConfirmationContext,
    complete = false,
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
    const expired =
      file.attemptStartedAt.getTime() <
      clock.now().getTime() - policy.pendingTtlHours * 60 * 60 * 1000;
    if (complete && file.kind === "multipart")
      await multipart.completeMultipartUpload(file);
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
        if (!(await rows.failFileIfUnchanged(file)))
          return await inspect(id, context);
        if (file.kind === "multipart" && liveParts) {
          await objectStore.abortMultipart(file.key, file.uploadId);
          return { status: "failed", aborted: true };
        }
      }
      return { status: "failed" };
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
    reconcile: (id, context) => inspect(id, context),
    async confirm(id, context) {
      const result = await inspect(id, context, true);
      if (result.status !== "succeeded")
        throw new FileNotFoundError(`File ${id} was not found`);
      return result.file;
    },
  };
}
