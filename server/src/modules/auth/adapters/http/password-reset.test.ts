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

async function start() {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const store = {
    consume: vi.fn().mockResolvedValue(0),
    save: vi.fn().mockResolvedValue(true),
    requestActivation: vi.fn().mockResolvedValue(true),
    confirmActivation: vi.fn().mockResolvedValue(true),
    requestPasswordReset: vi.fn().mockResolvedValue(true),
    confirmPasswordReset: vi.fn().mockResolvedValue("user@example.com"),
  };
  const sendEmail = vi.fn().mockResolvedValue({ messageId: "accepted" });
  const auth = createAuthHarness();
  const registration = createRegistration({
    store,
    hasher: auth.hasher,
    notification: { sendEmail },
    clock: { now: () => new Date(now) },
    wait: async (ms) => {
      now += ms;
    },
    publicUrl: "https://files.example.com",
    deadlineMs: 15000,
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
  const post = (
    path: string,
    body: unknown,
    origin = "https://files.example.com",
  ) =>
    fetch(`${base}/api/auth/password-reset/${path}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return {
    store,
    sendEmail,
    post,
    base,
    elapsed: () => now - Date.parse("2026-01-01T00:00:00Z"),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it("запрос восстановления нейтрален для любого состояния и исхода SMTP и ждёт общий срок", async () => {
  const h = await start();
  const results = [];
  for (const [known, smtp] of [
    [false, "accepted"],
    [true, "accepted"],
    [true, "rejected"],
  ] as const) {
    h.store.requestPasswordReset.mockResolvedValue(known);
    if (smtp === "rejected")
      h.sendEmail.mockRejectedValue(new Error("private@example.com SMTP"));
    const before = h.elapsed();
    const response = await h.post("request", { email: " User@Example.com " });
    expect(response.status).toBe(202);
    expect(h.elapsed() - before).toBe(15000);
    expect(response.headers.get("cache-control")).toBe("no-store");
    results.push(await response.json());
  }
  expect(results).toEqual(
    Array(3).fill({
      message: "Если требуется письмо, инструкции придут на email",
      retryAfterSeconds: 45,
    }),
  );
  expect(h.store.requestPasswordReset.mock.calls[0]![0]).toBe(
    "user@example.com",
  );
  expect(h.sendEmail).toHaveBeenCalledTimes(2);
  const message = h.sendEmail.mock.calls[0]![0];
  expect(message).toMatchObject({ to: "user@example.com" });
  const token = message.text.match(
    /https:\/\/files\.example\.com\/password-reset#token=([\w-]{43})/,
  )![1];
  expect(message.text).toContain("30 минут");
  const [, tokenHash, expiresAt] = h.store.requestPasswordReset.mock.calls[0]!;
  expect(tokenHash).not.toContain(token);
  expect(expiresAt).toEqual(new Date(Date.parse("2026-01-01T00:30:00Z")));
});

it("запрос восстановления расходует свою квоту email и общую квоту IP и при отказе не меняет ссылку", async () => {
  const h = await start();
  await h.post("request", { email: "user@example.com" });
  const keys = h.store.consume.mock.calls.map(([key]) => key as string);
  expect(keys[0]).toMatch(/^mail:ip:/);
  expect(keys[1]).toMatch(/^mail:password-reset:/);
  expect(h.store.consume.mock.calls[1]![1]).toEqual([
    { windowMs: 60000, maximum: 1 },
    { windowMs: 3600000, maximum: 5 },
  ]);
  h.store.consume.mockResolvedValueOnce(0).mockResolvedValueOnce(42);
  const limited = await h.post("request", { email: "unknown@example.com" });
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("42");
  expect(h.store.requestPasswordReset).toHaveBeenCalledTimes(1);
  expect(h.sendEmail).toHaveBeenCalledTimes(1);
});

it("сбой сохранения ссылки восстановления не начинает отправку и не раскрывает детали", async () => {
  const h = await start();
  h.store.requestPasswordReset.mockRejectedValue(new Error("SQL secret"));
  const response = await h.post("request", { email: "user@example.com" });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("SQL secret");
  expect(h.sendEmail).not.toHaveBeenCalled();
});

it("завершение сохраняет новый пароль, отправляет отдельное уведомление и не выполняет вход", async () => {
  const h = await start();
  const auth = createAuthHarness();
  await fetch(`${h.base}/api/auth/password-reset/confirm?token=private-token`);
  expect(h.store.confirmPasswordReset).not.toHaveBeenCalled();
  const password = "🙂".repeat(12);
  const response = await h.post("confirm", {
    token: "private-token",
    password,
    passwordConfirmation: password,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    message: "Пароль изменён. Теперь можно войти",
  });
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const [tokenHash, passwordHash] = h.store.confirmPasswordReset.mock.calls[0]!;
  expect(tokenHash).not.toContain("private-token");
  expect(await auth.hasher.verify(password, passwordHash)).toBe(true);
  expect(h.sendEmail).toHaveBeenCalledTimes(1);
  const message = h.sendEmail.mock.calls[0]![0];
  expect(message.to).toBe("user@example.com");
  expect(message.subject).toBe("Ваш пароль изменён");
  expect(message.text).not.toContain("http");
  expect(message.text).not.toContain(password);
});

it("сбой уведомления не отменяет изменение пароля", async () => {
  const h = await start();
  h.sendEmail.mockRejectedValue(new Error("private SMTP failure"));
  const response = await h.post("confirm", {
    token: "token",
    password: "new password 1",
    passwordConfirmation: "new password 1",
  });
  expect(response.status).toBe(200);
  expect(h.sendEmail).toHaveBeenCalledTimes(1);
});

it("ошибки полей дают 422 и не расходуют ссылку", async () => {
  const h = await start();
  for (const [password, passwordConfirmation, field] of [
    ["new password 1", "new password 2", "passwordConfirmation"],
    ["🙂".repeat(11), "🙂".repeat(11), "password"],
    ["x".repeat(129), "x".repeat(129), "password"],
  ] as const) {
    const response = await h.post("confirm", {
      token: "token",
      password,
      passwordConfirmation,
    });
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(Object.keys(body.error.details.fieldErrors)).toEqual([field]);
    expect(JSON.stringify(body)).not.toContain("new password");
  }
  const kept = await h.post("confirm", {
    token: "token",
    password: " ".repeat(12),
    passwordConfirmation: " ".repeat(12),
  });
  expect(kept.status).toBe(200);
  expect(h.store.confirmPasswordReset).toHaveBeenCalledTimes(1);
});

it("все недействующие ссылки дают один ответ, сбой хранения остаётся временным", async () => {
  const h = await start();
  h.store.confirmPasswordReset.mockResolvedValue(null);
  for (const token of ["wrong", "expired", "used", "activation", ""]) {
    const response = await h.post("confirm", {
      token,
      password: "new password 1",
      passwordConfirmation: "new password 1",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(
      "PASSWORD_RESET_LINK_INVALID",
    );
  }
  expect(h.sendEmail).not.toHaveBeenCalled();
  h.store.confirmPasswordReset.mockRejectedValue(new Error("SQL secret"));
  const response = await h.post("confirm", {
    token: "token",
    password: "new password 1",
    passwordConfirmation: "new password 1",
  });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("SQL secret");
});

it("завершение ограничено по IP с учётом некорректных тел до разбора", async () => {
  const h = await start();
  for (const [body, status] of [
    ["{private", 400],
    ["{}", 422],
  ] as const) {
    const response = await h.post("confirm", body);
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private");
  }
  const keys = h.store.consume.mock.calls.map(([key]) => key);
  expect(new Set(keys).size).toBe(1);
  expect(keys[0]).toMatch(/^password-reset:confirm:ip:/);
  expect(h.store.consume.mock.calls[0]![1]).toEqual([
    { windowMs: 900000, maximum: 20 },
  ]);
  h.store.consume.mockResolvedValue(600);
  const limited = await h.post("confirm", {
    token: "token",
    password: "new password 1",
    passwordConfirmation: "new password 1",
  });
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("600");
  expect(h.store.confirmPasswordReset).not.toHaveBeenCalled();
});

it("запрос и завершение восстановления запрещают чужой Origin до хранения", async () => {
  const h = await start();
  for (const path of ["request", "confirm"]) {
    const response = await h.post(path, {}, "https://other.example.com");
    expect(response.status).toBe(403);
  }
  expect(h.store.consume).not.toHaveBeenCalled();
});

it("уведомление получает отдельную попытку, даже если сохранение израсходовало бюджет запроса", async () => {
  const h = await start();
  h.store.confirmPasswordReset.mockImplementation(async () => {
    h.advance(14999);
    return "user@example.com";
  });
  const response = await h.post("confirm", {
    token: "token",
    password: "new password 1",
    passwordConfirmation: "new password 1",
  });
  expect(response.status).toBe(200);
  expect(h.sendEmail).toHaveBeenCalledTimes(1);
});
