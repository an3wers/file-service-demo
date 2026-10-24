import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Router } from "express";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../../../../app.js";
import { createAuthHarness } from "../../testing/auth.harness.js";
import { createRegistration } from "../../application/registration.js";
import { createAuthRouter, createRequireAuth } from "./routes.js";
import { mapAuthError } from "./error-map.js";

let server: Server;
afterEach(async () => {
  await new Promise<void>(
    (resolve) => server?.close(() => resolve()) ?? resolve(),
  );
});

async function start(
  options: { realTime?: boolean; deadlineMs?: number } = {},
) {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const store = {
    consume: vi.fn().mockResolvedValue(0),
    save: vi.fn().mockResolvedValue(true),
    requestActivation: vi.fn().mockResolvedValue(true),
    confirmActivation: vi.fn().mockResolvedValue(true),
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
    requireAuth: createRequireAuth(auth.sessions),
    healthRouter: Router(),
    filesRouter: Router(),
    directoriesRouter: Router(),
    corsOrigin: [],
    errorMappers: [mapAuthError],
  });
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}/api/auth/${path}`, {
      method: "POST",
      headers: {
        Origin: "https://files.example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  return {
    store,
    sendEmail,
    post,
    base,
    elapsed: () => now - Date.parse("2026-01-01T00:00:00Z"),
  };
}

it("повтор письма нормализует email и возвращает нейтральный ответ через общий срок", async () => {
  const h = await start();
  const response = await h.post("activation/request", {
    email: " User+tag@Example.com ",
  });
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({
    message: "Если требуется письмо, инструкции придут на email",
    retryAfterSeconds: 45,
  });
  expect(h.elapsed()).toBe(15000);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(h.sendEmail.mock.calls[0]![0]).toMatchObject({
    to: "user+tag@example.com",
    text: expect.stringMatching(
      /https:\/\/files.example.com\/activation#token=[\w-]{43}/,
    ),
  });
});

it("одинаково отвечает для неизвестного, активного и неактивного email при отказе SMTP", async () => {
  const h = await start();
  const results = [];
  for (const send of [false, false, true, true]) {
    h.store.requestActivation.mockResolvedValue(send);
    h.sendEmail.mockRejectedValue(new Error("private@example.com SMTP secret"));
    const before = h.elapsed();
    const response = await h.post("activation/request", {
      email: "user@example.com",
    });
    expect(response.status).toBe(202);
    expect(h.elapsed() - before).toBe(15000);
    results.push(await response.json());
  }
  expect(results).toEqual(
    Array(4).fill({
      message: "Если требуется письмо, инструкции придут на email",
      retryAfterSeconds: 45,
    }),
  );
  expect(h.sendEmail).toHaveBeenCalledTimes(2);
  expect(h.store.save).not.toHaveBeenCalled();
});

it("регистрация и повтор расходуют одни квоты и отказ не заменяет ссылку", async () => {
  const h = await start();
  await h.post("register", {
    name: "Имя",
    email: "user@example.com",
    password: "password 12345",
  });
  const keys = h.store.consume.mock.calls.map(([key]) => key);
  h.store.consume.mockResolvedValueOnce(30).mockResolvedValueOnce(61);
  const response = await h.post("activation/request", {
    email: "USER@example.com",
  });
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("61");
  expect((await response.json()).error.details).toEqual({
    retryAfterSeconds: 61,
  });
  expect(h.store.consume.mock.calls.slice(2).map(([key]) => key)).toEqual(keys);
  expect(h.store.requestActivation).not.toHaveBeenCalled();
  expect(h.sendEmail).toHaveBeenCalledTimes(1);
});

it("сбой сохранения повтора безопасен и не начинает отправку", async () => {
  const h = await start();
  h.store.requestActivation.mockRejectedValue(
    new Error("private@example.com token-secret"),
  );
  const response = await h.post("activation/request", {
    email: "user@example.com",
  });
  expect(response.status).toBe(503);
  const body = await response.text();
  expect(JSON.parse(body).error.code).toBe("SERVICE_UNAVAILABLE");
  expect(body).not.toContain("private");
  expect(body).not.toContain("token-secret");
  expect(h.sendEmail).not.toHaveBeenCalled();
});

it("подтверждает только явным POST без сессии и не расходует секрет при GET", async () => {
  const h = await start();
  await fetch(`${h.base}/api/auth/activation/confirm?token=private-token`);
  expect(h.store.confirmActivation).not.toHaveBeenCalled();
  const response = await h.post("activation/confirm", {
    token: "private-token",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    message: "Email подтверждён. Теперь можно войти",
  });
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect((await fetch(`${h.base}/api/files`)).status).toBe(401);
});

it("недействительные ссылки дают один безопасный ответ, сбой хранения остаётся временным", async () => {
  const h = await start();
  h.store.confirmActivation.mockResolvedValue(false);
  for (const token of ["wrong", "expired", "replaced", "used", ""]) {
    const response = await h.post("activation/confirm", { token });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("ACTIVATION_LINK_INVALID");
  }
  h.store.confirmActivation.mockRejectedValue(new Error("SQL secret"));
  const response = await h.post("activation/confirm", { token: "valid" });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("SQL secret");
});

it("подтверждение учитывает неправильные тела до разбора и не доверяет proxy-заголовкам", async () => {
  const h = await start();
  const keys = new Set();
  for (const [body, contentType, status] of [
    ["{private", "application/json", 400],
    ["private", "text/plain", 415],
    [JSON.stringify({ token: "x".repeat(17000) }), "application/json", 413],
    ["{}", "application/json", 422],
  ] as const) {
    const response = await fetch(`${h.base}/api/auth/ACTIVATION/confirm/`, {
      method: "POST",
      headers: {
        Origin: "https://files.example.com",
        "Content-Type": contentType,
        "X-Forwarded-For": `192.0.2.${status}`,
      },
      body,
    });
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private");
    keys.add(h.store.consume.mock.calls.at(-1)![0]);
  }
  expect(keys.size).toBe(1);
  expect(h.store.consume).toHaveBeenCalledTimes(4);
  h.store.consume.mockResolvedValue(900);
  const limited = await h.post("activation/confirm", { token: "valid" });
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("900");
  expect(h.store.confirmActivation).not.toHaveBeenCalled();
});

it("повтор и подтверждение запрещают отсутствующий, null и чужой Origin до хранения", async () => {
  const h = await start();
  for (const path of ["activation/request", "activation/confirm"]) {
    for (const origin of [null, "null", "https://other.example.com"]) {
      const response = await fetch(`${h.base}/api/auth/${path}`, {
        method: "POST",
        headers: {
          ...(origin === null ? {} : { Origin: origin }),
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(response.status).toBe(403);
    }
  }
  expect(h.store.consume).not.toHaveBeenCalled();
});

it("нейтральные ответы повтора под нагрузкой ждут 15 секунд для всех состояний и исходов SMTP", async () => {
  const h = await start({ realTime: true });
  h.store.requestActivation.mockImplementation(async (email: string) =>
    email.startsWith("inactive"),
  );
  h.sendEmail.mockImplementation(async (message) => {
    if (message.to.includes("timeout")) return new Promise(() => {});
    if (message.to.includes("rejected"))
      throw new Error("private SMTP failure");
    return { messageId: "accepted" };
  });
  const timings = await Promise.all(
    [
      "unknown",
      "active",
      "inactive-accepted",
      "inactive-rejected",
      "inactive-timeout",
    ].map(async (name) => {
      const started = performance.now();
      const response = await h.post("activation/request", {
        email: `${name}@example.com`,
      });
      expect(response.status).toBe(202);
      expect((await response.json()).message).toBe(
        "Если требуется письмо, инструкции придут на email",
      );
      return performance.now() - started;
    }),
  );
  expect(Math.min(...timings)).toBeGreaterThanOrEqual(15000);
  expect(Math.max(...timings) - Math.min(...timings)).toBeLessThan(1000);
}, 20000);
