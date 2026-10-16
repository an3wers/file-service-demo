import { logger } from "../../../logger.js";
import { z } from "zod";
import { NotificationError } from "../domain/errors.js";
import type { Notification } from "../domain/email.js";
import type { MailTransport } from "../domain/ports/mail-transport.js";

const messageSchema = z.strictObject({
  to: z.email(),
  subject: z.string().trim().min(1),
  text: z.string().refine((value) => value.trim().length > 0),
  html: z
    .string()
    .refine((value) => value.trim().length > 0)
    .optional(),
});

export function createEmailNotification(
  settings: { from: string; enabled: boolean },
  transport?: MailTransport,
): Notification {
  return {
    async sendEmail(message) {
      if (!messageSchema.safeParse(message).success)
        throw new NotificationError("INVALID_EMAIL_MESSAGE");
      if (!settings.enabled)
        throw new NotificationError("NOTIFICATION_DISABLED");
      try {
        if (!transport) throw new NotificationError("EMAIL_SEND_FAILED");
        const result = await transport.send({
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
          from: settings.from,
        });
        return { messageId: result.messageId };
      } catch {
        const err = new NotificationError("EMAIL_SEND_FAILED");
        logger.warn({ err }, "Email submission failed");
        throw err;
      }
    },
  };
}
