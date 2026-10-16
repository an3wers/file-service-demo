import { createSmtpTransport } from "./adapters/smtp/nodemailer-transport.js";
import type { SmtpSettings } from "./adapters/smtp/nodemailer-transport.js";
import { createEmailNotification } from "./application/send-email.js";
import type { Notification } from "./domain/email.js";

export type {
  EmailMessage,
  EmailResult,
  Notification,
} from "./domain/email.js";
export { NotificationError } from "./domain/errors.js";
export type { NotificationErrorCode } from "./domain/errors.js";

export type NotificationSettings =
  { enabled: false } | { enabled: true; from: string; smtp: SmtpSettings };

export function createNotification(
  settings: NotificationSettings,
): Notification {
  return settings.enabled
    ? createEmailNotification(settings, createSmtpTransport(settings.smtp))
    : createEmailNotification({ enabled: false, from: "" });
}
