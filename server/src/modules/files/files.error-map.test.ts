import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../../errors.js";
import { mapFilesError } from "./files.error-map.js";
import {
  FileNotFoundError,
  FileNotReadyError,
  FileTooLargeError,
  InvalidDirectoryError,
  InvalidFileNameError,
  MultipartNotFoundError,
  TooManyActiveUploadsError,
  UploadNotCompletedError,
} from "./errors.js";

describe("mapFilesError", () => {
  it("переводит «файл не найден» в 404 с исходным сообщением", () => {
    const domainError = new FileNotFoundError("File abc was not found");
    const appError = mapFilesError(domainError);

    expect(appError).toMatchObject({
      statusCode: 404,
      code: ERROR_CODES.FILE_NOT_FOUND,
      message: "File abc was not found",
    });
  });

  it("переводит «файл не готов» в 409", () => {
    const appError = mapFilesError(new FileNotReadyError('File abc is in status "pending"'));

    expect(appError).toMatchObject({ statusCode: 409, code: ERROR_CODES.FILE_NOT_READY });
  });

  it("переводит «загрузка не завершена» в 409 и сохраняет details", () => {
    const appError = mapFilesError(
      new UploadNotCompletedError("No object was found at the reserved key", {
        key: "docs/abc.bin",
      }),
    );

    expect(appError).toMatchObject({
      statusCode: 409,
      code: ERROR_CODES.UPLOAD_NOT_COMPLETED,
      details: { key: "docs/abc.bin" },
    });
  });

  it("переводит «составная загрузка не найдена» в 409", () => {
    const appError = mapFilesError(new MultipartNotFoundError("No multipart upload"));

    expect(appError).toMatchObject({ statusCode: 409, code: ERROR_CODES.MULTIPART_NOT_FOUND });
  });

  it("переводит «слишком много активных загрузок» в 429 и сохраняет details", () => {
    const appError = mapFilesError(
      new TooManyActiveUploadsError("Too many multipart uploads", { active: 2, limit: 2 }),
    );

    expect(appError).toMatchObject({
      statusCode: 429,
      code: ERROR_CODES.TOO_MANY_ACTIVE_UPLOADS,
      details: { active: 2, limit: 2 },
    });
  });

  it("переводит «недопустимый каталог» в 400", () => {
    const appError = mapFilesError(new InvalidDirectoryError("Directory contains control characters"));

    expect(appError).toMatchObject({ statusCode: 400, code: ERROR_CODES.INVALID_DIRECTORY });
  });

  it("переводит «недопустимое имя файла» в 400", () => {
    const appError = mapFilesError(new InvalidFileNameError("File name is missing or not usable"));

    expect(appError).toMatchObject({ statusCode: 400, code: ERROR_CODES.INVALID_FILE_NAME });
  });

  it("переводит «файл слишком большой» в 413 с кодом общего лимита размера", () => {
    const appError = mapFilesError(
      new FileTooLargeError("File exceeds the 200 GB limit", { maxObjectSize: 1 }),
    );

    expect(appError).toMatchObject({
      statusCode: 413,
      code: ERROR_CODES.PAYLOAD_TOO_LARGE,
      details: { maxObjectSize: 1 },
    });
  });

  it("оставляет причину как исходную доменную ошибку", () => {
    const domainError = new FileNotFoundError("File abc was not found");
    const appError = mapFilesError(domainError);

    expect(appError?.cause).toBe(domainError);
  });

  it("не трогает ошибки, не относящиеся к домену files", () => {
    expect(mapFilesError(new Error("boom"))).toBeUndefined();
    expect(mapFilesError("boom")).toBeUndefined();
    expect(mapFilesError(undefined)).toBeUndefined();
  });
});
