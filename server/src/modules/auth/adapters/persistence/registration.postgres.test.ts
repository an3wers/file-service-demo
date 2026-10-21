import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { pool } from "../../../../db/pool.js";
import { migrate } from "../../../../db/migrate.js";
import { createSqlRegistrationStore } from "./sql-registration-store.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Router } from "express";
import { createApp } from "../../../../app.js";
import { createAuthRouter, createRequireAuth } from "../http/routes.js";
import { createAuthHarness } from "../../testing/auth.harness.js";
import { createSessionsModule } from "../../application/sessions.js";
import { createSqlUserRows } from "./sql-user-rows.js";
import { createRegistration } from "../../application/registration.js";
import { vi } from "vitest";
import { mapAuthError } from "../http/error-map.js";

const schema = `registration_test_${randomUUID().replaceAll("-", "")}`;
let created = false;
const deadline = () => new Date(Date.now() + 15000);
beforeAll(async () => {
  await pool.query(`create schema ${schema}`);
  created = true;
  await pool.query(`set search_path to ${schema}`);
  pool.options.options = `-c search_path=${schema}`;
  await migrate();
});
beforeEach(async () => {
  await pool.query("truncate auth_secrets, auth_mail_events, users");
});
afterAll(async () => {
  if (created) await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

function record(email = "name@example.com") {
  return {
    id: randomUUID(),
    name: "Имя",
    email,
    passwordHash: "scrypt$hash",
    tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
    expiresAt: new Date(Date.now() + 86400000),
  };
}

it("конкурентные регистрации сохраняют одного пользователя и не меняют его имя и пароль", async () => {
  const first = record();
  const store = createSqlRegistrationStore();
  await store.save(first, deadline());
  await Promise.all(
    Array.from({ length: 20 }, () =>
      createSqlRegistrationStore().save(
        { ...record(), name: "Другое имя", passwordHash: "other" },
        deadline(),
      ),
    ),
  );
  const { rows } = await pool.query(
    "select id, name, email, password_hash, state from users",
  );
  expect(rows).toEqual([
    {
      id: first.id,
      name: "Имя",
      email: first.email,
      password_hash: first.passwordHash,
      state: "inactive",
    },
  ]);
  expect((await pool.query("select * from auth_secrets")).rows).toHaveLength(1);
  expect((await pool.query("select purpose from auth_secrets")).rows).toEqual([
    { purpose: "activation" },
  ]);
});

it("новая пара пользователя и секрета откатывается целиком при ошибке записи секрета", async () => {
  const store = createSqlRegistrationStore();
  const first = record();
  await store.save(first, deadline());
  await expect(
    store.save(
      { ...record("other@example.com"), tokenHash: first.tokenHash },
      deadline(),
    ),
  ).rejects.toThrow();
  expect((await pool.query("select id from users")).rows).toEqual([
    { id: first.id },
  ]);
});

it("активный пользователь не получает новую активацию", async () => {
  const store = createSqlRegistrationStore();
  const first = record();
  await store.save(first, deadline());
  await pool.query("update users set state = 'active'");
  expect(await store.save(record(), deadline())).toBe(false);
  expect(
    (await pool.query("select token_hash from auth_secrets")).rows,
  ).toEqual([{ token_hash: first.tokenHash }]);
});

it("часовая квота исключает левую границу и переживает пересоздание адаптера", async () => {
  const now = new Date();
  const limits = [{ windowMs: 3600000, maximum: 5 }];
  const consume = (ms: number) =>
    createSqlRegistrationStore().consume(
      "activation:email",
      limits,
      new Date(now.getTime() + ms),
      deadline(),
    );
  expect(await consume(0)).toBe(0);
  for (const ms of [60000, 120000, 180000, 240000])
    expect(await consume(ms)).toBe(0);
  expect(await consume(300000)).toBe(3300);
  expect(await consume(3599999)).toBe(1);
  expect(await consume(3600000)).toBe(0);
});

it("разные экземпляры не обходят IP-квоту параллельными запросами", async () => {
  const now = new Date();
  const results = await Promise.all(
    Array.from({ length: 40 }, () =>
      createSqlRegistrationStore().consume(
        "mail:ip:shared",
        [{ windowMs: 3600000, maximum: 20 }],
        now,
        deadline(),
      ),
    ),
  );
  expect(results.filter((retry) => retry === 0)).toHaveLength(20);
  expect(results.filter((retry) => retry === 3600)).toHaveLength(20);
  expect(
    (await pool.query("select count(*) from auth_mail_events")).rows[0]?.count,
  ).toBe(20);
});

it("единственная минутная квота допускает только одну конкурентную регистрацию", async () => {
  const now = new Date();
  const results = await Promise.all(
    Array.from({ length: 15 }, () =>
      createSqlRegistrationStore().consume(
        "mail:activation:shared",
        [
          { windowMs: 60000, maximum: 1 },
          { windowMs: 3600000, maximum: 5 },
        ],
        now,
        deadline(),
      ),
    ),
  );
  expect(results.filter((retry) => retry === 0)).toHaveLength(1);
});

it("минутный отказ расходует часовую квоту без сдвига собственного окна", async () => {
  const now = Date.now();
  const limits = [
    { windowMs: 60000, maximum: 1 },
    { windowMs: 3600000, maximum: 5 },
  ];
  const store = createSqlRegistrationStore();
  expect(
    await store.consume("separate-windows", limits, new Date(now), deadline()),
  ).toBe(0);
  for (const seconds of [1, 2, 3, 4])
    expect(
      await store.consume(
        "separate-windows",
        limits,
        new Date(now + seconds * 1000),
        deadline(),
      ),
    ).toBe(60 - seconds);
  expect(
    await store.consume(
      "separate-windows",
      limits,
      new Date(now + 60000),
      deadline(),
    ),
  ).toBe(3540);
});

it("собранное HTTP-приложение не пускает неактивного пользователя и сохраняет запись при остановке до SMTP", async () => {
  const auth = createAuthHarness();
  const first = record();
  first.passwordHash = await auth.hasher.hash("original password");
  const store = createSqlRegistrationStore();
  await store.save(first, deadline());
  const sessions = createSessionsModule({
    users: createSqlUserRows(),
    hasher: auth.hasher,
    tokens: auth.tokens,
    login: first.id,
  });
  let now = Date.now();
  const sendEmail = vi.fn();
  const registration = createRegistration({
    store: {
      ...store,
      save: async (...args) => {
        await store.save(...args);
        throw new Error("Остановка до SMTP");
      },
    },
    hasher: auth.hasher,
    notification: { sendEmail },
    publicUrl: "https://files.example.com",
    deadlineMs: 15000,
    clock: { now: () => new Date(now) },
    wait: async (ms) => {
      now += ms;
    },
  });
  const app = createApp({
    authRouter: createAuthRouter(sessions, {
      cookieSecure: false,
      registration,
      allowedOrigins: ["https://files.example.com"],
    }),
    requireAuth: createRequireAuth(sessions),
    healthRouter: Router(),
    filesRouter: Router(),
    directoriesRouter: Router(),
    corsOrigin: [],
    errorMappers: [mapAuthError],
  });
  const server = await new Promise<Server>((resolve) => {
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
  try {
    const login = await post("login", {
      login: first.id,
      password: "original password",
    });
    expect(login.status).toBe(401);
    expect(login.headers.getSetCookie()).toEqual([]);
    expect((await fetch(`${base}/api/files`)).status).toBe(401);
    const failed = await post("register", {
      name: "Новое имя",
      email: "new@example.com",
      password: "new password 123",
    });
    expect(failed.status).toBe(503);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(
      (
        await pool.query(
          "select state from users where email = 'new@example.com'",
        )
      ).rows,
    ).toEqual([{ state: "inactive" }]);
    expect(
      (await pool.query("select count(*) from auth_secrets")).rows[0]?.count,
    ).toBe(2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("минутное окно округляет ожидание вверх и исключает точную левую границу", async () => {
  const now = Date.now();
  const consume = (ms: number) =>
    createSqlRegistrationStore().consume(
      "minute-only",
      [{ windowMs: 60000, maximum: 1 }],
      new Date(now + ms),
      deadline(),
    );
  expect(await consume(0)).toBe(0);
  expect(await consume(1)).toBe(60);
  expect(await consume(59999)).toBe(1);
  expect(await consume(60000)).toBe(0);
});
