import { Socket, Server } from "node:net";
import { inspect } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { sendMail, info, error } = vi.hoisted(() => ({
  sendMail: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail }) },
}));
vi.mock("../logger.js", () => ({ logger: { info, error } }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.exitCode = undefined;
  process.argv = ["node", "notification-test.ts"];
  for (const [key, value] of Object.entries({
    NOTIFICATION_ENABLED: "true",
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "465",
    SMTP_TLS_MODE: "implicit",
    SMTP_USER: "sender@example.com",
    SMTP_PASSWORD: "smtp-secret-value",
    SMTP_FROM: "sender@example.com",
  }))
    vi.stubEnv(key, value);
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("Unexpected network connection");
  });
  vi.spyOn(Server.prototype, "listen").mockImplementation(() => {
    throw new Error("Unexpected server startup");
  });
});

afterEach(() => {
  expect(Socket.prototype.connect).not.toHaveBeenCalled();
  expect(Server.prototype.listen).not.toHaveBeenCalled();
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
});

it("отклоняет команду без получателя до отправки", async () => {
  await import("./notification-test.js");
  expect(process.exitCode).toBe(1);
  expect(sendMail).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(
    { code: "INVALID_ARGUMENTS" },
    expect.stringContaining("--to"),
  );
});

it("отправляет фиксированное письмо и сообщает принятие SMTP с кодом ноль", async () => {
  process.argv.push("--to", "recipient@example.com");
  sendMail.mockResolvedValue({
    messageId: "message-123",
    accepted: ["recipient@example.com"],
    rejected: [],
  });
  await import("./notification-test.js");
  expect(process.exitCode).toBe(0);
  expect(sendMail).toHaveBeenCalledExactlyOnceWith({
    from: "sender@example.com",
    to: "recipient@example.com",
    subject: "File service SMTP test",
    text: "This is a test email from the file service.",
  });
  expect(info).toHaveBeenCalledWith(
    { code: "EMAIL_ACCEPTED" },
    expect.stringContaining("accepted by SMTP"),
  );
});

it("сообщает выключенные уведомления и завершает команду с ошибкой без отправки", async () => {
  vi.stubEnv("NOTIFICATION_ENABLED", "false");
  process.argv.push("--to", "recipient@example.com");
  await import("./notification-test.js");
  expect(process.exitCode).toBe(1);
  expect(sendMail).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(
    {
      err: expect.objectContaining({ code: "NOTIFICATION_DISABLED" }),
      code: "NOTIFICATION_DISABLED",
    },
    "Notifications are disabled",
  );
});

it("скрывает детали сбоя SMTP и завершает команду с ошибкой после одной попытки", async () => {
  process.argv.push("--to", "recipient@example.com");
  sendMail.mockRejectedValue(
    new Error("smtp-secret-value This is a test email from the file service."),
  );
  await import("./notification-test.js");
  expect(process.exitCode).toBe(1);
  expect(sendMail).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledExactlyOnceWith(
    {
      err: expect.objectContaining({ code: "EMAIL_SEND_FAILED" }),
      code: "EMAIL_SEND_FAILED",
    },
    "Email submission failed",
  );
  expect(info).not.toHaveBeenCalled();
  expect(inspect(error.mock.calls)).not.toContain("smtp-secret-value");
  expect(inspect(error.mock.calls)).not.toContain("This is a test email");
});

it("не считает отказ получателя успешной отправкой при наличии идентификатора", async () => {
  process.argv.push("--to", "recipient@example.com");
  sendMail.mockResolvedValue({
    messageId: "message-123",
    accepted: [],
    rejected: ["recipient@example.com"],
  });
  await import("./notification-test.js");
  expect(process.exitCode).toBe(1);
  expect(error).toHaveBeenCalledWith(
    {
      err: expect.objectContaining({ code: "EMAIL_SEND_FAILED" }),
      code: "EMAIL_SEND_FAILED",
    },
    "Email submission failed",
  );
  expect(info).not.toHaveBeenCalled();
});

it("ожидает принятия письма прежде чем сообщить успех и установить код завершения", async () => {
  process.argv.push("--to", "recipient@example.com");
  type Result = { messageId: string; accepted: string[]; rejected: string[] };
  let accept!: (result: Result) => void;
  sendMail.mockReturnValue(
    new Promise<Result>((resolve) => {
      accept = resolve;
    }),
  );
  let completed = false;
  const command = import("./notification-test.js").then(() => {
    completed = true;
  });
  await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
  expect(completed).toBe(false);
  expect(process.exitCode).toBeUndefined();
  expect(info).not.toHaveBeenCalled();
  accept({
    messageId: "message-123",
    accepted: ["recipient@example.com"],
    rejected: [],
  });
  await command;
  expect(process.exitCode).toBe(0);
  expect(info).toHaveBeenCalledTimes(1);
});

it.each([
  ["--to"],
  ["--to", "invalid"],
  ["--to", "first@example.com,second@example.com"],
  ["--to", "Name <recipient@example.com>"],
  ["--to", "recipient@example.com", "--to", "second@example.com"],
  ["--to", "recipient@example.com", "--password", "smtp-secret-value"],
  ["--unknown", "recipient@example.com"],
])(
  "отклоняет неверные аргументы %j без отправки и раскрытия значений",
  async (...args) => {
    process.argv.push(...args);
    await import("./notification-test.js");
    expect(process.exitCode).toBe(1);
    expect(sendMail).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledExactlyOnceWith(
      { code: "INVALID_ARGUMENTS" },
      "Usage: npm run notification:test -w server -- --to recipient@example.com",
    );
  },
);
