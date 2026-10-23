import { logger } from "../../../logger.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Notification } from "../../notification/index.js";
import type { Clock } from "../domain/ports/clock.js";
import type { PasswordHasher } from "../domain/ports/password-hasher.js";
import type {
  MailLimit,
  RegistrationStore,
} from "../domain/ports/registration-store.js";
import { RegistrationUnavailableError } from "../domain/registration-errors.js";

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
    consumeEmail: (email: string, deadline: Date) =>
      consume(
        `mail:activation:${digest(email)}`,
        [
          { windowMs: 60000, maximum: 1 },
          { windowMs: 3600000, maximum: 5 },
        ],
        deadline,
      ),
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
        const token = randomBytes(32).toString("base64url");
        const send = await withinDeadline(deadline, () =>
          store.save(
            {
              id: randomUUID(),
              name: input.name,
              email: input.email,
              passwordHash,
              tokenHash: digest(token),
              expiresAt: new Date(clock.now().getTime() + 86400000),
            },
            deadline,
          ),
        );
        const remaining = deadline.getTime() - clock.now().getTime();
        if (send && remaining > 0) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), remaining);
          const link = new URL("/activation", publicUrl);
          link.hash = `token=${token}`;
          const smtpStarted = clock.now().getTime();
          let outcome = "unconfirmed";
          try {
            await Promise.race([
              notification
                .sendEmail(
                  {
                    to: input.email,
                    subject: "Подтверждение email",
                    text: `Подтвердите email: ${link.href}\nСсылка действует 24 часа.`,
                  },
                  { signal: controller.signal },
                )
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
                purpose: "activation",
                outcome,
                durationMs: clock.now().getTime() - smtpStarted,
                requestId,
              },
              "Auth mail attempt",
            );
          }
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
    },
  };
}

export type Registration = ReturnType<typeof createRegistration>;
