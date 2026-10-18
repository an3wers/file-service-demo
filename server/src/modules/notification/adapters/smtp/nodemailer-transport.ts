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
      return {
        messageId: result.messageId,
        accepted: result.accepted,
        rejected: result.rejected,
      };
    },
  };
}
