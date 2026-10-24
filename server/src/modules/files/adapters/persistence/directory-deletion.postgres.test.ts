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

const schema = `directory_deletion_test_${randomUUID().replaceAll("-", "")}`;
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

describe("удаление пустых каталогов на PostgreSQL", () => {
  it("удаляет пустой каталог и защищает корень, непустой и чужой каталоги", async () => {
    const owner = await createPostgresOwner();
    const stranger = await createPostgresOwner();
    const { catalog, uploads } = await filesOf(owner);
    const other = (await filesOf(stranger)).catalog;
    await catalog.createDirectory({ name: "docs" });
    await catalog.createDirectory({ parent: "docs", name: "inner" });
    await other.createDirectory({ name: "docs" });
    await other.createDirectory({ name: "private" });

    expect(await thrownBy(() => catalog.deleteDirectory("docs"))).toMatchObject(
      { name: "DirectoryNotEmptyError" },
    );
    const file = await uploads.uploadThroughServer({
      filename: "report.txt",
      directory: "docs/inner",
      bytes: Buffer.from("hello"),
      size: 5,
    });
    expect(
      await thrownBy(() => catalog.deleteDirectory("docs/inner")),
    ).toMatchObject({ name: "DirectoryNotEmptyError" });
    expect(await thrownBy(() => catalog.deleteDirectory(""))).toMatchObject({
      name: "InvalidDirectoryError",
    });
    expect(
      await thrownBy(() => catalog.deleteDirectory("private")),
    ).toMatchObject({ name: "DirectoryNotFoundError" });

    await catalog.deleteFile(file.id);
    await catalog.deleteDirectory("docs/inner");
    await catalog.deleteDirectory("docs");

    expect((await catalog.listDirectories("")).items).toEqual([]);
    expect((await other.listDirectories("")).items).toEqual([
      { name: "docs", path: "docs", fileCount: 0 },
      { name: "private", path: "private", fileCount: 0 },
    ]);
    expect(await thrownBy(() => catalog.deleteDirectory("docs"))).toMatchObject(
      { name: "DirectoryNotFoundError" },
    );
  });

  it("незавершённая загрузка защищает каталог, а отменённая не мешает удалению и уборке", async () => {
    const owner = await createPostgresOwner();
    const { catalog, uploads, maintain } = await filesOf(owner);
    await catalog.createDirectory({ name: "inbox" });
    const operationId = randomUUID();
    const started = await uploads.createPresignedUpload({
      operationId,
      filename: "draft.txt",
      directory: "inbox",
      size: 5,
    });
    expect(started.strategy).toBe("single");

    expect(
      await thrownBy(() => catalog.deleteDirectory("inbox")),
    ).toMatchObject({ name: "DirectoryNotEmptyError" });
    expect((await uploads.cancelUploadOperation(operationId)).status).toBe(
      "cancelled",
    );
    await catalog.deleteDirectory("inbox");

    expect(await uploads.getUploadOperation(operationId)).toEqual({
      status: "cancelled",
    });
    await maintain();
    expect(
      await thrownBy(() =>
        uploads.createPresignedUpload({
          operationId: randomUUID(),
          filename: "late.txt",
          directory: "inbox",
          size: 5,
        }),
      ),
    ).toMatchObject({ name: "DirectoryNotFoundError" });
    await catalog.createDirectory({ name: "inbox" });
    expect(
      (
        await catalog.listFiles({
          directory: "inbox",
          recursive: false,
          status: "any",
          page: 1,
          limit: 10,
          sort: "created_at",
          order: "asc",
        })
      ).total,
    ).toBe(0);
  });

  it("конкурентное создание подкаталога или файла и удаление не теряют связей и данных", async () => {
    const owner = await createPostgresOwner();
    const { catalog, uploads, objectStore } = await filesOf(owner);
    for (let round = 0; round < 15; round += 1) {
      const path = `race-${round}`;
      await catalog.createDirectory({ name: path });
      const [removal, child, upload] = await Promise.allSettled([
        catalog.deleteDirectory(path),
        catalog.createDirectory({ parent: path, name: "child" }),
        uploads.uploadThroughServer({
          filename: "data.bin",
          directory: path,
          bytes: Buffer.from("payload"),
          size: 7,
        }),
      ]);
      if (removal.status === "fulfilled") {
        expect(child).toMatchObject({
          status: "rejected",
          reason: { name: "DirectoryNotFoundError" },
        });
        expect(upload).toMatchObject({
          status: "rejected",
          reason: { name: "DirectoryNotFoundError" },
        });
        expect(
          await thrownBy(() => catalog.listDirectories(path)),
        ).toMatchObject({ name: "DirectoryNotFoundError" });
        continue;
      }
      expect(removal.reason).toMatchObject({ name: "DirectoryNotEmptyError" });
      const items = (await catalog.listDirectories(path)).items;
      expect(items).toEqual(
        child.status === "fulfilled"
          ? [{ name: "child", path: `${path}/child`, fileCount: 0 }]
          : [],
      );
      if (upload.status === "fulfilled") {
        const card = await catalog.getFileCard(upload.value.id, false);
        expect(card.file).toMatchObject({ directory: path, kind: "ready" });
        expect(await objectStore.head(upload.value.key)).toMatchObject({
          size: 7,
        });
      } else {
        expect(upload.reason).toMatchObject({
          name: "DirectoryNotFoundError",
        });
      }
      expect(
        child.status === "fulfilled" || upload.status === "fulfilled",
      ).toBe(true);
    }
  });
});
