import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError, ERROR_CODES } from "../../../errors.js";
import { FileNotFoundError } from "../domain/errors.js";
import type {
  FileRows,
  InsertFileInput,
  ListFilesParams,
} from "../domain/ports/file-rows.js";

function reservation(
  overrides: Partial<InsertFileInput> = {},
): InsertFileInput {
  const id = randomUUID();
  return {
    id,
    objectKey: `docs/${id}.bin`,
    directory: "",
    originalName: "report.bin",
    extension: "bin",
    contentType: "application/octet-stream",
    sizeBytes: 5,
    etag: null,
    status: "pending",
    uploadSource: "presigned",
    ...overrides,
  };
}

export function describeFileRowsErrors(
  name: string,
  create: () => FileRows,
): void {
  describe(`ошибки строк метаданных: ${name}`, () => {
    it("отклоняет повторное резервирование готового файла как ненайденный файл", async () => {
      const rows = create();
      const input = reservation();
      await rows.insertFile(input);
      await rows.markFileReady(input.id, {
        sizeBytes: 5,
        etag: '"etag"',
        contentType: input.contentType,
      });

      await expect(rows.reserveFile(input)).rejects.toBeInstanceOf(
        FileNotFoundError,
      );
    });

    it("отклоняет повторное резервирование удалённого файла как ненайденный файл", async () => {
      const rows = create();
      const input = reservation();
      await rows.insertFile(input);
      await rows.softDeleteFile(input.id);

      await expect(rows.reserveFile(input)).rejects.toBeInstanceOf(
        FileNotFoundError,
      );
    });

    it("отклоняет вторую строку с тем же идентификатором как конфликт ресурса", async () => {
      const rows = create();
      const input = reservation();
      await rows.insertFile(input);

      const error = await rows
        .insertFile({ ...input, objectKey: `docs/${randomUUID()}.bin` })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        statusCode: 409,
        code: ERROR_CODES.DUPLICATE_RESOURCE,
      });
    });

    it("отклоняет вторую строку на том же объектном ключе как конфликт ресурса", async () => {
      const rows = create();
      const input = reservation();
      await rows.insertFile(input);

      const error = await rows
        .insertFile(reservation({ objectKey: input.objectKey }))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        statusCode: 409,
        code: ERROR_CODES.DUPLICATE_RESOURCE,
      });
    });
  });
}

export function describeFileRowsPagination(
  name: string,
  create: () => FileRows,
): void {
  describe(`пагинация строк метаданных: ${name}`, () => {
    it("сохраняет количество совпадений на странице за пределами списка", async () => {
      const rows = create();
      for (const directory of ["docs", "docs/2026", "other"]) {
        await rows.insertFile(reservation({ directory, status: "ready" }));
      }
      await rows.insertFile(
        reservation({ directory: "docs", status: "pending" }),
      );
      await rows.insertFile(
        reservation({
          directory: "docs",
          status: "ready",
          originalName: "other.bin",
        }),
      );
      const deleted = await rows.insertFile(
        reservation({ directory: "docs", status: "ready" }),
      );
      await rows.softDeleteFile(deleted.id);

      const params: ListFilesParams = {
        directory: "docs",
        recursive: false,
        search: "REPORT",
        status: "ready",
        page: 3,
        limit: 1,
        sort: "created_at",
        order: "desc",
      };
      expect(await rows.listFiles(params)).toEqual({ items: [], total: 1 });
      expect(await rows.listFiles({ ...params, recursive: true })).toEqual({
        items: [],
        total: 2,
      });
      expect(await rows.listFiles({ ...params, search: "missing" })).toEqual({
        items: [],
        total: 0,
      });
      expect(
        await rows.listFiles({ ...params, search: "missing", page: 1 }),
      ).toEqual({ items: [], total: 0 });
    });
  });
}

export function describeFileRowsOwnership(
  name: string,
  create: () => Promise<{ mine: FileRows; theirs: FileRows; all: FileRows }>,
): void {
  describe(`владение строками метаданных: ${name}`, () => {
    it("владелец видит и меняет только свои строки, уборка видит строки всех", async () => {
      const { mine, theirs, all } = await create();
      const plan = { sizeBytes: 5, partSize: 5, partCount: 1 };
      const own = reservation({ ...plan, uploadId: "own-upload" });
      const other = reservation({ ...plan, uploadId: "other-upload" });
      await mine.insertFile(own);
      await theirs.insertFile(other);
      const listAll: ListFilesParams = {
        recursive: true,
        directory: "",
        status: "pending",
        page: 1,
        limit: 10,
        sort: "created_at",
        order: "asc",
      };

      expect(await mine.findFileById(other.id)).toBeNull();
      expect(await mine.isFileDeleted(other.id)).toBe(false);
      expect(
        await mine.markFileReady(other.id, {
          sizeBytes: 5,
          etag: null,
          contentType: other.contentType,
        }),
      ).toBeNull();
      await mine.markFileFailed(other.id);
      expect(await mine.softDeleteFile(other.id)).toBeNull();
      expect(await mine.countActiveMultipart()).toBe(1);
      expect((await mine.listFiles(listAll)).items.map((f) => f.id)).toEqual([
        own.id,
      ]);

      expect(await theirs.findFileById(other.id)).toMatchObject({
        kind: "multipart",
      });
      expect((await all.listFiles(listAll)).total).toBe(2);
      expect(
        await all.findKnownUploadIds(["own-upload", "other-upload"]),
      ).toEqual(new Set(["own-upload", "other-upload"]));
    });
  });
}
