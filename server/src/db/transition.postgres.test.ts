import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { pool } from "./pool.js";
import { migrate } from "./migrate.js";
import { checkCleanState, cleanOldState } from "./transition.js";

const schema = `transition_test_${randomUUID().replaceAll("-", "")}`;
let created = false;

beforeAll(async () => {
  await pool.query(`create schema ${schema}`);
  created = true;
  await pool.query(`set search_path to ${schema}`);
  pool.options.options = `-c search_path=${schema}`;
});
afterEach(async () => {
  await pool.query(`drop schema ${schema} cascade`);
  await pool.query(`create schema ${schema}`);
});
afterAll(async () => {
  if (created) await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

it("переход со старой схемы очищает старое состояние, применяет миграции и не повторяет очистку после открытия", async () => {
  await migrate("011_stopped_multipart.sql");
  const oldUser = randomUUID();
  const oldFile = randomUUID();
  await pool.query(
    "insert into users (id, login, password_hash) values ($1, 'admin', 'scrypt$old')",
    [oldUser],
  );
  await pool.query(
    "insert into directories (path, parent, name) values ('docs', '', 'docs')",
  );
  await pool.query(
    `insert into files (id, bucket, object_key, directory, original_name, status, upload_source, size_bytes, attempt_started_at)
     values ($1, 'bucket', 'docs/old.txt', 'docs', 'old.txt', 'ready', 'server', 3, now())`,
    [oldFile],
  );
  await pool.query(
    `insert into upload_operations (id, file_id, object_key, directory, original_name, extension, content_type, size_bytes)
     values ($1, $2, 'docs/old.txt', 'docs', 'old.txt', 'txt', 'text/plain', 3)`,
    [randomUUID(), oldFile],
  );
  expect((await checkCleanState()).nonEmptyTables).toEqual(
    expect.arrayContaining([
      "directories",
      "files",
      "upload_operations",
      "users",
    ]),
  );

  await cleanOldState();
  await migrate();

  expect(await checkCleanState()).toEqual({
    nonEmptyTables: [],
    pendingMigrations: [],
  });
  const newUser = randomUUID();
  await pool.query(
    `insert into users (id, login, password_hash, name, email, state)
     values ($1, $2, 'scrypt$new', 'Новый', 'new@example.com', 'active')`,
    [newUser, newUser],
  );
  await pool.query(
    `insert into auth_sessions (token_hash, user_id, created_at, expires_at)
     values ('session', $1, now(), now() + interval '7 days')`,
    [newUser],
  );
  const newFile = randomUUID();
  await pool.query(
    `insert into files (id, owner_id, bucket, object_key, original_name, status, upload_source, size_bytes, attempt_started_at)
     values ($1, $2, 'bucket', 'new.txt', 'new.txt', 'pending', 'presigned', 3, now())`,
    [newFile, newUser],
  );
  await pool.query(
    `insert into upload_operations (id, file_id, owner_id, object_key, directory, original_name, extension, content_type, size_bytes)
     values ($1, $2, $3, 'new.txt', '', 'new.txt', 'txt', 'text/plain', 3)`,
    [randomUUID(), newFile, newUser],
  );

  await expect(cleanOldState()).rejects.toThrow(
    "Найдены зарегистрированные пользователи",
  );
  await migrate();

  const { rows: users } = await pool.query("select id, email from users");
  expect(users).toEqual([{ id: newUser, email: "new@example.com" }]);
  const { rows: roots } = await pool.query(
    "select path from directories where owner_id = $1",
    [newUser],
  );
  expect(roots).toEqual([{ path: "" }]);
  expect(
    (await pool.query("select token_hash from auth_sessions")).rows,
  ).toEqual([{ token_hash: "session" }]);
  expect(
    (
      await pool.query(
        "select f.owner_id from files f join upload_operations o on o.file_id = f.id and o.owner_id = f.owner_id",
      )
    ).rows,
  ).toEqual([{ owner_id: newUser }]);
  expect((await checkCleanState()).nonEmptyTables).toEqual([
    "auth_sessions",
    "directories",
    "files",
    "upload_operations",
    "users",
  ]);
});

it("очистка после применения 014 удаляет оставшиеся без владельца файлы и пользователя из окружения", async () => {
  await migrate("013_login_sessions.sql");
  await pool.query(
    "insert into users (id, login, password_hash) values ($1, 'admin', 'scrypt$old')",
    [randomUUID()],
  );
  await pool.query(
    `insert into files (id, bucket, object_key, original_name, status, upload_source, size_bytes, attempt_started_at)
     values ($1, 'bucket', 'old.txt', 'old.txt', 'ready', 'server', 3, now())`,
    [randomUUID()],
  );
  await migrate();
  expect((await checkCleanState()).nonEmptyTables).toEqual([
    "directories",
    "files",
    "users",
  ]);

  await cleanOldState();

  expect(await checkCleanState()).toEqual({
    nonEmptyTables: [],
    pendingMigrations: [],
  });
});
