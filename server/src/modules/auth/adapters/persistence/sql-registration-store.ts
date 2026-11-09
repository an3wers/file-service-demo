import {
  authTransaction as transaction,
  consumeAuthLimit,
} from "./auth-transaction.js";
import { systemClock } from "../../domain/ports/clock.js";
import type { Clock } from "../../domain/ports/clock.js";
import type {
  MailEventCleanup,
  RegistrationStore,
} from "../../domain/ports/registration-store.js";

export function createSqlRegistrationStore(
  clock: Clock = systemClock,
): RegistrationStore & MailEventCleanup {
  return {
    resendRegistration: (tokenHash, code, mailQuota, now, deadline) =>
      transaction(deadline, async (client) => {
        const { rows } = await client.query<{
          user_id: string | null;
          password_hash: string | null;
          token_version: number | null;
          email: string | null;
          expires_at: Date;
          resend_available_at: Date;
          consumed_at: Date | null;
        }>(
          "select * from registration_attempts where token_hash = $1 for update",
          [tokenHash],
        );
        const attempt = rows[0];
        if (
          !attempt ||
          !attempt.email ||
          attempt.consumed_at ||
          attempt.expires_at <= now
        )
          return { status: "unavailable" };
        const users = await client.query<{
          state: "active" | "inactive";
          password_hash: string;
          token_version: number;
        }>(
          "select state, password_hash, token_version from users where email = $1 for share",
          [attempt.email],
        );
        const user = users.rows[0];
        if (!user) return { status: "unavailable" };
        if (
          attempt.user_id &&
          (user.state !== "inactive" ||
            user.password_hash !== attempt.password_hash ||
            user.token_version !== attempt.token_version)
        )
          return { status: "unavailable" };
        if (attempt.resend_available_at > now)
          return {
            status: "limited",
            retryAfterSeconds: Math.ceil(
              (attempt.resend_available_at.getTime() - now.getTime()) / 1000,
            ),
          };
        const retry = await consumeAuthLimit(
          client,
          mailQuota.key(attempt.email),
          mailQuota.limits,
          now,
        );
        if (retry > 0) return { status: "limited", retryAfterSeconds: retry };
        const updated = await client.query<{
          expires_at: Date;
          code_expires_at: Date;
          resend_available_at: Date;
        }>(
          "update registration_attempts set code_hash = $2, code_expires_at = least($3::timestamptz, expires_at), resend_available_at = $4 where token_hash = $1 returning expires_at, code_expires_at, resend_available_at",
          [
            tokenHash,
            code.codeHash,
            code.codeExpiresAt,
            code.resendAvailableAt,
          ],
        );
        const row = updated.rows[0]!;
        return {
          status: "replaced",
          outcome: attempt.user_id ? "created" : user.state,
          email: attempt.email,
          expiresAt: row.expires_at,
          codeExpiresAt: row.code_expires_at,
          resendAvailableAt: row.resend_available_at,
        };
      }),
    requestPasswordReset: (email, tokenHash, expiresAt, deadline) =>
      transaction(deadline, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          "select id from users where email = $1 for update",
          [email],
        );
        if (!rows[0]) return false;
        await client.query(
          "insert into auth_secrets (user_id, purpose, token_hash, expires_at) values ($1, 'password-reset', $2, $3) on conflict (user_id, purpose) do update set token_hash = excluded.token_hash, expires_at = excluded.expires_at",
          [rows[0].id, tokenHash, expiresAt],
        );
        return true;
      }),
    confirmPasswordReset: (tokenHash, passwordHash, deadline) =>
      transaction(deadline, async (client) => {
        const { rows } = await client.query<{ user_id: string }>(
          "select user_id from auth_secrets where token_hash = $1 and purpose = 'password-reset'",
          [tokenHash],
        );
        const secret = rows[0];
        if (!secret) return null;
        await client.query("select id from users where id = $1 for update", [
          secret.user_id,
        ]);
        const now = clock.now();
        const consumed = await client.query(
          "delete from auth_secrets where user_id = $1 and purpose = 'password-reset' and token_hash = $2 and expires_at > $3",
          [secret.user_id, tokenHash, now],
        );
        if (!consumed.rowCount) return null;
        const user = await client.query<{ email: string }>(
          "update users set password_hash = $2, state = 'active', token_version = token_version + 1 where id = $1 returning email",
          [secret.user_id, passwordHash],
        );
        await client.query("delete from auth_secrets where user_id = $1", [
          secret.user_id,
        ]);
        await client.query(
          "update login_attempts set consumed_at = $2 where user_id = $1 and consumed_at is null",
          [secret.user_id, now],
        );
        await client.query(
          "update registration_attempts set consumed_at = $2 where user_id = $1 and consumed_at is null",
          [secret.user_id, now],
        );
        await client.query(
          "update auth_sessions set revoked_at = $2 where user_id = $1 and revoked_at is null",
          [secret.user_id, now],
        );
        return user.rows[0]!.email;
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
    removeFinishedAttempts: (now) =>
      transaction(
        new Date(Date.now() + 15000),
        async (client) =>
          (
            await client.query(
              "delete from registration_attempts where ctid in (select ctid from registration_attempts where consumed_at is not null or expires_at <= $1::timestamptz limit 1000 for update skip locked)",
              [now],
            )
          ).rowCount ?? 0,
      ),
    consume: (key, limits, now, deadline) =>
      transaction(deadline, (client) =>
        consumeAuthLimit(client, key, limits, now),
      ),
    save: (record, deadline) =>
      transaction(deadline, async (client) => {
        const inserted = await client.query(
          "insert into users (id, login, name, email, password_hash, state) values ($1::uuid, $1::text, $2, $3, $4, 'inactive') on conflict (email) do nothing returning id",
          [record.id, record.name, record.email, record.passwordHash],
        );
        const attempt = record.attempt;
        await client.query(
          "insert into registration_attempts (token_hash, user_id, password_hash, token_version, code_hash, expires_at, code_expires_at, resend_available_at, email) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
          [
            attempt.tokenHash,
            inserted.rowCount ? record.id : null,
            inserted.rowCount ? record.passwordHash : null,
            inserted.rowCount ? 0 : null,
            attempt.codeHash,
            attempt.expiresAt,
            attempt.codeExpiresAt,
            attempt.resendAvailableAt,
            record.email,
          ],
        );
        if (inserted.rowCount) return "created";
        const { rows } = await client.query<{ state: "active" | "inactive" }>(
          "select state from users where email = $1",
          [record.email],
        );
        return rows[0]!.state;
      }),
  };
}
