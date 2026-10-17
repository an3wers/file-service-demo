import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError, ERROR_CODES } from "../../../errors.js";
import { FileNotFoundError } from "../domain/errors.js";
import type { FileRows, InsertFileInput } from "../domain/ports/file-rows.js";

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
