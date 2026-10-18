import { z } from "zod";
import { NotificationError } from "./domain/errors.js";
import type { Notification } from "./domain/email.js";
import type { MailTransport } from "./domain/ports/mail-transport.js";

const messageSchema = z.strictObject({
  to: z.email(),
  subject: z.string().trim().min(1),
  text: z.string().refine((value) => value.trim().length > 0),
  html: z
    .string()
    .refine((value) => value.trim().length > 0)
    .optional(),
});

export function createNotification(
  settings: NotificationSettings,
): Notification {
  return {
    async sendEmail(message) {
      if (!messageSchema.safeParse(message).success)
        throw new NotificationError("INVALID_EMAIL_MESSAGE");
      if (!settings.enabled)
        throw new NotificationError("NOTIFICATION_DISABLED");
      let result;
      try {
        result = await settings.transport.send({
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
          from: settings.from,
        });
      } catch (cause) {
        const err = new NotificationError("EMAIL_SEND_FAILED", { cause });
        throw err;
      }
      if (
        result.messageId.trim().length === 0 ||
        result.accepted.length !== 1 ||
        normalizeDomain(result.accepted[0]!) !== normalizeDomain(message.to) ||
        result.rejected.length > 0
      )
        throw new NotificationError("EMAIL_SEND_FAILED");
      return { messageId: result.messageId };
    },
  };
}

function normalizeDomain(address: string): string {
  const separator = address.lastIndexOf("@");
  return (
    address.slice(0, separator + 1) + address.slice(separator + 1).toLowerCase()
  );
}

export type NotificationSettings =
  | { enabled: false }
  | { enabled: true; from: string; transport: MailTransport };

export type {
  EmailMessage,
  EmailResult,
  Notification,
} from "./domain/email.js";
export { NotificationError } from "./domain/errors.js";
export type { NotificationErrorCode } from "./domain/errors.js";
export type { MailTransport } from "./domain/ports/mail-transport.js";
export { createSmtpTransport } from "./adapters/smtp/nodemailer-transport.js";
