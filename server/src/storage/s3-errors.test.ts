import { describe, expect, it } from "vitest";
import { AppError, ERROR_CODES, notFound } from "../errors.js";
import { isS3NoSuchUpload, isS3NotFound, storageError } from "./s3-errors.js";

const context = { operation: "getObject", bucket: "test-bucket", key: "docs/a.pdf" };

function awsError(name: string, httpStatusCode?: number) {
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode, requestId: "req-1" },
  });
}

describe("isS3NotFound", () => {
  it("recognises every shape S3 answers a missing key with", () => {
    expect(isS3NotFound(awsError("NotFound", 404))).toBe(true);
    expect(isS3NotFound(awsError("NoSuchKey", 404))).toBe(true);
    expect(isS3NotFound(awsError("SomethingElse", 404))).toBe(true);
  });

  it("does not swallow other failures", () => {
    expect(isS3NotFound(awsError("AccessDenied", 403))).toBe(false);
    expect(isS3NotFound(null)).toBe(false);
  });
});

describe("isS3NoSuchUpload", () => {
  it("recognises the named error and the bare 404 behind it", () => {
    expect(isS3NoSuchUpload(awsError("NoSuchUpload", 404))).toBe(true);
    expect(isS3NoSuchUpload(awsError("NoSuchUpload"))).toBe(true);
    expect(isS3NoSuchUpload(awsError("SomethingElse", 404))).toBe(true);
  });

  it("does not swallow other failures", () => {
    expect(isS3NoSuchUpload(awsError("AccessDenied", 403))).toBe(false);
    expect(isS3NoSuchUpload(null)).toBe(false);
  });
});

describe("storageError", () => {
  it("passes an AppError through untouched", () => {
    const original = notFound(ERROR_CODES.FILE_NOT_FOUND, "gone");

    expect(storageError(original, context)).toBe(original);
  });

  it("maps credential and bucket problems to misconfigured", () => {
    const mapped = storageError(awsError("SignatureDoesNotMatch", 403), context);

    expect(mapped).toMatchObject({ statusCode: 502, code: ERROR_CODES.STORAGE_MISCONFIGURED });
  });

  it("maps a bare 403 to misconfigured as well", () => {
    expect(storageError(awsError("Forbidden", 403), context)).toMatchObject({
      code: ERROR_CODES.STORAGE_MISCONFIGURED,
    });
  });

  it("maps transient failures to unavailable", () => {
    expect(storageError(awsError("SlowDown", 503), context)).toMatchObject({
      statusCode: 503,
      code: ERROR_CODES.STORAGE_UNAVAILABLE,
    });
    expect(
      storageError(Object.assign(new Error("socket"), { code: "ECONNRESET" }), context),
    ).toMatchObject({ code: ERROR_CODES.STORAGE_UNAVAILABLE });
  });

  it("falls back to a generic storage error", () => {
    expect(storageError(awsError("InvalidRequest", 400), context)).toMatchObject({
      statusCode: 502,
      code: ERROR_CODES.STORAGE_ERROR,
    });
  });

  it("keeps vendor internals out of the response body", () => {
    const mapped = storageError(awsError("AccessDenied", 403), context) as AppError;

    expect(mapped.details).toEqual({ operation: "getObject" });
    expect(mapped.logContext).toMatchObject({
      bucket: "test-bucket",
      key: "docs/a.pdf",
      awsError: "AccessDenied",
      awsStatus: 403,
      awsRequestId: "req-1",
    });
  });
});
