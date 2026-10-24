import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
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

const schema = `sessions_test_${randomUUID().replaceAll("-", "")}`;
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

it("регистрация и активация дают вход только после кода, БД хранит проверочные значения и одну сессию", async () => {
  const h = await start();
  await h.activate();
  const attempt = await (await h.login()).json();
  expect((await fetch(`${h.base}/api/files`)).status).toBe(401);
  const before = (await pool.query("select * from login_attempts")).rows[0]!;
  expect(before.token_hash).not.toBe(attempt.attemptToken);
  expect(before.code_hash).not.toBe(
    createHash("sha256").update(h.auth.code()).digest("hex"),
  );
  expect((await pool.query("select * from auth_sessions")).rowCount).toBe(0);
  const session = await h.verify(attempt.attemptToken);
  expect(session.status).toBe(200);
  const body = await session.json();
  expect(
    (
      await fetch(`${h.base}/api/files`, {
        headers: { Authorization: `Bearer ${body.accessToken}` },
      })
    ).status,
  ).toBe(200);
  const rows = (await pool.query("select * from auth_sessions")).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].token_hash).not.toBe(cookieOf(session).split("=")[1]);
  expect((await h.verify(attempt.attemptToken)).status).toBe(410);
  const other = await start(h.clock);
  expect(
    (await other.post("refresh", undefined, cookieOf(session))).status,
  ).toBe(200);
  expect(other.auth.sendEmail).not.toHaveBeenCalled();
});

it("гонка успешных проверок между экземплярами атомарно создаёт ровно одну сессию", async () => {
  const h = await start();
  await h.activate();
  const { attemptToken } = await (await h.login()).json();
  const code = h.auth.code();
  const other = await start(h.clock);
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? h : other).verify(attemptToken, code),
    ),
  );
  expect(responses.filter((response) => response.status === 200)).toHaveLength(
    1,
  );
  expect(responses.filter((response) => response.status === 410)).toHaveLength(
    19,
  );
  expect((await pool.query("select * from auth_sessions")).rowCount).toBe(1);
});

it("конкурентные неверные коды расходуют ровно пять ошибок без потерянных обновлений", async () => {
  const h = await start();
  await h.activate();
  const { attemptToken } = await (await h.login()).json();
  const wrong = h.auth.code() === "000000" ? "999999" : "000000";
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => h.verify(attemptToken, wrong)),
  );
  const failures = await Promise.all(
    responses
      .filter((response) => response.status === 400)
      .map((response) => response.json()),
  );
  expect(
    failures.map((body) => body.error.details.remainingAttempts).sort(),
  ).toEqual([0, 1, 2, 3, 4]);
  expect(responses.filter((response) => response.status === 410)).toHaveLength(
    5,
  );
  expect((await h.verify(attemptToken)).status).toBe(410);
});

it("сбой создания сессии откатывает погашение и не расходует ошибку кода", async () => {
  const h = await start();
  await h.activate();
  const { attemptToken } = await (await h.login()).json();
  await pool.query(
    "create function reject_session() returns trigger language plpgsql as $$ begin raise exception 'private secret'; end $$",
  );
  await pool.query(
    "create trigger reject_session before insert on auth_sessions for each row execute function reject_session()",
  );
  try {
    const failed = await h.verify(attemptToken);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("private");
    expect(
      (await pool.query("select failures, consumed_at from login_attempts"))
        .rows,
    ).toEqual([{ failures: 0, consumed_at: null }]);
  } finally {
    await pool.query("drop trigger reject_session on auth_sessions");
    await pool.query("drop function reject_session()");
  }
  expect((await h.verify(attemptToken)).status).toBe(200);
});

it("срок кода перепроверяется после ожидания блокировки пользователя", async () => {
  const h = await start();
  await h.activate();
  const { attemptToken } = await (await h.login()).json();
  h.clock.advance(299999 / 3600000);
  const held = await pool.connect();
  await held.query("begin");
  await held.query("select id from users for update");
  const verifying = h.verify(attemptToken);
  try {
    await vi.waitFor(async () => {
      expect(
        (
          await pool.query(
            "select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like 'select * from users where id = % for update'",
          )
        ).rowCount,
      ).toBeGreaterThan(0);
    });
    h.clock.advance(1 / 3600000);
  } finally {
    await held.query("commit");
    held.release();
  }
  const response = await verifying;
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("LOGIN_CODE_EXPIRED");
});

it("продление перепроверяет срок после блокировки и не воскрешает истёкшую сессию", async () => {
  const h = await start();
  await h.activate();
  const cookie = cookieOf(await h.enter());
  h.clock.advance((604800000 - 1) / 3600000);
  const held = await pool.connect();
  await held.query("begin");
  await held.query("select * from auth_sessions for update");
  const renewing = h.post("refresh", undefined, cookie);
  try {
    await vi.waitFor(async () => {
      expect(
        (
          await pool.query(
            "select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like 'select * from auth_sessions where token_hash = % for update'",
          )
        ).rowCount,
      ).toBeGreaterThan(0);
    });
    h.clock.advance(1 / 3600000);
  } finally {
    await held.query("commit");
    held.release();
  }
  expect((await renewing).status).toBe(401);
  expect((await h.post("refresh", undefined, cookie)).status).toBe(401);
});

it("параллельное продление постоянно сохраняет токен и отзыв запрещает дальнейшее продление", async () => {
  const h = await start();
  await h.activate();
  const cookie = cookieOf(await h.enter());
  const other = await start(h.clock);
  for (let i = 0; i < 6; i++) {
    h.clock.advance(6 * 24);
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 ? h : other).post("refresh", undefined, cookie),
      ),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(cookieOf(response)).toBe(cookie);
    }
  }
  const logout = h.post("logout", undefined, cookie);
  await Promise.all(
    Array.from({ length: 10 }, () => other.post("refresh", undefined, cookie)),
  );
  expect((await logout).status).toBe(204);
  expect((await other.post("refresh", undefined, cookie)).status).toBe(401);
});

it("лимиты писем и первого шага общие после перезапуска и конкурентный пароль не создаёт лишних попыток", async () => {
  const h = await start();
  await h.activate();
  const other = await start(h.clock);
  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, index) => (index % 2 ? h : other).login()),
  );
  expect(responses.filter((response) => response.status === 200)).toHaveLength(
    1,
  );
  expect(responses.filter((response) => response.status === 429)).toHaveLength(
    9,
  );
  expect((await pool.query("select * from login_attempts")).rowCount).toBe(1);
  expect(
    h.auth.sendEmail.mock.calls.length + other.auth.sendEmail.mock.calls.length,
  ).toBe(2);
  const blocked = await other.login();
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get("retry-after")).toBe("900");
  h.clock.advance(900000 / 3600000);
  expect((await other.login()).status).toBe(200);
});

it("общий лимит пользователя не сбрасывается новой попыткой и живёт после перезапуска", async () => {
  const h = await start();
  await h.activate();
  const { attemptToken } = await (await h.login()).json();
  const other = await start(h.clock);
  h.clock.advance(300000 / 3600000);
  for (let i = 0; i < 20; i++)
    expect(
      (await (i % 2 ? h : other).verify(attemptToken, "123456")).status,
    ).toBe(400);
  const fresh = await (await other.login()).json();
  const response = await h.verify(fresh.attemptToken, other.auth.code());
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("900");
  expect((await pool.query("select * from auth_sessions")).rowCount).toBe(0);
});

it("таймаут SMTP не отменяет сохранённый код и не порождает досылку после перезапуска", async () => {
  const h = await start(createTestClock(), 60);
  await h.activate();
  let signal: AbortSignal | undefined;
  h.auth.sendEmail.mockImplementationOnce((_message, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  const response = await h.login();
  expect(response.status).toBe(200);
  const attempt = await response.json();
  expect(attempt.deliveryStatus).toBe("unconfirmed");
  expect(signal?.aborted).toBe(true);
  const other = await start(h.clock);
  expect((await other.verify(attempt.attemptToken, h.auth.code())).status).toBe(
    200,
  );
  expect(other.auth.sendEmail).not.toHaveBeenCalled();
});

it("пять писем в час по назначению не заменяют пределом первого шага и освобождаются на точной границе", async () => {
  const h = await start();
  await h.activate();
  for (let index = 0; index < 5; index++) {
    if (index) h.clock.advance(1 / 60);
    expect((await h.login()).status).toBe(200);
  }
  h.clock.advance(1 / 60);
  const blocked = await h.login();
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get("retry-after")).toBe("3300");
  expect((await pool.query("select * from login_attempts")).rowCount).toBe(5);
  h.clock.advance(3300 / 3600);
  expect((await h.login()).status).toBe(200);
});

it("общая IP-квота писем регистрации блокирует вход после пароля без попытки или письма", async () => {
  const h = await start();
  await h.activate();
  for (let i = 1; i < 20; i++)
    expect(
      (
        await h.post("register", {
          name: "Имя",
          email: `other${i}@example.com`,
          password: PASSWORD,
        })
      ).status,
    ).toBe(202);
  const before = h.auth.sendEmail.mock.calls.length;
  const response = await h.login();
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("3300");
  expect((await pool.query("select * from login_attempts")).rowCount).toBe(0);
  expect(h.auth.sendEmail).toHaveBeenCalledTimes(before);
});

it("IP-лимиты ошибочных запросов сохраняются между экземплярами и открываются ровно через 15 минут", async () => {
  const h = await start();
  const other = await start(h.clock);
  for (let i = 0; i < 50; i++)
    expect((await (i % 2 ? h : other).post("login", {})).status).toBe(422);
  expect((await h.login()).status).toBe(429);
  for (let i = 0; i < 100; i++)
    expect((await (i % 2 ? h : other).verify("unknown", "123456")).status).toBe(
      410,
    );
  expect((await other.verify("unknown", "123456")).status).toBe(429);
  h.clock.advance(899999 / 3600000);
  expect((await h.verify("unknown", "123456")).headers.get("retry-after")).toBe(
    "1",
  );
  h.clock.advance(1 / 3600000);
  expect((await other.verify("unknown", "123456")).status).toBe(410);
  expect((await other.login()).status).toBe(401);
});

it("скользящее окно IP-квоты отсчитывается после ожидания общей блокировки", async () => {
  const h = await start();
  for (let i = 0; i < 50; i++)
    expect((await h.post("login", {})).status).toBe(422);
  const key = (
    await pool.query<{ key: string }>(
      "select distinct key from auth_mail_events where key like 'login:ip:%'",
    )
  ).rows[0]!.key;
  const held = await pool.connect();
  await held.query("begin");
  await held.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    key,
  ]);
  const pending = h.post("login", {});
  try {
    await vi.waitFor(async () => {
      expect(
        (
          await pool.query(
            "select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like 'select pg_advisory_xact_lock%'",
          )
        ).rowCount,
      ).toBeGreaterThan(0);
    });
    h.clock.advance(900000 / 3600000);
  } finally {
    await held.query("commit");
    held.release();
  }
  expect((await pending).status).toBe(422);
  for (let i = 0; i < 49; i++)
    expect((await h.post("login", {})).status).toBe(422);
  const blocked = await h.post("login", {});
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get("retry-after")).toBe("900");
});

it("конкурентные повторы между экземплярами заменяют код один раз, новый код переживает перезапуск", async () => {
  const h = await start();
  await h.activate();
  const { attemptToken } = await (await h.login()).json();
  const oldCode = h.auth.code();
  h.clock.advance(1 / 60);
  const other = await start(h.clock);
  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      (index % 2 ? h : other).resend(attemptToken),
    ),
  );
  expect(responses.filter((response) => response.status === 200)).toHaveLength(
    1,
  );
  expect(responses.filter((response) => response.status === 429)).toHaveLength(
    9,
  );
  const sender = other.auth.sendEmail.mock.calls.length ? other : h;
  const newCode = sender.auth.code();
  const restarted = await start(h.clock);
  if (newCode !== oldCode)
    expect((await restarted.verify(attemptToken, oldCode)).status).toBe(400);
  expect((await restarted.verify(attemptToken, newCode)).status).toBe(200);
  expect((await restarted.resend(attemptToken)).status).toBe(410);
});

it("повтор и проверка конкурируют атомарно: проверенная попытка не получает новый код", async () => {
  const h = await start();
  await h.activate();
  const { attemptToken } = await (await h.login()).json();
  h.clock.advance(1 / 60);
  const other = await start(h.clock);
  const [verified, resent] = await Promise.all([
    h.verify(attemptToken),
    other.resend(attemptToken),
  ]);
  expect(verified.status).toBe(200);
  expect([200, 410]).toContain(resent.status);
  expect((await pool.query("select * from auth_sessions")).rowCount).toBe(1);
  expect((await h.resend(attemptToken)).status).toBe(410);
});

it("отклонённый по лимиту повтор не меняет код и сроки в БД и не расходует квоту назначения", async () => {
  const h = await start();
  await h.activate();
  const { attemptToken } = await (await h.login()).json();
  const before = (await pool.query("select * from login_attempts")).rows[0];
  const limited = await h.resend(attemptToken);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("60");
  expect((await pool.query("select * from login_attempts")).rows[0]).toEqual(
    before,
  );
  h.clock.advance(1 / 60);
  expect((await h.resend(attemptToken)).status).toBe(200);
});
