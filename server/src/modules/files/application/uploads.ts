import { logger } from "../../../logger.js";
import type { Clock } from "../domain/ports/clock.js";
import { FileNotFoundError, MultipartNotFoundError, UploadNotCompletedError } from "../domain/errors.js";
import type { FileRowsForFiles } from "../domain/ports/file-rows.js";
import type { ObjectStoreForFiles } from "../domain/ports/object-storage.js";
import type { MultipartModule, MultipartStatus, PartUrlsInput, PartUrlsResult, PresignMultipartResult } from "./multipart.js";
import { expiresAt, reserveKey } from "../domain/reservation.js";
import { needsMultipart } from "../domain/upload-plan.js";
import type { StoredFile } from "../domain/stored-file.js";
import type { UploadPolicy } from "../domain/upload-policy.js";

export interface UploadsModuleDeps {
  objectStore: ObjectStoreForFiles;
  fileRows: FileRowsForFiles;
  policy: UploadPolicy;
  /** Multipart is a separate module this one drives, not a branch inside it. */
  multipart: MultipartModule;
  /** The wall clock a reservation's `expiresAt` reads, shared with every other scenario. */
  clock: Clock;
}

export interface UploadThroughServerInput {
  filename: string;
  directory?: string | undefined;
  contentType?: string | undefined;
  bytes: Buffer;
  size: number;
}

export interface CreatePresignedUploadInput {
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

export type PresignUploadResult = PresignSingleResult | PresignMultipartResult;

export interface UploadsModule {
  uploadThroughServer(input: UploadThroughServerInput): Promise<StoredFile>;
  createPresignedUpload(input: CreatePresignedUploadInput): Promise<PresignUploadResult>;
  getPartUrls(id: string, input: PartUrlsInput): Promise<PartUrlsResult>;
  getMultipartStatus(id: string): Promise<MultipartStatus>;
  completeUpload(id: string): Promise<StoredFile>;
}

function fileNotFound(id: string) {
  return new FileNotFoundError(`File ${id} was not found`);
}

export function createUploadsModule({
  objectStore,
  fileRows,
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

  return {
    /** Upload proxied through the server: the request body is already in memory. */
    async uploadThroughServer(input): Promise<StoredFile> {
      const { id, key, directory, originalName, extension, contentType } = reserveKey({
        filename: input.filename,
        directory: input.directory,
        contentType: input.contentType,
      });

      const { etag } = await objectStore.put(key, input.bytes, {
        contentType,
        contentLength: input.size,
      });

      try {
        return await fileRows.insertFile({
          id,
          objectKey: key,
          directory,
          originalName,
          extension,
          contentType,
          sizeBytes: input.size,
          etag,
          status: "ready",
          uploadSource: "server",
        });
      } catch (error) {
        // The object is already stored but has no metadata row, so nothing can
        // ever reach it again. Roll the storage side back rather than leak an
        // orphan. (If the insert actually committed and only the response was
        // lost, this deletes the object under a live row — rare enough to leave
        // to a future reconciliation pass rather than a transaction here.)
        await objectStore.remove(key).catch((cleanupError: unknown) => {
          logger.error(
            { err: cleanupError, id, key },
            "Failed to remove orphaned object after metadata insert failed",
          );
        });

        throw error;
      }
    },

    /**
     * Reserves an id, key and metadata row, then hands back a URL the client can
     * PUT to directly. The row stays `pending` until `completeUpload` confirms
     * the object actually landed.
     *
     * Past the multipart threshold the same call answers with a plan instead,
     * discriminated by `strategy`. A request that sends no `size` cannot be
     * planned and stays on the single-PUT path, which is also what keeps callers
     * that predate multipart working unchanged.
     */
    async createPresignedUpload(input): Promise<PresignUploadResult> {
      if (needsMultipart(input.size, policy.multipartThresholdBytes)) {
        return await multipart.createMultipartUpload({
          filename: input.filename,
          directory: input.directory,
          contentType: input.contentType,
          size: input.size!,
        });
      }

      const { id, key, directory, originalName, extension, contentType } = reserveKey(input);
      const ttl = policy.presignUploadTtlSeconds;

      // Sign before recording anything: the key is already fixed, and a signing
      // failure this way leaves no `pending` row that no client will confirm.
      const uploadUrl = await objectStore.signUpload(key, {
        contentType,
        expiresIn: ttl,
      });

      await fileRows.insertFile({
        id,
        objectKey: key,
        directory,
        originalName,
        extension,
        contentType,
        sizeBytes: input.size ?? null,
        etag: null,
        status: "pending",
        uploadSource: "presigned",
      });

      return {
        strategy: "single",
        id,
        key,
        directory,
        uploadUrl,
        expiresAt: expiresAt(clock, ttl),
        // The signature covers Content-Type, so the client must send it verbatim.
        requiredHeaders: { "Content-Type": contentType },
      };
    },

    /** A further batch of part URLs for an upload already in flight. */
    async getPartUrls(id, input) {
      return await multipart.createPartUrls(await requireFile(id), input);
    },

    /** Which parts storage already holds, so an interrupted upload can resume. */
    async getMultipartStatus(id) {
      return await multipart.getMultipartStatus(await requireFile(id));
    },

    /**
     * Confirms an upload against storage itself. Size and ETag are read off the
     * object rather than taken from the client, so the metadata reflects the
     * bytes that were actually stored.
     */
    async completeUpload(id): Promise<StoredFile> {
      const file = await requireFile(id);

      if (file.kind === "ready") {
        return file; // Idempotent: a retried confirmation is not an error.
      }

      if (file.kind === "failed") {
        // `db:cleanup` gave up on this row earlier. If the object is there after
        // all, the upload did work and only the confirmation was lost, so let
        // the check below revive it — but say so, because it means cleanup ran
        // early.
        logger.info(
          { id, key: file.key },
          "Confirming an upload that was previously marked failed",
        );
      }

      if (file.kind === "multipart") {
        // Assembles the object out of its parts first; everything below then
        // reads the finished object exactly as for a single-PUT upload.
        const outcome = await multipart.completeMultipartUpload(file);

        if (outcome === "gone") {
          logger.info(
            { id, key: file.key },
            "Multipart upload had already been settled elsewhere",
          );
        }
      }

      const stored = await objectStore.head(file.key);

      if (!stored) {
        const message = "No object was found at the reserved key; upload the file before confirming";
        const details = { key: file.key };

        throw file.kind === "multipart"
          ? new MultipartNotFoundError(message, details)
          : new UploadNotCompletedError(message, details);
      }

      const row = await fileRows.markFileReady(id, {
        sizeBytes: stored.size,
        etag: stored.etag,
        contentType: stored.contentType ?? file.contentType,
      });

      if (!row) {
        throw fileNotFound(id); // Deleted between the lookup and the update.
      }

      return row;
    },
  };
}
