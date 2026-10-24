import type { Clock } from "../domain/ports/clock.js";
import { LOGIN_MAIL_LIMITS } from "../domain/ports/session-store.js";
import type {
  SessionStore,
  LoginAttempt,
  StoredSession,
} from "../domain/ports/session-store.js";
import type { User } from "../domain/user.js";
import type { MailLimit } from "../domain/ports/registration-store.js";

export function createMemorySessionStore(clock: Clock) {
  const users = new Map<string, User>();
  const attempts = new Map<
    string,
    LoginAttempt & { failures: number; consumed: boolean; version: number }
  >();
  const sessions = new Map<
    string,
    StoredSession & { userId: string; expiresAt: Date; revoked: boolean }
  >();
  const events = new Map<string, number[]>();
  function consume(key: string, limits: readonly MailLimit[]): number {
    const now = clock.now().getTime();
    let retry = 0;
    for (const limit of limits) {
      const eventKey = `${key}:${limit.windowMs}`;
      const recent = (events.get(eventKey) ?? []).filter(
        (time) => time > now - limit.windowMs,
      );
      if (recent.length >= limit.maximum)
        retry = Math.max(
          retry,
          Math.ceil(
            (recent[recent.length - limit.maximum]! + limit.windowMs - now) /
              1000,
          ),
        );
      else recent.push(now);
      events.set(eventKey, recent);
    }
    return retry;
  }
  const store: SessionStore = {
    async findByEmail(email) {
      return [...users.values()].find((user) => user.email === email) ?? null;
    },
    async consume(key, limits) {
      return consume(key, limits);
    },
    async saveAttempt(attempt, keys) {
      const user = users.get(attempt.userId);
      if (
        !user ||
        user.state !== "active" ||
        user.passwordHash !== attempt.passwordHash
      )
        throw new Error("User changed");
      const retry = Math.max(
        consume(keys.email, LOGIN_MAIL_LIMITS),
        consume(keys.ip, [{ windowMs: 3600000, maximum: 20 }]),
      );
      if (retry) return retry;
      attempts.set(attempt.tokenHash, {
        ...attempt,
        failures: 0,
        consumed: false,
        version: user.tokenVersion,
      });
      return 0;
    },
    async resend(hash, code, mailKey, ipRetrySeconds) {
      const attempt = attempts.get(hash);
      const user = attempt ? users.get(attempt.userId) : undefined;
      if (
        !attempt ||
        attempt.consumed ||
        attempt.expiresAt <= clock.now() ||
        !user ||
        user.state !== "active" ||
        attempt.version !== user.tokenVersion
      )
        return { status: "unavailable" };
      const retry = Math.max(
        ipRetrySeconds,
        consume(mailKey(user.email), LOGIN_MAIL_LIMITS),
      );
      if (retry) return { status: "limited", retryAfterSeconds: retry };
      attempt.codeHash = code.codeHash;
      attempt.codeExpiresAt =
        code.codeExpiresAt < attempt.expiresAt
          ? code.codeExpiresAt
          : attempt.expiresAt;
      attempt.resendAvailableAt = code.resendAvailableAt;
      return {
        status: "replaced",
        email: user.email,
        expiresAt: attempt.expiresAt,
        codeExpiresAt: attempt.codeExpiresAt,
        resendAvailableAt: attempt.resendAvailableAt,
      };
    },
    async verify(hash, codeHash, session) {
      const attempt = attempts.get(hash);
      const user = attempt ? users.get(attempt.userId) : undefined;
      if (
        !attempt ||
        attempt.consumed ||
        attempt.expiresAt <= clock.now() ||
        !user ||
        user.state !== "active" ||
        attempt.version !== user.tokenVersion
      )
        return { status: "unavailable" };
      const retry = consume(`login:verify:user:${user.id}`, [
        { windowMs: 900000, maximum: 20 },
      ]);
      if (retry) return { status: "limited", retryAfterSeconds: retry };
      if (codeHash === null) return { status: "format" };
      if (attempt.codeExpiresAt <= clock.now()) return { status: "expired" };
      if (codeHash !== attempt.codeHash) {
        attempt.failures++;
        attempt.consumed = attempt.failures >= 5;
        return { status: "invalid", remainingAttempts: 5 - attempt.failures };
      }
      attempt.consumed = true;
      sessions.set(session.tokenHash, {
        ...session,
        userId: user.id,
        expiresAt: new Date(clock.now().getTime() + session.ttlSeconds * 1000),
        revoked: false,
      });
      return { status: "verified", user };
    },
    async refresh(hash, ttlSeconds) {
      const session = sessions.get(hash);
      const user = session ? users.get(session.userId) : undefined;
      if (
        !session ||
        session.revoked ||
        session.expiresAt <= clock.now() ||
        !user ||
        user.state !== "active"
      )
        return null;
      session.expiresAt = new Date(clock.now().getTime() + ttlSeconds * 1000);
      return user;
    },
    async revoke(hash) {
      const session = sessions.get(hash);
      if (session) session.revoked = true;
    },
  };
  return { store, users };
}
