import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Router } from "express";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../../../../app.js";
import { createAuthHarness } from "../../testing/auth.harness.js";
import { createAuthRouter } from "./routes.js";
import { mapAuthError } from "./error-map.js";
import { createRegistration } from "../../application/registration.js";
import type { RegistrationStore } from "../../domain/ports/registration-store.js";

let server: Server;
afterEach(async () => {
  await new Promise<void>(
    (resolve) => server?.close(() => resolve()) ?? resolve(),
  );
});

async function start(
  options: {
    deadlineMs?: number;
    trustedProxies?: string[];
    realTime?: boolean;
  } = {},
) {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const store: RegistrationStore = {
    consume: vi.fn().mockResolvedValue(0),
    save: vi.fn().mockResolvedValue(true),
  };
  const sendEmail = vi.fn().mockResolvedValue({ messageId: "accepted" });
  const auth = createAuthHarness();
  const registration = createRegistration({
    store,
    hasher: auth.hasher,
    notification: { sendEmail },
    clock: { now: () => new Date(options.realTime ? Date.now() : now) },
    wait: async (ms) => {
      if (options.realTime)
        await new Promise((resolve) => setTimeout(resolve, ms));
      else now += ms;
    },
    publicUrl: "https://files.example.com",
    deadlineMs: options.deadlineMs ?? 15000,
  });
  const app = createApp({
    authRouter: createAuthRouter(auth.sessions, {
      cookieSecure: false,
      registration,
      allowedOrigins: ["https://files.example.com"],
    }),
    requireAuth: (_req, _res, next) => next(),
    healthRouter: Router(),
    filesRouter: Router(),
    directoriesRouter: Router(),
    trustedProxies: options.trustedProxies,
    corsOrigin: [],
    errorMappers: [mapAuthError],
  });
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const request = (
    body: unknown = {
      name: " Имя ",
      email: " User.Name+tag@Example.com ",
      password: " пароль😀 12345 ",
    },
    origin: string | null = "https://files.example.com",
  ) =>
    fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/register`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(origin === null ? {} : { Origin: origin }),
        },
        body: JSON.stringify(body),
      },
    );
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    advance: (ms: number) => {
      now += ms;
    },
    store,
    sendEmail,
    request,
    elapsed: () => now - Date.parse("2026-01-01T00:00:00Z"),
  };
}

it("сохраняет неактивного пользователя до письма и ждёт общий срок", async () => {
  const h = await start();
  const response = await h.request();
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({
    message: "Если требуется письмо, инструкции придут на email",
    retryAfterSeconds: 45,
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(h.elapsed()).toBe(15000);
  expect(h.store.save).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "Имя",
      email: "user.name+tag@example.com",
      passwordHash: expect.stringMatching(/^scrypt\$/),
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
    expect.any(Date),
  );
  expect(vi.mocked(h.store.save).mock.invocationCallOrder[0]).toBeLessThan(
    h.sendEmail.mock.invocationCallOrder[0]!,
  );
  const message = h.sendEmail.mock.calls[0]![0];
  expect(message.text).toMatch(
    /https:\/\/files.example.com\/activation#token=[\w-]{43}/,
  );
  expect(message.text).not.toContain("пароль");
});

it("даёт одинаковый нейтральный ответ при существующем пользователе и любом результате SMTP", async () => {
  const h = await start();
  const replies: unknown[] = [];
  for (const outcome of ["accepted", "rejected", "unknown", "active"]) {
    if (outcome === "active") vi.mocked(h.store.save).mockResolvedValue(false);
    else if (outcome !== "accepted")
      h.sendEmail.mockRejectedValue(
        new Error("private@example.com secret smtp details"),
      );
    const before = h.elapsed();
    const response = await h.request();
    expect(response.status).toBe(202);
    expect(h.elapsed() - before).toBe(15000);
    replies.push(await response.json());
  }
  expect(
    replies.every(
      (reply) => JSON.stringify(reply) === JSON.stringify(replies[0]),
    ),
  ).toBe(true);
  expect(h.sendEmail).toHaveBeenCalledTimes(3);
});

it("сохранение и SMTP расходуют общий бюджет вместо добавления нового ожидания", async () => {
  const h = await start();
  vi.mocked(h.store.save).mockImplementation(async () => {
    h.advance(4000);
    return true;
  });
  h.sendEmail.mockImplementation(async () => {
    h.advance(7000);
    return { messageId: "accepted" };
  });
  const response = await h.request();
  expect(response.status).toBe(202);
  expect(h.elapsed()).toBe(15000);
  expect((await response.json()).retryAfterSeconds).toBe(45);
});

it("срок повтора отсчитывается от email-квоты после задержки проверки IP", async () => {
  const h = await start();
  vi.mocked(h.store.consume).mockImplementationOnce(async () => {
    h.advance(5000);
    return 0;
  });
  const response = await h.request();
  expect(response.status).toBe(202);
  expect(h.elapsed()).toBe(15000);
  expect((await response.json()).retryAfterSeconds).toBe(50);
});

it("таймаут останавливает одну SMTP-попытку и сохраняет нейтральный ответ", async () => {
  const h = await start({ deadlineMs: 20 });
  let signal!: AbortSignal;
  h.sendEmail.mockImplementation((_message, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  const response = await h.request();
  expect(response.status).toBe(202);
  expect(signal.aborted).toBe(true);
  expect(h.store.save).toHaveBeenCalledTimes(1);
  expect(h.sendEmail).toHaveBeenCalledTimes(1);
});

it("сбой хранения или проверки квоты даёт общую временную ошибку без письма", async () => {
  const h = await start();
  vi.mocked(h.store.save).mockRejectedValue(
    new Error("secret password email@example.com"),
  );
  let response = await h.request();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("secret");
  vi.mocked(h.store.consume).mockRejectedValue(new Error("database details"));
  response = await h.request();
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe("SERVICE_UNAVAILABLE");
  expect(h.sendEmail).not.toHaveBeenCalled();
});

it("отказ квоты не создаёт пользователя или секрет и возвращает максимальное ожидание", async () => {
  const h = await start();
  vi.mocked(h.store.consume)
    .mockResolvedValueOnce(15)
    .mockResolvedValueOnce(61);
  const response = await h.request();
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("61");
  expect((await response.json()).error).toMatchObject({
    code: "RATE_LIMITED",
    details: { retryAfterSeconds: 61 },
  });
  expect(h.store.save).not.toHaveBeenCalled();
  expect(h.sendEmail).not.toHaveBeenCalled();
});

it("проверяет Origin до разбора тела и запрещает отсутствующий, null и чужой источник", async () => {
  const h = await start();
  for (const origin of [null, "null", "https://other.example.com"]) {
    const response = await h.request(undefined, origin);
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).error.code).toBe("ORIGIN_NOT_ALLOWED");
  }
  expect(h.store.save).not.toHaveBeenCalled();
  expect(h.store.consume).not.toHaveBeenCalled();
});

it("валидирует Unicode-кодовые точки, не обрезает и не нормализует пароль", async () => {
  const h = await start();
  for (const [name, password, status] of [
    ["😀".repeat(100), "😀".repeat(12), 202],
    ["😀".repeat(101), "😀".repeat(12), 422],
    [" ", "a".repeat(12), 422],
    ["Имя", "a".repeat(11), 422],
    ["Имя", "😀".repeat(128), 202],
    ["Имя", "😀".repeat(129), 422],
    ["Имя", " 1234567890 ", 202],
  ] as const) {
    const response = await h.request({
      name,
      email: "user@example.com",
      password,
    });
    expect(response.status).toBe(status);
    if (status === 422) {
      const body = await response.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details).toHaveProperty("fieldErrors");
    }
  }
  expect(h.store.save).toHaveBeenCalledTimes(3);
});

it("ошибочные поля расходуют IP-квоту и квоту корректного email", async () => {
  const h = await start();
  expect(
    (
      await h.request({
        name: "",
        email: "USER@example.com",
        password: "short",
      })
    ).status,
  ).toBe(422);
  expect(h.store.consume).toHaveBeenCalledTimes(2);
  expect(
    (await h.request({ name: "Имя", email: "bad", password: "short" })).status,
  ).toBe(422);
  expect(h.store.consume).toHaveBeenCalledTimes(3);
  expect(h.store.save).not.toHaveBeenCalled();
});

it("ошибки JSON, размера и типа тела безопасны и учитываются IP-квотой", async () => {
  const h = await start();
  for (const [body, type, status, code] of [
    ["{private-secret", "application/json", 400, "BAD_REQUEST"],
    ["private-secret", "text/plain", 415, "UNSUPPORTED_MEDIA_TYPE"],
    [
      JSON.stringify({ password: "private-secret".repeat(3000) }),
      "application/json",
      413,
      "PAYLOAD_TOO_LARGE",
    ],
    ["null", "application/json", 422, "VALIDATION_ERROR"],
  ] as const) {
    const response = await fetch(`${h.base}/api/auth/register`, {
      method: "POST",
      headers: { Origin: "https://files.example.com", "Content-Type": type },
      body,
    });
    expect(response.status).toBe(status);
    const text = await response.text();
    expect(text).not.toContain("private-secret");
    expect(JSON.parse(text).error.code).toBe(code);
  }
  expect(h.store.consume).toHaveBeenCalledTimes(4);
});

it("не доверяет произвольному X-Forwarded-For", async () => {
  const h = await start();
  await fetch(`${h.base}/api/auth/register`, {
    method: "POST",
    headers: {
      Origin: "https://files.example.com",
      "Content-Type": "application/json",
      "X-Forwarded-For": "192.0.2.10",
    },
    body: "{}",
  });
  const first = vi.mocked(h.store.consume).mock.calls[0]![0];
  await fetch(`${h.base}/api/auth/register`, {
    method: "POST",
    headers: {
      Origin: "https://files.example.com",
      "Content-Type": "application/json",
      "X-Forwarded-For": "192.0.2.20",
    },
    body: "{}",
  });
  expect(vi.mocked(h.store.consume).mock.calls[1]![0]).toBe(first);
});

it("под параллельной нагрузкой реальные нейтральные ответы ждут 15 секунд для всех исходов", async () => {
  const h = await start({ realTime: true });
  vi.mocked(h.store.save).mockImplementation(
    async (record) => !record.email.startsWith("active"),
  );
  h.sendEmail.mockImplementation(async (message) => {
    if (message.to.startsWith("timeout")) return new Promise(() => {});
    if (message.to.startsWith("rejected"))
      throw new Error("private SMTP failure");
    return { messageId: "accepted" };
  });
  const timings = await Promise.all(
    Array.from({ length: 12 }, async (_, i) => {
      const started = performance.now();
      const response = await h.request({
        name: "Имя",
        email: `${["active", "new", "rejected", "timeout"][i % 4]}${i}@example.com`,
        password: "valid password 123",
      });
      expect(response.status).toBe(202);
      expect((await response.json()).message).toBe(
        "Если требуется письмо, инструкции придут на email",
      );
      return performance.now() - started;
    }),
  );
  expect(Math.min(...timings)).toBeGreaterThanOrEqual(15000);
  expect(Math.max(...timings)).toBeLessThan(18000);
  expect(Math.max(...timings) - Math.min(...timings)).toBeLessThan(1000);
  expect(h.sendEmail).toHaveBeenCalledTimes(9);
}, 20000);

it("после исчерпания бюджета сохранением не начинает SMTP и не удаляет состояние", async () => {
  const h = await start();
  vi.mocked(h.store.save).mockImplementation(async () => {
    h.advance(15000);
    return true;
  });
  expect((await h.request()).status).toBe(202);
  expect(h.sendEmail).not.toHaveBeenCalled();
  expect(h.store.save).toHaveBeenCalledTimes(1);
});
