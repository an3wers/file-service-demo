import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../../../db/pool.js";
import { migrate } from "../../../../db/migrate.js";
import { createPostgresOwner } from "../../testing/postgres-owner.js";
import { createFilesPersistence } from "../../persistence.js";
import { FileNotFoundError } from "../../domain/errors.js";

let owner: string;

const schema = `operation_session_test_${randomUUID().replaceAll("-", "")}`;
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
});
afterAll(async () => {
  if (created) await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

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

function gate() {
  let open!: () => void;
  let entered!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return {
    open,
    started,
    async hold() {
      entered();
      await opened;
    },
  };
}

function reservation() {
  const id = randomUUID();
  return {
    id,
    key: `docs/${id}.txt`,
    directory: "",
    originalName: "a.txt",
    extension: "txt",
    contentType: "text/plain",
  };
}

describe("сессия операции загрузки в PostgreSQL", () => {
  it("под блокировкой все обращения к строкам и каталогам идут через одно соединение", async () => {
    const { operations } = createFilesPersistence("test").forOwner(owner);
    const operationId = randomUUID();
    const record = { reservation: reservation(), size: 5 };
    const { id, key, directory, originalName, extension, contentType } =
      record.reservation;
    const input = {
      id,
      objectKey: key,
      directory,
      originalName,
      extension,
      contentType,
      sizeBytes: 5,
      etag: null,
      status: "pending" as const,
      uploadSource: "presigned" as const,
    };
    await withSingleConnection(async () => {
      const result = await operations.exclusive(
        operationId,
        async (session) => {
          const rows = session.fileRows;
          expect(await session.directories.exists("")).toBe(true);
          expect(await session.read()).toBeNull();
          await session.save(record);
          expect(await session.read()).toMatchObject(record);
          expect(await rows.countActiveMultipart()).toBe(0);
          const reserved = await rows.reserveFile(input);
          expect(await rows.findFileById(id)).toEqual(reserved);
          expect(await rows.failFileIfUnchanged(reserved)).toBe(true);
          expect(
            await rows.markFileReady(id, {
              sizeBytes: 5,
              etag: "etag",
              contentType,
            }),
          ).toMatchObject({ kind: "ready" });
          await rows.markFileFailed(id);
          expect(await rows.isFileDeleted(id)).toBe(false);
          await session.markMultipartStopped(null);
          expect(await session.termination()).toBeNull();
          await session.terminate("cancelled");
          await session.checked();
          expect(await session.termination()).toEqual({
            reason: "cancelled",
            uploadId: null,
          });
          return "готово";
        },
      );
      expect(result).toEqual({ busy: false, value: "готово" });
    });
  });

  it("ошибка сценария под блокировкой выходит нетронутой, а не как ошибка базы", async () => {
    const { operations } = createFilesPersistence("test").forOwner(owner);
    const network = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const domain = new FileNotFoundError("Файла нет");
    for (const error of [network, domain])
      await expect(
        operations.exclusive(randomUUID(), async () => {
          throw error;
        }),
      ).rejects.toBe(error);
  });

  it("занятая операция возвращает явный результат, а ожидание блокировки ограничено", async () => {
    const { operations } = createFilesPersistence("test", {
      lockWaitMs: 100,
    }).forOwner(owner);
    const operationId = randomUUID();
    const holder = gate();
    const holding = operations.exclusive(operationId, holder.hold);
    await holder.started;
    try {
      expect(await operations.exclusive(operationId, async () => 1)).toEqual({
        busy: true,
      });
      const waitedFrom = Date.now();
      expect(
        await operations.exclusive(operationId, async () => 1, { wait: true }),
      ).toEqual({ busy: true });
      expect(Date.now() - waitedFrom).toBeGreaterThanOrEqual(90);
      expect(Date.now() - waitedFrom).toBeLessThan(5_000);
    } finally {
      holder.open();
    }
    expect(await holding).toEqual({ busy: false, value: undefined });
    expect(
      await operations.exclusive(operationId, async () => 2, { wait: true }),
    ).toEqual({ busy: false, value: 2 });
  });

  it("ожидающее подтверждение получает блокировку, как только её освобождают", async () => {
    const { operations } = createFilesPersistence("test", {
      lockWaitMs: 5_000,
    }).forOwner(owner);
    const operationId = randomUUID();
    const holder = gate();
    const holding = operations.exclusive(operationId, holder.hold);
    await holder.started;
    const waiting = operations.exclusive(operationId, async () => "после", {
      wait: true,
    });
    setTimeout(holder.open, 50);
    await holding;
    expect(await waiting).toEqual({ busy: false, value: "после" });
  });
});
