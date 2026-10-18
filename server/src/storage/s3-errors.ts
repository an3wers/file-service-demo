import { NoSuchKey, NotFound } from "@aws-sdk/client-s3";
import {
  AppError,
  ERROR_CODES,
  badGateway,
  serviceUnavailable,
} from "../errors.js";

/** Неверный бакет, ключи доступа или подпись: повтор не устранит причину. */
const MISCONFIGURED = new Set([
  "AccessDenied",
  "AuthorizationHeaderMalformed",
  "InvalidAccessKeyId",
  "InvalidToken",
  "NoSuchBucket",
  "RequestTimeTooSkewed",
  "SignatureDoesNotMatch",
]);

/** Хранилище доступно, но временно не может ответить; повтор может помочь. */
const UNAVAILABLE = new Set([
  "InternalError",
  "NetworkingError",
  "RequestTimeout",
  "ServiceUnavailable",
  "SlowDown",
  "TimeoutError",
]);

/** Сбои сокета Node приходят как исходные ошибки обработчика. */
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
 * Единое распознавание отсутствия объекта в S3. HeadObject возвращает
 * `NotFound`, GetObject — `NoSuchKey`, а некоторые совместимые реализации
 * возвращают только статус 404.
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
 * Загрузки с таким идентификатором нет: она завершена, отменена или
 * не существовала. В SDK нет класса исключения `NoSuchUpload`, поэтому
 * проверяем имя и статус 404, как в `isS3NotFound`. Применяется только
 * к командам составной загрузки, где у 404 нет другого смысла.
 */
export function isS3NoSuchUpload(error: unknown): boolean {
  const shape = error as AwsErrorShape | null | undefined;

  return (
    shape?.name === "NoSuchUpload" || shape?.$metadata?.httpStatusCode === 404
  );
}

/**
 * Преобразует сбой AWS SDK в AppError с устойчивым кодом для клиента.
 * Внутренние данные поставщика (имя ошибки, идентификатор запроса, бакет,
 * ключ) помещаются в `logContext`, чтобы попасть в журнал, но не в ответ.
 */
export function storageError(
  error: unknown,
  context: StorageContext,
): AppError {
  if (error instanceof AppError) {
    return error; // Ошибка уже преобразована во вложенном вызове; повторно не оборачиваем.
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
