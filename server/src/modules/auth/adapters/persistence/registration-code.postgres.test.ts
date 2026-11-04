import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { pool } from "../../../../db/pool.js";
import { migrate } from "../../../../db/migrate.js";
import { registrationCodeDigest } from "../../application/attempt-secrets.js";
import { CODE_SECRET } from "../../testing/auth.harness.js";
import { createSqlRegistrationStore } from "./sql-registration-store.js";
import { createSqlSessionStore } from "./sql-session-store.js";

const schema = `registration_code_test_${randomUUID().replaceAll("-", "")}`;
let created = false;
const deadline = () => new Date(Date.now() + 15000);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
beforeAll(async () => {
  await pool.query(`create schema ${schema}`);
  created = true;
  await pool.query(`set search_path to ${schema}`);
  pool.options.options = `-c search_path=${schema}`;
  await migrate();
});
beforeEach(async () => {
  await pool.query(
    "truncate registration_attempts, login_attempts, auth_sessions, auth_secrets, auth_mail_events, users cascade",
  );
});
afterAll(async () => {
  if (created) await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

const CODE = "012345";
async function register(email = "name@example.com") {
  const tokenHash = sha(randomUUID());
  const result = await createSqlRegistrationStore().save(
    {
      id: randomUUID(),
      name: "Имя",
      email,
      passwordHash: "scrypt$hash",
      attempt: {
        tokenHash,
        codeHash: registrationCodeDigest(CODE_SECRET, tokenHash, CODE),
        expiresAt: new Date(Date.now() + 900000),
        codeExpiresAt: new Date(Date.now() + 300000),
        resendAvailableAt: new Date(Date.now() + 60000),
      },
    },
    deadline(),
  );
  return { tokenHash, result };
}
const verify = (tokenHash: string, code: string | null = CODE, hash?: string) =>
  createSqlSessionStore().verifyRegistration(
    tokenHash,
    code === null ? null : registrationCodeDigest(CODE_SECRET, tokenHash, code),
    { tokenHash: hash ?? sha(randomUUID()), ttlSeconds: 14 * 24 * 3600 },
    deadline(),
  );
const sessions = async () =>
  (await pool.query("select * from auth_sessions")).rows;
const userState = async () =>
  (await pool.query("select state from users")).rows[0]?.state;

it("верный код атомарно активирует пользователя, погашает попытку и создаёт одну сессию на 14 суток от проверки", async () => {
  const { tokenHash, result } = await register();
  expect(result).toBe("created");
  const before = Date.now();
  const outcome = await verify(tokenHash);
  expect(outcome.status).toBe("verified");
  expect(await userState()).toBe("active");
  const rows = await sessions();
  expect(rows).toHaveLength(1);
  expect(rows[0].created_at.getTime()).toBeGreaterThanOrEqual(before);
  expect(rows[0].expires_at.getTime() - rows[0].created_at.getTime()).toBe(
    14 * 24 * 3600 * 1000,
  );
  expect(
    (await pool.query("select consumed_at from registration_attempts")).rows[0]
      .consumed_at,
  ).not.toBeNull();
  expect((await verify(tokenHash)).status).toBe("unavailable");
  expect(await sessions()).toHaveLength(1);
});

it("конкурентная проверка одного кода создаёт ровно одну сессию", async () => {
  const { tokenHash } = await register();
  const outcomes = await Promise.all(
    Array.from({ length: 20 }, () => verify(tokenHash)),
  );
  expect(outcomes.filter((o) => o.status === "verified")).toHaveLength(1);
  expect(outcomes.filter((o) => o.status === "unavailable")).toHaveLength(19);
  expect(await sessions()).toHaveLength(1);
});

it("конкурентные неверные коды расходуют ровно пять проверок и не дают сессию", async () => {
  const { tokenHash } = await register();
  const outcomes = await Promise.all(
    Array.from({ length: 12 }, () => verify(tokenHash, "999999")),
  );
  expect(outcomes.filter((o) => o.status === "invalid")).toHaveLength(5);
  expect(outcomes.filter((o) => o.status === "unavailable")).toHaveLength(7);
  expect((await verify(tokenHash)).status).toBe("unavailable");
  expect(await sessions()).toEqual([]);
  expect(await userState()).toBe("inactive");
});

it("сбой записи сессии откатывает активацию и погашение попытки", async () => {
  const first = await register();
  const second = await register("other@example.com");
  const duplicate = sha("shared-session");
  expect((await verify(first.tokenHash, CODE, duplicate)).status).toBe(
    "verified",
  );
  await expect(verify(second.tokenHash, CODE, duplicate)).rejects.toThrow();
  expect(
    (
      await pool.query(
        "select state from users where email = 'other@example.com'",
      )
    ).rows,
  ).toEqual([{ state: "inactive" }]);
  expect(
    (
      await pool.query(
        "select consumed_at from registration_attempts where token_hash = $1",
        [second.tokenHash],
      )
    ).rows,
  ).toEqual([{ consumed_at: null }]);
  expect(await sessions()).toHaveLength(1);
  expect((await verify(second.tokenHash)).status).toBe("verified");
});

it("контекст существующего email не даёт сессию и отвечает как неверный код", async () => {
  const winner = await register();
  const loser = await register();
  expect(loser.result).toBe("inactive");
  expect(
    (
      await pool.query(
        "select count(*)::int as n from registration_attempts where user_id is not null",
      )
    ).rows[0].n,
  ).toBe(1);
  const decoyTrail = [];
  const wrongTrail = [];
  for (let index = 0; index < 5; index++) {
    decoyTrail.push(await verify(loser.tokenHash));
    wrongTrail.push(await verify(winner.tokenHash, "999999"));
  }
  expect(decoyTrail).toEqual(wrongTrail);
  expect(decoyTrail.map((outcome) => outcome.status)).toEqual(
    Array(5).fill("invalid"),
  );
  expect((await verify(loser.tokenHash)).status).toBe("unavailable");
  expect(await sessions()).toEqual([]);
  expect(await userState()).toBe("inactive");
});

it("смена пароля восстановлением и активация старой ссылкой лишают попытку возможности войти", async () => {
  const store = createSqlRegistrationStore();
  const reset = await register("reset@example.com");
  const resetToken = sha("reset-token");
  await store.requestPasswordReset(
    "reset@example.com",
    resetToken,
    new Date(Date.now() + 1800000),
    deadline(),
  );
  expect(
    await store.confirmPasswordReset(resetToken, "scrypt$new", deadline()),
  ).toBe("reset@example.com");
  expect((await verify(reset.tokenHash)).status).toBe("unavailable");

  const linked = await register("linked@example.com");
  const activationToken = sha("activation-token");
  await store.requestActivation(
    "linked@example.com",
    activationToken,
    new Date(Date.now() + 86400000),
    deadline(),
  );
  expect(await store.confirmActivation(activationToken, deadline())).toBe(true);
  expect((await verify(linked.tokenHash)).status).toBe("unavailable");
  expect(await sessions()).toEqual([]);
});

it("ошибка формата не расходует проверки, а просроченные границы проверяются сервером", async () => {
  const { tokenHash } = await register();
  expect((await verify(tokenHash, null)).status).toBe("format");
  expect(
    (await pool.query("select failures from registration_attempts")).rows,
  ).toEqual([{ failures: 0 }]);

  await pool.query(
    "update registration_attempts set code_expires_at = now() - interval '1 millisecond'",
  );
  expect((await verify(tokenHash)).status).toBe("expired");
  await pool.query(
    "update registration_attempts set expires_at = now() - interval '1 millisecond', code_expires_at = now() - interval '1 second'",
  );
  expect((await verify(tokenHash)).status).toBe("unavailable");
});

const LIMITS = [
  { windowMs: 60000, maximum: 1 },
  { windowMs: 3600000, maximum: 5 },
];
const quota = {
  key: (email: string) => `mail:activation:${sha(email)}`,
  limits: LIMITS,
};
const NEW_CODE = "654321";
const resend = (tokenHash: string, now = new Date(Date.now() + 61000)) =>
  createSqlRegistrationStore().resendRegistration(
    tokenHash,
    {
      codeHash: registrationCodeDigest(CODE_SECRET, tokenHash, NEW_CODE),
      codeExpiresAt: new Date(now.getTime() + 300000),
      resendAvailableAt: new Date(now.getTime() + 60000),
    },
    quota,
    now,
    deadline(),
  );
const attemptRow = async (tokenHash: string) =>
  (
    await pool.query(
      "select * from registration_attempts where token_hash = $1",
      [tokenHash],
    )
  ).rows[0];

it("повтор до срока ожидания отклоняется и оставляет прежний код, срок и число ошибок", async () => {
  const { tokenHash } = await register();
  const before = await attemptRow(tokenHash);
  const early = await resend(tokenHash, new Date());
  expect(early.status).toBe("limited");
  expect(early).toMatchObject({ retryAfterSeconds: expect.any(Number) });
  expect(await attemptRow(tokenHash)).toEqual(before);
  expect((await verify(tokenHash)).status).toBe("verified");
});

it("повтор заменяет код, не двигает 15 минут, не сбрасывает ошибки, и старый код перестаёт подходить", async () => {
  const { tokenHash } = await register();
  expect((await verify(tokenHash, "999999")).status).toBe("invalid");
  const before = await attemptRow(tokenHash);
  const outcome = await resend(tokenHash);
  expect(outcome).toMatchObject({ status: "replaced", outcome: "created" });
  const after = await attemptRow(tokenHash);
  expect(after.expires_at).toEqual(before.expires_at);
  expect(after.failures).toBe(1);
  expect(after.code_hash).not.toBe(before.code_hash);
  expect((await verify(tokenHash, CODE)).status).toBe("invalid");
  expect((await verify(tokenHash, NEW_CODE)).status).toBe("verified");
  expect(await sessions()).toHaveLength(1);
});

it("новый код не живёт дольше попытки", async () => {
  const { tokenHash } = await register();
  await pool.query(
    "update registration_attempts set code_expires_at = now() + interval '80 seconds', expires_at = now() + interval '90 seconds'",
  );
  const outcome = await resend(tokenHash, new Date(Date.now() + 61000));
  expect(outcome.status).toBe("replaced");
  const row = await attemptRow(tokenHash);
  expect(row.code_expires_at.getTime()).toBe(row.expires_at.getTime());
});

it("повтор для существующего email возвращает ветку инструкций, не меняя аккаунт и не заменяя пользователя", async () => {
  for (const state of ["inactive", "active"] as const) {
    await pool.query(
      "truncate registration_attempts, auth_mail_events, users cascade",
    );
    await register();
    await pool.query("update users set state = $1", [state]);
    const before = (await pool.query("select * from users")).rows;
    const decoy = await register();
    const outcome = await resend(decoy.tokenHash);
    expect(outcome).toMatchObject({
      status: "replaced",
      outcome: state,
      email: "name@example.com",
    });
    expect((await pool.query("select * from users")).rows).toEqual(before);
    expect((await verify(decoy.tokenHash, NEW_CODE)).status).toBe("invalid");
  }
});

it("неизвестная, погашенная, изменённая и истёкшая попытки недоступны и не тратят квоту", async () => {
  expect((await resend(sha("unknown"))).status).toBe("unavailable");
  const done = await register();
  await verify(done.tokenHash);
  expect((await resend(done.tokenHash)).status).toBe("unavailable");

  const changed = await register("changed@example.com");
  await pool.query(
    "update users set token_version = token_version + 1 where email = 'changed@example.com'",
  );
  expect((await resend(changed.tokenHash)).status).toBe("unavailable");

  const expired = await register("expired@example.com");
  await pool.query(
    "update registration_attempts set code_expires_at = now() - interval '2 seconds', expires_at = now() - interval '1 second' where token_hash = $1",
    [expired.tokenHash],
  );
  expect((await resend(expired.tokenHash)).status).toBe("unavailable");
  expect(
    (
      await pool.query(
        "select count(*)::int as n from auth_mail_events where key = $1",
        [quota.key("changed@example.com")],
      )
    ).rows[0].n,
  ).toBe(0);
});

it("квота адреса общая с другими письмами и не зависит от наличия аккаунта, отказ оставляет код", async () => {
  const trails: string[][] = [];
  for (const existing of [false, true]) {
    await pool.query(
      "truncate registration_attempts, auth_mail_events, users cascade",
    );
    if (existing) await register();
    const { tokenHash } = await register();
    const statuses: string[] = [];
    for (let minute = 1; minute <= 6; minute++)
      statuses.push(
        (await resend(tokenHash, new Date(Date.now() + minute * 61000))).status,
      );
    trails.push(statuses);
    const kept = await attemptRow(tokenHash);
    const last = await resend(tokenHash, new Date(Date.now() + 7 * 61000));
    expect(last.status).toBe("limited");
    expect(await attemptRow(tokenHash)).toEqual(kept);
  }
  expect(trails[0]).toEqual(trails[1]);
  expect(trails[0]).toContain("limited");
});

it("конкурентные повтор и проверка кода не создают двух сессий и не теряют результат", async () => {
  const { tokenHash } = await register();
  const [replaced, verified] = await Promise.all([
    resend(tokenHash),
    verify(tokenHash, CODE),
  ]);
  expect(["replaced", "unavailable"]).toContain(replaced.status);
  expect(["verified", "invalid", "unavailable"]).toContain(verified.status);
  expect(await sessions()).toHaveLength(verified.status === "verified" ? 1 : 0);
  if (verified.status === "verified")
    expect((await resend(tokenHash)).status).toBe("unavailable");
});

it("одновременные повторы заменяют код один раз в пределах срока ожидания", async () => {
  const { tokenHash } = await register();
  const now = new Date(Date.now() + 61000);
  const outcomes = await Promise.all(
    Array.from({ length: 8 }, () => resend(tokenHash, now)),
  );
  expect(outcomes.filter((o) => o.status === "replaced")).toHaveLength(1);
  expect(outcomes.filter((o) => o.status === "limited")).toHaveLength(7);
});

it("повтор ровно в момент resendAvailableAt проходит квоту адреса в одно письмо в минуту, а на миллисекунду раньше отклоняется", async () => {
  const { tokenHash } = await register();
  const base = new Date(Date.now() + 10000);
  await createSqlRegistrationStore().consume(
    quota.key("name@example.com"),
    LIMITS,
    base,
    deadline(),
  );
  await pool.query(
    "update registration_attempts set resend_available_at = $1",
    [new Date(base.getTime() + 60000)],
  );
  const early = await resend(tokenHash, new Date(base.getTime() + 59999));
  expect(early.status).toBe("limited");
  const exact = await resend(tokenHash, new Date(base.getTime() + 60000));
  expect(exact.status).toBe("replaced");
});

it("уборка удаляет просроченные и погашенные попытки регистрации и сохраняет действующие", async () => {
  const live = await register("live@example.com");
  const expired = await register("expired@example.com");
  const consumed = await register("consumed@example.com");
  await pool.query(
    "update registration_attempts set expires_at = now() - interval '1 second', code_expires_at = now() - interval '2 seconds' where token_hash = $1",
    [expired.tokenHash],
  );
  await pool.query(
    "update registration_attempts set consumed_at = now() where token_hash = $1",
    [consumed.tokenHash],
  );
  expect(
    await createSqlRegistrationStore().removeFinishedAttempts(new Date()),
  ).toBe(2);
  expect(await attemptRow(live.tokenHash)).toBeDefined();
  expect(await attemptRow(expired.tokenHash)).toBeUndefined();
  expect(await attemptRow(consumed.tokenHash)).toBeUndefined();
});
