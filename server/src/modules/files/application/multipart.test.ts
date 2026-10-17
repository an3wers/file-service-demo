import { describe, expect, it } from "vitest";
import {
  InvalidPartNumberError,
  MultipartIncompleteError,
  MultipartNotFoundError,
  TooManyActiveUploadsError,
} from "../domain/errors.js";
import {
  MIB,
  THREE_PART_SIZE,
  buildHarnessWithDirectories,
  thrownBy,
} from "../testing/files-module.harness.js";

/**
 * Правила составных загрузок через интерфейс фабрики модуля: хранилище и
 * репозиторий строк подменены вторыми реализациями поверх Map, а не моками.
 * Утверждения — о наблюдаемом результате: что вернулось вызывающему коду и в
 * каком состоянии оказались строка метаданных и объектное хранилище.
 */

/** Тело запроса на старт составной загрузки — то, что приходит от клиента. */
function uploadRequest(size = THREE_PART_SIZE) {
  return {
    filename: "report.bin",
    directory: "docs",
    contentType: "text/plain",
    size,
  };
}

describe("multipart uploads", () => {
  describe("part ranges", () => {
    it("hands out the ranges of the plan recorded at start, with a shorter last part", async () => {
      const { multipart, rowOf } = await buildHarnessWithDirectories({
        partUrlBatch: 3,
      });

      const started = await multipart.createMultipartUpload(uploadRequest());
      const { parts } = await multipart.createPartUrls(
        await rowOf(started.id),
        {
          partNumbers: [1, 2, 3],
        },
      );

      expect(started).toMatchObject({
        size: THREE_PART_SIZE,
        partSize: 5 * MIB,
        partCount: 3,
      });
      expect(parts).toEqual([
        { partNumber: 1, offset: 0, size: 5 * MIB, url: expect.any(String) },
        {
          partNumber: 2,
          offset: 5 * MIB,
          size: 5 * MIB,
          url: expect.any(String),
        },
        {
          partNumber: 3,
          offset: 10 * MIB,
          size: 2 * MIB,
          url: expect.any(String),
        },
      ]);
    });

    it("signs the first batch at the start, capped by the policy", async () => {
      const { multipart } = await buildHarnessWithDirectories();

      const started = await multipart.createMultipartUpload(uploadRequest());

      // Политика подписывает по две ссылки за раз, а план — на три части.
      expect(started.parts.map((part) => part.partNumber)).toEqual([1, 2]);
    });

    it("refuses a part number outside the plan", async () => {
      const { multipart, rowOf } = await buildHarnessWithDirectories();

      const started = await multipart.createMultipartUpload(uploadRequest());
      const error = await thrownBy(async () =>
        multipart.createPartUrls(await rowOf(started.id), { partNumbers: [4] }),
      );

      expect(error).toBeInstanceOf(InvalidPartNumberError);
      expect(error).toMatchObject({ details: { partCount: 3 } });
    });

    it("refuses a batch longer than the policy allows, naming the limit", async () => {
      const { multipart, rowOf, policy } = await buildHarnessWithDirectories();

      const started = await multipart.createMultipartUpload(uploadRequest());
      const error = await thrownBy(async () =>
        multipart.createPartUrls(await rowOf(started.id), {
          partNumbers: [1, 2, 3],
        }),
      );

      expect(error).toBeInstanceOf(InvalidPartNumberError);
      expect(error).toMatchObject({
        details: { maxBatch: policy.partUrlBatch },
      });
    });
  });

  describe("admission", () => {
    it("refuses over the concurrent-upload limit before anything opens in storage", async () => {
      const { multipart, objectStore, fileRows } =
        await buildHarnessWithDirectories({ maxActiveUploads: 1 });

      await multipart.createMultipartUpload(uploadRequest());

      // Открытие загрузки заминировано: если бы лимит проверялся после него,
      // наружу вышла бы эта ошибка, а не отказ по лимиту. Конечное состояние
      // одно и то же в обоих случаях — отличает их только то, что вернулось.
      objectStore.failNext(
        "beginMultipart",
        new Error("storage was reached first"),
      );

      const error = await thrownBy(() =>
        multipart.createMultipartUpload(uploadRequest()),
      );

      expect(error).toBeInstanceOf(TooManyActiveUploadsError);
      expect(error).toMatchObject({ details: { active: 1, limit: 1 } });
      expect(objectStore.openUploads()).toHaveLength(1);
      expect(await fileRows.countActiveMultipart()).toBe(1);
    });
  });

  describe("cleaning up after a failed start", () => {
    it("aborts the upload it opened when the first batch of URLs cannot be signed", async () => {
      const { multipart, objectStore, rowCount } =
        await buildHarnessWithDirectories();

      objectStore.failNext("signPart", new Error("signing is down"));
      const error = await thrownBy(() =>
        multipart.createMultipartUpload(uploadRequest()),
      );

      expect(error.message).toBe("signing is down");
      // Ни открытой загрузки в хранилище, ни строки метаданных: следов нет.
      expect(objectStore.openUploads()).toEqual([]);
      expect(await rowCount()).toBe(0);
    });
  });

  describe("status of an interrupted upload", () => {
    it("reports the part numbers and bytes storage actually holds", async () => {
      const { multipart, objectStore, rowOf } =
        await buildHarnessWithDirectories();

      const started = await multipart.createMultipartUpload(uploadRequest());

      // Клиент успел отправить первую и третью части и оборвался.
      objectStore.uploadPart(started.uploadId, 1, Buffer.alloc(5 * MIB, 1));
      objectStore.uploadPart(started.uploadId, 3, Buffer.alloc(2 * MIB, 3));

      expect(
        await multipart.getMultipartStatus(await rowOf(started.id)),
      ).toEqual({
        id: started.id,
        uploadId: started.uploadId,
        size: THREE_PART_SIZE,
        partSize: 5 * MIB,
        partCount: 3,
        uploadedParts: [1, 3],
        uploadedBytes: 7 * MIB,
      });
    });

    it("reports nothing uploaded while storage holds no parts", async () => {
      const { multipart, rowOf } = await buildHarnessWithDirectories();

      const started = await multipart.createMultipartUpload(uploadRequest());

      expect(
        await multipart.getMultipartStatus(await rowOf(started.id)),
      ).toMatchObject({
        uploadedParts: [],
        uploadedBytes: 0,
      });
    });

    it("conflicts when storage no longer knows the upload", async () => {
      const { multipart, objectStore, rowOf } =
        await buildHarnessWithDirectories();

      const started = await multipart.createMultipartUpload(uploadRequest());

      await objectStore.abortMultipart(started.key, started.uploadId);

      const error = await thrownBy(async () =>
        multipart.getMultipartStatus(await rowOf(started.id)),
      );

      expect(error).toBeInstanceOf(MultipartNotFoundError);
    });
  });

  describe("завершение составной загрузки", () => {
    it("отказывает в завершении, пока в хранилище долетели не все части", async () => {
      const { multipart, objectStore, rowOf } =
        await buildHarnessWithDirectories();

      const started = await multipart.createMultipartUpload(uploadRequest());
      objectStore.uploadPart(started.uploadId, 1, Buffer.alloc(5 * MIB, 1));

      const error = await thrownBy(async () =>
        multipart.completeMultipartUpload(await rowOf(started.id)),
      );

      expect(error).toBeInstanceOf(MultipartIncompleteError);
      expect(error).toMatchObject({ details: { uploaded: 1, expected: 3 } });
    });
  });

  describe("deleting a live multipart upload", () => {
    it("удаляет части и объект под зарезервированным ключом", async () => {
      const { multipart, files, objectStore, fileRows } =
        await buildHarnessWithDirectories();

      const started = await multipart.createMultipartUpload(uploadRequest());

      objectStore.uploadPart(started.uploadId, 1, Buffer.alloc(5 * MIB, 1));
      objectStore.uploadObject(started.key, Buffer.from("bystander"));

      await files.deleteFile(started.id);

      expect(objectStore.openUploads()).toEqual([]);
      expect(objectStore.objectAt(started.key)).toBeNull();
      expect(await fileRows.findFileById(started.id)).toBeNull();
    });
  });
});
