import { beforeEach, describe, expect, it, vi } from "vitest";

const smtp = {
  NOTIFICATION_ENABLED: "true",
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "465",
  SMTP_TLS_MODE: "implicit",
  SMTP_USER: "sender@example.com",
  SMTP_PASSWORD: "secret",
  SMTP_FROM: "sender@example.com",
};

beforeEach(() => {
  vi.resetModules();
  for (const key of [
    ...Object.keys(smtp),
    "SMTP_CONNECTION_TIMEOUT_MS",
    "SMTP_GREETING_TIMEOUT_MS",
    "SMTP_SOCKET_TIMEOUT_MS",
  ])
    vi.stubEnv(key, undefined);
});

describe("конфигурация email-уведомлений", () => {
  it("выключена по умолчанию и не требует SMTP", async () => {
    const { config } = await import("./config.js");
    expect(config.notification).toEqual({ enabled: false });
  });
  it("собирает SMTP и отдельные таймауты по умолчанию", async () => {
    for (const [key, value] of Object.entries(smtp)) vi.stubEnv(key, value);
    const { config } = await import("./config.js");
    expect(config.notification).toEqual({
      enabled: true,
      from: "sender@example.com",
      smtp: {
        host: "smtp.example.com",
        port: 465,
        tlsMode: "implicit",
        user: "sender@example.com",
        password: "secret",
        connectionTimeoutMs: 10000,
        greetingTimeoutMs: 10000,
        socketTimeoutMs: 30000,
      },
    });
  });

  it.each([
    ...Object.keys(smtp)
      .filter((key) => key !== "NOTIFICATION_ENABLED")
      .map((key) => [key, undefined]),
    ["SMTP_HOST", " "],
    ["SMTP_PORT", "0"],
    ["SMTP_PORT", "65536"],
    ["SMTP_PORT", "1.5"],
    ["SMTP_TLS_MODE", "plain"],
    ["SMTP_FROM", "invalid"],
    ["SMTP_CONNECTION_TIMEOUT_MS", "0"],
    ["SMTP_GREETING_TIMEOUT_MS", "-1"],
    ["SMTP_SOCKET_TIMEOUT_MS", "0"],
  ])(
    "отклоняет некорректную настройку включённого SMTP: %s=%s",
    async (key, value) => {
      for (const [name, setting] of Object.entries(smtp))
        vi.stubEnv(name, setting);
      vi.stubEnv(key!, value);
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("invalid configuration");
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(import("./config.js")).rejects.toThrow(
        "invalid configuration",
      );
      expect(exit).toHaveBeenCalledWith(1);
    },
  );
});
