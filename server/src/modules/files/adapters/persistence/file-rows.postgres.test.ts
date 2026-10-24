import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../../../db/pool.js";
import { migrate } from "../../../../db/migrate.js";
import { createPostgresOwner } from "../../testing/postgres-owner.js";
import { createSqlDirectories } from "./sql-directories.js";
import { createSqlFileRows } from "./sql-file-rows.js";
import {
  describeFileRowsErrors,
  describeFileRowsOwnership,
  describeFileRowsPagination,
  describeFileRowsRelocation,
} from "../../testing/file-rows.contract.js";

let owner: string;

const schema = `file_rows_test_${randomUUID().replaceAll("-", "")}`;
let created = false;
beforeAll(async () => {
  await pool.query(`create schema ${schema}`);
  created = true;
  await pool.query(`set search_path to ${schema}`);
  pool.options.options = `-c search_path=${schema}`;
  await migrate();
  owner = await createPostgresOwner();
});
beforeEach(async () => {
  await pool.query("truncate files, upload_operations, upload_terminations");
  await pool.query(
    `insert into directories (owner_id, path, parent, name)
    values ($1, 'docs', '', 'docs'), ($1, 'docs/2026', 'docs', '2026'), ($1, 'other', '', 'other')
    on conflict (owner_id, path) do nothing`,
    [owner],
  );
});
afterAll(async () => {
  if (created) await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

describeFileRowsErrors("PostgreSQL", () =>
  createSqlFileRows("test", undefined, owner),
);

describeFileRowsPagination("PostgreSQL", () =>
  createSqlFileRows("test", undefined, owner),
);

describeFileRowsRelocation("PostgreSQL", () =>
  createSqlFileRows("test", undefined, owner),
);

describe("размещение строк метаданных на PostgreSQL", () => {
  it("не переносит файл в отсутствующий или чужой каталог", async () => {
    const rows = createSqlFileRows("test", undefined, owner);
    const stranger = await createPostgresOwner();
    await pool.query(
      `insert into directories (owner_id, path, parent, name) values ($1, 'foreign', '', 'foreign')`,
      [stranger],
    );
    const id = randomUUID();
    await rows.insertFile({
      id,
      objectKey: `${id}.txt`,
      directory: "",
      originalName: "a.txt",
      extension: "txt",
      contentType: "text/plain",
      sizeBytes: 1,
      etag: null,
      status: "ready",
      uploadSource: "server",
    });

    for (const directory of ["missing", "foreign"])
      expect(
        await rows.relocateFile(id, {
          name: { originalName: "b.txt", extension: "txt" },
          directory,
        }),
      ).toBeNull();
    expect(await rows.findFileById(id)).toMatchObject({
      originalName: "a.txt",
      directory: "",
    });
  });

  it("нарушение внешнего ключа при резервировании и создании каталога без ранней проверки становится отсутствием каталога", async () => {
    const rows = createSqlFileRows("test", undefined, owner);
    const directories = createSqlDirectories(undefined, owner);
    const id = randomUUID();

    await expect(
      rows.reserveFile({
        id,
        objectKey: `missing/${id}.txt`,
        directory: "missing",
        originalName: "a.txt",
        extension: "txt",
        contentType: "text/plain",
        sizeBytes: 1,
        etag: null,
        status: "pending",
        uploadSource: "server",
      }),
    ).rejects.toMatchObject({
      name: "DirectoryNotFoundError",
      details: { path: "missing" },
    });
    await expect(directories.create("missing", "inner")).rejects.toMatchObject({
      name: "DirectoryNotFoundError",
      details: { path: "missing" },
    });
    expect(await rows.findFileById(id)).toBeNull();
    expect(await directories.exists("missing/inner")).toBe(false);
  });
});

describeFileRowsOwnership("PostgreSQL", async () => ({
  all: createSqlFileRows("test"),
  mine: createSqlFileRows("test", undefined, await createPostgresOwner()),
  theirs: createSqlFileRows("test", undefined, await createPostgresOwner()),
}));
