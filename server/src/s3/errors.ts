import { NoSuchKey, NotFound } from "@aws-sdk/client-s3";
import { AppError, ERROR_CODES, badGateway, serviceUnavailable } from "../errors.js";

/** Wrong bucket, wrong keys, wrong signature: retrying changes nothing. */
const MISCONFIGURED = new Set([
  "AccessDenied",
  "AuthorizationHeaderMalformed",
  "InvalidAccessKeyId",
  "InvalidToken",
  "NoSuchBucket",
  "RequestTimeTooSkewed",
  "SignatureDoesNotMatch",
]);

/** Storage is there but cannot answer right now; a retry is worth a try. */
const UNAVAILABLE = new Set([
  "InternalError",
  "NetworkingError",
  "RequestTimeout",
  "ServiceUnavailable",
  "SlowDown",
  "TimeoutError",
]);

/** Node-level socket failures, which reach us as the raw error from the handler. */
const UNAVAILABLE_SYSCALLS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

interface AwsErrorShape {
  name?: string;
  code?: string;
  $retryable?: unknown;
  $metadata?: { httpStatusCode?: number; requestId?: string };
}

export type StorageContext = { operation: string } & Record<string, unknown>;

/**
 * The only place that decides "S3 has no object at this key". HeadObject
 * answers with `NotFound`, GetObject with `NoSuchKey`, and some S3-compatible
 * implementations send neither shape back — only a bare 404.
 */
export function isS3NotFound(error: unknown): boolean {
  if (error instanceof NotFound || error instanceof NoSuchKey) {
    return true;
  }

  const shape = error as AwsErrorShape | null | undefined;

  return (
    shape?.name === "NotFound" ||
    shape?.name === "NoSuchKey" ||
    shape?.$metadata?.httpStatusCode === 404
  );
}

/**
 * Turns an AWS SDK failure into an AppError with a stable client-facing code.
 * Vendor internals (error name, request id, bucket, key) go to `logContext` so
 * they reach the log without being served to the caller.
 */
export function storageError(error: unknown, context: StorageContext): AppError {
  if (error instanceof AppError) {
    return error; // Already mapped further down the call; do not re-wrap.
  }

  const shape = (error ?? {}) as AwsErrorShape;
  const status = shape.$metadata?.httpStatusCode;
  const name = shape.name ?? "";
  const details = { operation: context.operation };
  const options = {
    cause: error,
    logContext: {
      ...context,
      awsError: name,
      awsStatus: status,
      awsRequestId: shape.$metadata?.requestId,
    },
  };

  if (MISCONFIGURED.has(name) || status === 401 || status === 403) {
    return badGateway(
      ERROR_CODES.STORAGE_MISCONFIGURED,
      "Object storage rejected the request; the bucket or credentials are wrong",
      details,
      options,
    );
  }

  if (
    UNAVAILABLE.has(name) ||
    UNAVAILABLE_SYSCALLS.has(shape.code ?? "") ||
    shape.$retryable !== undefined ||
    (status !== undefined && status >= 500)
  ) {
    return serviceUnavailable(
      ERROR_CODES.STORAGE_UNAVAILABLE,
      "Object storage is unreachable right now; please try again shortly",
      details,
      options,
    );
  }

  return badGateway(
    ERROR_CODES.STORAGE_ERROR,
    "Object storage could not complete the request",
    details,
    options,
  );
}
