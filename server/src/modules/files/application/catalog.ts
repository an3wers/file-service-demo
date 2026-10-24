import type { ConfirmationModule } from "./confirmation.js";
import type { DirectoryDto } from "../domain/ports/directories.js";
import { requireDirectory } from "../domain/directories.js";
import type { DirectoriesForCatalog } from "../domain/ports/directories.js";
import { randomUUID } from "node:crypto";
import type { UploadOperations } from "../domain/ports/upload-operations.js";
import {
  fileExtension,
  normalizeDirectory,
  normalizeDirectoryName,
  normalizeFileName,
} from "../domain/keys.js";
import type { Clock } from "../domain/ports/clock.js";
import {
  DirectoryAlreadyExistsError,
  FileNotFoundError,
  FileNotReadyError,
} from "../domain/errors.js";
import type {
  FilePlacement,
  FileRowsForFiles,
  ListFilesParams,
} from "../domain/ports/file-rows.js";
import type { ObjectStoreForFiles } from "../domain/ports/object-storage.js";
import { expiresAt } from "../domain/reservation.js";
import { statusOf } from "../domain/stored-file.js";
import type { FileStatus, StoredFile } from "../domain/stored-file.js";
import type { UploadPolicy } from "../domain/upload-policy.js";

export interface CatalogModuleDeps {
  confirmation: Pick<ConfirmationModule, "cleanup">;
  operations: UploadOperations;
  objectStore: ObjectStoreForFiles;
  fileRows: FileRowsForFiles;
  directories: DirectoriesForCatalog;
  policy: UploadPolicy;
  /** Общие для всех сценариев часы, по которым задаётся `expiresAt` резервирования. */
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

export interface UpdateFileInput {
  name?: string | undefined;
  directory?: string | undefined;
}

export interface ListFilesResult {
  items: StoredFile[];
  total: number;
}

export interface CatalogModule {
  createDirectory(input: {
    parent?: string | undefined;
    name: string;
  }): Promise<DirectoryDto>;
  getDownloadUrl(
    id: string,
    input: GetDownloadUrlInput,
  ): Promise<GetDownloadUrlResult>;
  getFileCard(id: string, withUrl: boolean): Promise<FileCardResult>;
  listFiles(input: ListFilesInput): Promise<ListFilesResult>;
  deleteFile(id: string): Promise<void>;
  updateFile(id: string, input: UpdateFileInput): Promise<StoredFile>;
  listDirectories(rawParent: string | undefined): Promise<{
    parent: string;
    items: DirectoryDto[];
  }>;
}

function fileNotReady(file: StoredFile) {
  return new FileNotReadyError(
    `File ${file.id} is in status "${statusOf(file)}" and cannot be changed`,
  );
}

function fileNotFound(id: string) {
  return new FileNotFoundError(`File ${id} was not found`);
}

export function createCatalogModule({
  operations,
  confirmation,
  objectStore,
  fileRows,
  directories,
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
        url: await presignDownload(file, {
          disposition: input.disposition,
          expiresIn,
        }),
        expiresAt: expiresAt(clock, expiresIn),
        name: file.originalName,
      };
    },

    async getFileCard(id, withUrl): Promise<FileCardResult> {
      const file = await requireFile(id);

      if (!withUrl || file.kind !== "ready") {
        return { file };
      }

      // Если запрошена ссылка, ошибка подписывания отклоняет весь ответ:
      // карточка без запрошенной ссылки не возвращается.
      const downloadUrl = await presignDownload(file, {
        disposition: "attachment",
        expiresIn: policy.presignDownloadTtlSeconds,
      });

      return { file, downloadUrl };
    },

    async listFiles(input): Promise<ListFilesResult> {
      if (input.directory !== undefined) {
        await requireDirectory(
          directories,
          normalizeDirectory(input.directory),
        );
      }
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
      const file = await fileRows.findFileById(id);
      const operationId = await operations.findIdByFileId(id);
      if (!file && !operationId) throw fileNotFound(id);
      const cleanupId = operationId ?? randomUUID();
      if (!operationId && file) {
        await operations.exclusive(cleanupId, async (session) => {
          await session.save({
            reservation: {
              id: file.id,
              key: file.key,
              directory: file.directory,
              originalName: file.originalName,
              extension: file.extension,
              contentType: file.contentType,
            },
            size:
              file.kind === "ready" || file.kind === "reserved"
                ? file.size
                : null,
          });
        });
      }
      await operations.terminate(
        cleanupId,
        "deleted",
        file?.kind === "multipart" ? file.uploadId : undefined,
      );
      await fileRows.softDeleteFile(id);
      const result = await operations.exclusive(
        cleanupId,
        confirmation.cleanup,
      );
      if (result.busy) throw new FileNotReadyError("Удаление ещё выполняется");
    },

    async updateFile(id, input) {
      const originalName =
        input.name === undefined ? undefined : normalizeFileName(input.name);
      const directory =
        input.directory === undefined
          ? undefined
          : normalizeDirectory(input.directory);
      const file = await requireFile(id);
      if (file.kind !== "ready") throw fileNotReady(file);
      const placement: FilePlacement = {
        ...(originalName === undefined
          ? {}
          : {
              name: { originalName, extension: fileExtension(originalName) },
            }),
        ...(directory === undefined ? {} : { directory }),
      };
      if (directory !== undefined)
        await requireDirectory(directories, directory);
      const updated = await fileRows.relocateFile(id, placement);
      if (updated) return updated;
      const current = await requireFile(id);
      if (directory !== undefined)
        await requireDirectory(directories, directory);
      throw fileNotReady(current);
    },

    async createDirectory(input) {
      const parent = normalizeDirectory(input.parent);
      const name = normalizeDirectoryName(input.name);
      const path = normalizeDirectory(parent ? `${parent}/${name}` : name);
      await requireDirectory(directories, parent);
      if (!(await directories.create(parent, name))) {
        throw new DirectoryAlreadyExistsError("Директория уже существует", {
          path,
        });
      }
      return { name, path, fileCount: 0 };
    },

    async listDirectories(rawParent) {
      const parent = normalizeDirectory(rawParent);

      await requireDirectory(directories, parent);
      return { parent, items: await directories.listChildren(parent) };
    },
  };
}
