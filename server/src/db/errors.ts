import {
  AppError,
  ERROR_CODES,
  conflict,
  serviceUnavailable,
} from "../errors.js";

/** Классы SQLSTATE, означающие недоступность базы данных, а не ошибку запроса. */
const UNAVAILABLE_STATES = new Set([
  "08000", // Ошибка соединения
  "08001", // Клиент не смог установить SQL-соединение
  "08003", // Соединение не существует
  "08004", // Сервер отклонил установление SQL-соединения
  "08006", // Сбой соединения
  "53300", // Слишком много соединений
  "57P01", // Остановка администратором
  "57P02", // Аварийная остановка
  "57P03", // Подключение сейчас невозможно
]);

/** Сбои сокета приходят как обычные ошибки Node без SQLSTATE. */
const UNAVAILABLE_SYSCALLS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

/**
 * node-postgres сообщает о некоторых сбоях соединения обычным `Error` без кода.
 * Так происходит, когда удалённая база перестаёт отвечать и пакеты теряются,
 * а не отклоняются. Распознать такой сбой можно только по сообщению.
 */
const UNAVAILABLE_MESSAGES = [
  "connection terminated",
  "connection ended unexpectedly",
  "timeout exceeded when trying to connect",
  "client has encountered a connection error",
  "connection refused",
];

interface PgErrorShape {
  code?: unknown;
  constraint?: unknown;
  table?: unknown;
  message?: unknown;
}

/** Ошибка и цепочка её `cause`: pg оборачивает исходный сбой на один уровень. */
function chain(error: unknown): PgErrorShape[] {
  const links: PgErrorShape[] = [];
  let current = error;

  while (current !== null && typeof current === "object" && links.length < 5) {
    links.push(current as PgErrorShape);
    current = (current as { cause?: unknown }).cause;
  }

  return links;
}

export function violatedForeignKey(error: unknown): string | undefined {
  const link = chain(error).find((item) => item.code === "23503");
  return typeof link?.constraint === "string" ? link.constraint : undefined;
}

export function hasSqlState(error: unknown, code: string): boolean {
  return chain(error).some((item) => item.code === code);
}

function isUnreachable(links: PgErrorShape[]): boolean {
  return links.some((link) => {
    const code = typeof link.code === "string" ? link.code : "";
    const message =
      typeof link.message === "string" ? link.message.toLowerCase() : "";

    return (
      UNAVAILABLE_STATES.has(code) ||
      UNAVAILABLE_SYSCALLS.has(code) ||
      UNAVAILABLE_MESSAGES.some((known) => message.includes(known))
    );
  });
}

/**
 * Преобразует ожидаемые сбои зависимостей в AppError.
 * Нарушения ограничений и ошибки синтаксиса остаются без изменений,
 * чтобы возвращаться как 500 с исходным стеком в журнале.
 */
export function databaseError(error: unknown): unknown {
  if (error instanceof AppError) {
    return error;
  }

  const links = chain(error);
  const shape = links[0] ?? {};
  const code = typeof shape.code === "string" ? shape.code : "";
  const options = {
    cause: error,
    logContext: {
      pgCode: code,
      constraint: shape.constraint,
      table: shape.table,
    },
  };

  if (code === "23505" || code === "23503") {
    return conflict(
      ERROR_CODES.DUPLICATE_RESOURCE,
      "The record conflicts with one that already exists",
      undefined,
      options,
    );
  }

  if (code === "57014") {
    return serviceUnavailable(
      ERROR_CODES.DATABASE_TIMEOUT,
      "The database took too long to answer; please try again",
      undefined,
      options,
    );
  }

  if (isUnreachable(links)) {
    return serviceUnavailable(
      ERROR_CODES.DATABASE_UNAVAILABLE,
      "The database is unreachable right now; please try again shortly",
      undefined,
      options,
    );
  }

  return error;
}
