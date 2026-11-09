import { MAX_CODE_FAILURES } from "../domain/registration-policy.js";
import type { Clock } from "../domain/ports/clock.js";
import { LOGIN_MAIL_LIMITS } from "../domain/ports/session-store.js";
import type {
  SessionStore,
  LoginAttempt,
  StoredSession,
} from "../domain/ports/session-store.js";
import type { User } from "../domain/user.js";
import type {
  MailLimit,
  RegistrationAttemptRecord,
  RegistrationStore,
} from "../domain/ports/registration-store.js";

export interface MemoryRegistrationAttempt extends RegistrationAttemptRecord {
  email: string;
  userId: string | null;
  passwordHash: string | null;
  tokenVersion: number | null;
  failures: number;
  consumed: boolean;
}

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
  const registrationAttempts = new Map<string, MemoryRegistrationAttempt>();
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
      if (!user || user.passwordHash !== attempt.passwordHash)
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
        attempt.consumed = attempt.failures >= MAX_CODE_FAILURES;
        return { status: "invalid", remainingAttempts: MAX_CODE_FAILURES - attempt.failures };
      }
      attempt.consumed = true;
      user.state = "active";
      sessions.set(session.tokenHash, {
        ...session,
        userId: user.id,
        expiresAt: new Date(clock.now().getTime() + session.ttlSeconds * 1000),
        revoked: false,
      });
      return { status: "verified", user };
    },
    async verifyRegistration(hash, codeHash, session) {
      const attempt = registrationAttempts.get(hash);
      const now = clock.now();
      if (!attempt || attempt.consumed || attempt.expiresAt <= now)
        return { status: "unavailable" };
      const user = attempt.userId ? users.get(attempt.userId) : undefined;
      const usable =
        !!user &&
        user.state === "inactive" &&
        user.passwordHash === attempt.passwordHash &&
        user.tokenVersion === attempt.tokenVersion;
      if (attempt.userId && !usable) return { status: "unavailable" };
      if (codeHash === null) return { status: "format" };
      if (attempt.codeExpiresAt <= now) return { status: "expired" };
      if (!usable || codeHash !== attempt.codeHash) {
        attempt.failures++;
        attempt.consumed = attempt.failures >= MAX_CODE_FAILURES;
        return { status: "invalid", remainingAttempts: MAX_CODE_FAILURES - attempt.failures };
      }
      attempt.consumed = true;
      user.state = "active";
      sessions.set(session.tokenHash, {
        ...session,
        userId: user.id,
        expiresAt: new Date(now.getTime() + session.ttlSeconds * 1000),
        revoked: false,
      });
      return { status: "verified", user };
    },
    async refresh(hash) {
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
      return user;
    },
    async revoke(hash) {
      const session = sessions.get(hash);
      if (session) session.revoked = true;
    },
  };
  const registrationStore: RegistrationStore = {
    async consume(key, limits) {
      return consume(key, limits);
    },
    async save(record) {
      const existing = [...users.values()].find(
        (user) => user.email === record.email,
      );
      if (!existing)
        users.set(record.id, {
          id: record.id,
          name: record.name,
          email: record.email,
          passwordHash: record.passwordHash,
          tokenVersion: 0,
          state: "inactive",
        });
      registrationAttempts.set(record.attempt.tokenHash, {
        ...record.attempt,
        email: record.email,
        userId: existing ? null : record.id,
        passwordHash: existing ? null : record.passwordHash,
        tokenVersion: existing ? null : 0,
        failures: 0,
        consumed: false,
      });
      return existing ? existing.state : "created";
    },
    async resendRegistration(hash, code, mailQuota) {
      const attempt = registrationAttempts.get(hash);
      const now = clock.now();
      if (!attempt || attempt.consumed || attempt.expiresAt <= now)
        return { status: "unavailable" };
      const user = [...users.values()].find((u) => u.email === attempt.email);
      if (!user) return { status: "unavailable" };
      if (
        attempt.userId &&
        (user.state !== "inactive" ||
          user.passwordHash !== attempt.passwordHash ||
          user.tokenVersion !== attempt.tokenVersion)
      )
        return { status: "unavailable" };
      if (attempt.resendAvailableAt > now)
        return {
          status: "limited",
          retryAfterSeconds: Math.ceil(
            (attempt.resendAvailableAt.getTime() - now.getTime()) / 1000,
          ),
        };
      const retry = consume(mailQuota.key(attempt.email), mailQuota.limits);
      if (retry) return { status: "limited", retryAfterSeconds: retry };
      attempt.codeHash = code.codeHash;
      attempt.codeExpiresAt =
        code.codeExpiresAt < attempt.expiresAt
          ? code.codeExpiresAt
          : attempt.expiresAt;
      attempt.resendAvailableAt = code.resendAvailableAt;
      return {
        status: "replaced",
        outcome: attempt.userId ? "created" : user.state,
        email: attempt.email,
        expiresAt: attempt.expiresAt,
        codeExpiresAt: attempt.codeExpiresAt,
        resendAvailableAt: attempt.resendAvailableAt,
      };
    },
    async requestActivation() {
      return false;
    },
    async confirmActivation() {
      return false;
    },
    async requestPasswordReset() {
      return false;
    },
    async confirmPasswordReset() {
      return null;
    },
  };
  return { store, users, registrationStore, registrationAttempts };
}
