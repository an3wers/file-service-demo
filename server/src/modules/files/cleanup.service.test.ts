import { describe, expect, it } from "vitest";
import type { MemoryObjectStore } from "../../storage/memory-object-store.js";
import type { UploadedPart } from "../../storage/object-store.js";
import { MIB, PENDING_TTL_HOURS, THREE_PART_SIZE, buildHarness } from "./files-module.harness.js";

/**
 * Правила уборки через интерфейс фабрики модуля: объектное хранилище и
 * репозиторий строк подменены вторыми реализациями поверх Map, а не моками.
 * Часы у них общие — резервирование, открытая составная загрузка и возраст,
 * по которому уборка судит, стареют вместе.
 *
 * Утверждения — о наблюдаемом результате: в каком состоянии оказались строка
 * метаданных и хранилище, а не какие методы были вызваны.
 */

/** Час сверх TTL: всё, что было до него, уборка считает просроченным. */
const PAST_TTL = PENDING_TTL_HOURS + 1;

/** Меньше порога составной загрузки — резервируется один подписанный PUT. */
function singleUpload() {
  return { filename: "note.txt", directory: "docs", contentType: "text/plain", size: MIB };
}

function multipartUpload() {
  return {
    filename: "report.bin",
    directory: "docs",
    contentType: "text/plain",
    size: THREE_PART_SIZE,
  };
}

/** Клиент нарезал файл по плану и залил все три части. */
function uploadEveryPart(objectStore: MemoryObjectStore, uploadId: string): UploadedPart[] {
  return [5 * MIB, 5 * MIB, 2 * MIB].map((size, index) => {
    const partNumber = index + 1;

    objectStore.uploadPart(uploadId, partNumber, Buffer.alloc(size, partNumber));

    return { partNumber, size, etag: `"part-${partNumber}"` };
  });
}

describe("cleanup", () => {
  describe("expired pending rows", () => {
    it("recovers an upload whose confirmation was the only thing lost", async () => {
      const { files, cleanup, objectStore, rowOf, advance } = buildHarness();

      const reserved = await files.createPresignedUpload(singleUpload());
      // Клиент положил байты по подписанной ссылке и не подтвердил загрузку.
      objectStore.uploadObject(reserved.key, Buffer.from("hello"), "text/plain");
      advance(PAST_TTL);

      const counters = await cleanup.settleExpiredRows();
      const stored = await objectStore.head(reserved.key);

      expect(counters).toMatchObject({ examined: 1, recovered: 1, failed: 0 });
      expect(await rowOf(reserved.id)).toMatchObject({
        kind: "ready",
        size: stored?.size,
        etag: stored?.etag,
        contentType: "text/plain",
      });
    });

    it("recovers a multipart upload storage had already assembled", async () => {
      const { multipart, cleanup, objectStore, rowOf, advance } = buildHarness();

      const started = await multipart.createMultipartUpload(multipartUpload());

      const parts = uploadEveryPart(objectStore, started.uploadId);

      // Хранилище собрало объект, а ответ о сборке до сервиса не дошёл.
      await objectStore.completeMultipart(started.key, started.uploadId, parts);
      advance(PAST_TTL);

      const counters = await cleanup.settleExpiredRows();

      expect(counters).toMatchObject({ examined: 1, recovered: 1, failed: 0 });
      expect(await rowOf(started.id)).toMatchObject({ kind: "ready", size: THREE_PART_SIZE });
    });

    it("marks an upload failed when storage has no object at the key", async () => {
      const { files, cleanup, objectStore, rowOf, advance } = buildHarness();

      const reserved = await files.createPresignedUpload(singleUpload());

      advance(PAST_TTL);

      const counters = await cleanup.settleExpiredRows();

      expect(counters).toMatchObject({ examined: 1, recovered: 0, failed: 1 });
      expect(await rowOf(reserved.id)).toMatchObject({ kind: "failed" });
      expect(objectStore.objectKeys()).toEqual([]);
    });

    it("marks a multipart upload failed when neither the upload nor an object is left", async () => {
      const { multipart, cleanup, objectStore, rowOf, advance } = buildHarness();

      const started = await multipart.createMultipartUpload(multipartUpload());

      // Загрузки в хранилище больше нет, а объект так и не собрался.
      await objectStore.abortMultipart(started.key, started.uploadId);
      advance(PAST_TTL);

      const counters = await cleanup.settleExpiredRows();

      expect(counters).toMatchObject({ examined: 1, failed: 1, recovered: 0, aborted: 0 });
      expect(await rowOf(started.id)).toMatchObject({ kind: "failed" });
      expect(objectStore.objectKeys()).toEqual([]);
    });

    it("leaves the upload alone when the claim is lost to whoever settled the row", async () => {
      const { files, multipart, cleanup, objectStore, fileRows, rowOf, advance } = buildHarness();

      const started = await multipart.createMultipartUpload(multipartUpload());

      uploadEveryPart(objectStore, started.uploadId);
      advance(PAST_TTL);
      // Клиент дошёл до подтверждения ровно между выборкой и захватом строки.
      fileRows.beforeNextClaim(async () => {
        await files.completeUpload(started.id);
      });

      const counters = await cleanup.settleExpiredRows();

      expect(counters).toMatchObject({ examined: 1, skipped: 1, aborted: 0, failed: 0 });
      expect(await rowOf(started.id)).toMatchObject({ kind: "ready" });
      // Загрузка не отменена: объект собран и лежит под своим ключом.
      expect(objectStore.objectAt(started.key)?.body.byteLength).toBe(THREE_PART_SIZE);
    });

    it("aborts an abandoned multipart upload and fails its row", async () => {
      const { multipart, cleanup, objectStore, rowOf, advance } = buildHarness();

      const started = await multipart.createMultipartUpload(multipartUpload());

      objectStore.uploadPart(started.uploadId, 1, Buffer.alloc(5 * MIB, 1));
      advance(PAST_TTL);

      const counters = await cleanup.settleExpiredRows();

      expect(counters).toMatchObject({ examined: 1, aborted: 1, failed: 1, recovered: 0 });
      expect(await rowOf(started.id)).toMatchObject({ kind: "failed" });
      expect(objectStore.openUploads()).toEqual([]);
      expect(objectStore.objectKeys()).toEqual([]);
    });
  });

  describe("orphan sweep", () => {
    it("aborts uploads no row points at, sparing known and fresh ones", async () => {
      const { multipart, cleanup, objectStore, advance } = buildHarness();

      const orphan = await objectStore.beginMultipart("docs/orphan.bin", {
        contentType: "text/plain",
      });
      const known = await multipart.createMultipartUpload(multipartUpload());

      advance(PAST_TTL);

      // Открыта только что: её как раз сейчас может вставлять в таблицу сервис.
      const fresh = await objectStore.beginMultipart("docs/fresh.bin", {
        contentType: "text/plain",
      });

      const swept = await cleanup.sweepOrphanUploads();

      expect(swept).toEqual({ examined: 2, aborted: 1 });
      expect(objectStore.openUploads().map((upload) => upload.uploadId).sort()).toEqual(
        [known.uploadId, fresh].sort(),
      );
      expect(objectStore.openUploads().map((upload) => upload.uploadId)).not.toContain(orphan);
    });
  });
});
