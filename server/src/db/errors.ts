import { AppError, ERROR_CODES, conflict, serviceUnavailable } from "../errors.js";

/** SQLSTATE classes that mean "the database is not answering", not "bad query". */
const UNAVAILABLE_STATES = new Set([
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure
  "53300", // too_many_connections
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

/** Socket-level failures, which reach us as plain Node errors without a SQLSTATE. */
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
 * node-postgres raises its own connection failures as bare `Error`s with no
 * code at all — which is exactly what a remote database that stops answering
 * produces, since the packets are dropped rather than refused. The message is
 * the only thing left to match on.
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

/** The error plus its `cause` chain — pg wraps the real failure one level down. */
function chain(error: unknown): PgErrorShape[] {
  const links: PgErrorShape[] = [];
  let current = error;

  while (current !== null && typeof current === "object" && links.length < 5) {
    links.push(current as PgErrorShape);
    current = (current as { cause?: unknown }).cause;
  }

  return links;
}

function isUnreachable(links: PgErrorShape[]): boolean {
  return links.some((link) => {
    const code = typeof link.code === "string" ? link.code : "";
    const message = typeof link.message === "string" ? link.message.toLowerCase() : "";

    return (
      UNAVAILABLE_STATES.has(code) ||
      UNAVAILABLE_SYSCALLS.has(code) ||
      UNAVAILABLE_MESSAGES.some((known) => message.includes(known))
    );
  });
}

/**
 * Translates the failures a healthy service can actually hit into AppErrors.
 * Anything else — a constraint the code should never violate, a syntax error —
 * is returned untouched so it still surfaces as a 500 with its stack.
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
    logContext: { pgCode: code, constraint: shape.constraint, table: shape.table },
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
