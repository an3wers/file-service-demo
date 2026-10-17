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
  "fileRows" | "read" | "termination"
>;
export type ReconciliationResult =
  | { status: "succeeded"; file: StoredFile }
  | { status: "failed" | "deleted"; aborted?: boolean };

export interface ConfirmationModule {
  confirm(id: string, context?: ConfirmationContext): Promise<StoredFile>;
  reconcile(
    id: string,
    context?: ConfirmationContext,
    options?: { expired?: boolean },
  ): Promise<ReconciliationResult>;
}

export function createConfirmationModule({
  objectStore,
  fileRows,
  multipart,
}: {
  objectStore: Pick<ObjectStoreForFiles, "head" | "abortMultipart"> &
    Pick<ObjectStoreForMultipart, "listParts">;
  fileRows: Pick<
    FileRowsForFiles,
    "findFileById" | "isFileDeleted" | "markFileReady" | "failFileIfUnchanged"
  >;
  multipart: Pick<MultipartModule, "completeMultipartUpload">;
}): ConfirmationModule {
  async function inspect(
    id: string,
    context?: ConfirmationContext,
    complete = false,
    expired = false,
  ): Promise<ReconciliationResult> {
    const rows = context?.fileRows ?? fileRows;
    if (await context?.termination()) return { status: "deleted" };
    const file = await rows.findFileById(id);
    if (!file)
      return { status: (await rows.isFileDeleted(id)) ? "deleted" : "failed" };
    if (file.kind === "ready") return { status: "succeeded", file };
    if (complete && file.kind === "multipart")
      await multipart.completeMultipartUpload(file);
    const stored = await objectStore.head(file.key);
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
    return ready ? { status: "succeeded", file: ready } : { status: "deleted" };
  }
  return {
    reconcile: (id, context, options) =>
      inspect(id, context, false, options?.expired),
    async confirm(id, context) {
      const result = await inspect(id, context, true);
      if (result.status !== "succeeded")
        throw new FileNotFoundError(`File ${id} was not found`);
      return result.file;
    },
  };
}
