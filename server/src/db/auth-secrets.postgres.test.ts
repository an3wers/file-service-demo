import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { pool } from "./pool.js";
import { migrate } from "./migrate.js";

const schema = `auth_secrets_test_${randomUUID().replaceAll("-", "")}`;
let created = false;

beforeAll(async () => {
  await pool.query(`create schema ${schema}`);
  created = true;
  await pool.query(`set search_path to ${schema}`);
  pool.options.options = `-c search_path=${schema}`;
});
afterAll(async () => {
  if (created) await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

it("миграция удаляет ссылки активации и оставляет секретам только восстановление пароля", async () => {
  await migrate("017_registration_attempt_email.sql");
  const user = randomUUID();
  await pool.query(
    "insert into users (id, login, password_hash, name, email, state) values ($1, 'user', 'hash', 'Имя', 'user@example.com', 'inactive')",
    [user],
  );
  await pool.query(
    "insert into auth_secrets (user_id, purpose, token_hash, expires_at) values ($1, 'activation', 'a', now()), ($1, 'password-reset', 'r', now())",
    [user],
  );

  await migrate();

  expect(
    (await pool.query("select purpose, token_hash from auth_secrets")).rows,
  ).toEqual([{ purpose: "password-reset", token_hash: "r" }]);
  await expect(
    pool.query(
      "insert into auth_secrets (user_id, purpose, token_hash, expires_at) values ($1, 'activation', 'b', now())",
      [user],
    ),
  ).rejects.toThrow(/check constraint/);
});
