import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as wait } from "node:timers/promises";
import { Router } from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { pool } from "../../../../db/pool.js";
import { migrate } from "../../../../db/migrate.js";
import { createApp } from "../../../../app.js";
import { createTestClock } from "../../../../testing/clock.js";
import type { TestClock } from "../../../../testing/clock.js";
import { createAuthHarness } from "../../testing/auth.harness.js";
import { createRegistration } from "../../application/registration.js";
import { createAuthRouter, createRequireAuth } from "../http/routes.js";
import { mapAuthError } from "../http/error-map.js";
import { createSqlRegistrationStore } from "./sql-registration-store.js";

const schema = `activation_test_${randomUUID().replaceAll("-", "")}`;
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
    "truncate login_attempts, auth_sessions, auth_secrets, auth_mail_events, users",
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

async function start(
  clock: TestClock = createTestClock(),
  deadlineMs = 15000,
  realTime = false,
) {
  const auth = createAuthHarness();
  const sendEmail = vi.fn().mockResolvedValue({ messageId: "accepted" });
  const store = createSqlRegistrationStore(clock);
  const registration = createRegistration({
    store,
    hasher: auth.hasher,
    notification: { sendEmail },
    clock,
    wait: async (ms) => {
      if (realTime) await wait(ms);
      else clock.advance(ms / 3600000);
    },
    publicUrl: "https://files.example.com",
    deadlineMs,
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
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  servers.push(server);
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
  const register = (email = "user@example.com") =>
    post("register", { name: "Имя", email, password: "password 12345" });
  const token = () =>
    new URL(
      sendEmail.mock.calls.at(-1)![0].text.match(/https:\/\/\S+/)![0],
    ).hash.slice(7);
  const confirm = (value: string) =>
    post("activation/confirm", { token: value });
  const request = (email = "user@example.com") =>
    post("activation/request", { email });
  return {
    base,
    clock,
    sendEmail,
    store,
    post,
    register,
    token,
    confirm,
    request,
  };
}

it("письмо открывается в другом браузере, GET не активирует, а POST погашает ссылку без сессии", async () => {
  const first = await start();
  expect((await first.register()).status).toBe(202);
  const token = first.token();
  expect((await pool.query("select state from users")).rows).toEqual([
    { state: "inactive" },
  ]);
  expect(
    (await pool.query("select token_hash from auth_secrets")).rows,
  ).toEqual([{ token_hash: createHash("sha256").update(token).digest("hex") }]);
  const other = await start(first.clock);
  await fetch(`${other.base}/api/auth/activation/confirm?token=${token}`);
  expect((await pool.query("select state from users")).rows).toEqual([
    { state: "inactive" },
  ]);
  const response = await other.confirm(token);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    message: "Email подтверждён. Теперь можно войти",
  });
  expect(response.headers.getSetCookie()).toEqual([]);
  expect((await pool.query("select state from users")).rows).toEqual([
    { state: "active" },
  ]);
  expect((await other.confirm(token)).status).toBe(400);
  expect((await fetch(`${other.base}/api/files`)).status).toBe(401);
});

it("повтор отменяет старое письмо до SMTP, отказ SMTP не восстанавливает старый секрет", async () => {
  const h = await start();
  await h.register();
  const old = h.token();
  h.clock.advance(1 / 60);
  let replacement = "";
  h.sendEmail.mockImplementationOnce(async () => {
    replacement = h.token();
    expect((await h.confirm(old)).status).toBe(400);
    expect(
      (await pool.query("select token_hash from auth_secrets")).rows,
    ).toEqual([
      { token_hash: createHash("sha256").update(replacement).digest("hex") },
    ]);
    throw new Error("SMTP rejected private@example.com");
  });
  const requestedAt = h.clock.now().getTime();
  expect((await h.request()).status).toBe(202);
  expect(
    (
      await pool.query("select expires_at from auth_secrets")
    ).rows[0]?.expires_at.getTime(),
  ).toBe(requestedAt + 86400000);
  expect(replacement).not.toBe(old);
  expect((await h.confirm(old)).status).toBe(400);
  expect((await h.confirm(replacement)).status).toBe(200);
  expect(h.sendEmail).toHaveBeenCalledTimes(2);
});

it("ошибка записи повтора откатывает замену и оставляет старую ссылку без отправки", async () => {
  const h = await start();
  await h.register();
  const old = h.token();
  h.clock.advance(1 / 60);
  await pool.query(
    "create function reject_activation() returns trigger language plpgsql as $$ begin raise exception 'private secret'; end $$",
  );
  await pool.query(
    "create trigger reject_activation before update on auth_secrets for each row execute function reject_activation()",
  );
  try {
    const response = await h.request();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private secret");
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    expect((await h.confirm(old)).status).toBe(200);
  } finally {
    await pool.query("drop trigger reject_activation on auth_secrets");
    await pool.query("drop function reject_activation()");
  }
});

it.each([-1, 0, 1])(
  "проверяет срок 24 часа с точностью до миллисекунды: смещение %s",
  async (offset) => {
    const h = await start();
    const issuedAt = h.clock.now().getTime();
    await h.register();
    const expiresAt = issuedAt + 86400000;
    h.clock.advance((expiresAt + offset - h.clock.now().getTime()) / 3600000);
    const response = await h.confirm(h.token());
    expect(response.status).toBe(offset < 0 ? 200 : 400);
    if (offset >= 0)
      expect((await response.json()).error.code).toBe(
        "ACTIVATION_LINK_INVALID",
      );
  },
);

it("действующая ссылка активного пользователя погашается успешно, секрет другого назначения не подходит", async () => {
  const h = await start();
  await h.register();
  const activation = h.token();
  await pool.query("update users set state = 'active'");
  expect((await h.confirm(activation)).status).toBe(200);
  expect((await h.confirm(activation)).status).toBe(400);
  h.clock.advance(1 / 60);
  await h.register("other@example.com");
  const reset = h.token();
  await pool.query("update auth_secrets set purpose = 'password-reset'");
  expect((await h.confirm(reset)).status).toBe(400);
  expect((await pool.query("select purpose from auth_secrets")).rows).toEqual([
    { purpose: "password-reset" },
  ]);
});

it("конкурентное подтверждение через разные экземпляры даёт ровно один успех", async () => {
  const h = await start();
  await h.register();
  const other = await start(h.clock);
  const token = h.token();
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? h : other).confirm(token),
    ),
  );
  expect(responses.filter((response) => response.status === 200)).toHaveLength(
    1,
  );
  expect(responses.filter((response) => response.status === 400)).toHaveLength(
    19,
  );
  expect((await pool.query("select * from auth_secrets")).rows).toHaveLength(0);
  expect((await pool.query("select state from users")).rows).toEqual([
    { state: "active" },
  ]);
});

it("подтверждение перепроверяет срок после ожидания блокировки пользователя", async () => {
  const h = await start();
  await h.register();
  const token = h.token();
  h.clock.advance((86400000 - 15000 - 1) / 3600000);
  const held = await pool.connect();
  await held.query("begin");
  await held.query("select id from users for update");
  const confirming = h.confirm(token);
  try {
    await vi.waitFor(async () => {
      const { rows } = await pool.query(
        "select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like 'select id from users where id = % for update'",
      );
      expect(rows.length).toBeGreaterThan(0);
    });
    h.clock.advance(1 / 3600000);
  } finally {
    await held.query("commit");
    held.release();
  }
  expect((await confirming).status).toBe(400);
  expect((await pool.query("select state from users")).rows).toEqual([
    { state: "inactive" },
  ]);
});

it("пересоздание приложения сохраняет ссылку и общие квоты, отказ повтора не меняет секрет", async () => {
  const h = await start();
  await h.register();
  const token = h.token();
  const other = await start(h.clock);
  const limited = await other.request();
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("45");
  expect(other.sendEmail).not.toHaveBeenCalled();
  expect((await other.confirm(token)).status).toBe(200);
  h.clock.advance(1 / 60);
  expect((await other.request()).status).toBe(202);
  expect((await other.request("missing@example.com")).status).toBe(202);
  expect(other.sendEmail).not.toHaveBeenCalled();
});

it("общая IP-квота подтверждения учитывает неверные ссылки и транспортные ошибки и открывается на границе", async () => {
  const h = await start();
  for (let index = 0; index < 20; index++) {
    const response =
      index % 2
        ? await h.confirm("invalid")
        : await fetch(`${h.base}/api/auth/activation/confirm`, {
            method: "POST",
            headers: {
              Origin: "https://files.example.com",
              "Content-Type": "application/json",
            },
            body: "{",
          });
    expect(response.status).toBe(400);
  }
  const other = await start(h.clock);
  let limited = await other.confirm("invalid");
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("900");
  h.clock.advance(899999 / 3600000);
  limited = await other.confirm("invalid");
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("1");
  h.clock.advance(1 / 3600000);
  expect((await other.confirm("invalid")).status).toBe(400);
});

it("неизвестный результат SMTP не возвращает старую ссылку и не вызывает досылку", async () => {
  const h = await start(createTestClock(), 500);
  await h.register();
  const old = h.token();
  h.clock.advance(1 / 60);
  let signal: AbortSignal | undefined;
  h.sendEmail.mockImplementationOnce((_message, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  expect((await h.request()).status).toBe(202);
  expect(signal?.aborted).toBe(true);
  const replacement = h.token();
  expect((await h.confirm(old)).status).toBe(400);
  const other = await start(h.clock);
  expect((await other.confirm(replacement)).status).toBe(200);
  expect(other.sendEmail).not.toHaveBeenCalled();
  expect(h.sendEmail).toHaveBeenCalledTimes(2);
});

it("ошибка активации откатывает погашение секрета вместе с изменением пользователя", async () => {
  const h = await start();
  await h.register();
  const token = h.token();
  await pool.query(
    "create function reject_user_activation() returns trigger language plpgsql as $$ begin raise exception 'private secret'; end $$",
  );
  await pool.query(
    "create trigger reject_user_activation before update on users for each row execute function reject_user_activation()",
  );
  try {
    expect((await h.confirm(token)).status).toBe(503);
    expect((await pool.query("select state from users")).rows).toEqual([
      { state: "inactive" },
    ]);
    expect(
      (await pool.query("select user_id from auth_secrets")).rows,
    ).toHaveLength(1);
  } finally {
    await pool.query("drop trigger reject_user_activation on users");
    await pool.query("drop function reject_user_activation()");
  }
  expect((await h.confirm(token)).status).toBe(200);
});

function runningClock(): TestClock {
  let offset = 0;
  return {
    now: () => new Date(Date.now() + offset),
    advance: (hours) => {
      offset += hours * 3600000;
    },
  };
}

it("конкурентные повторы в разных экземплярах допускают одно письмо и не обходят общую email-квоту", async () => {
  const clock = runningClock();
  const first = await start(clock, 500, true);
  const other = await start(clock, 500, true);
  await first.register();
  const old = first.token();
  clock.advance(1 / 60);
  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      (index % 2 ? first : other).request(),
    ),
  );
  expect(responses.filter((response) => response.status === 202)).toHaveLength(
    1,
  );
  expect(responses.filter((response) => response.status === 429)).toHaveLength(
    9,
  );
  expect(
    first.sendEmail.mock.calls.length + other.sendEmail.mock.calls.length,
  ).toBe(2);
  expect((await first.confirm(old)).status).toBe(400);
  const replacement = other.sendEmail.mock.calls.length
    ? other.token()
    : first.token();
  expect((await first.confirm(replacement)).status).toBe(200);
});

it("гонка повтора и подтверждения не воскрешает погашенную ссылку и не меняет активного пользователя", async () => {
  const clock = runningClock();
  const h = await start(clock, 500, true);
  await h.register();
  const old = h.token();
  clock.advance(1 / 60);
  const [confirmation, request] = await Promise.all([
    h.confirm(old),
    h.request(),
  ]);
  expect(request.status).toBe(202);
  expect([200, 400]).toContain(confirmation.status);
  if (confirmation.status === 200) {
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
  } else {
    expect(h.sendEmail).toHaveBeenCalledTimes(2);
    expect((await h.confirm(h.token())).status).toBe(200);
  }
  expect((await h.confirm(old)).status).toBe(400);
  expect((await pool.query("select state from users")).rows).toEqual([
    { state: "active" },
  ]);
  expect((await pool.query("select * from auth_secrets")).rows).toHaveLength(0);
});
