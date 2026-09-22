import { logger } from "../../../logger.js";
import { normalizeDirectory } from "../domain/keys.js";
import type { Clock } from "../domain/ports/clock.js";
import { FileNotFoundError, FileNotReadyError } from "../domain/errors.js";
import type { DirectoryDto, FileRowsForFiles, ListFilesParams } from "../domain/ports/file-rows.js";
import type { ObjectStoreForFiles } from "../domain/ports/object-storage.js";
import { expiresAt } from "../domain/reservation.js";
import { statusOf } from "../domain/stored-file.js";
import type { FileStatus, StoredFile } from "../domain/stored-file.js";
import type { UploadPolicy } from "../domain/upload-policy.js";

export interface CatalogModuleDeps {
  objectStore: ObjectStoreForFiles;
  fileRows: FileRowsForFiles;
  policy: UploadPolicy;
  /** The wall clock a reservation's `expiresAt` reads, shared with every other scenario. */
  clock: Clock;
}

export interface GetDownloadUrlInput {
  disposition: "attachment" | "inline";
  expiresIn?: number | undefined;
}

export interface GetDownloadUrlResult {
  url: string;
  expiresAt: Date;
  name: string;
}

export interface FileCardResult {
  file: StoredFile;
  downloadUrl?: string | undefined;
}

export interface ListFilesInput {
  directory?: string | undefined;
  recursive: boolean;
  search?: string | undefined;
  status: FileStatus | "any";
  page: number;
  limit: number;
  sort: "created_at" | "original_name" | "size_bytes";
  order: "asc" | "desc";
}

export interface ListFilesResult {
  items: StoredFile[];
  total: number;
}

export interface CatalogModule {
  getDownloadUrl(id: string, input: GetDownloadUrlInput): Promise<GetDownloadUrlResult>;
  getFileCard(id: string, withUrl: boolean): Promise<FileCardResult>;
  listFiles(input: ListFilesInput): Promise<ListFilesResult>;
  deleteFile(id: string): Promise<void>;
  listDirectories(rawParent: string | undefined): Promise<{
    parent: string;
    items: DirectoryDto[];
  }>;
}

function fileNotFound(id: string) {
  return new FileNotFoundError(`File ${id} was not found`);
}

export function createCatalogModule({
  objectStore,
  fileRows,
  policy,
  clock,
}: CatalogModuleDeps): CatalogModule {
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

  return {
    async getDownloadUrl(id, input) {
      const file = await requireFile(id);

      if (file.kind !== "ready") {
        throw new FileNotReadyError(
          `File ${id} is in status "${statusOf(file)}" and cannot be downloaded yet`,
        );
      }

      const expiresIn = input.expiresIn ?? policy.presignDownloadTtlSeconds;

      return {
        url: await presignDownload(file, { disposition: input.disposition, expiresIn }),
        expiresAt: expiresAt(clock, expiresIn),
        name: file.originalName,
      };
    },

    async getFileCard(id, withUrl): Promise<FileCardResult> {
      const file = await requireFile(id);

      if (!withUrl || file.kind !== "ready") {
        return { file };
      }

      // The caller asked for a link, so a signing failure is the whole answer
      // failing rather than a card quietly served without one.
      const downloadUrl = await presignDownload(file, {
        disposition: "attachment",
        expiresIn: policy.presignDownloadTtlSeconds,
      });

      return { file, downloadUrl };
    },

    async listFiles(input): Promise<ListFilesResult> {
      const params: ListFilesParams = {
        recursive: input.recursive,
        page: input.page,
        limit: input.limit,
        sort: input.sort,
        order: input.order,
        ...(input.directory !== undefined
          ? { directory: normalizeDirectory(input.directory) }
          : {}),
        ...(input.search ? { search: input.search } : {}),
        ...(input.status !== "any" ? { status: input.status } : {}),
      };

      return await fileRows.listFiles(params);
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
}
