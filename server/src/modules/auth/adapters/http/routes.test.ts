import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Router } from "express";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../../../../app.js";
import {
  EMAIL,
  PASSWORD,
  createAuthHarness,
} from "../../testing/auth.harness.js";
import type { SessionsModule } from "../../application/sessions.js";
import { createAuthRouter, createRequireAuth } from "./routes.js";
import { mapAuthError } from "./error-map.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});
async function start(
  options: {
    cookieSecure?: boolean;
    sessions?: (h: ReturnType<typeof createAuthHarness>) => SessionsModule;
  } = {},
) {
  const auth = createAuthHarness();
  await auth.seed();
  const sessions = options.sessions?.(auth) ?? auth.sessions;
  const app = createApp({
    healthRouter: Router(),
    authRouter: createAuthRouter(sessions, {
      cookieSecure: options.cookieSecure ?? true,
      allowedOrigins: ["https://files.example.com"],
    }),
    requireAuth: createRequireAuth(sessions),
    filesRouter: Router().get("/", (_req, res) => res.json({ items: [] })),
    directoriesRouter: Router(),
    corsOrigin: [],
    errorMappers: [mapAuthError],
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body?: unknown, cookie?: string) =>
    fetch(`${base}/api/auth/${path}`, {
      method: "POST",
      headers: {
        Origin: "https://files.example.com",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = (email = EMAIL, password = PASSWORD) =>
    post("login", { email, password });
  const verify = (attemptToken: string, code = auth.code()) =>
    post("login/verify", { attemptToken, code });
  const resend = (attemptToken: string) =>
    post("login/resend", { attemptToken });
  const enter = async () => {
    const response = await login();
    expect(response.status).toBe(200);
    return verify((await response.json()).attemptToken);
  };
  const files = (token?: string) =>
    fetch(`${base}/api/files`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  return { auth, post, login, verify, resend, enter, base, files };
}
const cookieOf = (response: Response) =>
  response.headers.getSetCookie()[0]?.split(";")[0] ?? "";
const errorOf = async (response: Response) => (await response.json()).error;

it("после пароля создаёт попытку без сессии и cookie, только код открывает доступ к файлам", async () => {
  const h = await start();
  const response = await h.login(" USER@Example.com ");
  expect(response.status).toBe(200);
  const attempt = await response.json();
  expect(attempt).toEqual({
    attemptToken: expect.stringMatching(/^[\w-]{43}$/),
    attemptExpiresAt: "2026-01-01T00:15:00.000Z",
    codeExpiresAt: "2026-01-01T00:05:00.000Z",
    resendAvailableAt: "2026-01-01T00:01:00.000Z",
    deliveryStatus: "accepted",
  });
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await h.files()).status).toBe(401);
  expect((await h.post("refresh")).status).toBe(401);
  const verified = await h.verify(attempt.attemptToken);
  expect(verified.status).toBe(200);
  const session = await verified.json();
  expect(session).toEqual({
    accessToken: expect.any(String),
    expiresIn: 900,
    user: {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Имя",
      email: EMAIL,
    },
  });
  const cookie = verified.headers.getSetCookie()[0]!;
  for (const attribute of [
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/api/auth",
    "Max-Age=604800",
  ])
    expect(cookie).toContain(attribute);
  expect(cookie).not.toContain("Domain=");
  expect((await h.files(session.accessToken)).status).toBe(200);
  expect((await h.verify(attempt.attemptToken)).status).toBe(410);
  expect((await h.post("refresh", undefined, cookieOf(verified))).status).toBe(
    200,
  );
});

it("неизвестный email и неправильный пароль одинаковы; неактивность видна только после правильного пароля", async () => {
  const h = await start();
  const results = [];
  for (const [email, password] of [
    ["missing@example.com", PASSWORD],
    [EMAIL, "wrong password"],
  ]) {
    const response = await h.login(email, password);
    expect(response.status).toBe(401);
    const error = await errorOf(response);
    results.push({ code: error.code, message: error.message });
  }
  expect(results[0]).toEqual(results[1]);
  await h.auth.seed("inactive");
  expect((await h.login(EMAIL, "wrong password")).status).toBe(401);
  const inactive = await h.login();
  expect(inactive.status).toBe(403);
  expect((await errorOf(inactive)).code).toBe("EMAIL_NOT_VERIFIED");
  expect(h.auth.sendEmail).not.toHaveBeenCalled();
  expect(
    (await h.post("login", { login: "operator", password: PASSWORD })).status,
  ).toBe(422);
});

it("пять неправильных кодов завершают попытку, ошибка формата не расходует проверки", async () => {
  const h = await start();
  const { attemptToken } = await (await h.login()).json();
  for (const code of ["12345", "１２３４５６", " 123456", 123456])
    expect((await h.post("login/verify", { attemptToken, code })).status).toBe(
      422,
    );
  const wrong = h.auth.code() === "000000" ? "999999" : "000000";
  for (let remainingAttempts = 4; remainingAttempts >= 0; remainingAttempts--) {
    const response = await h.verify(attemptToken, wrong);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({
      code: "LOGIN_CODE_INVALID",
      details: { remainingAttempts },
    });
  }
  expect((await h.verify(attemptToken)).status).toBe(410);
});

it("проверяет код и попытку на точной границе сроков", async () => {
  const h = await start();
  const { attemptToken } = await (await h.login()).json();
  h.auth.clock.advance(300000 / 3600000);
  const expired = await h.verify(attemptToken);
  expect(expired.status).toBe(400);
  expect((await errorOf(expired)).code).toBe("LOGIN_CODE_EXPIRED");
  h.auth.clock.advance(600000 / 3600000);
  expect((await h.verify(attemptToken)).status).toBe(410);
  expect((await h.verify("unknown", "123456")).status).toBe(410);
});

it("попытки независимы и секреты разных назначений не заменяют друг друга", async () => {
  const h = await start();
  const first = await (await h.login()).json();
  const oldCode = h.auth.code();
  h.auth.clock.advance(1 / 60);
  const second = await (await h.login()).json();
  const secondCode = h.auth.code();
  expect(first.attemptToken).not.toBe(second.attemptToken);
  if (oldCode !== secondCode)
    expect((await h.verify(second.attemptToken, oldCode)).status).toBe(400);
  const signedIn = await h.verify(first.attemptToken, oldCode);
  expect(signedIn.status).toBe(200);
  expect((await h.verify(second.attemptToken, secondCode)).status).toBe(200);
  expect(
    (await h.post("refresh", undefined, `refresh_token=${first.attemptToken}`))
      .status,
  ).toBe(401);
  expect(
    (await h.files(cookieOf(signedIn).slice("refresh_token=".length))).status,
  ).toBe(401);
});

it("сбой SMTP сохраняет попытку; сбой записи не отправляет письмо и не раскрывает ошибку", async () => {
  const h = await start();
  h.auth.sendEmail.mockRejectedValueOnce(
    new Error("private@example.com secret"),
  );
  const response = await h.login();
  expect(response.status).toBe(200);
  const attempt = await response.json();
  expect(attempt.deliveryStatus).toBe("unconfirmed");
  expect((await h.verify(attempt.attemptToken)).status).toBe(200);
  const broken = await start({
    sessions: (a) =>
      a.withStore({
        ...a.store,
        saveAttempt: async () => {
          throw new Error("SQL private secret");
        },
      }),
  });
  const failed = await broken.login();
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("private");
  expect(broken.auth.sendEmail).not.toHaveBeenCalled();
});

it("квота писем возвращает 429 без новой попытки, а первый шаг ограничен отдельно", async () => {
  const h = await start();
  const first = await (await h.login()).json();
  const limited = await h.login();
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("60");
  expect(h.auth.sendEmail).toHaveBeenCalledTimes(1);
  expect((await h.verify(first.attemptToken)).status).toBe(200);
  for (let i = 0; i < 8; i++) await h.login(EMAIL, "wrong");
  const denied = await h.login();
  expect(denied.status).toBe(429);
  expect(denied.headers.get("retry-after")).toBe("900");
});

it("повтор кода без пароля заменяет прежний код, не сдвигает попытку и не сбрасывает проверки", async () => {
  const h = await start();
  const { attemptToken } = await (await h.login()).json();
  const oldCode = h.auth.code();
  const wrong = oldCode === "000000" ? "999999" : "000000";
  expect((await h.verify(attemptToken, wrong)).status).toBe(400);
  h.auth.clock.advance(1 / 60);
  const response = await h.resend(attemptToken);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    attemptExpiresAt: "2026-01-01T00:15:00.000Z",
    codeExpiresAt: "2026-01-01T00:06:00.000Z",
    resendAvailableAt: "2026-01-01T00:02:00.000Z",
    deliveryStatus: "accepted",
  });
  expect(h.auth.sendEmail).toHaveBeenCalledTimes(2);
  const newCode = h.auth.code();
  if (newCode !== oldCode) {
    const delayed = await h.verify(attemptToken, oldCode);
    expect(delayed.status).toBe(400);
    expect((await errorOf(delayed)).details).toEqual({ remainingAttempts: 3 });
  }
  expect((await h.verify(attemptToken, newCode)).status).toBe(200);
  expect((await h.resend(attemptToken)).status).toBe(410);
});

it("повтор по лимиту возвращает 429 и сохраняет прежний код и оставшиеся проверки", async () => {
  const h = await start();
  const { attemptToken } = await (await h.login()).json();
  const code = h.auth.code();
  const wrong = code === "000000" ? "999999" : "000000";
  expect((await h.verify(attemptToken, wrong)).status).toBe(400);
  h.auth.clock.advance(59 / 3600);
  const limited = await h.resend(attemptToken);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("1");
  expect((await errorOf(limited)).details).toEqual({ retryAfterSeconds: 1 });
  expect(h.auth.sendEmail).toHaveBeenCalledTimes(1);
  const again = await h.verify(attemptToken, wrong);
  expect((await errorOf(again)).details).toEqual({ remainingAttempts: 3 });
  expect((await h.verify(attemptToken, code)).status).toBe(200);
});

it("первый код и повторы делят пять писем в час по назначению", async () => {
  const h = await start();
  const { attemptToken } = await (await h.login()).json();
  for (let i = 0; i < 4; i++) {
    h.auth.clock.advance(1 / 60);
    expect((await h.resend(attemptToken)).status).toBe(200);
  }
  h.auth.clock.advance(1 / 60);
  const limited = await h.resend(attemptToken);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("3300");
  expect(h.auth.sendEmail).toHaveBeenCalledTimes(5);
  expect((await h.verify(attemptToken)).status).toBe(200);
});

it("новый код не живёт дольше попытки, пятая ошибка после повторов завершает попытку", async () => {
  const h = await start();
  const { attemptToken } = await (await h.login()).json();
  const wrong = () => (h.auth.code() === "000000" ? "999999" : "000000");
  for (let i = 0; i < 4; i++)
    expect((await h.verify(attemptToken, wrong())).status).toBe(400);
  h.auth.clock.advance(12 / 60);
  const response = await h.resend(attemptToken);
  expect(await response.json()).toMatchObject({
    attemptExpiresAt: "2026-01-01T00:15:00.000Z",
    codeExpiresAt: "2026-01-01T00:15:00.000Z",
  });
  const last = await h.verify(attemptToken, wrong());
  expect((await errorOf(last)).details).toEqual({ remainingAttempts: 0 });
  expect((await h.verify(attemptToken)).status).toBe(410);
  expect((await h.resend(attemptToken)).status).toBe(410);

  h.auth.clock.advance(1 / 60);
  const { attemptToken: next } = await (await h.login()).json();
  h.auth.clock.advance(15 / 60);
  expect((await h.resend(next)).status).toBe(410);
});

it("отказ или таймаут SMTP при повторе оставляют новый код; сбой записи не отправляет письмо и сохраняет прежний", async () => {
  const h = await start();
  const { attemptToken } = await (await h.login()).json();
  const oldCode = h.auth.code();
  h.auth.clock.advance(1 / 60);
  h.auth.sendEmail.mockRejectedValueOnce(new Error("private@example.com"));
  const rejected = await h.resend(attemptToken);
  expect(rejected.status).toBe(200);
  expect((await rejected.json()).deliveryStatus).toBe("unconfirmed");
  const newCode = h.auth.code();
  if (newCode !== oldCode)
    expect((await h.verify(attemptToken, oldCode)).status).toBe(400);
  expect((await h.verify(attemptToken, newCode)).status).toBe(200);

  const slow = await start({ sessions: (a) => a.withStore(a.store, 50) });
  const slowAttempt = await (await slow.login()).json();
  slow.auth.clock.advance(1 / 60);
  let signal: AbortSignal | undefined;
  slow.auth.sendEmail.mockImplementationOnce((_message, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  const timedOut = await slow.resend(slowAttempt.attemptToken);
  expect((await timedOut.json()).deliveryStatus).toBe("unconfirmed");
  expect(signal?.aborted).toBe(true);
  expect((await slow.verify(slowAttempt.attemptToken)).status).toBe(200);

  const broken = await start({
    sessions: (a) =>
      a.withStore({
        ...a.store,
        resend: async () => {
          throw new Error("SQL private secret");
        },
      }),
  });
  const brokenAttempt = await (await broken.login()).json();
  broken.auth.clock.advance(1 / 60);
  const failed = await broken.resend(brokenAttempt.attemptToken);
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("private");
  expect(broken.auth.sendEmail).toHaveBeenCalledTimes(1);
  expect((await broken.verify(brokenAttempt.attemptToken)).status).toBe(200);
});

it("IP-квота писем доступа считает повторы неизвестных попыток и некорректных тел", async () => {
  const h = await start();
  await h.login();
  expect((await h.resend("unknown")).status).toBe(410);
  expect((await h.post("login/resend", {})).status).toBe(422);
  for (let i = 0; i < 17; i++) await h.resend("unknown");
  const limited = await h.resend("unknown");
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("3600");
});

it("параллельные проверки создают одну сессию, потерянный ответ не разрешает повторное погашение", async () => {
  const h = await start();
  const { attemptToken } = await (await h.login()).json();
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => h.verify(attemptToken)),
  );
  expect(responses.filter((response) => response.status === 200)).toHaveLength(
    1,
  );
  expect(responses.filter((response) => response.status === 410)).toHaveLength(
    9,
  );
});

it("продление сохраняет refresh-токен и сдвигает семь дней дольше месяца; выход отзывает только текущую сессию", async () => {
  const h = await start();
  const first = await h.enter();
  const cookie = cookieOf(first);
  const access = (await first.json()).accessToken;
  h.auth.clock.advance(1 / 60);
  const other = cookieOf(await h.enter());
  for (let i = 0; i < 6; i++) {
    h.auth.clock.advance(6 * 24);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => h.post("refresh", undefined, cookie)),
    );
    for (const response of results) {
      expect(response.status).toBe(200);
      expect(cookieOf(response)).toBe(cookie);
    }
  }
  expect((await h.files(access)).status).toBe(401);
  const logout = await h.post("logout", undefined, cookie);
  expect(logout.status).toBe(204);
  expect(cookieOf(logout)).toBe("refresh_token=");
  expect((await h.post("refresh", undefined, cookie)).status).toBe(401);
  expect((await h.post("logout", undefined, cookie)).status).toBe(204);
  expect((await h.post("logout")).status).toBe(204);
  expect((await h.post("refresh", undefined, other)).status).toBe(401);
});

it("выход сохраняет доступ JWT до 15 минут и не отзывает другой браузер", async () => {
  const h = await start({ cookieSecure: false });
  const first = await h.enter();
  const cookie = cookieOf(first);
  const access = (await first.json()).accessToken;
  h.auth.clock.advance(1 / 60);
  const other = cookieOf(await h.enter());
  expect(first.headers.getSetCookie()[0]).not.toContain("Secure");
  await h.post("logout", undefined, cookie);
  expect((await h.post("refresh", undefined, other)).status).toBe(200);
  expect((await h.files(access)).status).toBe(200);
  h.auth.clock.advance(14 / 60);
  expect((await h.files(access)).status).toBe(401);
});

it("истёкшая сессия не восстанавливается; временный сбой refresh и logout сохраняет cookie", async () => {
  const h = await start();
  const cookie = cookieOf(await h.enter());
  h.auth.clock.advance(7 * 24);
  const expired = await h.post("refresh", undefined, cookie);
  expect(expired.status).toBe(401);
  expect(cookieOf(expired)).toBe("refresh_token=");
  const broken = await start({
    sessions: (a) =>
      a.withStore({
        ...a.store,
        refresh: async () => {
          throw new Error("secret");
        },
        revoke: async () => {
          throw new Error("secret");
        },
      }),
  });
  for (const path of ["refresh", "logout"]) {
    const failed = await broken.post(path, undefined, "refresh_token=unknown");
    expect(failed.status).toBe(503);
    expect(failed.headers.getSetCookie()).toEqual([]);
  }
});

it("все маршруты требуют разрешённый Origin и запрещают кэширование", async () => {
  const h = await start();
  for (const path of ["login", "login/verify", "refresh", "logout"]) {
    for (const origin of [null, "null", "https://foreign.example.com"]) {
      const response = await fetch(`${h.base}/api/auth/${path}`, {
        method: "POST",
        headers: origin ? { Origin: origin } : {},
      });
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe("ORIGIN_NOT_ALLOWED");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  }
});

it("IP-ограничение проверок считает неизвестные попытки, испорченные и слишком большие тела и игнорирует поддельный proxy", async () => {
  const h = await start();
  for (let index = 0; index < 100; index++) {
    const response = await fetch(`${h.base}/api/auth/LOGIN/verify/`, {
      method: "POST",
      headers: {
        Origin: "https://files.example.com",
        "Content-Type": "application/json",
        "X-Forwarded-For": `192.0.2.${index}`,
      },
      body:
        index % 2
          ? "{"
          : JSON.stringify({ attemptToken: "unknown", code: "123456" }),
    });
    expect([400, 410]).toContain(response.status);
  }
  const response = await h.verify("unknown", "123456");
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("900");
  h.auth.clock.advance(900000 / 3600000);
  expect((await h.verify("unknown", "123456")).status).toBe(410);
});

it("HTTP-ошибки формата имеют общие безопасные ответы", async () => {
  const h = await start();
  for (const path of ["login", "login/verify", "refresh", "logout"]) {
    for (const [body, contentType, status] of [
      ["{secret", "application/json", 400],
      ["secret", "text/plain", 415],
      [JSON.stringify({ secret: "x".repeat(17000) }), "application/json", 413],
    ] as const) {
      const response = await fetch(`${h.base}/api/auth/${path}`, {
        method: "POST",
        headers: {
          Origin: "https://files.example.com",
          "Content-Type": contentType,
        },
        body,
      });
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain("secret");
    }
  }
});

it("ошибки формата учитываются общим лимитом пользователя без расхода пяти кодов", async () => {
  const h = await start();
  const { attemptToken } = await (await h.login()).json();
  for (let index = 0; index < 20; index++)
    expect((await h.verify(attemptToken, "123")).status).toBe(422);
  const response = await h.verify(attemptToken);
  expect(response.status).toBe(429);
  expect((await errorOf(response)).code).toBe("RATE_LIMITED");
});

it("при IP- и email-лимите повтора Retry-After равен наибольшему ожиданию", async () => {
  const h = await start();
  await h.login();
  for (let i = 0; i < 18; i++) await h.resend("unknown");
  h.auth.clock.advance(59.5 / 60);
  const { attemptToken } = await (await h.login()).json();
  const limited = await h.resend(attemptToken);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("60");
  expect((await errorOf(limited)).details).toEqual({ retryAfterSeconds: 60 });
});

it("десять входов с корректным email и пустым паролем расходуют квоту email и дают 429", async () => {
  const h = await start();
  for (let i = 0; i < 10; i++) {
    const email = i % 2 ? `  ${EMAIL.toUpperCase()} ` : EMAIL;
    expect((await h.post("login", { email, password: "" })).status).toBe(422);
  }
  const limited = await h.login(EMAIL, "wrong");
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("900");
  expect((await errorOf(limited)).details).toEqual({ retryAfterSeconds: 900 });
  const body = await h.post("login", { email: EMAIL, password: "secret-pass" });
  expect(body.status).toBe(429);
  expect(await body.text()).not.toContain("secret-pass");
  expect(h.auth.sendEmail).not.toHaveBeenCalled();
  expect((await h.login("other@example.com", "")).status).toBe(422);
});

it("при IP- и email-лимите входа ответ берёт наибольшее ожидание, а отказ по IP учитывается в квоте email", async () => {
  const h = await start();
  for (let i = 0; i < 45; i++)
    expect((await h.post("login", {})).status).toBe(422);
  h.auth.clock.advance(10 / 60);
  for (let i = 0; i < 5; i++)
    expect((await h.login(EMAIL, "")).status).toBe(422);
  for (let i = 0; i < 5; i++) {
    const limited = await h.login(EMAIL, "");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("300");
  }
  const both = await h.login();
  expect(both.status).toBe(429);
  expect(both.headers.get("retry-after")).toBe("900");
  expect((await errorOf(both)).details).toEqual({ retryAfterSeconds: 900 });
  h.auth.clock.advance(5 / 60);
  expect((await h.post("login", {})).status).toBe(422);
  const email = await h.login();
  expect(email.status).toBe(429);
  expect(email.headers.get("retry-after")).toBe("600");
  expect(h.auth.sendEmail).not.toHaveBeenCalled();
});
