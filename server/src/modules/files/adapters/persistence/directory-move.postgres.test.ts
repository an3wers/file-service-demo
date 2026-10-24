import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../../../db/pool.js";
import { migrate } from "../../../../db/migrate.js";
import { createPostgresOwner } from "../../testing/postgres-owner.js";
import { createFilesPersistence } from "../../persistence.js";
import { assembleFiles } from "../../assembly.js";
import { buildHarness, thrownBy } from "../../testing/files-module.harness.js";
import { createMemoryObjectStore } from "../../../../storage/memory-object-store.js";
import { systemClock } from "../../domain/ports/clock.js";

const schema = `directory_move_test_${randomUUID().replaceAll("-", "")}`;
let created = false;

beforeAll(async () => {
  await pool.query(`create schema ${schema}`);
  created = true;
  await pool.query(`set search_path to ${schema}`);
  pool.options.options = `-c search_path=${schema}`;
  await migrate();
});

afterAll(async () => {
  if (created) await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

async function filesOf(owner: string) {
  const persistence = createFilesPersistence("test-bucket");
  const objectStore = createMemoryObjectStore();
  const files = assembleFiles({
    ...persistence,
    ...persistence.forOwner(owner),
    objectStore,
    policy: buildHarness().policy,
    clock: systemClock,
  });
  return { ...files, objectStore };
}

const everything = {
  directory: "",
  recursive: true,
  status: "any",
  page: 1,
  limit: 100,
  sort: "created_at",
  order: "asc",
} as const;

async function tree(owner: string) {
  const { rows } = await pool.query<{ path: string; parent: string | null }>(
    'select path, parent from directories where owner_id = $1 order by path collate "C"',
    [owner],
  );
  return rows;
}

describe("перемещение каталогов на PostgreSQL", () => {
  it("переносит дерево каталога с файлами и операциями, не трогая одинаковые пути другого владельца", async () => {
    const owner = await createPostgresOwner();
    const stranger = await createPostgresOwner();
    const { catalog, uploads, objectStore } = await filesOf(owner);
    const other = await filesOf(stranger);
    for (const files of [catalog, other.catalog]) {
      await files.createDirectory({ name: "docs" });
      await files.createDirectory({ parent: "docs", name: "inner" });
      await files.createDirectory({ name: "archive" });
    }
    const operationId = randomUUID();
    const file = await uploads.uploadThroughServer({
      operationId,
      filename: "report.txt",
      directory: "docs/inner",
      bytes: Buffer.from("hello"),
      size: 5,
    });
    const foreign = await other.uploads.uploadThroughServer({
      filename: "report.txt",
      directory: "docs/inner",
      bytes: Buffer.from("other"),
      size: 5,
    });

    expect(
      await catalog.moveDirectory("docs", { parent: "archive", name: "Папка" }),
    ).toEqual({ name: "Папка", path: "archive/Папка", fileCount: 1 });

    expect(await tree(owner)).toEqual([
      { path: "", parent: null },
      { path: "archive", parent: "" },
      { path: "archive/Папка", parent: "archive" },
      { path: "archive/Папка/inner", parent: "archive/Папка" },
    ]);
    const card = await catalog.getFileCard(file.id, false);
    expect(card.file).toMatchObject({
      id: file.id,
      key: file.key,
      directory: "archive/Папка/inner",
      kind: "ready",
    });
    expect(await objectStore.head(file.key)).toMatchObject({ size: 5 });
    expect(
      (await catalog.getDownloadUrl(file.id, { disposition: "attachment" }))
        .url,
    ).toEqual(expect.any(String));
    const { rows: operations } = await pool.query(
      "select directory from upload_operations where id = $1",
      [operationId],
    );
    expect(operations).toEqual([{ directory: "archive/Папка/inner" }]);

    expect((await other.catalog.listDirectories("docs")).items).toEqual([
      { name: "inner", path: "docs/inner", fileCount: 1 },
    ]);
    expect(
      (await other.catalog.getFileCard(foreign.id, false)).file,
    ).toMatchObject({ directory: "docs/inner" });
    expect(
      await thrownBy(() =>
        other.catalog.moveDirectory("archive/Папка", { name: "x" }),
      ),
    ).toMatchObject({ name: "DirectoryNotFoundError" });
    expect(
      await thrownBy(() =>
        catalog.moveDirectory("archive/Папка", { parent: "docs" }),
      ),
    ).toMatchObject({ name: "DirectoryNotFoundError" });

    await catalog.moveDirectory("archive/Папка/inner", { parent: "" });
    const later = await uploads.uploadThroughServer({
      filename: "later.txt",
      directory: "inner",
      bytes: Buffer.from("later"),
      size: 5,
    });
    expect(later.directory).toBe("inner");
    expect(
      (await catalog.listFiles({ ...everything, directory: "inner" })).items,
    ).toHaveLength(2);
  });

  it("занятый путь, незавершённая загрузка и слишком длинный путь отклоняются без частичных изменений", async () => {
    const owner = await createPostgresOwner();
    const { catalog, uploads } = await filesOf(owner);
    await catalog.createDirectory({ name: "src" });
    await catalog.createDirectory({ parent: "src", name: "deep" });
    await catalog.createDirectory({ name: "dst" });
    await catalog.createDirectory({ parent: "dst", name: "src" });
    await catalog.createDirectory({ parent: "dst", name: "y".repeat(95) });
    const ready = await uploads.uploadThroughServer({
      filename: "a.txt",
      directory: "src/deep",
      bytes: Buffer.from("a"),
      size: 1,
    });
    const before = await tree(owner);

    expect(
      await thrownBy(() => catalog.moveDirectory("src", { parent: "dst" })),
    ).toMatchObject({ name: "DirectoryAlreadyExistsError" });

    const operationId = randomUUID();
    await uploads.createPresignedUpload({
      operationId,
      filename: "draft.txt",
      directory: "src/deep",
      size: 5,
    });
    expect(
      await thrownBy(() => catalog.moveDirectory("src", { name: "renamed" })),
    ).toMatchObject({ name: "DirectoryBusyError" });

    const long = "x".repeat(100);
    let parent = "";
    for (let depth = 0; depth < 6; depth += 1) {
      await catalog.createDirectory({ parent, name: long });
      parent = parent ? `${parent}/${long}` : long;
    }
    const grown = await tree(owner);
    expect(
      await thrownBy(() => catalog.moveDirectory("dst", { parent })),
    ).toMatchObject({ name: "InvalidDirectoryError" });
    expect(await tree(owner)).toEqual(grown);
    expect(grown.filter((row) => !row.path.startsWith(long))).toEqual(before);
    expect((await catalog.getFileCard(ready.id, false)).file).toMatchObject({
      directory: "src/deep",
    });

    expect((await uploads.cancelUploadOperation(operationId)).status).toBe(
      "cancelled",
    );
    await catalog.moveDirectory("src", { name: "renamed" });
    expect((await catalog.getFileCard(ready.id, false)).file).toMatchObject({
      directory: "renamed/deep",
    });
  });

  it("конкурентные перемещение, создание подкаталога и загрузка не оставляют частично перенесённого дерева", async () => {
    const owner = await createPostgresOwner();
    const { catalog, uploads } = await filesOf(owner);
    for (let round = 0; round < 15; round += 1) {
      const path = `race-${round}`;
      await catalog.createDirectory({ name: path });
      await catalog.createDirectory({ parent: path, name: "inner" });
      const [move, rival, child, upload] = await Promise.allSettled([
        catalog.moveDirectory(path, { name: `moved-${round}` }),
        catalog.moveDirectory(path, { name: `rival-${round}` }),
        catalog.createDirectory({ parent: `${path}/inner`, name: "child" }),
        uploads.uploadThroughServer({
          filename: "data.bin",
          directory: `${path}/inner`,
          bytes: Buffer.from("payload"),
          size: 7,
        }),
      ]);
      const refusal = expect.stringMatching(
        /^(DirectoryNotFoundError|DirectoryBusyError)$/,
      );
      for (const attempt of [move, rival])
        if (attempt.status === "rejected")
          expect(attempt.reason).toMatchObject({ name: refusal });
      expect(
        [move, rival].filter((attempt) => attempt.status === "fulfilled"),
      ).not.toHaveLength(2);
      const winner =
        move.status === "fulfilled"
          ? `moved-${round}`
          : rival.status === "fulfilled"
            ? `rival-${round}`
            : path;
      const rows = (await tree(owner)).filter((row) =>
        [path, `moved-${round}`, `rival-${round}`].some(
          (prefix) => row.path === prefix || row.path.startsWith(`${prefix}/`),
        ),
      );
      expect(rows.map((row) => row.path)).toEqual(
        child.status === "fulfilled"
          ? [winner, `${winner}/inner`, `${winner}/inner/child`]
          : [winner, `${winner}/inner`],
      );
      if (child.status === "rejected")
        expect(child.reason).toMatchObject({ name: "DirectoryNotFoundError" });
      if (upload.status === "fulfilled") {
        expect(
          (await catalog.getFileCard(upload.value.id, false)).file,
        ).toMatchObject({ directory: `${winner}/inner`, kind: "ready" });
      } else {
        expect(upload.reason).toMatchObject({ name: refusal });
      }
      const { rows: orphans } = await pool.query(
        `select f.id from files f
          where f.owner_id = $1 and f.deleted_at is null
            and not exists (
              select 1 from directories d where d.owner_id = f.owner_id and d.path = f.directory
            )`,
        [owner],
      );
      expect(orphans).toEqual([]);
    }
  });
});
