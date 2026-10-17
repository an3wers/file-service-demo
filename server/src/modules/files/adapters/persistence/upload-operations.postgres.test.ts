import { assembleFiles } from "../../assembly.js";
import { readFile, readdir } from "node:fs/promises";
import type { QueryResultRow } from "pg";
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
  const { confirmation, uploads, catalog } = assembleFiles(deps);
  return { confirmation, ...uploads, ...catalog };
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
        { status: "pending" },
      );
      expect(
        await secondModule.resolveUploadOperation(upload.operationId),
      ).toEqual({ status: "processing" });
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
    const recovered = await assemble(objectStore).resolveUploadOperation(
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

  it("сохраняет неизвестность PUT между экземплярами до позднего появления объекта", async () => {
    const { objectStore } = buildHarness();
    const upload = input();
    objectStore.failNext("put", new Error("Нет связи"));
    await expect(
      assemble(objectStore).uploadThroughServer(upload),
    ).rejects.toThrow("Нет связи");
    const operations = createSqlUploadOperations("test");
    const { record } = await operations.read(upload.operationId);
    expect(
      await assemble(objectStore).getUploadOperation(upload.operationId),
    ).toEqual({ status: "pending" });
    expect(
      await assemble(objectStore).resolveUploadOperation(upload.operationId),
    ).toEqual({ status: "pending" });
    await expect(
      assemble(objectStore).uploadThroughServer(upload),
    ).rejects.toMatchObject({ name: "UploadOperationProcessingError" });
    objectStore.uploadObject(
      record!.reservation.key,
      upload.bytes,
      "text/plain",
    );
    objectStore.failNext("put", new Error("Повторная передача запрещена"));
    const file = await assemble(objectStore).uploadThroughServer(upload);
    expect(file.id).toBe(record!.reservation.id);
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
        ).toEqual({ status: "pending" });
        expect(
          await assemble(objectStore).resolveUploadOperation(
            upload.operationId,
          ),
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

it("условная неудача PostgreSQL не перезаписывает готовый или удалённый файл", async () => {
  const { objectStore } = buildHarness();
  const module = assemble(objectStore);
  const reserved = await module.createPresignedUpload(input());
  const rows = createSqlFileRows("test");
  const expected = (await rows.findFileById(reserved.id))!;
  objectStore.uploadObject(reserved.key, Buffer.from("hello"), "text/plain");
  await module.completeUpload(reserved.id);
  expect(await rows.failFileIfUnchanged(expected)).toBe(false);
  expect(await rows.findFileById(reserved.id)).toMatchObject({ kind: "ready" });
  await module.deleteFile(reserved.id);
  expect(await rows.failFileIfUnchanged(expected)).toBe(false);
  expect(await rows.findFileById(reserved.id)).toBeNull();
});

it("PostgreSQL сохраняет окончательное намерение при попытках подтверждения и условной неудачи", async () => {
  const { objectStore } = buildHarness();
  const upload = input();
  const reserved = await assemble(objectStore).createPresignedUpload(upload);
  const rows = createSqlFileRows("test");
  const expected = (await rows.findFileById(reserved.id))!;
  await createSqlUploadOperations("test").terminate(
    upload.operationId,
    "cancelled",
  );
  expect(
    await rows.markFileReady(reserved.id, {
      sizeBytes: 5,
      etag: "etag",
      contentType: "text/plain",
    }),
  ).toBeNull();
  expect(await rows.failFileIfUnchanged(expected)).toBe(false);
  expect(await rows.findFileById(reserved.id)).toMatchObject({
    kind: "reserved",
  });
});

it("PostgreSQL атомарно устанавливает временную неудачу старого файла без операции", async () => {
  const rows = createSqlFileRows("test");
  const id = randomUUID();
  const file = await rows.insertFile({
    id,
    objectKey: id,
    directory: "",
    originalName: "a.txt",
    extension: "txt",
    contentType: "text/plain",
    sizeBytes: 5,
    etag: null,
    status: "pending",
    uploadSource: "presigned",
  });
  expect(await rows.failFileIfUnchanged(file)).toBe(true);
  expect(await rows.failFileIfUnchanged(file)).toBe(false);
  expect(await rows.findFileById(id)).toMatchObject({ kind: "failed" });
});

it("общая очистка PostgreSQL переживает частичный сбой и перезапуск без нового срока намерения", async () => {
  await withSingleConnection(async () => {
    const { objectStore } = buildHarness();
    const upload = { ...input(), size: THREE_PART_SIZE };
    const reserved = await assemble(objectStore).createPresignedUpload(upload);
    const operations = createSqlUploadOperations("test");
    await operations.terminate(upload.operationId, "failed");
    objectStore.failNext("remove", new Error("Нет связи"));
    await expect(
      operations.exclusive(upload.operationId, (session) =>
        assemble(objectStore).confirmation.cleanup(session),
      ),
    ).rejects.toThrow("Нет связи");
    expect(objectStore.openUploads()).toEqual([]);
    objectStore.uploadObject(reserved.key, Buffer.alloc(1), "text/plain");
    const restarted = assemble(objectStore);
    const restartedOperations = createSqlUploadOperations("test");
    expect(await restartedOperations.listTerminated()).toContain(
      upload.operationId,
    );
    expect(
      await restartedOperations.exclusive(upload.operationId, (session) =>
        restarted.confirmation.cleanup(session),
      ),
    ).toEqual({ status: "discarded" });
    expect(objectStore.objectKeys()).toEqual([]);
    expect(
      await restartedOperations.exclusive(upload.operationId, (session) =>
        restarted.confirmation.reconcile(reserved.id, session),
      ),
    ).toEqual({ status: "discarded" });
    await expect(restarted.completeUpload(reserved.id)).rejects.toMatchObject({
      name: "FileNotFoundError",
    });
  });
});

it("PostgreSQL сохраняет дату создания и полный срок новой попытки при одинаковых часах", async () => {
  const client = await pool.connect();
  await client.query("begin");
  const execute = async <T extends QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ) => await client.query<T>(text, values);
  const rows = createSqlFileRows("test", execute);
  const id = randomUUID();
  const data = {
    id,
    objectKey: id,
    directory: "",
    originalName: "a.txt",
    extension: "txt",
    contentType: "text/plain",
    sizeBytes: 5,
    etag: null,
    status: "pending" as const,
    uploadSource: "presigned" as const,
  };
  try {
    await rows.insertFile(data);
    await client.query(
      "update files set created_at = '2020-01-01Z', attempt_started_at = now() - interval '25 hours' where id = $1",
      [id],
    );
    const expired = (await rows.findFileById(id))!;
    expect(
      (await rows.listExpiredPending(24)).map((file) => file.id),
    ).toContain(id);
    const retry = await rows.reserveFile(data);
    expect(retry.createdAt).toEqual(new Date("2020-01-01Z"));
    expect(retry.attemptStartedAt.getTime()).toBeGreaterThan(
      expired.attemptStartedAt.getTime(),
    );
    expect(
      (await rows.listExpiredPending(24)).map((file) => file.id),
    ).not.toContain(id);
    const immediate = await rows.reserveFile(data);
    expect(immediate.updatedAt).toEqual(retry.updatedAt);
    expect(immediate.attemptStartedAt).toEqual(retry.attemptStartedAt);
    expect(immediate.attemptGeneration).not.toBe(retry.attemptGeneration);
    expect(await rows.failFileIfUnchanged(retry)).toBe(false);
    expect(await rows.findFileById(id)).toMatchObject({ kind: "reserved" });
    await client.query(
      "update files set attempt_started_at = now() - interval '24 hours' where id = $1",
      [id],
    );
    expect(
      (await rows.listExpiredPending(24)).map((file) => file.id),
    ).not.toContain(id);
    await client.query(
      "update files set attempt_started_at = attempt_started_at - interval '1 millisecond' where id = $1",
      [id],
    );
    expect(
      (await rows.listExpiredPending(24)).map((file) => file.id),
    ).toContain(id);
  } finally {
    await client.query("rollback");
    client.release();
  }
});

it("миграция сохраняет историческую дату создания и делает старое резервирование доступным уборке", async () => {
  const client = await pool.connect();
  const historicalSchema = `historical_${randomUUID().replaceAll("-", "")}`;
  await client.query("begin");
  try {
    await client.query(`create schema ${historicalSchema}`);
    await client.query(`set local search_path to ${historicalSchema}`);
    const directory = new URL("../../../../db/migrations/", import.meta.url);
    for (const name of (await readdir(directory))
      .filter((name) => name < "010")
      .sort())
      await client.query(await readFile(new URL(name, directory), "utf8"));
    const id = randomUUID();
    await client.query(
      `insert into files (id, bucket, object_key, original_name, content_type, size_bytes, status, upload_source, created_at, updated_at)
      values ($1, 'test', $2, 'a.txt', 'text/plain', 5, 'pending', 'presigned', '2020-01-01Z', '2020-02-01Z')`,
      [id, id],
    );
    await client.query(
      await readFile(new URL("010_upload_attempt.sql", directory), "utf8"),
    );
    const execute = async <T extends QueryResultRow>(
      text: string,
      values: unknown[] = [],
    ) => await client.query<T>(text, values);
    const rows = createSqlFileRows("test", execute);
    expect(await rows.findFileById(id)).toMatchObject({
      kind: "reserved",
      createdAt: new Date("2020-01-01Z"),
      updatedAt: new Date("2020-02-01Z"),
      attemptStartedAt: new Date("2020-01-01Z"),
      attemptGeneration: expect.any(String),
    });
    expect((await rows.listExpiredPending(24)).map((file) => file.id)).toEqual([
      id,
    ]);
    const h = buildHarness();
    const { confirmation } = assembleFiles({
      ...h.dependencies,
      fileRows: rows,
      clock: systemClock,
    });
    expect(await confirmation.reconcile(id)).toEqual({ status: "failed" });
    expect(await rows.findFileById(id)).toMatchObject({
      kind: "failed",
      createdAt: new Date("2020-01-01Z"),
    });
  } finally {
    await client.query("rollback");
    client.release();
  }
});

it("сохраняет остановку составной передачи между экземплярами и очищает её без нового срока", async () => {
  const { objectStore } = buildHarness();
  const firstModule = assemble(objectStore);
  const upload = { ...input(), size: THREE_PART_SIZE };
  const first = await firstModule.createPresignedUpload(upload);
  if (first.strategy !== "multipart")
    throw new Error("Ожидалась составная загрузка");
  objectStore.uploadPart(first.uploadId, 1, Buffer.alloc(first.partSize));
  const rows = createSqlFileRows("test");
  const before = await rows.findFileById(first.id);
  const operations = createSqlUploadOperations("test");
  await operations.exclusive(upload.operationId, async () => {
    expect(
      await assemble(objectStore).resolveUploadOperation(
        upload.operationId,
        first.uploadId,
      ),
    ).toEqual({ status: "processing" });
    expect(
      await assemble(objectStore).getUploadOperation(upload.operationId),
    ).toEqual({ status: "pending" });
  });
  objectStore.failNext("listParts", new Error("Нет хранилища"));
  await expect(
    firstModule.resolveUploadOperation(upload.operationId, first.uploadId),
  ).rejects.toThrow("Нет хранилища");
  expect(
    await assemble(objectStore).getUploadOperation(upload.operationId),
  ).toEqual({ status: "pending" });
  expect(
    await firstModule.resolveUploadOperation(
      upload.operationId,
      first.uploadId,
    ),
  ).toEqual({ status: "failed" });
  const restarted = assemble(objectStore);
  expect(await restarted.getUploadOperation(upload.operationId)).toEqual({
    status: "failed",
  });
  expect(await restarted.resolveUploadOperation(upload.operationId)).toEqual({
    status: "failed",
  });
  expect(await restarted.createPresignedUpload(upload)).toMatchObject({
    uploadId: first.uploadId,
    id: first.id,
  });
  expect(await restarted.getUploadOperation(upload.operationId)).toEqual({
    status: "pending",
  });
  expect(await rows.findFileById(first.id)).toEqual(before);
  expect(await restarted.getMultipartStatus(first.id)).toMatchObject({
    uploadedParts: [1],
  });
});
