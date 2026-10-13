import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { pool } from "../../../../db/pool.js";
import { migrate } from "../../../../db/migrate.js";
import { createSqlDirectories } from "./sql-directories.js";
import { createSqlFileRows } from "./sql-file-rows.js";
import { createCatalogModule } from "../../application/catalog.js";
import { createMultipartModule } from "../../application/multipart.js";
import { createUploadsModule } from "../../application/uploads.js";
import { buildHarness, THREE_PART_SIZE } from "../../testing/files-module.harness.js";
import { systemClock } from "../../domain/ports/clock.js";

const schema = `legacy_storage_test_${randomUUID().replaceAll("-", "")}`;
let schemaCreated = false;

beforeAll(async () => {
  await pool.query(`create schema ${schema}`);
  schemaCreated = true;
  await pool.query(`set search_path to ${schema}`);
  pool.options.options = `-c search_path=${schema}`;
  await migrate();
  await pool.query("alter table files alter column bucket drop not null");
  await pool.query("alter table files add column storage text not null");
  await pool.query("drop index files_object_key_uniq");
  await pool.query("create unique index files_storage_object_key_uniq on files (storage, object_key)");
  await pool.query("insert into schema_migrations (name) values ('003_storage_alias.sql')");
  await pool.query("delete from schema_migrations where name = '006_legacy_storage_default.sql'");
  await pool.query(
    `insert into files (id, bucket, storage, object_key, original_name, status, upload_source)
     values ($1, null, 'primary', 'legacy-object.txt', 'legacy.txt', 'ready', 'server'),
            ($2, 'test-bucket', 'primary', 'existing-object.txt', 'existing.txt', 'ready', 'server')`,
    [randomUUID(), randomUUID()],
  );
});

afterAll(async () => {
  if (schemaCreated) await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

it("после миграции старой схемы загружает файлы в новый каталог всеми способами и сохраняет прежние строки", async () => {
  const legacy = (await pool.query("select id, bucket, storage, object_key from files order by id")).rows;
  await migrate();
  const harness = buildHarness();
  const deps = {
    objectStore: harness.objectStore,
    fileRows: createSqlFileRows("test-bucket"),
    directories: createSqlDirectories(),
    policy: harness.policy,
    clock: systemClock,
  };
  const catalog = createCatalogModule(deps);
  const multipart = createMultipartModule(deps);
  const uploads = createUploadsModule({ ...deps, multipart });
  const directory = await catalog.createDirectory({ name: "Новый каталог" });
  const single = await uploads.createPresignedUpload({ filename: "single.txt", directory: directory.path, size: 1 });
  expect(single.strategy).toBe("single");
  harness.objectStore.uploadObject(single.key, Buffer.from("a"));
  expect(await uploads.completeUpload(single.id)).toMatchObject({ kind: "ready", directory: directory.path, size: 1 });

  const server = await uploads.uploadThroughServer({ filename: "server.txt", directory: directory.path, size: 1, bytes: Buffer.from("b") });
  expect(server).toMatchObject({ kind: "ready", directory: directory.path, size: 1 });
  const composed = await uploads.createPresignedUpload({ filename: "multipart.txt", directory: directory.path, size: THREE_PART_SIZE });
  expect(composed.strategy).toBe("multipart");
  expect(await deps.fileRows.findFileById(composed.id)).toMatchObject({ kind: "multipart", directory: directory.path });
  expect((await pool.query("select storage, bucket from files where directory = $1 order by original_name", [directory.path])).rows).toEqual([
    { storage: "primary", bucket: "test-bucket" },
    { storage: "primary", bucket: "test-bucket" },
    { storage: "primary", bucket: "test-bucket" },
  ]);
  expect((await pool.query("select id, bucket, storage, object_key from files where directory = '' order by id")).rows).toEqual(legacy);
  await migrate();
  expect((await pool.query("select count(*)::int as count from files")).rows[0]?.count).toBe(5);
});
