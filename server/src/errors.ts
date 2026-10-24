/**
 * Все коды ошибок для клиента определены здесь. Этот список — контракт,
 * которому соответствует таблица сообщений клиента; коды не задаются на месте.
 */
export const ERROR_CODES = {
  BAD_REQUEST: "BAD_REQUEST",
  ORIGIN_NOT_ALLOWED: "ORIGIN_NOT_ALLOWED",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  RATE_LIMITED: "RATE_LIMITED",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  UNAUTHORIZED: "UNAUTHORIZED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  LOGIN_ATTEMPT_INVALID: "LOGIN_ATTEMPT_INVALID",
  LOGIN_CODE_EXPIRED: "LOGIN_CODE_EXPIRED",
  LOGIN_CODE_INVALID: "LOGIN_CODE_INVALID",
  ACTIVATION_LINK_INVALID: "ACTIVATION_LINK_INVALID",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  ROUTE_NOT_FOUND: "ROUTE_NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",

  UPLOAD_OPERATION_CONFLICT: "UPLOAD_OPERATION_CONFLICT",
  UPLOAD_OPERATION_PROCESSING: "UPLOAD_OPERATION_PROCESSING",
  FILE_REQUIRED: "FILE_REQUIRED",
  UPLOAD_REJECTED: "UPLOAD_REJECTED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  DIRECTORY_NOT_FOUND: "DIRECTORY_NOT_FOUND",
  DIRECTORY_ALREADY_EXISTS: "DIRECTORY_ALREADY_EXISTS",
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
  /** Исходная ошибка сохраняется для журнала и поля `err.cause` в pino. */
  cause?: unknown;
  /**
   * Поля для журнала, которые нельзя отправлять в ответе. `details` доступно
   * клиенту, поэтому имена бакетов, объектные ключи и имена ошибок хранилища
   * помещаются сюда.
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
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "AppError";
    this.logContext = options?.logContext;
  }
}

export type ErrorMapper = (error: unknown) => AppError | undefined;

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
) =>
  new AppError(413, ERROR_CODES.PAYLOAD_TOO_LARGE, message, details, options);

/** Временное ограничение: после освобождения слота тот же запрос может пройти. */
export const tooManyRequests = (
  code: ErrorCode,
  message: string,
  details?: unknown,
  options?: AppErrorOptions,
) => new AppError(429, code, message, details, options);

/** Зависимость ответила, но сервис не может обработать её ответ. */
export const badGateway = (
  code: ErrorCode,
  message: string,
  details?: unknown,
  options?: AppErrorOptions,
) => new AppError(502, code, message, details, options);

/** Зависимость недоступна или перегружена; повторная попытка может пройти. */
export const serviceUnavailable = (
  code: ErrorCode,
  message: string,
  details?: unknown,
  options?: AppErrorOptions,
) => new AppError(503, code, message, details, options);
