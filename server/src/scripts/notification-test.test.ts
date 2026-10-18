import { inspect } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
let createNotificationHarness: typeof import("../modules/notification/testing/notification.harness.js").createNotificationHarness;

const { info, error, warn } = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

let harness: ReturnType<typeof createNotificationHarness>;
vi.mock("../composition.js", () => ({
  createNotification: () => harness.notification,
}));
vi.mock("../logger.js", () => ({ logger: { info, error, warn } }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  process.exitCode = undefined;
  process.argv = ["node", "notification-test.ts"];
  ({ createNotificationHarness } =
    await import("../modules/notification/testing/notification.harness.js"));
  harness = createNotificationHarness();
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
});

it("отклоняет команду без получателя до отправки", async () => {
  await import("./notification-test.js");
  expect(process.exitCode).toBe(1);
  expect(harness.transport.messages).toEqual([]);
  expect(error).toHaveBeenCalledWith(
    { code: "INVALID_ARGUMENTS" },
    expect.stringContaining("--to"),
  );
});

it("отправляет фиксированное письмо и сообщает принятие SMTP с кодом ноль", async () => {
  process.argv.push("--to", "recipient@example.com");
  harness.transport.result = {
    messageId: "message-123",
    accepted: ["recipient@example.com"],
    rejected: [],
  };
  await import("./notification-test.js");
  expect(process.exitCode).toBe(0);
  expect(harness.transport.messages).toEqual([
    {
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "File service SMTP test",
      text: "This is a test email from the file service.",
    },
  ]);
  expect(info).toHaveBeenCalledWith(
    { code: "EMAIL_ACCEPTED" },
    expect.stringContaining("accepted by SMTP"),
  );
});

it("сообщает выключенные уведомления и завершает команду с ошибкой без отправки", async () => {
  harness = createNotificationHarness({ enabled: false });
  process.argv.push("--to", "recipient@example.com");
  await import("./notification-test.js");
  expect(process.exitCode).toBe(1);
  expect(harness.transport.messages).toEqual([]);
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
  harness.transport.failure = new Error(
    "smtp-secret-value This is a test email from the file service.",
  );
  await import("./notification-test.js");
  expect(process.exitCode).toBe(1);
  expect(harness.transport.messages).toHaveLength(1);
  expect(error).toHaveBeenCalledExactlyOnceWith(
    {
      err: expect.objectContaining({ code: "EMAIL_SEND_FAILED" }),
      code: "EMAIL_SEND_FAILED",
    },
    "Email submission failed",
  );
  expect(info).not.toHaveBeenCalled();
  expect(inspect(warn.mock.calls)).not.toContain("smtp-secret-value");
  expect(inspect(warn.mock.calls)).not.toContain("This is a test email");
  expect(inspect(error.mock.calls)).not.toContain("smtp-secret-value");
  expect(inspect(error.mock.calls)).not.toContain("This is a test email");
});

it("не считает отказ получателя успешной отправкой при наличии идентификатора", async () => {
  process.argv.push("--to", "recipient@example.com");
  harness.transport.result = {
    messageId: "message-123",
    accepted: [],
    rejected: ["recipient@example.com"],
  };
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
  harness.transport.send = async (message) => {
    harness.transport.messages.push(message);
    return new Promise<Result>((resolve) => {
      accept = resolve;
    });
  };
  let completed = false;
  const command = import("./notification-test.js").then(() => {
    completed = true;
  });
  await vi.waitFor(() => expect(harness.transport.messages).toHaveLength(1));
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
    expect(harness.transport.messages).toEqual([]);
    expect(error).toHaveBeenCalledExactlyOnceWith(
      { code: "INVALID_ARGUMENTS" },
      "Usage: npm run notification:test -w server -- --to recipient@example.com",
    );
  },
);
