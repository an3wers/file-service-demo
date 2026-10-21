import nodemailer from "nodemailer";
import { connect } from "node:net";
import type { Socket } from "node:net";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
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
    async send(message, options) {
      options?.signal?.throwIfAborted();
      let socket: Socket | undefined;
      const getSocket: SMTPTransport.Options["getSocket"] = (
        _settings,
        callback,
      ) => {
        let handedOff = false;
        socket = connect({
          host: settings.host,
          port: settings.port,
          signal: options?.signal,
        });
        socket.setTimeout(settings.connectionTimeoutMs, () =>
          socket?.destroy(new Error("SMTP connection timed out")),
        );
        socket.once("error", (error) => {
          if (!handedOff) callback(error, {});
        });
        socket.once("connect", () => {
          handedOff = true;
          socket!.setTimeout(0);
          callback(null, { connection: socket });
        });
      };
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
        ...(options?.signal ? { getSocket } : {}),
      });
      const abort = () => transport.close();
      options?.signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await transport.sendMail(message);
        return {
          messageId: result.messageId,
          accepted: result.accepted,
          rejected: result.rejected,
        };
      } finally {
        options?.signal?.removeEventListener("abort", abort);
        transport.close();
        socket?.destroy();
      }
    },
  };
}
