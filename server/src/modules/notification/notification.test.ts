import { describe, expect, it } from "vitest";
import { createNotificationHarness } from "./testing/notification.harness.js";

const message = { to: "recipient@example.com", subject: "Тема", text: "Текст" };

describe("email-уведомления", () => {
  it("отправляет текстовое письмо одному получателю от настроенного отправителя", async () => {
    const { notification, transport } = createNotificationHarness();

    expect(await notification.sendEmail(message)).toEqual({
      messageId: "test-message",
    });
    expect(transport.messages).toEqual([
      { ...message, from: "sender@example.com" },
    ]);
  });
  it("передаёт HTML вместе с обязательным текстом", async () => {
    const { notification, transport } = createNotificationHarness();
    await notification.sendEmail({ ...message, html: "<p>Текст</p>" });
    expect(transport.messages).toEqual([
      { ...message, html: "<p>Текст</p>", from: "sender@example.com" },
    ]);
  });

  it.each([
    { to: "invalid" },
    { to: "one@example.com,two@example.com" },
    { to: "Name <one@example.com>" },
    { subject: "  " },
    { text: "\n " },
    { html: " " },
  ])("отклоняет некорректное письмо до отправки: %j", async (invalid) => {
    const { notification, transport } = createNotificationHarness();
    await expect(
      notification.sendEmail({ ...message, ...invalid }),
    ).rejects.toMatchObject({ code: "INVALID_EMAIL_MESSAGE" });
    expect(transport.messages).toEqual([]);
  });
  it("отказывает при выключенных уведомлениях без обращения к транспорту", async () => {
    const { notification, transport } = createNotificationHarness({
      enabled: false,
    });
    await expect(notification.sendEmail(message)).rejects.toMatchObject({
      code: "NOTIFICATION_DISABLED",
    });
    expect(transport.messages).toEqual([]);
  });

  it.each(["SMTP rejection", "Network failure", "Timeout"])(
    "сохраняет причину ошибки транспорта и не повторяет попытку: %s",
    async (reason) => {
      const { notification, transport } = createNotificationHarness();
      transport.failure = new Error(reason);
      const result = notification.sendEmail(message);
      await expect(result).rejects.toMatchObject({
        code: "EMAIL_SEND_FAILED",
        message: "Email submission failed",
      });
      await expect(result).rejects.toHaveProperty("cause", transport.failure);
      expect(transport.messages).toHaveLength(1);
    },
  );
});

it.each([
  { messageId: "id", accepted: [], rejected: [message.to] },
  { messageId: "id", accepted: ["other@example.com"], rejected: [] },
  { messageId: "id", accepted: [message.to, message.to], rejected: [] },
  { messageId: "id", accepted: [message.to], rejected: [message.to] },
  { messageId: " ", accepted: [message.to], rejected: [] },
])("отклоняет неподтверждённое принятие получателя: %j", async (result) => {
  const { notification, transport } = createNotificationHarness();
  transport.result = result;
  await expect(notification.sendEmail(message)).rejects.toMatchObject({
    code: "EMAIL_SEND_FAILED",
  });
  expect(transport.messages).toHaveLength(1);
});

it("сравнивает домен без учёта регистра", async () => {
  const { notification, transport } = createNotificationHarness();
  transport.result = {
    messageId: "id",
    accepted: ["Recipient@example.com"],
    rejected: [],
  };
  await expect(
    notification.sendEmail({ ...message, to: "Recipient@EXAMPLE.COM" }),
  ).resolves.toEqual({ messageId: "id" });
});

it("сравнивает локальную часть адреса с учётом регистра", async () => {
  const { notification, transport } = createNotificationHarness();
  transport.result = {
    messageId: "id",
    accepted: ["recipient@example.com"],
    rejected: [],
  };
  await expect(
    notification.sendEmail({ ...message, to: "Recipient@example.com" }),
  ).rejects.toMatchObject({ code: "EMAIL_SEND_FAILED" });
});
