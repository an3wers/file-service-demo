import { logger } from "../../../logger.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Notification } from "../../notification/index.js";
import type { Clock } from "../domain/ports/clock.js";
import type { PasswordHasher } from "../domain/ports/password-hasher.js";
import type {
  MailLimit,
  RegistrationStore,
} from "../domain/ports/registration-store.js";
import {
  ActivationLinkInvalidError,
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
}

type LinkPurpose = "activation" | "password-reset";
const LINKS = {
  activation: {
    path: "/activation",
    ttlMs: 86400000,
    subject: "Подтверждение email",
    text: (url: string) =>
      `Подтвердите email: ${url}\nСсылка действует 24 часа.`,
  },
  "password-reset": {
    path: "/password-reset",
    ttlMs: 1800000,
    subject: "Восстановление пароля",
    text: (url: string) =>
      `Задайте новый пароль: ${url}\nСсылка действует 30 минут.`,
  },
} as const;

export const REGISTRATION_MESSAGE =
  "Если требуется письмо, инструкции придут на email";

export function createRegistration({
  store,
  hasher,
  notification,
  clock,
  wait,
  publicUrl,
  deadlineMs,
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
    requestId?: string | number,
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
      logger.info(
        {
          purpose,
          outcome,
          durationMs: clock.now().getTime() - smtpStarted,
          requestId,
        },
        "Auth mail attempt",
      );
    }
  }
  async function sendLink(
    purpose: LinkPurpose,
    email: string,
    save: (tokenHash: string, expiresAt: Date) => Promise<boolean>,
    deadline: Date,
    mailRequestedAt: Date,
    requestId?: string | number,
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
          requestId,
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
          (mailRequestedAt.getTime() + 60000 - clock.now().getTime()) / 1000,
        ),
      ),
    };
  }
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
      purpose: LinkPurpose = "activation",
    ) =>
      consume(
        `mail:${purpose}:${digest(email)}`,
        [
          { windowMs: 60000, maximum: 1 },
          { windowMs: 3600000, maximum: 5 },
        ],
        deadline,
      ),
    consumeConfirmationIp: async (
      ip: string,
      deadline: Date,
      purpose: LinkPurpose = "activation",
    ) =>
      (
        await consume(
          `${purpose}:confirm:ip:${digest(ip)}`,
          [{ windowMs: 900000, maximum: 20 }],
          deadline,
        )
      ).retryAfterSeconds,
    requestActivation: (
      email: string,
      deadline: Date,
      mailRequestedAt: Date,
      requestId?: string | number,
    ) =>
      sendLink(
        "activation",
        email,
        (tokenHash, expiresAt) =>
          store.requestActivation(email, tokenHash, expiresAt, deadline),
        deadline,
        mailRequestedAt,
        requestId,
      ),
    requestPasswordReset: (
      email: string,
      deadline: Date,
      mailRequestedAt: Date,
      requestId?: string | number,
    ) =>
      sendLink(
        "password-reset",
        email,
        (tokenHash, expiresAt) =>
          store.requestPasswordReset(email, tokenHash, expiresAt, deadline),
        deadline,
        mailRequestedAt,
        requestId,
      ),
    async confirmPasswordReset(
      token: string,
      password: string,
      deadline: Date,
      requestId?: string | number,
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
        requestId,
      );
      return { message: "Пароль изменён. Теперь можно войти" as const };
    },
    async confirmActivation(token: string, deadline: Date) {
      let confirmed: boolean;
      try {
        confirmed = await withinDeadline(deadline, () =>
          store.confirmActivation(digest(token), deadline),
        );
      } catch {
        throw new RegistrationUnavailableError();
      }
      if (!confirmed) throw new ActivationLinkInvalidError();
      return { message: "Email подтверждён. Теперь можно войти" as const };
    },
    async register(
      input: RegistrationInput,
      deadline: Date,
      mailRequestedAt: Date,
      requestId?: string | number,
    ) {
      try {
        const passwordHash = await withinDeadline(deadline, () =>
          hasher.hash(input.password),
        );
        return await sendLink(
          "activation",
          input.email,
          (tokenHash, expiresAt) =>
            store.save(
              {
                id: randomUUID(),
                name: input.name,
                email: input.email,
                passwordHash,
                tokenHash,
                expiresAt,
              },
              deadline,
            ),
          deadline,
          mailRequestedAt,
          requestId,
        );
      } catch {
        throw new RegistrationUnavailableError();
      }
    },
  };
}

export type Registration = ReturnType<typeof createRegistration>;
