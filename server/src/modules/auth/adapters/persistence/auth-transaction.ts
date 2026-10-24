import type { PoolClient } from "pg";
import { pool } from "../../../../db/pool.js";
import type { MailLimit } from "../../domain/ports/registration-store.js";

export async function authTransaction<T>(
  deadline: Date,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const remaining = deadline.getTime() - Date.now();
  if (remaining <= 0) throw new Error("Deadline exceeded");
  let client: PoolClient | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      client?.release(true);
      client = undefined;
      reject(new Error("Deadline exceeded"));
    }, remaining);
  });
  async function run() {
    const connection = await pool.connect();
    if (expired || Date.now() >= deadline.getTime()) {
      connection.release();
      throw new Error("Deadline exceeded");
    }
    client = connection;
    try {
      await connection.query("begin");
      const remaining = deadline.getTime() - Date.now();
      if (remaining <= 0) throw new Error("Deadline exceeded");
      await connection.query(
        "select set_config('statement_timeout', $1, true)",
        [String(remaining)],
      );
      await connection.query("select set_config('lock_timeout', $1, true)", [
        String(remaining),
      ]);
      const value = await action(connection);
      if (Date.now() >= deadline.getTime())
        throw new Error("Deadline exceeded");
      await connection.query("commit");
      if (Date.now() >= deadline.getTime())
        throw new Error("Deadline exceeded");
      return value;
    } catch (error) {
      if (!expired) await connection.query("rollback");
      throw error;
    } finally {
      if (!expired) connection.release();
      client = undefined;
    }
  }
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function consumeAuthLimit(
  client: PoolClient,
  key: string,
  limits: readonly MailLimit[],
  at: Date | (() => Date),
): Promise<number> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    key,
  ]);
  const now = typeof at === "function" ? at() : at;
  let retryMs = 0;
  for (const limit of limits) {
    const { rows } = await client.query<{ occurred_at: Date }>(
      "select occurred_at from auth_mail_events where key = $1 and window_ms = $2 and occurred_at > $3 order by occurred_at",
      [key, limit.windowMs, new Date(now.getTime() - limit.windowMs)],
    );
    if (rows.length >= limit.maximum) {
      retryMs = Math.max(
        retryMs,
        rows[rows.length - limit.maximum]!.occurred_at.getTime() +
          limit.windowMs -
          now.getTime(),
      );
    } else {
      await client.query(
        "insert into auth_mail_events (key, window_ms, occurred_at) values ($1, $2, $3)",
        [key, limit.windowMs, now],
      );
    }
  }
  return Math.ceil(retryMs / 1000);
}
