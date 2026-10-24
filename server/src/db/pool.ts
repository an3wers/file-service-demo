import pg from "pg";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { databaseError } from "./errors.js";

const { Pool, types } = pg;

// `bigint` (OID 20) по умолчанию приходит строкой. Все такие значения в схеме
// (size_bytes, COUNT(*)) помещаются в JS number, поэтому преобразуем их сразу,
// чтобы HTTP-слой всегда получал числа.
types.setTypeParser(20, (value: string | null) =>
  value === null ? null : Number(value),
);

export const pool = new Pool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.database,
  user: config.database.user,
  password: config.database.password,
  max: config.database.poolSize,
  ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  // Ограничение времени не даёт зависшему запросу удерживать соединение бесконечно.
  // Postgres отменяет запрос с кодом 57014, который `databaseError` преобразует
  // в ответ 503.
  statement_timeout: 15_000,
});

pool.on("error", (error) => {
  logger.error({ err: error }, "Idle PostgreSQL client error");
});

export type Execute = <T extends pg.QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<pg.QueryResult<T>>;

/**
 * Все обращения репозиториев проходят здесь, поэтому преобразование
 * ошибок драйвера в AppError сосредоточено в одном месте.
 */
export async function query<T extends pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  try {
    return await pool.query<T>(text, values);
  } catch (error) {
    throw databaseError(error);
  }
}

export type Transaction = <T>(
  run: (execute: Execute) => Promise<T>,
) => Promise<T>;

export function transactionOn(execute: Execute): Transaction {
  return async (run) => {
    await execute("begin");
    try {
      const value = await run(execute);
      await execute("commit");
      return value;
    } catch (error) {
      await execute("rollback").catch(() => undefined);
      throw error;
    }
  };
}

export const transaction: Transaction = async (run) => {
  const client = await pool.connect().catch((error: unknown) => {
    throw databaseError(error);
  });
  const execute: Execute = async (text, values = []) => {
    try {
      return await client.query(text, values);
    } catch (error) {
      throw databaseError(error);
    }
  };
  try {
    return await transactionOn(execute)(run);
  } finally {
    client.release();
  }
};

export async function checkDatabase(): Promise<void> {
  await pool.query("select 1");
}
