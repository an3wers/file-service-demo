import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { pool } from "../../../../db/pool.js";
import { migrate } from "../../../../db/migrate.js";
import { createSqlDirectories } from "./sql-directories.js";
import { createSqlFileRows } from "./sql-file-rows.js";
import { createSqlUploadOperations } from "./sql-upload-operations.js";
import { createUploadsModule } from "../../application/uploads.js";
import { createMultipartModule } from "../../application/multipart.js";
import { createCatalogModule } from "../../application/catalog.js";
import { buildHarness } from "../../testing/files-module.harness.js";
import { systemClock } from "../../domain/ports/clock.js";

const schema = `operations_test_${randomUUID().replaceAll("-", "")}`;
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

function assemble(objectStore: ReturnType<typeof buildHarness>["objectStore"]) {
  const { policy } = buildHarness();
  const fileRows = createSqlFileRows("test");
  const deps = {
    objectStore,
    fileRows,
    directories: createSqlDirectories(),
    policy,
    clock: systemClock,
  };
  return {
    ...createUploadsModule({
      ...deps,
      operations: createSqlUploadOperations("test"),
      multipart: createMultipartModule(deps),
    }),
    ...createCatalogModule(deps),
  };
}
function input() {
  return {
    operationId: randomUUID(),
    filename: "report.txt",
    bytes: Buffer.from("hello"),
    size: 5,
  };
}

describe("операции загрузки в PostgreSQL", () => {
  it("загружает файл и выясняет результат с одним соединением в пуле", async () => {
    const previousLimit = pool.options.max ?? 10;
    pool.options.max = 1;
    try {
      const { objectStore } = buildHarness();
      const module = assemble(objectStore);
      const upload = input();
      const file = await module.uploadThroughServer(upload);
      expect(await module.getUploadOperation(upload.operationId)).toEqual({
        status: "succeeded",
        file,
      });
      expect(await module.uploadThroughServer(upload)).toEqual(file);
      expect(pool.totalCount).toBe(1);
    } finally {
      pool.options.max = previousLimit;
    }
  });

  it("не запускает конкурентную обработку в другом экземпляре модуля", async () => {
    const { objectStore } = buildHarness();
    const firstModule = assemble(objectStore);
    const secondModule = assemble(objectStore);
    const upload = input();
    const put = objectStore.put.bind(objectStore);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sending = vi
      .spyOn(objectStore, "put")
      .mockImplementation(async (...args) => {
        entered();
        await waiting;
        return await put(...args);
      });
    const running = firstModule.uploadThroughServer(upload);
    try {
      await started;
      expect(await secondModule.getUploadOperation(upload.operationId)).toEqual(
        { status: "processing" },
      );
      await expect(
        secondModule.uploadThroughServer(upload),
      ).rejects.toMatchObject({ name: "UploadOperationProcessingError" });
    } finally {
      release();
    }
    const file = await running;
    expect(await secondModule.uploadThroughServer(upload)).toEqual(file);
    expect(sending).toHaveBeenCalledOnce();
    expect(
      (
        await pool.query(
          "select count(*)::int as count from files where id = $1",
          [file.id],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it("возвращает тот же результат после пересоздания модуля, потери подтверждения и удаления", async () => {
    const { objectStore } = buildHarness();
    const upload = input();
    const firstModule = assemble(objectStore);
    const file = await firstModule.uploadThroughServer(upload);
    const restarted = assemble(objectStore);
    expect(await restarted.getUploadOperation(upload.operationId)).toEqual({
      status: "succeeded",
      file,
    });
    expect(await restarted.uploadThroughServer(upload)).toEqual(file);
    await pool.query(
      "update files set status = 'pending', etag = null where id = $1",
      [file.id],
    );
    const recovered = await assemble(objectStore).getUploadOperation(
      upload.operationId,
    );
    expect(recovered).toMatchObject({
      status: "succeeded",
      file: { id: file.id, kind: "ready" },
    });
    await restarted.deleteFile(file.id);
    expect(
      await assemble(objectStore).getUploadOperation(upload.operationId),
    ).toEqual({ status: "deleted" });
    await expect(
      assemble(objectStore).uploadThroughServer(upload),
    ).rejects.toMatchObject({ name: "FileNotFoundError" });
    expect(objectStore.objectKeys()).toEqual([]);
  });

  it("сохраняет неудачу и исходное резервирование при повторе в другом экземпляре", async () => {
    const { objectStore } = buildHarness();
    const upload = input();
    objectStore.failNext("put", new Error("Нет связи"));
    await expect(
      assemble(objectStore).uploadThroughServer(upload),
    ).rejects.toThrow("Нет связи");
    const before = (
      await pool.query("select file_id from upload_operations where id = $1", [
        upload.operationId,
      ])
    ).rows[0];
    expect(
      await assemble(objectStore).getUploadOperation(upload.operationId),
    ).toEqual({ status: "failed" });
    const file = await assemble(objectStore).uploadThroughServer(upload);
    expect(file.id).toBe(before.file_id);
    expect(objectStore.objectKeys()).toHaveLength(1);
  });
});
