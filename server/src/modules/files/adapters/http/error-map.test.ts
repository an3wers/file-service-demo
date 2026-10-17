import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../../../../errors.js";
import { mapFilesError } from "./error-map.js";
import {
  FileNotFoundError,
  FileNotReadyError,
  FileTooLargeError,
  ImpossibleFileRowError,
  InvalidDirectoryError,
  InvalidPartNumberError,
  InvalidUploadSizeError,
  MultipartIncompleteError,
  InvalidFileNameError,
  MultipartNotFoundError,
  TooManyActiveUploadsError,
  UploadNotCompletedError,
  UploadOperationConflictError,
  UploadOperationProcessingError,
} from "../../domain/errors.js";

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
    const appError = mapFilesError(
      new FileNotReadyError('File abc is in status "pending"'),
    );

    expect(appError).toMatchObject({
      statusCode: 409,
      code: ERROR_CODES.FILE_NOT_READY,
    });
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
    const appError = mapFilesError(
      new MultipartNotFoundError("No multipart upload"),
    );

    expect(appError).toMatchObject({
      statusCode: 409,
      code: ERROR_CODES.MULTIPART_NOT_FOUND,
    });
  });

  it("переводит «слишком много активных загрузок» в 429 и сохраняет details", () => {
    const appError = mapFilesError(
      new TooManyActiveUploadsError("Too many multipart uploads", {
        active: 2,
        limit: 2,
      }),
    );

    expect(appError).toMatchObject({
      statusCode: 429,
      code: ERROR_CODES.TOO_MANY_ACTIVE_UPLOADS,
      details: { active: 2, limit: 2 },
    });
  });

  it("переводит «недопустимый каталог» в 400", () => {
    const appError = mapFilesError(
      new InvalidDirectoryError("Directory contains control characters"),
    );

    expect(appError).toMatchObject({
      statusCode: 400,
      code: ERROR_CODES.INVALID_DIRECTORY,
    });
  });

  it("переводит «недопустимое имя файла» в 400", () => {
    const appError = mapFilesError(
      new InvalidFileNameError("File name is missing or not usable"),
    );

    expect(appError).toMatchObject({
      statusCode: 400,
      code: ERROR_CODES.INVALID_FILE_NAME,
    });
  });

  it("переводит «файл слишком большой» в 413 с кодом общего лимита размера", () => {
    const appError = mapFilesError(
      new FileTooLargeError("File exceeds the 200 GB limit", {
        maxObjectSize: 1,
      }),
    );

    expect(appError).toMatchObject({
      statusCode: 413,
      code: ERROR_CODES.PAYLOAD_TOO_LARGE,
      details: { maxObjectSize: 1 },
    });
  });

  it.each([
    [
      "конфликт операции загрузки",
      UploadOperationConflictError,
      ERROR_CODES.UPLOAD_OPERATION_CONFLICT,
    ],
    [
      "операция загрузки ещё выполняется",
      UploadOperationProcessingError,
      ERROR_CODES.UPLOAD_OPERATION_PROCESSING,
    ],
  ])("переводит «%s» в 409 и сохраняет details и причину", (_, Kind, code) => {
    const domainError = new Kind("Operation op-1 is busy", {
      operationId: "op-1",
    });
    const appError = mapFilesError(domainError);

    expect(appError).toMatchObject({
      statusCode: 409,
      code,
      message: "Operation op-1 is busy",
      details: { operationId: "op-1" },
    });
    expect(appError?.cause).toBe(domainError);
  });

  it("переводит «недопустимый размер загрузки» в 400", () => {
    const appError = mapFilesError(
      new InvalidUploadSizeError("File size must be a positive number"),
    );

    expect(appError).toMatchObject({
      statusCode: 400,
      code: ERROR_CODES.INVALID_UPLOAD_SIZE,
    });
  });

  it("переводит «недопустимый номер части» в 400 и сохраняет details", () => {
    const appError = mapFilesError(
      new InvalidPartNumberError("Part 4 is outside the plan", {
        partCount: 3,
      }),
    );

    expect(appError).toMatchObject({
      statusCode: 400,
      code: ERROR_CODES.INVALID_PART_NUMBER,
      details: { partCount: 3 },
    });
  });

  it("переводит «составная загрузка неполна» в 409 и сохраняет details", () => {
    const appError = mapFilesError(
      new MultipartIncompleteError("Not every part has been uploaded", {
        uploaded: 1,
        expected: 3,
      }),
    );

    expect(appError).toMatchObject({
      statusCode: 409,
      code: ERROR_CODES.MULTIPART_INCOMPLETE,
      details: { uploaded: 1, expected: 3 },
    });
  });

  it("переводит невозможную строку метаданных во внутреннюю ошибку, не показывая подробности клиенту", () => {
    const domainError = new ImpossibleFileRowError(
      "Metadata row is in an impossible state",
      { reason: "A ready file still carries a multipart upload", id: "abc" },
    );
    const appError = mapFilesError(domainError);

    expect(appError).toMatchObject({
      statusCode: 500,
      code: ERROR_CODES.INTERNAL_SERVER_ERROR,
      message: "An unexpected error occurred",
      details: undefined,
      logContext: {
        reason: "A ready file still carries a multipart upload",
        id: "abc",
      },
    });
    expect(appError?.cause).toBe(domainError);
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
