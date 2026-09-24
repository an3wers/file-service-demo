import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Router } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../../../app.js";
import { ERROR_CODES } from "../../../../errors.js";
import {
  ACCESS_TTL_SECONDS,
  LOGIN,
  PASSWORD,
  REFRESH_TTL_SECONDS,
  createAuthHarness,
} from "../../testing/auth.harness.js";
import { createAuthRouter, createRequireAuth } from "./routes.js";

let server: Server | undefined;

async function start(options: { cookieSecure?: boolean } = {}) {
  const auth = createAuthHarness();

  await auth.sync();

  const filesRouter = Router().get("/", (_req, res) => {
    res.json({ items: [] });
  });
  const app = createApp({
    healthRouter: Router(),
    authRouter: createAuthRouter(auth.sessions, { cookieSecure: options.cookieSecure ?? false }),
    requireAuth: createRequireAuth(auth.sessions),
    filesRouter,
    directoriesRouter: Router(),
    corsOrigin: [],
  });

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });

  return { auth, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

function login(base: string, body: unknown = { login: LOGIN, password: PASSWORD }) {
  return fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function refresh(base: string, cookie?: string) {
  return fetch(`${base}/api/auth/refresh`, {
    method: "POST",
    headers: cookie ? { Cookie: cookie } : {},
  });
}

function refreshCookie(response: Response): string {
  const header = response.headers.getSetCookie().find((value) => value.startsWith("refresh_token="));

  return header?.split(";")[0] ?? "";
}

function listFiles(base: string, authorization?: string) {
  return fetch(`${base}/api/files`, {
    headers: authorization ? { Authorization: authorization } : {},
  });
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

async function accessTokenOf(base: string): Promise<string> {
  return ((await (await login(base)).json()) as { accessToken: string }).accessToken;
}

describe("POST /api/auth/login", () => {
  it("отдаёт токен доступа и кладёт токен обновления в httpOnly-cookie", async () => {
    const { base } = await start();

    const response = await login(base);
    const body = await response.json();
    const [cookie] = response.headers.getSetCookie();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      accessToken: expect.any(String),
      expiresIn: ACCESS_TTL_SECONDS,
      user: { login: LOGIN },
    });
    expect(cookie).toMatch(/^refresh_token=[^;]+;/);
    expect(cookie).toContain(`Max-Age=${REFRESH_TTL_SECONDS}`);
    expect(cookie).toContain("Path=/api/auth");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Secure");
  });

  it("ставит Secure у cookie, когда это включено в конфигурации", async () => {
    const { base } = await start({ cookieSecure: true });

    const [cookie] = (await login(base)).headers.getSetCookie();

    expect(cookie).toContain("Secure");
  });

  it("отвечает одинаковым 401 INVALID_CREDENTIALS на неверный логин и неверный пароль", async () => {
    const { base } = await start();

    const wrongLogin = await login(base, { login: "stranger", password: PASSWORD });
    const wrongPassword = await login(base, { login: LOGIN, password: "wrong password" });

    expect(wrongLogin.status).toBe(401);
    expect(wrongPassword.status).toBe(401);

    const [loginBody, passwordBody] = await Promise.all([wrongLogin.json(), wrongPassword.json()]);

    expect(loginBody.error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
    expect(passwordBody.error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
    expect(loginBody.error.message).toBe(passwordBody.error.message);
    expect(wrongLogin.headers.getSetCookie()).toEqual([]);
  });
});

describe("POST /api/auth/refresh", () => {
  it("меняет токен обновления из cookie на новую пару и новую cookie", async () => {
    const { auth, base } = await start();
    const first = refreshCookie(await login(base));

    auth.clock.advance(1);
    const response = await refresh(base, first);
    const second = refreshCookie(response);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { login: LOGIN }, expiresIn: ACCESS_TTL_SECONDS });
    expect(second).not.toBe("");
    expect(second).not.toBe(first);
    expect((await refresh(base, second)).status).toBe(200);
  });

  it("отвечает 401 SESSION_EXPIRED без cookie", async () => {
    const { base } = await start();

    const response = await refresh(base);

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(ERROR_CODES.SESSION_EXPIRED);
  });

  it("отвечает 401 SESSION_EXPIRED и стирает cookie после отзыва сессий", async () => {
    const { auth, base } = await start();
    const cookie = refreshCookie(await login(base));

    await auth.sync({ password: "a brand new password" });
    const response = await refresh(base, cookie);

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(ERROR_CODES.SESSION_EXPIRED);
    expect(response.headers.getSetCookie()[0]).toMatch(/^refresh_token=;.*Expires=Thu, 01 Jan 1970/);
  });
});

describe("POST /api/auth/logout", () => {
  it("отвечает 204 и очищает cookie, в том числе без неё", async () => {
    const { base } = await start();

    const withCookie: Record<string, string>[] = [{ Cookie: refreshCookie(await login(base)) }, {}];

    for (const headers of withCookie) {
      const response = await fetch(`${base}/api/auth/logout`, { method: "POST", headers });
      const [cookie] = response.headers.getSetCookie();

      expect(response.status).toBe(204);
      expect(cookie).toMatch(/^refresh_token=;/);
      expect(cookie).toContain("Path=/api/auth");
      expect(cookie).toContain("Expires=Thu, 01 Jan 1970");
    }
  });
});

describe("requireAuth", () => {
  it("пускает запрос с действующим токеном доступа", async () => {
    const { base } = await start();
    const token = await accessTokenOf(base);

    expect((await listFiles(base, `Bearer ${token}`)).status).toBe(200);
  });

  it("отвечает 401 UNAUTHORIZED без заголовка Authorization", async () => {
    const { base } = await start();

    const response = await listFiles(base);

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(ERROR_CODES.UNAUTHORIZED);
  });

  it("отвечает 401 UNAUTHORIZED на просроченный токен доступа", async () => {
    const { auth, base } = await start();
    const token = await accessTokenOf(base);

    auth.clock.advance(1);
    const response = await listFiles(base, `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(ERROR_CODES.UNAUTHORIZED);
  });

  it("отвечает 401 UNAUTHORIZED на токен обновления вместо токена доступа", async () => {
    const { base } = await start();
    const refreshToken = refreshCookie(await login(base)).replace("refresh_token=", "");

    const response = await listFiles(base, `Bearer ${refreshToken}`);

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe(ERROR_CODES.UNAUTHORIZED);
  });

  it("отвечает 401 UNAUTHORIZED на схему, отличную от Bearer", async () => {
    const { base } = await start();
    const token = await accessTokenOf(base);

    expect((await listFiles(base, `Basic ${token}`)).status).toBe(401);
  });
});
