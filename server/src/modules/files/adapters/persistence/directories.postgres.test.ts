import { createFilesPersistence } from "../../persistence.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../../../db/pool.js";
import { migrate } from "../../../../db/migrate.js";
import { createPostgresOwner } from "../../testing/postgres-owner.js";
import { createSqlDirectories } from "./sql-directories.js";
import { createSqlFileRows } from "./sql-file-rows.js";
import { createCatalogModule } from "../../application/catalog.js";
import { buildHarness } from "../../testing/files-module.harness.js";
import { systemClock } from "../../domain/ports/clock.js";

let owner: string;

let schemaCreated = false;
let originalKeys: unknown[] = [];
const schema = `directories_test_${randomUUID().replaceAll("-", "")}`;

beforeAll(async () => {
  await pool.query(`create schema ${schema}`);
  schemaCreated = true;
  await pool.query(`set search_path to ${schema}`);
  pool.options.options = `-c search_path=${schema}`;
  await pool.query(
    "create table schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  for (const name of [
    "001_init.sql",
    "002_multipart.sql",
    "003_multipart_plan_required.sql",
    "004_users.sql",
  ]) {
    const sql = await readFile(
      new URL(`../../../../db/migrations/${name}`, import.meta.url),
      "utf8",
    );
    await pool.query(sql);
    await pool.query("insert into schema_migrations (name) values ($1)", [
      name,
    ]);
  }
  await pool.query(
    `insert into files (id, bucket, object_key, directory, original_name, status, upload_source, deleted_at)
     values ($1, 'legacy', 'docs/reports/2026/original-object.txt', 'docs/reports/2026', 'original.txt', 'ready', 'server', null),
            ($2, 'legacy', 'archive/deleted/key.bin', 'archive/deleted', 'gone.bin', 'failed', 'presigned', now()),
            ($3, 'legacy', 'literal%_/nested/key.bin', 'literal%_/nested', 'special.bin', 'pending', 'presigned', null)`,
    [randomUUID(), randomUUID(), randomUUID()],
  );
  originalKeys = (
    await pool.query("select object_key from files order by object_key")
  ).rows;
  await migrate();
  owner = await createPostgresOwner();
});

afterAll(async () => {
  if (schemaCreated) await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

describe("постоянные каталоги на PostgreSQL", () => {
  it("мигрирует пути всех файлов и родителей, сохраняя объектные ключи", async () => {
    const after = (
      await pool.query("select object_key from files order by object_key")
    ).rows;
    expect(after).toEqual(originalKeys);
    expect(
      (
        await pool.query(
          'select path from directories where owner_id is null order by path collate "C"',
        )
      ).rows.map((row) => row.path),
    ).toEqual([
      "",
      "archive",
      "archive/deleted",
      "docs",
      "docs/reports",
      "docs/reports/2026",
      "literal%_",
      "literal%_/nested",
    ]);
    const directories = createSqlDirectories();
    expect(await directories.listChildren("")).toEqual([
      { name: "archive", path: "archive", fileCount: 0 },
      { name: "docs", path: "docs", fileCount: 1 },
      { name: "literal%_", path: "literal%_", fileCount: 0 },
    ]);
    await migrate();
    expect(await directories.exists("docs/reports/2026")).toBe(true);
  });

  it("один конкурентный запрос создаёт каталог, второй получает ошибку дубликата", async () => {
    const harness = buildHarness();
    const catalog = createCatalogModule({
      confirmation: harness.confirmation,
      operations: createFilesPersistence("test").forOwner(owner).operations,
      objectStore: harness.objectStore,
      fileRows: createSqlFileRows("test", undefined, owner),
      directories: createSqlDirectories(undefined, owner),
      policy: harness.policy,
      clock: systemClock,
    });
    const outcomes = await Promise.allSettled([
      catalog.createDirectory({ name: "  Cafe\u0301 " }),
      catalog.createDirectory({ name: "Café" }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.find((outcome) => outcome.status === "rejected"),
    ).toMatchObject({ reason: { name: "DirectoryAlreadyExistsError" } });
    expect(
      (await catalog.listDirectories("")).items.filter(
        (directory) => directory.path === "Café",
      ),
    ).toEqual([{ name: "Café", path: "Café", fileCount: 0 }]);
    await catalog.createDirectory({ name: "café" });
    await catalog.createDirectory({ name: "docs" });
    await catalog.createDirectory({ parent: "docs", name: "Café" });
    expect(await catalog.listDirectories("docs/Café")).toEqual({
      parent: "docs/Café",
      items: [],
    });
  });
});
