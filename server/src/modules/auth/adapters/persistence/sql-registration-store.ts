import type { PoolClient } from "pg";
import { pool } from "../../../../db/pool.js";
import { systemClock } from "../../domain/ports/clock.js";
import type { Clock } from "../../domain/ports/clock.js";
import type {
  MailEventCleanup,
  RegistrationStore,
} from "../../domain/ports/registration-store.js";

export function createSqlRegistrationStore(
  clock: Clock = systemClock,
): RegistrationStore & MailEventCleanup {
  async function transaction<T>(
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
  return {
    requestActivation: (email, tokenHash, expiresAt, deadline) =>
      transaction(deadline, async (client) => {
        const { rows } = await client.query<{ id: string; state: string }>(
          "select id, state from users where email = $1 for update",
          [email],
        );
        const user = rows[0];
        if (!user || user.state === "active") return false;
        await client.query(
          "insert into auth_secrets (user_id, purpose, token_hash, expires_at) values ($1, 'activation', $2, $3) on conflict (user_id, purpose) do update set token_hash = excluded.token_hash, expires_at = excluded.expires_at",
          [user.id, tokenHash, expiresAt],
        );
        return true;
      }),
    confirmActivation: (tokenHash, deadline) =>
      transaction(deadline, async (client) => {
        const { rows } = await client.query<{ user_id: string }>(
          "select user_id from auth_secrets where token_hash = $1 and purpose = 'activation'",
          [tokenHash],
        );
        const secret = rows[0];
        if (!secret) return false;
        await client.query("select id from users where id = $1 for update", [
          secret.user_id,
        ]);
        const consumed = await client.query(
          "delete from auth_secrets where user_id = $1 and purpose = 'activation' and token_hash = $2 and expires_at > $3 returning user_id",
          [secret.user_id, tokenHash, clock.now()],
        );
        if (!consumed.rowCount) return false;
        await client.query("update users set state = 'active' where id = $1", [
          secret.user_id,
        ]);
        return true;
      }),
    removeExpiredEvents: (now) =>
      transaction(
        new Date(Date.now() + 15000),
        async (client) =>
          (
            await client.query(
              "delete from auth_mail_events where ctid in (select ctid from auth_mail_events where occurred_at <= $1::timestamptz - window_ms * interval '1 millisecond' limit 1000 for update skip locked)",
              [now],
            )
          ).rowCount ?? 0,
      ),
    consume: (key, limits, now, deadline) =>
      transaction(deadline, async (client) => {
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [key],
        );
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
      }),
    save: (record, deadline) =>
      transaction(deadline, async (client) => {
        await client.query(
          "insert into users (id, login, name, email, password_hash, state) values ($1::uuid, $1::text, $2, $3, $4, 'inactive') on conflict (email) do nothing",
          [record.id, record.name, record.email, record.passwordHash],
        );
        const { rows } = await client.query<{ id: string; state: string }>(
          "select id, state from users where email = $1 for update",
          [record.email],
        );
        const user = rows[0]!;
        if (user.state === "active") return false;
        await client.query(
          "insert into auth_secrets (user_id, purpose, token_hash, expires_at) values ($1, 'activation', $2, $3) on conflict (user_id, purpose) do update set token_hash = excluded.token_hash, expires_at = excluded.expires_at",
          [user.id, record.tokenHash, record.expiresAt],
        );
        return true;
      }),
  };
}
