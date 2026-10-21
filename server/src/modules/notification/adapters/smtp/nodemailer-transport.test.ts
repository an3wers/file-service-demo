import { beforeEach, describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import { createSmtpTransport } from "./nodemailer-transport.js";

vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn() } }));

const settings = {
  host: "smtp.example.com",
  port: 465,
  tlsMode: "implicit" as const,
  user: "sender@example.com",
  password: "private-password",
  connectionTimeoutMs: 10000,
  greetingTimeoutMs: 10000,
  socketTimeoutMs: 30000,
};
const message = {
  from: "sender@example.com",
  to: "recipient@example.com",
  subject: "Тема",
  text: "Текст",
};
const sendMail = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(nodemailer.createTransport).mockReturnValue({
    sendMail,
    close: vi.fn(),
  } as unknown as ReturnType<typeof nodemailer.createTransport>);
  sendMail.mockResolvedValue({
    messageId: "smtp-id",
    accepted: [message.to],
    rejected: [],
    response: "250 ok",
  });
});

describe("SMTP-транспорт", () => {
  it("создаёт соединение только при отправке и возвращает идентификатор принятого письма", async () => {
    const transport = createSmtpTransport(settings);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(await transport.send(message)).toEqual({
      messageId: "smtp-id",
      accepted: [message.to],
      rejected: [],
    });
    expect(sendMail).toHaveBeenCalledExactlyOnceWith(message);
    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      requireTLS: true,
      opportunisticTLS: false,
      tls: { rejectUnauthorized: true },
      auth: { user: "sender@example.com", pass: "private-password" },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 30000,
      pool: false,
      logger: false,
      debug: false,
    });
  });
  it("требует STARTTLS и применяет отдельные таймауты без пула", async () => {
    await createSmtpTransport({
      ...settings,
      port: 587,
      tlsMode: "starttls",
      connectionTimeoutMs: 101,
      greetingTimeoutMs: 202,
      socketTimeoutMs: 303,
    }).send(message);
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 587,
        secure: false,
        requireTLS: true,
        opportunisticTLS: false,
        tls: { rejectUnauthorized: true },
        pool: false,
        connectionTimeout: 101,
        greetingTimeout: 202,
        socketTimeout: 303,
      }),
    );
  });

  it("передаёт исходную ошибку библиотеки без повтора", async () => {
    const cause = new Error("SMTP failure");
    sendMail.mockRejectedValue(cause);
    await expect(createSmtpTransport(settings).send(message)).rejects.toBe(
      cause,
    );
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
