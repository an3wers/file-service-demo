import { randomUUID } from "node:crypto";
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { pool } from "../../../../db/pool.js";
import { migrate } from "../../../../db/migrate.js";
import { createSqlDirectories } from "./sql-directories.js";
import { createSqlFileRows } from "./sql-file-rows.js";
import { createSqlUploadOperations } from "./sql-upload-operations.js";
import { createUploadsModule } from "../../application/uploads.js";
import { createMultipartModule } from "../../application/multipart.js";
import { createCatalogModule } from "../../application/catalog.js";
import {
  buildHarness,
  THREE_PART_SIZE,
} from "../../testing/files-module.harness.js";
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
beforeEach(async () => {
  await pool.query("truncate files, upload_operations, upload_terminations");
});
afterAll(async () => {
  if (created) await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

function assemble(objectStore: ReturnType<typeof buildHarness>["objectStore"]) {
  const { policy } = buildHarness();
  const fileRows = createSqlFileRows("test");
  const deps = {
    operations: createSqlUploadOperations("test"),
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
async function withSingleConnection(run: () => Promise<void>) {
  const previousLimit = pool.options.max ?? 10;
  const previousTimeout = pool.options.connectionTimeoutMillis;
  while (pool.idleCount > 0) (await pool.connect()).release(true);
  pool.options.max = 1;
  pool.options.connectionTimeoutMillis = 1_000;
  try {
    await run();
    expect(pool.totalCount).toBe(1);
  } finally {
    pool.options.max = previousLimit;
    pool.options.connectionTimeoutMillis = previousTimeout;
  }
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
    await withSingleConnection(async () => {
      const { objectStore } = buildHarness();
      const module = assemble(objectStore);
      const upload = input();
      const file = await module.uploadThroughServer(upload);
      expect(await module.getUploadOperation(upload.operationId)).toEqual({
        status: "succeeded",
        file,
      });
      expect(await module.uploadThroughServer(upload)).toEqual(file);
    });
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

describe.each([5, THREE_PART_SIZE])(
  "прямая операция PostgreSQL размером %i",
  (size) => {
    it("сохраняет резервирование, план и подтверждение после перезапуска и удаления", async () => {
      await withSingleConnection(async () => {
        const { objectStore } = buildHarness();
        const upload = { ...input(), size };
        const first = await assemble(objectStore).createPresignedUpload(upload);
        const repeated =
          await assemble(objectStore).createPresignedUpload(upload);
        expect(repeated).toMatchObject({
          ...first,
          expiresAt: expect.any(Date),
        });
        if (first.strategy === "multipart") {
          for (let part = 1; part <= first.partCount; part++)
            objectStore.uploadPart(
              first.uploadId,
              part,
              Buffer.alloc(
                Math.min(first.partSize, size - (part - 1) * first.partSize),
              ),
            );
        } else {
          await objectStore.put(first.key, Buffer.from("hello"), {
            contentType: "text/plain",
            contentLength: 5,
          });
        }
        const file = await assemble(objectStore).completeUpload(first.id);
        expect(await assemble(objectStore).completeUpload(first.id)).toEqual(
          file,
        );
        expect(
          await assemble(objectStore).getUploadOperation(upload.operationId),
        ).toEqual({ status: "succeeded", file });
        expect(
          await assemble(objectStore).createPresignedUpload(upload),
        ).toMatchObject({ strategy: "ready", file });
        const count = await pool.query(
          "select count(*)::int as count from files where id = $1",
          [file.id],
        );
        expect(count.rows[0].count).toBe(1);
        await assemble(objectStore).deleteFile(file.id);
        expect(
          await assemble(objectStore).getUploadOperation(upload.operationId),
        ).toEqual({ status: "deleted" });
        await expect(
          assemble(objectStore).createPresignedUpload(upload),
        ).rejects.toMatchObject({ name: "FileNotFoundError" });
        expect(
          (
            await assemble(objectStore).createPresignedUpload({
              ...upload,
              operationId: randomUUID(),
            })
          ).id,
        ).not.toBe(file.id);
      });
    });

    it("не создаёт второе резервирование при конкурентном повторе из другого экземпляра", async () => {
      const { objectStore } = buildHarness();
      const upload = { ...input(), size };
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      async function gate() {
        entered();
        await waiting;
      }
      if (size === 5) {
        const original = objectStore.signUpload.bind(objectStore);
        vi.spyOn(objectStore, "signUpload").mockImplementation(
          async (key, options) => {
            await gate();
            return await original(key, options);
          },
        );
      } else {
        const original = objectStore.beginMultipart.bind(objectStore);
        vi.spyOn(objectStore, "beginMultipart").mockImplementation(
          async (key, options) => {
            await gate();
            return await original(key, options);
          },
        );
      }
      const running = assemble(objectStore).createPresignedUpload(upload);
      try {
        await started;
        expect(
          await assemble(objectStore).getUploadOperation(upload.operationId),
        ).toEqual({ status: "processing" });
        await expect(
          assemble(objectStore).createPresignedUpload(upload),
        ).rejects.toMatchObject({ name: "UploadOperationProcessingError" });
      } finally {
        release();
      }
      const first = await running;
      expect(
        (await assemble(objectStore).createPresignedUpload(upload)).id,
      ).toBe(first.id);
      expect(objectStore.openUploads()).toHaveLength(size === 5 ? 0 : 1);
    });

    it("сохраняет окончательную отмену после пересоздания модуля", async () => {
      const { objectStore } = buildHarness();
      const upload = { ...input(), size };
      const first = await assemble(objectStore).createPresignedUpload(upload);
      expect(
        await assemble(objectStore).cancelUploadOperation(upload.operationId),
      ).toEqual({ status: "cancelled" });
      expect(objectStore.openUploads()).toEqual([]);
      expect(
        await assemble(objectStore).getUploadOperation(upload.operationId),
      ).toEqual({ status: "cancelled" });
      await objectStore.put(first.key, Buffer.alloc(size), {
        contentLength: size,
        contentType: "text/plain",
      });
      await assemble(objectStore).sweepTerminated();
      expect(await objectStore.head(first.key)).toBeNull();
      await expect(
        assemble(objectStore).uploadThroughServer(upload),
      ).rejects.toMatchObject({ name: "FileNotFoundError" });
    });
  },
);
