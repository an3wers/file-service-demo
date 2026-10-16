import { NotificationError } from "../../domain/errors.js";
import nodemailer from "nodemailer";
import type { MailTransport } from "../../domain/ports/mail-transport.js";

export interface SmtpSettings {
  host: string;
  port: number;
  tlsMode: "implicit" | "starttls";
  user: string;
  password: string;
  connectionTimeoutMs: number;
  greetingTimeoutMs: number;
  socketTimeoutMs: number;
}

export function createSmtpTransport(settings: SmtpSettings): MailTransport {
  return {
    async send(message) {
      try {
        const transport = nodemailer.createTransport({
          host: settings.host,
          port: settings.port,
          secure: settings.tlsMode === "implicit",
          requireTLS: true,
          opportunisticTLS: false,
          tls: { rejectUnauthorized: true },
          auth: { user: settings.user, pass: settings.password },
          connectionTimeout: settings.connectionTimeoutMs,
          greetingTimeout: settings.greetingTimeoutMs,
          socketTimeout: settings.socketTimeoutMs,
          pool: false,
          logger: false,
          debug: false,
        });
        const result = await transport.sendMail(message);
        if (
          typeof result.messageId !== "string" ||
          result.messageId.trim().length === 0 ||
          result.accepted.length !== 1 ||
          result.accepted[0] !== message.to ||
          result.rejected.length > 0
        ) {
          throw new NotificationError("EMAIL_SEND_FAILED");
        }
        return { messageId: result.messageId };
      } catch {
        throw new NotificationError("EMAIL_SEND_FAILED");
      }
    },
  };
}
