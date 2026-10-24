import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import type { Notification } from "../../notification/index.js";
import type { PasswordHasher } from "../domain/ports/password-hasher.js";
import type { Tokens } from "../domain/ports/tokens.js";
import type { SessionStore } from "../domain/ports/session-store.js";
import type { Clock } from "../domain/ports/clock.js";
import type { User } from "../domain/user.js";
import {
  InvalidCredentialsError,
  SessionExpiredError,
  EmailNotVerifiedError,
  LoginAttemptInvalidError,
  LoginCodeExpiredError,
  LoginCodeInvalidError,
  LoginCodeFormatError,
} from "../domain/errors.js";
import {
  MailRateLimitedError,
  RegistrationUnavailableError,
} from "../domain/registration-errors.js";

const REFRESH_TTL_SECONDS = 604800;
const secretDigest = (purpose: string, value: string) =>
  createHash("sha256").update(`${purpose}\0${value}`).digest("hex");

export interface SessionsDeps {
  store: SessionStore;
  hasher: PasswordHasher;
  tokens: Tokens;
  notification: Notification;
  clock: Clock;
  codeSecret: string;
  deadlineMs?: number;
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
  user: { id: string; name: string; email: string };
}

export function createSessionsModule({
  store,
  hasher,
  tokens,
  notification,
  clock,
  codeSecret,
  deadlineMs = 15000,
}: SessionsDeps) {
  const deadline = () => new Date(Date.now() + deadlineMs);
  const codeDigest = (attemptHash: string, code: string) =>
    createHmac("sha256", codeSecret)
      .update(`login-code\0${attemptHash}\0${code}`)
      .digest("hex");
  async function available<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch {
      throw new RegistrationUnavailableError();
    }
  }
  async function withinDeadline<T>(
    until: Date,
    run: () => Promise<T>,
  ): Promise<T> {
    const remaining = until.getTime() - Date.now();
    if (remaining <= 0) throw new RegistrationUnavailableError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new RegistrationUnavailableError()),
            remaining,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const retryAfter = (key: string, maximum: number, until: Date) =>
    available(() => store.consume(key, [{ windowMs: 900000, maximum }], until));
  async function consume(key: string, maximum: number, until: Date) {
    const retry = await retryAfter(key, maximum, until);
    if (retry) throw new MailRateLimitedError(retry);
  }
  const mailIpKey = (ip: string) =>
    `mail:ip:${createHash("sha256").update(ip).digest("hex")}`;
  const mailEmailKey = (email: string) =>
    `mail:login:${secretDigest("email", email)}`;
  const newCode = () => randomInt(1000000).toString().padStart(6, "0");
  async function deliver(
    email: string,
    code: string,
    until: Date,
  ): Promise<"accepted" | "unconfirmed"> {
    const remaining = until.getTime() - Date.now();
    if (remaining <= 0) return "unconfirmed";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      return await Promise.race([
        notification
          .sendEmail(
            {
              to: email,
              subject: "Код входа",
              text: `Код входа: ${code}\nКод действует пять минут.`,
            },
            { signal: controller.signal },
          )
          .then(() => "accepted" as const),
        new Promise<"unconfirmed">((resolve) =>
          controller.signal.addEventListener(
            "abort",
            () => resolve("unconfirmed"),
            { once: true },
          ),
        ),
      ]);
    } catch {
      return "unconfirmed";
    } finally {
      clearTimeout(timer);
    }
  }
  async function issueSession(
    user: User,
    refreshToken: string,
  ): Promise<Session> {
    const access = await available(() => tokens.issueAccess(user.id));
    return {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken,
      refreshExpiresIn: REFRESH_TTL_SECONDS,
      user: { id: user.id, name: user.name, email: user.email },
    };
  }
  return {
    deadline,
    withinDeadline,
    now: () => clock.now(),
    consumeLoginIp: (ip: string, until: Date) =>
      retryAfter(`login:ip:${secretDigest("ip", ip)}`, 50, until),
    consumeLoginEmail: (email: string, until: Date) =>
      retryAfter(`login:email:${secretDigest("email", email)}`, 10, until),
    consumeVerifyIp: (ip: string, until: Date) =>
      consume(`login:verify:ip:${secretDigest("ip", ip)}`, 100, until),
    consumeMailIp: (ip: string, until: Date) =>
      available(() =>
        store.consume(
          mailIpKey(ip),
          [{ windowMs: 3600000, maximum: 20 }],
          until,
        ),
      ),
    async login(email: string, password: string, ip: string, until: Date) {
      const user = await available(() => store.findByEmail(email, until));
      const correct = user
        ? await available(() => hasher.verify(password, user.passwordHash))
        : (await available(() => hasher.hash(password)), false);
      if (!correct || !user) throw new InvalidCredentialsError();
      if (user.state !== "active") throw new EmailNotVerifiedError();
      const attemptToken = randomBytes(32).toString("base64url");
      const tokenHash = secretDigest("login-attempt", attemptToken);
      const code = newCode();
      const now = clock.now().getTime();
      const attempt = {
        tokenHash,
        userId: user.id,
        passwordHash: user.passwordHash,
        codeHash: codeDigest(tokenHash, code),
        expiresAt: new Date(now + 900000),
        codeExpiresAt: new Date(now + 300000),
        resendAvailableAt: new Date(now + 60000),
      };
      const retry = await available(() =>
        store.saveAttempt(
          attempt,
          { email: mailEmailKey(email), ip: mailIpKey(ip) },
          until,
        ),
      );
      if (retry) throw new MailRateLimitedError(retry);
      const deliveryStatus = await deliver(user.email, code, until);
      return {
        attemptToken,
        attemptExpiresAt: attempt.expiresAt.toISOString(),
        codeExpiresAt: attempt.codeExpiresAt.toISOString(),
        resendAvailableAt: attempt.resendAvailableAt.toISOString(),
        deliveryStatus,
      };
    },
    async resend(attemptToken: string, ipRetrySeconds: number, until: Date) {
      const tokenHash = secretDigest("login-attempt", attemptToken);
      const code = newCode();
      const now = clock.now().getTime();
      const result = await available(() =>
        store.resend(
          tokenHash,
          {
            codeHash: codeDigest(tokenHash, code),
            codeExpiresAt: new Date(now + 300000),
            resendAvailableAt: new Date(now + 60000),
          },
          mailEmailKey,
          ipRetrySeconds,
          until,
        ),
      );
      if (result.status === "unavailable") throw new LoginAttemptInvalidError();
      if (result.status === "limited")
        throw new MailRateLimitedError(result.retryAfterSeconds);
      const deliveryStatus = await deliver(result.email, code, until);
      return {
        attemptExpiresAt: result.expiresAt.toISOString(),
        codeExpiresAt: result.codeExpiresAt.toISOString(),
        resendAvailableAt: result.resendAvailableAt.toISOString(),
        deliveryStatus,
      };
    },
    async verify(attemptToken: string, code: string | null, until: Date) {
      const refreshToken = randomBytes(32).toString("base64url");
      const tokenHash = secretDigest("login-attempt", attemptToken);
      const result = await available(() =>
        store.verify(
          tokenHash,
          code === null ? null : codeDigest(tokenHash, code),
          {
            tokenHash: secretDigest("refresh-session", refreshToken),
            ttlSeconds: REFRESH_TTL_SECONDS,
          },
          until,
        ),
      );
      if (result.status === "unavailable") throw new LoginAttemptInvalidError();
      if (result.status === "format") throw new LoginCodeFormatError();
      if (result.status === "expired") throw new LoginCodeExpiredError();
      if (result.status === "invalid")
        throw new LoginCodeInvalidError(result.remainingAttempts);
      if (result.status === "limited")
        throw new MailRateLimitedError(result.retryAfterSeconds);
      if (result.status !== "verified")
        throw new RegistrationUnavailableError();
      return issueSession(result.user, refreshToken);
    },
    async refresh(refreshToken: string | undefined, until: Date) {
      const user = refreshToken
        ? await available(() =>
            store.refresh(
              secretDigest("refresh-session", refreshToken),
              REFRESH_TTL_SECONDS,
              until,
            ),
          )
        : null;
      if (!user || !refreshToken) throw new SessionExpiredError();
      return issueSession(user, refreshToken);
    },
    async logout(refreshToken: string | undefined, until: Date) {
      if (refreshToken)
        await available(() =>
          store.revoke(secretDigest("refresh-session", refreshToken), until),
        );
    },
    authenticate: (accessToken: string) => tokens.verifyAccess(accessToken),
  };
}
export type SessionsModule = ReturnType<typeof createSessionsModule>;
