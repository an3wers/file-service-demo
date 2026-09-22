import { logger } from "../../logger.js";
import type { ObjectStore } from "../../storage/object-store.js";
import { decodeOriginalName, normalizeDirectory } from "../../storage/keys.js";
import { toFileDto } from "./files.mapper.js";
import { FileNotFoundError, FileNotReadyError, MultipartNotFoundError, UploadNotCompletedError } from "./errors.js";
import type { FileRowsForFiles } from "./file-rows.js";
import type { MultipartModule, MultipartStatus } from "./multipart.service.js";
import { expiresAt, reserveKey } from "./reservation.js";
import { needsMultipart } from "./upload-plan.js";
import { statusOf } from "./stored-file.js";
import type { StoredFile } from "./stored-file.js";
import type { UploadPolicy } from "./upload-policy.js";
import type {
  DirectoryDto,
  FileDto,
  ListFilesParams,
  MultipartPartDto,
  PresignUploadResult,
} from "./files.types.js";
import type {
  DownloadUrlQuery,
  ListFilesQuery,
  PartUrlsBody,
  PresignUploadBody,
} from "./files.schemas.js";

export interface FilesModuleDeps {
  objectStore: ObjectStore;
  fileRows: FileRowsForFiles;
  policy: UploadPolicy;
  /** Multipart is a separate module this one drives, not a branch inside it. */
  multipart: MultipartModule;
  /** Recorded on every row as provenance; see `MultipartModuleDeps.bucket`. */
  bucket: string;
}

export interface ListFilesResult {
  items: FileDto[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface FilesModule {
  uploadThroughServer(
    file: Express.Multer.File,
    rawDirectory: string | undefined,
  ): Promise<FileDto>;
  createPresignedUpload(body: PresignUploadBody): Promise<PresignUploadResult>;
  getPartUrls(
    id: string,
    body: PartUrlsBody,
  ): Promise<{ expiresAt: string; parts: MultipartPartDto[] }>;
  getMultipartStatus(id: string): Promise<MultipartStatus>;
  completeUpload(id: string): Promise<FileDto>;
  getDownloadUrl(
    id: string,
    query: DownloadUrlQuery,
  ): Promise<{ url: string; expiresAt: string; name: string }>;
  getFileCard(id: string, withUrl: boolean): Promise<FileDto>;
  listFiles(query: ListFilesQuery): Promise<ListFilesResult>;
  deleteFile(id: string): Promise<void>;
  listDirectories(rawParent: string | undefined): Promise<{
    parent: string;
    items: DirectoryDto[];
  }>;
}

function fileNotFound(id: string) {
  return new FileNotFoundError(`File ${id} was not found`);
}

export function createFilesModule({
  objectStore,
  fileRows,
  policy,
  multipart,
  bucket,
}: FilesModuleDeps): FilesModule {
  async function requireFile(id: string): Promise<StoredFile> {
    const file = await fileRows.findFileById(id);

    if (!file) {
      throw fileNotFound(id);
    }

    return file;
  }

  async function presignDownload(
    file: StoredFile,
    options: { disposition: "attachment" | "inline"; expiresIn: number },
  ): Promise<string> {
    return await objectStore.signDownload(file.key, {
      name: file.originalName,
      contentType: file.contentType,
      disposition: options.disposition,
      expiresIn: options.expiresIn,
    });
  }

  const files: FilesModule = {
    /** Upload proxied through the server: the request body is already in memory. */
    async uploadThroughServer(file, rawDirectory): Promise<FileDto> {
      const { id, key, directory, originalName, extension, contentType } = reserveKey({
        filename: decodeOriginalName(file.originalname),
        directory: rawDirectory,
        contentType: file.mimetype,
      });

      const { etag } = await objectStore.put(key, file.buffer, {
        contentType,
        contentLength: file.size,
      });

      try {
        const row = await fileRows.insertFile({
          id,
          bucket,
          objectKey: key,
          directory,
          originalName,
          extension,
          contentType,
          sizeBytes: file.size,
          etag,
          status: "ready",
          uploadSource: "server",
        });

        return toFileDto(row);
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
    async createPresignedUpload(body): Promise<PresignUploadResult> {
      if (needsMultipart(body.size, policy.multipartThresholdBytes)) {
        return await multipart.createMultipartUpload({
          filename: body.filename,
          directory: body.directory,
          contentType: body.contentType,
          size: body.size!,
        });
      }

      const { id, key, directory, originalName, extension, contentType } = reserveKey(body);
      const ttl = policy.presignUploadTtlSeconds;

      // Sign before recording anything: the key is already fixed, and a signing
      // failure this way leaves no `pending` row that no client will confirm.
      const uploadUrl = await objectStore.signUpload(key, {
        contentType,
        expiresIn: ttl,
      });

      await fileRows.insertFile({
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

      return {
        strategy: "single",
        id,
        key,
        directory,
        uploadUrl,
        expiresAt: expiresAt(ttl),
        // The signature covers Content-Type, so the client must send it verbatim.
        requiredHeaders: { "Content-Type": contentType },
      };
    },

    /** A further batch of part URLs for an upload already in flight. */
    async getPartUrls(id, body) {
      return await multipart.createPartUrls(await requireFile(id), body);
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
    async completeUpload(id): Promise<FileDto> {
      const file = await requireFile(id);

      if (file.kind === "ready") {
        return toFileDto(file); // Idempotent: a retried confirmation is not an error.
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

      return toFileDto(row);
    },

    async getDownloadUrl(id, query) {
      const file = await requireFile(id);

      if (file.kind !== "ready") {
        throw new FileNotReadyError(
          `File ${id} is in status "${statusOf(file)}" and cannot be downloaded yet`,
        );
      }

      const expiresIn = query.expiresIn ?? policy.presignDownloadTtlSeconds;

      return {
        url: await presignDownload(file, { disposition: query.disposition, expiresIn }),
        expiresAt: expiresAt(expiresIn),
        name: file.originalName,
      };
    },

    async getFileCard(id, withUrl): Promise<FileDto> {
      const file = await requireFile(id);

      if (!withUrl || file.kind !== "ready") {
        return toFileDto(file);
      }

      // The caller asked for a link, so a signing failure is the whole answer
      // failing rather than a card quietly served without one.
      const url = await presignDownload(file, {
        disposition: "attachment",
        expiresIn: policy.presignDownloadTtlSeconds,
      });

      return toFileDto(file, url);
    },

    async listFiles(query): Promise<ListFilesResult> {
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

      const { items, total } = await fileRows.listFiles(params);

      return {
        items: items.map((row) => toFileDto(row)),
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      };
    },

    async deleteFile(id): Promise<void> {
      // The metadata row is the source of truth, so retire it first; a failed
      // storage delete then only leaves an unreferenced object behind.
      const file = await fileRows.softDeleteFile(id);

      if (!file) {
        throw fileNotFound(id);
      }

      try {
        if (file.kind === "multipart") {
          // No object exists under this key yet — the uploaded parts are what
          // has to go, and only an abort removes those.
          await objectStore.abortMultipart(file.key, file.uploadId);
        } else {
          await objectStore.remove(file.key);
        }
      } catch (error) {
        logger.error(
          { err: error, id, key: file.key },
          "File marked deleted but the stored object could not be removed",
        );
      }
    },

    async listDirectories(rawParent) {
      const parent = normalizeDirectory(rawParent);

      return { parent, items: await fileRows.listChildDirectories(parent) };
    },
  };

  return files;
}
