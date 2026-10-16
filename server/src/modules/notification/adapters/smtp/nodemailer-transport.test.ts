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
    expect(await transport.send(message)).toEqual({ messageId: "smtp-id" });
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
  it("принимает адрес с нормализованным регистром домена SMTP", async () => {
    sendMail.mockResolvedValue({
      messageId: "smtp-id",
      accepted: ["Recipient@example.com"],
      rejected: [],
    });
    await expect(
      createSmtpTransport(settings).send({
        ...message,
        to: "Recipient@EXAMPLE.COM",
      }),
    ).resolves.toEqual({ messageId: "smtp-id" });
  });

  it("отклоняет принятие адреса с другим регистром локальной части", async () => {
    sendMail.mockResolvedValue({
      messageId: "smtp-id",
      accepted: ["recipient@example.com"],
      rejected: [],
    });
    await expect(
      createSmtpTransport(settings).send({
        ...message,
        to: "Recipient@EXAMPLE.COM",
      }),
    ).rejects.toMatchObject({ code: "EMAIL_SEND_FAILED" });
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

  it.each([
    { messageId: "smtp-id", accepted: [], rejected: [message.to] },
    { messageId: "smtp-id", accepted: ["other@example.com"], rejected: [] },
    { messageId: "smtp-id", accepted: [message.to], rejected: [message.to] },
    { messageId: "", accepted: [message.to], rejected: [] },
  ])(
    "не считает идентификатор доказательством принятия получателя: %j",
    async (result) => {
      sendMail.mockResolvedValue(result);
      await expect(
        createSmtpTransport(settings).send(message),
      ).rejects.toMatchObject({ code: "EMAIL_SEND_FAILED" });
      expect(sendMail).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["ECONNECTION", "ETIMEDOUT", "EENVELOPE"])(
    "скрывает отказ библиотеки без повтора: %s",
    async (code) => {
      sendMail.mockRejectedValue(
        Object.assign(new Error("private SMTP detail"), { code }),
      );
      await expect(
        createSmtpTransport(settings).send(message),
      ).rejects.toMatchObject({
        code: "EMAIL_SEND_FAILED",
        message: "Email submission failed",
      });
      expect(sendMail).toHaveBeenCalledTimes(1);
    },
  );
});
