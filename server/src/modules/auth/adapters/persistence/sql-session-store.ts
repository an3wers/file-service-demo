import type { PoolClient } from "pg";
import type { SessionStore } from "../../domain/ports/session-store.js";
import type { User } from "../../domain/user.js";
import type { Clock } from "../../domain/ports/clock.js";
import { systemClock } from "../../domain/ports/clock.js";
import { authTransaction, consumeAuthLimit } from "./auth-transaction.js";

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  token_version: number;
  state: User["state"];
}
const userFrom = (row: UserRow): User => ({
  id: row.id,
  name: row.name,
  email: row.email,
  passwordHash: row.password_hash,
  tokenVersion: row.token_version,
  state: row.state,
});
async function userById(client: PoolClient, id: string) {
  const { rows } = await client.query<UserRow>(
    "select * from users where id = $1 and email is not null for update",
    [id],
  );
  return rows[0] ? userFrom(rows[0]) : null;
}

export function createSqlSessionStore(
  clock: Clock = systemClock,
): SessionStore {
  return {
    findByEmail: (email, deadline) =>
      authTransaction(deadline, async (client) => {
        const { rows } = await client.query<UserRow>(
          "select * from users where email = $1",
          [email],
        );
        return rows[0] ? userFrom(rows[0]) : null;
      }),
    consume: (key, limits, deadline) =>
      authTransaction(deadline, (client) =>
        consumeAuthLimit(client, key, limits, () => clock.now()),
      ),
    saveAttempt: (attempt, mailKeys, deadline) =>
      authTransaction(deadline, async (client) => {
        const user = await userById(client, attempt.userId);
        if (
          !user ||
          user.state !== "active" ||
          user.passwordHash !== attempt.passwordHash
        )
          throw new Error("User changed");
        await client.query("savepoint mail_admission");
        const emailRetry = await consumeAuthLimit(
          client,
          mailKeys.email,
          [
            { windowMs: 60000, maximum: 1 },
            { windowMs: 3600000, maximum: 5 },
          ],
          () => clock.now(),
        );
        const ipRetry = await consumeAuthLimit(
          client,
          mailKeys.ip,
          [{ windowMs: 3600000, maximum: 20 }],
          () => clock.now(),
        );
        const retry = Math.max(emailRetry, ipRetry);
        if (retry) {
          await client.query("rollback to savepoint mail_admission");
          return retry;
        }
        if (clock.now() >= attempt.codeExpiresAt)
          throw new Error("Deadline exceeded");
        await client.query(
          "insert into login_attempts (token_hash, user_id, token_version, code_hash, expires_at, code_expires_at, resend_available_at) values ($1, $2, $3, $4, $5, $6, $7)",
          [
            attempt.tokenHash,
            user.id,
            user.tokenVersion,
            attempt.codeHash,
            attempt.expiresAt,
            attempt.codeExpiresAt,
            attempt.resendAvailableAt,
          ],
        );
        return 0;
      }),
    verify: (tokenHash, codeHash, session, deadline) =>
      authTransaction(deadline, async (client) => {
        const found = await client.query<{ user_id: string }>(
          "select user_id from login_attempts where token_hash = $1",
          [tokenHash],
        );
        if (!found.rows[0]) return { status: "unavailable" };
        const user = await userById(client, found.rows[0].user_id);
        const { rows } = await client.query<{
          expires_at: Date;
          code_expires_at: Date;
          code_hash: string;
          failures: number;
          consumed_at: Date | null;
          token_version: number;
        }>("select * from login_attempts where token_hash = $1 for update", [
          tokenHash,
        ]);
        const attempt = rows[0];
        const now = clock.now();
        if (
          !user ||
          user.state !== "active" ||
          !attempt ||
          attempt.consumed_at ||
          attempt.expires_at <= now ||
          attempt.token_version !== user.tokenVersion
        )
          return { status: "unavailable" };
        const retry = await consumeAuthLimit(
          client,
          `login:verify:user:${user.id}`,
          [{ windowMs: 900000, maximum: 20 }],
          () => clock.now(),
        );
        if (retry) return { status: "limited", retryAfterSeconds: retry };
        if (attempt.expires_at <= clock.now()) return { status: "unavailable" };
        if (codeHash === null) return { status: "format" };
        if (attempt.code_expires_at <= clock.now())
          return { status: "expired" };
        if (attempt.code_hash !== codeHash) {
          const remainingAttempts = Math.max(0, 4 - attempt.failures);
          await client.query(
            "update login_attempts set failures = failures + 1, consumed_at = case when failures >= 4 then $2::timestamptz else null end where token_hash = $1",
            [tokenHash, clock.now()],
          );
          return { status: "invalid", remainingAttempts };
        }
        await client.query(
          "update login_attempts set consumed_at = $2 where token_hash = $1",
          [tokenHash, clock.now()],
        );
        await client.query(
          "insert into auth_sessions (token_hash, user_id, created_at, expires_at) values ($1, $2, $3, $4)",
          [
            session.tokenHash,
            user.id,
            clock.now(),
            new Date(clock.now().getTime() + session.ttlSeconds * 1000),
          ],
        );
        return { status: "verified", user };
      }),
    refresh: (tokenHash, ttlSeconds, deadline) =>
      authTransaction(deadline, async (client) => {
        const { rows } = await client.query<{
          user_id: string;
          expires_at: Date;
          revoked_at: Date | null;
        }>("select * from auth_sessions where token_hash = $1 for update", [
          tokenHash,
        ]);
        const session = rows[0];
        const now = clock.now();
        if (!session || session.revoked_at || session.expires_at <= now)
          return null;
        const users = await client.query<UserRow>(
          "select * from users where id = $1 and state = 'active' and email is not null",
          [session.user_id],
        );
        if (!users.rows[0]) return null;
        await client.query(
          "update auth_sessions set expires_at = $2 where token_hash = $1",
          [tokenHash, new Date(now.getTime() + ttlSeconds * 1000)],
        );
        return userFrom(users.rows[0]);
      }),
    revoke: (tokenHash, deadline) =>
      authTransaction(deadline, async (client) => {
        await client.query(
          "update auth_sessions set revoked_at = $2 where token_hash = $1 and revoked_at is null",
          [tokenHash, clock.now()],
        );
      }),
  };
}
