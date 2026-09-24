/**
 * Every client-facing error code lives here. The list is the contract the
 * frontend's message table mirrors, so a code is never spelled out inline.
 */
export const ERROR_CODES = {
  UNAUTHORIZED: "UNAUTHORIZED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  ROUTE_NOT_FOUND: "ROUTE_NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",

  FILE_REQUIRED: "FILE_REQUIRED",
  UPLOAD_REJECTED: "UPLOAD_REJECTED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  INVALID_DIRECTORY: "INVALID_DIRECTORY",
  INVALID_FILE_NAME: "INVALID_FILE_NAME",

  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  FILE_NOT_READY: "FILE_NOT_READY",
  UPLOAD_NOT_COMPLETED: "UPLOAD_NOT_COMPLETED",

  INVALID_UPLOAD_SIZE: "INVALID_UPLOAD_SIZE",
  INVALID_PART_NUMBER: "INVALID_PART_NUMBER",
  MULTIPART_NOT_FOUND: "MULTIPART_NOT_FOUND",
  MULTIPART_INCOMPLETE: "MULTIPART_INCOMPLETE",
  TOO_MANY_ACTIVE_UPLOADS: "TOO_MANY_ACTIVE_UPLOADS",

  STORAGE_UNAVAILABLE: "STORAGE_UNAVAILABLE",
  STORAGE_MISCONFIGURED: "STORAGE_MISCONFIGURED",
  STORAGE_ERROR: "STORAGE_ERROR",

  DATABASE_UNAVAILABLE: "DATABASE_UNAVAILABLE",
  DATABASE_TIMEOUT: "DATABASE_TIMEOUT",
  DUPLICATE_RESOURCE: "DUPLICATE_RESOURCE",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface AppErrorOptions {
  /** The original failure, kept for the log line and for `err.cause` in pino. */
  cause?: unknown;
  /**
   * Fields that belong in the log but not in the response. `details` is sent to
   * the client, so bucket names, object keys and vendor error names go here.
   */
  logContext?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly logContext: Record<string, unknown> | undefined;

  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
    options?: AppErrorOptions,
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.logContext = options?.logContext;
  }
}

export const badRequest = (
  code: ErrorCode,
  message: string,
  details?: unknown,
  options?: AppErrorOptions,
) => new AppError(400, code, message, details, options);

export const unauthorized = (message = "Missing or invalid access token") =>
  new AppError(401, ERROR_CODES.UNAUTHORIZED, message);

export const notFound = (
  code: ErrorCode,
  message: string,
  details?: unknown,
  options?: AppErrorOptions,
) => new AppError(404, code, message, details, options);

export const conflict = (
  code: ErrorCode,
  message: string,
  details?: unknown,
  options?: AppErrorOptions,
) => new AppError(409, code, message, details, options);

export const payloadTooLarge = (
  message: string,
  details?: unknown,
  options?: AppErrorOptions,
) => new AppError(413, ERROR_CODES.PAYLOAD_TOO_LARGE, message, details, options);

/** Nothing is permanently wrong: free a slot and the same request goes through. */
export const tooManyRequests = (
  code: ErrorCode,
  message: string,
  details?: unknown,
  options?: AppErrorOptions,
) => new AppError(429, code, message, details, options);

/** The service reached a dependency and got an answer it cannot work with. */
export const badGateway = (
  code: ErrorCode,
  message: string,
  details?: unknown,
  options?: AppErrorOptions,
) => new AppError(502, code, message, details, options);

/** The dependency is unreachable or overloaded; retrying may well succeed. */
export const serviceUnavailable = (
  code: ErrorCode,
  message: string,
  details?: unknown,
  options?: AppErrorOptions,
) => new AppError(503, code, message, details, options);
