import pg from "pg";
import { config } from "../config.js";
import { logger } from "../logger.js";

const { Pool, types } = pg;

// `bigint` (OID 20) arrives as a string by default. Every bigint in this schema
// (size_bytes, COUNT(*)) fits comfortably in a JS number, so parse it eagerly
// and keep the API layer free of string/number ambiguity.
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
});

pool.on("error", (error) => {
  logger.error({ err: error }, "Idle PostgreSQL client error");
});

export async function query<T extends pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, values);
}

export async function checkDatabase(): Promise<void> {
  await pool.query("select 1");
}
