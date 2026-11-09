import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  registrationAttemptDigest,
  registrationCodeDigest,
} from "./attempt-secrets.js";
import type { Notification } from "../../notification/index.js";
import { logMailAttempt, type MailLog } from "./mail-log.js";
import type { Clock } from "../domain/ports/clock.js";
import type { PasswordHasher } from "../domain/ports/password-hasher.js";
import type {
  MailLimit,
  RegistrationStore,
  SaveOutcome,
} from "../domain/ports/registration-store.js";
import {
  CONFIRMATION_IP_WINDOW_MS,
  REGISTRATION_ATTEMPT_TTL_MS,
  REGISTRATION_CODE_TTL_MS,
  REGISTRATION_RESEND_WAIT_MS,
} from "../domain/registration-policy.js";
import { RegistrationAttemptInvalidError } from "../domain/errors.js";
import {
  MailRateLimitedError,
  PasswordResetLinkInvalidError,
  RegistrationUnavailableError,
} from "../domain/registration-errors.js";

export interface RegistrationInput {
  name: string;
  email: string;
  password: string;
}
export interface RegistrationDeps {
  store: RegistrationStore;
  hasher: PasswordHasher;
  notification: Notification;
  clock: Clock;
  wait(ms: number): Promise<void>;
  publicUrl: string;
  deadlineMs: number;
  codeSecret: string;
}

type LinkPurpose = "password-reset";
const LINKS = {
  "password-reset": {
    path: "/password-reset",
    ttlMs: 1800000,
    subject: "Восстановление пароля",
    text: (url: string) =>
      `Задайте новый пароль: ${url}\nСсылка действует 30 минут.`,
  },
} as const;

const ACCESS_INSTRUCTIONS = {
  active: (login: string, reset: string) =>
    `На этот адрес уже зарегистрирован аккаунт.\n\nЧтобы продолжить, войдите в него: ${login}\nЕсли не помните пароль, восстановите доступ: ${reset}\n\nЕсли вы не начинали регистрацию, можете проигнорировать письмо. Этот запрос не изменил данные вашего аккаунта.`,
  inactive: (login: string, reset: string) =>
    `На этот адрес уже зарегистрирован аккаунт.\n\nЕсли вы не завершили регистрацию, восстановите доступ и задайте собственный пароль: ${reset}\nЕсли аккаунт уже подтверждён, войдите в него: ${login}\n\nЕсли вы не начинали регистрацию, можете проигнорировать письмо. Этот запрос не изменил данные вашего аккаунта.`,
} as const;

export const REGISTRATION_MESSAGE =
  "Если требуется письмо, инструкции придут на email";

const EMAIL_MAIL_LIMITS: readonly MailLimit[] = [
  { windowMs: REGISTRATION_RESEND_WAIT_MS, maximum: 1 },
  { windowMs: 3600000, maximum: 5 },
];

export function createRegistration({
  store,
  hasher,
  notification,
  clock,
  wait,
  publicUrl,
  deadlineMs,
  codeSecret,
}: RegistrationDeps) {
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  async function withinDeadline<T>(
    deadline: Date,
    action: () => Promise<T>,
  ): Promise<T> {
    const remaining = deadline.getTime() - clock.now().getTime();
    if (remaining <= 0) throw new RegistrationUnavailableError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        action(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new RegistrationUnavailableError()),
            remaining,
          );
        }),
      ]);
      if (clock.now() >= deadline) throw new RegistrationUnavailableError();
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
  async function consume(
    key: string,
    limits: readonly MailLimit[],
    deadline: Date,
  ) {
    let retry: number;
    const now = clock.now();
    try {
      retry = await withinDeadline(deadline, () =>
        store.consume(key, limits, now, deadline),
      );
    } catch {
      throw new RegistrationUnavailableError();
    }
    return { retryAfterSeconds: retry, requestedAt: now };
  }
  async function deliver(
    message: { to: string; subject: string; text: string },
    deadline: Date,
    purpose: string,
    log: MailLog,
  ) {
    const remaining = deadline.getTime() - clock.now().getTime();
    if (remaining <= 0) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    const smtpStarted = clock.now().getTime();
    let outcome = "unconfirmed";
    try {
      await Promise.race([
        notification
          .sendEmail(message, { signal: controller.signal })
          .then(() => {
            outcome = "accepted";
          }),
        new Promise<void>((resolve) =>
          controller.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        ),
      ]).catch(() => undefined);
    } finally {
      clearTimeout(timer);
      logMailAttempt(log, {
        purpose,
        outcome,
        durationMs: clock.now().getTime() - smtpStarted,
      });
    }
  }
  async function sendLink(
    purpose: LinkPurpose,
    email: string,
    save: (tokenHash: string, expiresAt: Date) => Promise<boolean>,
    deadline: Date,
    mailRequestedAt: Date,
    log: MailLog,
  ) {
    const link = LINKS[purpose];
    try {
      const token = randomBytes(32).toString("base64url");
      const send = await withinDeadline(deadline, () =>
        save(digest(token), new Date(clock.now().getTime() + link.ttlMs)),
      );
      if (send) {
        const url = new URL(link.path, publicUrl);
        url.hash = `token=${token}`;
        await deliver(
          { to: email, subject: link.subject, text: link.text(url.href) },
          deadline,
          purpose,
          log,
        );
      }
    } catch {
      throw new RegistrationUnavailableError();
    }
    while (clock.now() < deadline)
      await wait(deadline.getTime() - clock.now().getTime());
    return {
      message: REGISTRATION_MESSAGE,
      retryAfterSeconds: Math.max(
        0,
        Math.ceil(
          (mailRequestedAt.getTime() + REGISTRATION_RESEND_WAIT_MS - clock.now().getTime()) / 1000,
        ),
      ),
    };
  }
  const outcomeMail = (outcome: SaveOutcome, email: string, code: string) =>
    outcome === "created"
      ? {
          to: email,
          subject: "Код подтверждения",
          text: `Код подтверждения: ${code}\nКод действует 5 минут.`,
        }
      : {
          to: email,
          subject: "Продолжение регистрации",
          text: ACCESS_INSTRUCTIONS[outcome](
            new URL("/login", publicUrl).href,
            new URL("/password-reset", publicUrl).href,
          ),
        };
  const outcomePurpose = (outcome: SaveOutcome) =>
    outcome === "created" ? "registration-code" : "registration-instructions";
  return {
    deadline: () => new Date(clock.now().getTime() + deadlineMs),
    withinDeadline,
    consumeIp: async (ip: string, deadline: Date) =>
      (
        await consume(
          `mail:ip:${digest(ip)}`,
          [{ windowMs: 3600000, maximum: 20 }],
          deadline,
        )
      ).retryAfterSeconds,
    consumeEmail: (
      email: string,
      deadline: Date,
      purpose: "activation" | LinkPurpose = "activation",
    ) =>
      consume(`mail:${purpose}:${digest(email)}`, EMAIL_MAIL_LIMITS, deadline),
    consumeConfirmationIp: async (ip: string, deadline: Date) =>
      (
        await consume(
          `password-reset:confirm:ip:${digest(ip)}`,
          [{ windowMs: CONFIRMATION_IP_WINDOW_MS, maximum: 20 }],
          deadline,
        )
      ).retryAfterSeconds,
    requestPasswordReset: (
      email: string,
      deadline: Date,
      mailRequestedAt: Date,
      log: MailLog,
    ) =>
      sendLink(
        "password-reset",
        email,
        (tokenHash, expiresAt) =>
          store.requestPasswordReset(email, tokenHash, expiresAt, deadline),
        deadline,
        mailRequestedAt,
        log,
      ),
    async confirmPasswordReset(
      token: string,
      password: string,
      deadline: Date,
      log: MailLog,
    ) {
      let email: string | null;
      try {
        const passwordHash = await withinDeadline(deadline, () =>
          hasher.hash(password),
        );
        email = await withinDeadline(deadline, () =>
          store.confirmPasswordReset(digest(token), passwordHash, deadline),
        );
      } catch {
        throw new RegistrationUnavailableError();
      }
      if (email === null) throw new PasswordResetLinkInvalidError();
      await deliver(
        {
          to: email,
          subject: "Ваш пароль изменён",
          text: "Пароль вашей учётной записи изменён. Если это были не вы, восстановите пароль на странице входа.",
        },
        new Date(clock.now().getTime() + deadlineMs),
        "password-changed",
        log,
      );
      return { message: "Пароль изменён. Теперь можно войти" as const };
    },
    async resendRegistration(
      attemptToken: string,
      deadline: Date,
      log: MailLog,
    ) {
      const now = clock.now();
      const requested = now.getTime();
      const tokenHash = registrationAttemptDigest(attemptToken);
      const code = randomInt(1000000).toString().padStart(6, "0");
      let result;
      try {
        result = await withinDeadline(deadline, () =>
          store.resendRegistration(
            tokenHash,
            {
              codeHash: registrationCodeDigest(codeSecret, tokenHash, code),
              codeExpiresAt: new Date(requested + REGISTRATION_CODE_TTL_MS),
              resendAvailableAt: new Date(requested + REGISTRATION_RESEND_WAIT_MS),
            },
            {
              key: (email) => `mail:activation:${digest(email)}`,
              limits: EMAIL_MAIL_LIMITS,
            },
            now,
            deadline,
          ),
        );
      } catch {
        throw new RegistrationUnavailableError();
      }
      if (result.status === "unavailable")
        throw new RegistrationAttemptInvalidError();
      if (result.status === "limited")
        throw new MailRateLimitedError(result.retryAfterSeconds);
      await deliver(
        outcomeMail(result.outcome, result.email, code),
        deadline,
        outcomePurpose(result.outcome),
        log,
      );
      while (clock.now() < deadline)
        await wait(deadline.getTime() - clock.now().getTime());
      return {
        message: REGISTRATION_MESSAGE,
        retryAfterSeconds: Math.max(
          0,
          Math.ceil((requested + REGISTRATION_RESEND_WAIT_MS - clock.now().getTime()) / 1000),
        ),
        attemptExpiresAt: result.expiresAt.toISOString(),
        codeExpiresAt: result.codeExpiresAt.toISOString(),
        resendAvailableAt: result.resendAvailableAt.toISOString(),
      };
    },
    async register(
      input: RegistrationInput,
      deadline: Date,
      mailRequestedAt: Date,
      log: MailLog,
    ) {
      const attemptToken = randomBytes(32).toString("base64url");
      const tokenHash = registrationAttemptDigest(attemptToken);
      const code = randomInt(1000000).toString().padStart(6, "0");
      const requested = mailRequestedAt.getTime();
      const attempt = {
        tokenHash,
        codeHash: registrationCodeDigest(codeSecret, tokenHash, code),
        expiresAt: new Date(requested + REGISTRATION_ATTEMPT_TTL_MS),
        codeExpiresAt: new Date(requested + REGISTRATION_CODE_TTL_MS),
        resendAvailableAt: new Date(requested + REGISTRATION_RESEND_WAIT_MS),
      };
      try {
        const passwordHash = await withinDeadline(deadline, () =>
          hasher.hash(input.password),
        );
        const outcome = await withinDeadline(deadline, () =>
          store.save(
            {
              id: randomUUID(),
              name: input.name,
              email: input.email,
              passwordHash,
              attempt,
            },
            deadline,
          ),
        );
        await deliver(
          outcomeMail(outcome, input.email, code),
          deadline,
          outcomePurpose(outcome),
          log,
        );
      } catch {
        throw new RegistrationUnavailableError();
      }
      while (clock.now() < deadline)
        await wait(deadline.getTime() - clock.now().getTime());
      return {
        message: REGISTRATION_MESSAGE,
        retryAfterSeconds: Math.max(
          0,
          Math.ceil((requested + REGISTRATION_RESEND_WAIT_MS - clock.now().getTime()) / 1000),
        ),
        attemptToken,
        attemptExpiresAt: attempt.expiresAt.toISOString(),
        codeExpiresAt: attempt.codeExpiresAt.toISOString(),
        resendAvailableAt: attempt.resendAvailableAt.toISOString(),
      };
    },
  };
}

export type Registration = ReturnType<typeof createRegistration>;
