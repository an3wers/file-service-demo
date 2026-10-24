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
      transaction(deadline, (client) =>
        consumeAuthLimit(client, key, limits, now),
      ),
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
