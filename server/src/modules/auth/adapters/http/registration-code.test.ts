import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Router } from "express";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../../../../app.js";
import {
  CODE_SECRET,
  EMAIL,
  PASSWORD,
  createAuthHarness,
} from "../../testing/auth.harness.js";
import { createRegistration } from "../../application/registration.js";
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

const MINUTE = 1 / 60;
const SECOND = MINUTE / 60;
const OTHER_EMAIL = "other@example.com";

async function start() {
  const auth = createAuthHarness();
  const registration = createRegistration({
    store: auth.registrationStore,
    hasher: auth.hasher,
    notification: { sendEmail: auth.sendEmail },
    clock: auth.clock,
    wait: async (ms) => auth.clock.advance(ms / 3600000),
    publicUrl: "https://files.example.com",
    deadlineMs: 1000,
    codeSecret: CODE_SECRET,
  });
  const app = createApp({
    healthRouter: Router(),
    authRouter: createAuthRouter(auth.sessions, {
      cookieSecure: false,
      registration,
      allowedOrigins: ["https://files.example.com"],
    }),
    requireAuth: createRequireAuth(auth.sessions),
    filesRouter: Router().get("/", (_req, res) => res.json({ items: [] })),
    directoriesRouter: Router(),
    corsOrigin: [],
    errorMappers: [mapAuthError],
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;
  const post = (path: string, body: unknown, cookie?: string) =>
    fetch(`${base}/${path}`, {
      method: "POST",
      headers: {
        Origin: "https://files.example.com",
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  const register = async (email = EMAIL) => {
    const response = await post("register", {
      name: "Имя",
      email,
      password: PASSWORD,
    });
    expect(response.status).toBe(202);
    return (await response.json()) as {
      attemptToken: string;
      attemptExpiresAt: string;
      codeExpiresAt: string;
      resendAvailableAt: string;
    };
  };
  const sentCode = () => auth.code();
  const verify = (attemptToken: string, code: string) =>
    post("registration/verify", { attemptToken, code });
  return { auth, post, register, sentCode, verify };
}

const wrongCode = (code: string) => (code === "000000" ? "111111" : "000000");

it("новый email: до кода нет сессии, верный код создаёт сессию и cookie на 14 суток без второго письма", async () => {
  const h = await start();
  const attempt = await h.register();
  expect(h.auth.sendEmail).toHaveBeenCalledTimes(1);
  const mail = h.auth.sendEmail.mock.calls[0]![0];
  expect(mail.to).toBe(EMAIL);
  expect(mail.text).not.toContain(attempt.attemptToken);
  expect(mail.text).not.toMatch(/https?:/);
  expect((await h.post("refresh", {})).status).toBe(401);
  expect(h.auth.users.get([...h.auth.users.keys()][0]!)!.state).toBe(
    "inactive",
  );

  const response = await h.verify(attempt.attemptToken, h.sentCode());
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.user).toMatchObject({ email: EMAIL, name: "Имя" });
  expect(body.accessToken).toEqual(expect.any(String));
  const cookie = response.headers.get("set-cookie")!;
  expect(cookie).toMatch(/Max-Age=1209600/);
  expect(cookie).toMatch(/HttpOnly/);
  expect(h.auth.users.get(body.user.id)!.state).toBe("active");
  expect(h.auth.sendEmail).toHaveBeenCalledTimes(1);
  expect((await h.post("refresh", {}, cookie.split(";")[0])).status).toBe(200);
});

it("повтор погашенного кода не создаёт ещё одну сессию", async () => {
  const h = await start();
  const attempt = await h.register();
  const code = h.sentCode();
  expect((await h.verify(attempt.attemptToken, code)).status).toBe(200);
  const again = await h.verify(attempt.attemptToken, code);
  expect(again.status).toBe(410);
  expect(again.headers.get("set-cookie")).toBeNull();
});

it("после потерянного ответа проверки cookie восстанавливает сессию, а повтор погашенного кода новую не создаёт", async () => {
  const h = await start();
  const attempt = await h.register();
  const code = h.sentCode();
  const first = await h.verify(attempt.attemptToken, code);
  const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
  const again = await h.verify(attempt.attemptToken, code);
  expect(again.status).toBe(410);
  expect(again.headers.get("set-cookie")).toBeNull();
  const refreshed = await h.post("refresh", {}, cookie);
  expect(refreshed.status).toBe(200);
  expect((await refreshed.json()).user.email).toBe(EMAIL);
  expect((await h.post("refresh", {})).status).toBe(401);
});

it("код без секрета попытки, чужой секрет и чужой код не дают вход", async () => {
  const h = await start();
  const mine = await h.register();
  const myCode = h.sentCode();
  const theirs = await h.register(OTHER_EMAIL);
  const theirCode = h.sentCode();
  expect(theirCode).not.toBe(myCode);

  expect((await h.post("registration/verify", { code: myCode })).status).toBe(
    422,
  );
  expect(
    (await h.post("registration/verify", { attemptToken: mine.attemptToken }))
      .status,
  ).toBe(422);
  expect((await h.verify(theirs.attemptToken, myCode)).status).toBe(400);
  expect((await h.verify(mine.attemptToken, theirCode)).status).toBe(400);
  expect(
    (
      await h.post("registration/verify", {
        attemptToken: mine.attemptToken,
        code: myCode,
        email: OTHER_EMAIL,
        userId: [...h.auth.users.keys()][1],
      })
    ).status,
  ).toBe(200);
  const other = [...h.auth.users.values()].find(
    (u) => u.email === OTHER_EMAIL,
  )!;
  expect(other.state).toBe("inactive");
});

it("код входа не подходит для регистрации, а код регистрации не подходит для входа", async () => {
  const h = await start();
  await h.auth.seed();
  const login = await h.post("login", { email: EMAIL, password: PASSWORD });
  const loginAttempt = await login.json();
  const loginCode = h.sentCode();
  const registered = await h.register(OTHER_EMAIL);
  const registrationCode = h.sentCode();

  const crossed = await h.verify(registered.attemptToken, loginCode);
  expect(crossed.status).toBe(400);
  expect((await crossed.json()).error.code).toBe("LOGIN_CODE_INVALID");
  const reverse = await h.post("login/verify", {
    attemptToken: registered.attemptToken,
    code: registrationCode,
  });
  expect(reverse.status).toBe(410);
  const reverseLogin = await h.post("login/verify", {
    attemptToken: loginAttempt.attemptToken,
    code: registrationCode,
  });
  expect(reverseLogin.status).toBe(400);
  const asRegistration = await h.verify(loginAttempt.attemptToken, loginCode);
  expect(asRegistration.status).toBe(410);
});

it("пятая неверная проверка завершает попытку, формат не расходует проверки", async () => {
  const h = await start();
  const attempt = await h.register();
  const code = h.sentCode();
  expect((await h.verify(attempt.attemptToken, "12ab")).status).toBe(422);
  const remaining: number[] = [];
  for (let index = 0; index < 5; index++) {
    const response = await h.verify(attempt.attemptToken, wrongCode(code));
    expect(response.status).toBe(400);
    remaining.push((await response.json()).error.details.remainingAttempts);
  }
  expect(remaining).toEqual([4, 3, 2, 1, 0]);
  expect((await h.verify(attempt.attemptToken, code)).status).toBe(410);
});

it("существующий email получает тот же ход ошибок и ни один код не создаёт сессию", async () => {
  const h = await start();
  await h.auth.seed("active");
  const existing = await h.register();
  expect(h.auth.sendEmail.mock.calls[0]![0].text).toContain(
    "уже зарегистрирован",
  );
  const fresh = await h.register(OTHER_EMAIL);
  const freshCode = h.sentCode();
  expect(Object.keys(existing).sort()).toEqual(Object.keys(fresh).sort());

  for (const token of [existing.attemptToken, fresh.attemptToken]) {
    const trail: unknown[] = [];
    for (let index = 0; index < 5; index++) {
      const response = await h.verify(token, wrongCode(freshCode));
      trail.push([
        response.status,
        (await response.json()).error.details.remainingAttempts,
        response.headers.get("set-cookie"),
      ]);
    }
    expect(trail).toEqual([
      [400, 4, null],
      [400, 3, null],
      [400, 2, null],
      [400, 1, null],
      [400, 0, null],
    ]);
    expect((await h.verify(token, freshCode)).status).toBe(410);
  }
});

it("случайный код для существующего email не создаёт сессию", async () => {
  const h = await start();
  await h.auth.seed("inactive");
  const existing = await h.register();
  for (const code of ["000000", "123456", "999999"]) {
    const response = await h.verify(existing.attemptToken, code);
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
  }
  expect([...h.auth.users.values()][0]!.state).toBe("inactive");
});

it("код действует пять минут, попытка пятнадцать, границы включены в срок", async () => {
  const h = await start();
  const attempt = await h.register();
  const code = h.sentCode();
  const requested = Date.parse(attempt.codeExpiresAt) - 5 * 60000;
  const elapsed = () => h.auth.clock.now().getTime() - requested;
  h.auth.clock.advance(5 * MINUTE - elapsed() / 3600000 - SECOND);
  expect((await h.verify(attempt.attemptToken, wrongCode(code))).status).toBe(
    400,
  );
  h.auth.clock.advance((5 * 60000 - elapsed()) / 3600000);
  const expired = await h.verify(attempt.attemptToken, code);
  expect(expired.status).toBe(400);
  expect((await expired.json()).error.code).toBe("LOGIN_CODE_EXPIRED");
  h.auth.clock.advance((15 * 60000 - elapsed() - 1000) / 3600000);
  expect((await h.verify(attempt.attemptToken, code)).status).toBe(400);
  h.auth.clock.advance(1 / 3600);
  expect((await h.verify(attempt.attemptToken, code)).status).toBe(410);
});

it("смена пароля или активация другим способом лишают попытку возможности войти", async () => {
  for (const change of ["password", "activation"] as const) {
    const h = await start();
    const attempt = await h.register();
    const code = h.sentCode();
    const user = [...h.auth.users.values()][0]!;
    if (change === "password") {
      user.passwordHash = "scrypt$new";
      user.tokenVersion++;
    } else user.state = "active";
    const response = await h.verify(attempt.attemptToken, code);
    expect(response.status).toBe(410);
    expect(response.headers.get("set-cookie")).toBeNull();
  }
});

it("публичные ответы нового и существующего email имеют одинаковые сроки и структуру", async () => {
  const h = await start();
  await h.auth.seed("active");
  const existing = await h.register();
  const fresh = await h.register(OTHER_EMAIL);
  const span = (body: typeof existing) =>
    [body.attemptExpiresAt, body.codeExpiresAt].map(
      (value) => Date.parse(value) - Date.parse(body.resendAvailableAt),
    );
  expect(span(existing)).toEqual(span(fresh));
  expect(existing.attemptToken).not.toBe(fresh.attemptToken);
  expect(existing.attemptToken).toHaveLength(fresh.attemptToken.length);
});
