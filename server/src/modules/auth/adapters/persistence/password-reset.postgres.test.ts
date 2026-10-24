import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Router } from "express";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { pool } from "../../../../db/pool.js";
import { migrate } from "../../../../db/migrate.js";
import { buildApp, uploadPolicy } from "../../../../composition.js";
import { createFilesPersistence } from "../../../files/persistence.js";
import { createMemoryObjectStore } from "../../../../storage/memory-object-store.js";
import { createTestClock } from "../../../../testing/clock.js";
import type { TestClock } from "../../../../testing/clock.js";
import {
  createAuthHarness,
  EMAIL,
  PASSWORD,
} from "../../testing/auth.harness.js";
import { createRegistration } from "../../application/registration.js";
import { createAuthRouter, createRequireAuth } from "../http/routes.js";
import { createSqlRegistrationStore } from "./sql-registration-store.js";
import { createSqlSessionStore } from "./sql-session-store.js";

const schema = `password_reset_test_${randomUUID().replaceAll("-", "")}`;
let created = false;
const servers: Server[] = [];
beforeAll(async () => {
  await pool.query(`create schema ${schema}`);
  created = true;
  await pool.query(`set search_path to ${schema}`);
  pool.options.options = `-c search_path=${schema}`;
  await migrate();
});
beforeEach(async () => {
  await pool.query(
    "truncate login_attempts, auth_sessions, auth_secrets, auth_mail_events, users cascade",
  );
});
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
afterAll(async () => {
  if (created) await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

async function start(clock: TestClock = createTestClock(), deadlineMs = 15000) {
  const auth = createAuthHarness(clock);
  const store = createSqlSessionStore(clock);
  const sessions = auth.withStore(store, deadlineMs);
  const registration = createRegistration({
    store: createSqlRegistrationStore(clock),
    hasher: auth.hasher,
    notification: { sendEmail: auth.sendEmail },
    clock,
    wait: async (ms) => clock.advance(ms / 3600000),
    publicUrl: "https://files.example.com",
    deadlineMs,
  });
  const app = buildApp({
    files: {
      ...createFilesPersistence("test-bucket"),
      objectStore: createMemoryObjectStore(),
      policy: uploadPolicy(),
    },
    healthRouter: Router(),
    auth: {
      authRouter: createAuthRouter(sessions, {
        cookieSecure: true,
        registration,
        allowedOrigins: ["https://files.example.com"],
      }),
      requireAuth: createRequireAuth(sessions),
    },
    corsOrigin: [],
    maxUploadSizeBytes: 1024,
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
  async function activate(email = EMAIL) {
    expect(
      (await post("register", { name: "Имя", email, password: PASSWORD }))
        .status,
    ).toBe(202);
    const token = new URL(
      auth.sendEmail.mock.calls.at(-1)![0].text.match(/https:\/\/\S+/)![0],
    ).hash.slice(7);
    expect((await post("activation/confirm", { token })).status).toBe(200);
  }
  const login = () => post("login", { email: EMAIL, password: PASSWORD });
  const verify = (attemptToken: string, code = auth.code()) =>
    post("login/verify", { attemptToken, code });
  const resend = (attemptToken: string) =>
    post("login/resend", { attemptToken });
  const enter = async () => {
    const response = await login();
    expect(response.status).toBe(200);
    return verify((await response.json()).attemptToken);
  };
  return { auth, clock, post, activate, login, verify, resend, enter, base };
}
const cookieOf = (response: Response) =>
  response.headers.getSetCookie()[0]?.split(";")[0] ?? "";

const NEW_PASSWORD = "new password 12345";
async function startReset(clock?: TestClock) {
  const h = await start(clock);
  const mailToken = () =>
    new URL(
      h.auth.sendEmail.mock.calls.at(-1)![0].text.match(/https:\/\/\S+/)![0],
    ).hash.slice(7);
  const request = (email = EMAIL) =>
    h.post("password-reset/request", { email });
  const confirm = (token: string, password = NEW_PASSWORD) =>
    h.post("password-reset/confirm", {
      token,
      password,
      passwordConfirmation: password,
    });
  const resetLink = async () => {
    expect((await request()).status).toBe(202);
    return mailToken();
  };
  return { ...h, mailToken, request, confirm, resetLink };
}

it("неактивный пользователь задаёт пароль по ссылке, становится активным и входит только с новым паролем и кодом", async () => {
  const h = await startReset();
  expect(
    (
      await h.post("register", {
        name: "Имя",
        email: EMAIL,
        password: PASSWORD,
      })
    ).status,
  ).toBe(202);
  const activation = h.mailToken();
  h.clock.advance(1 / 60);
  const requestedAt = h.clock.now().getTime();
  const token = await h.resetLink();
  const secrets = await pool.query(
    "select purpose, token_hash, expires_at from auth_secrets where purpose = 'password-reset'",
  );
  expect(secrets.rows).toEqual([
    {
      purpose: "password-reset",
      token_hash: createHash("sha256").update(token).digest("hex"),
      expires_at: new Date(requestedAt + 1800000),
    },
  ]);
  await fetch(`${h.base}/api/auth/password-reset/confirm?token=${token}`);
  expect((await pool.query("select state from users")).rows).toEqual([
    { state: "inactive" },
  ]);
  expect((await h.post("activation/confirm", { token })).status).toBe(400);
  expect((await h.confirm(activation)).status).toBe(400);
  const response = await h.confirm(token);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    message: "Пароль изменён. Теперь можно войти",
  });
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(h.auth.sendEmail.mock.calls.at(-1)![0].subject).toBe(
    "Ваш пароль изменён",
  );
  expect((await pool.query("select state from users")).rows).toEqual([
    { state: "active" },
  ]);
  expect((await pool.query("select * from auth_secrets")).rows).toEqual([]);
  expect((await h.confirm(token)).status).toBe(400);
  expect(
    (await h.post("activation/confirm", { token: activation })).status,
  ).toBe(400);
  expect((await h.login()).status).toBe(401);
  const login = await h.post("login", {
    email: EMAIL,
    password: NEW_PASSWORD,
  });
  expect(login.status).toBe(200);
  expect((await h.verify((await login.json()).attemptToken)).status).toBe(200);
});

it("сам запрос не отзывает доступ, а завершение отзывает сессии и попытки и допускает прежний пароль", async () => {
  const h = await startReset();
  await h.activate();
  const cookie = cookieOf(await h.enter());
  h.clock.advance(1 / 60);
  const pending = (await (await h.login()).json()).attemptToken as string;
  const code = h.auth.code();
  h.clock.advance(1 / 60);
  const token = await h.resetLink();
  expect((await h.post("refresh", undefined, cookie)).status).toBe(200);
  expect((await h.confirm(token, PASSWORD)).status).toBe(200);
  expect((await h.post("refresh", undefined, cookie)).status).toBe(401);
  expect((await h.verify(pending, code)).status).toBe(410);
  expect((await h.resend(pending)).status).toBe(410);
  expect((await h.enter()).status).toBe(200);
});

it.each([-1, 0, 1])(
  "ссылка восстановления действует ровно 30 минут (смещение %i мс)",
  async (offset) => {
    const h = await startReset();
    await h.activate();
    const requestedAt = h.clock.now().getTime();
    const token = await h.resetLink();
    h.clock.advance(
      (requestedAt + 1800000 + offset - h.clock.now().getTime()) / 3600000,
    );
    expect((await h.confirm(token)).status).toBe(offset < 0 ? 200 : 400);
  },
);

it("повтор заменяет секрет до SMTP, отказ SMTP не восстанавливает старую ссылку, квота нейтральна для неизвестного email", async () => {
  const h = await startReset();
  await h.activate();
  const old = await h.resetLink();
  h.clock.advance(1 / 60);
  let replacement = "";
  h.auth.sendEmail.mockImplementationOnce(async () => {
    replacement = h.mailToken();
    expect((await h.confirm(old)).status).toBe(400);
    throw new Error("SMTP rejected private@example.com");
  });
  expect((await h.request()).status).toBe(202);
  expect((await h.request()).status).toBe(429);
  expect((await h.request("unknown@example.com")).status).toBe(202);
  expect((await h.request("unknown@example.com")).status).toBe(429);
  const restarted = await startReset(h.clock);
  expect((await restarted.request()).status).toBe(429);
  expect((await h.confirm(old)).status).toBe(400);
  expect((await restarted.confirm(replacement)).status).toBe(200);
});

it("конкурентное завершение через разные экземпляры даёт ровно один успех", async () => {
  const h = await startReset();
  await h.activate();
  const token = await h.resetLink();
  const other = await startReset(h.clock);
  const statuses = await Promise.all(
    [h, other, h, other].map(
      async (instance) => (await instance.confirm(token)).status,
    ),
  );
  expect(statuses.sort()).toEqual([200, 400, 400, 400]);
});

it("гонка завершения с продлением и проверкой кода не оставляет действующего доступа из старой сессии и попытки", async () => {
  const h = await startReset();
  await h.activate();
  const cookie = cookieOf(await h.enter());
  h.clock.advance(1 / 60);
  const pending = (await (await h.login()).json()).attemptToken as string;
  const code = h.auth.code();
  h.clock.advance(1 / 60);
  const token = await h.resetLink();
  const other = await startReset(h.clock);
  const [reset, , verified] = await Promise.all([
    other.confirm(token),
    h.post("refresh", undefined, cookie),
    h.verify(pending, code),
  ]);
  expect(reset.status).toBe(200);
  expect((await h.post("refresh", undefined, cookie)).status).toBe(401);
  const late = cookieOf(verified);
  if (late) expect((await h.post("refresh", undefined, late)).status).toBe(401);
});

it("сбой отзыва откатывает новый пароль и оставляет ссылку действующей", async () => {
  const h = await startReset();
  await h.activate();
  const cookie = cookieOf(await h.enter());
  const token = await h.resetLink();
  await pool.query(
    "create function reject_revoke() returns trigger language plpgsql as $$ begin raise exception 'private secret'; end $$",
  );
  await pool.query(
    "create trigger reject_revoke before update on auth_sessions for each row execute function reject_revoke()",
  );
  try {
    const response = await h.confirm(token);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private secret");
  } finally {
    await pool.query("drop trigger reject_revoke on auth_sessions");
    await pool.query("drop function reject_revoke()");
  }
  expect((await h.post("refresh", undefined, cookie)).status).toBe(200);
  expect((await h.confirm(token)).status).toBe(200);
  expect((await h.post("refresh", undefined, cookie)).status).toBe(401);
});
