import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FileNotReadyError, MultipartNotFoundError, UploadNotCompletedError } from "./errors.js";
import { THREE_PART_SIZE, buildHarness, thrownBy } from "./files-module.harness.js";
import type { FilesModule, UploadThroughServerInput } from "./files.service.js";
import type { PresignMultipartResult, PresignSingleResult } from "./files.types.js";

/**
 * Правила подтверждения загрузки через интерфейс фабрики файлового модуля:
 * объектное хранилище и репозиторий строк метаданных подменены вторыми
 * реализациями поверх Map, а модуль составных загрузок настоящий и собран на
 * тех же зависимостях.
 *
 * Утверждения — о наблюдаемом результате: что вернулось вызывающему коду и в
 * каком состоянии оказались строка метаданных и объектное хранилище. Списка
 * вызовов зависимости здесь нет: подтверждение — это переход, а не вызов.
 */

/** Хранилище закавычивает ETag, и вторая реализация повторяет это правило. */
function etagOf(body: Buffer): string {
  return `"${createHash("md5").update(body).digest("hex")}"`;
}

/** Резервирование под один подписанный PUT: размер ниже порога составной. */
async function reserveSingle(files: FilesModule, size?: number): Promise<PresignSingleResult> {
  const reserved = await files.createPresignedUpload({
    filename: "report.bin",
    directory: "docs",
    contentType: "text/plain",
    ...(size === undefined ? {} : { size }),
  });

  if (reserved.strategy !== "single") {
    throw new Error("Expected a single-PUT reservation, got a multipart one");
  }

  return reserved;
}

/** Резервирование составной загрузки: размер за порогом сам уводит на этот путь. */
async function reserveMultipart(
  files: FilesModule,
  size = THREE_PART_SIZE,
): Promise<PresignMultipartResult> {
  const reserved = await files.createPresignedUpload({
    filename: "report.bin",
    directory: "docs",
    contentType: "text/plain",
    size,
  });

  if (reserved.strategy !== "multipart") {
    throw new Error("Expected a multipart reservation, got a single-PUT one");
  }

  return reserved;
}

/**
 * Три части, которые клиент кладёт по подписанным ссылкам. Байтов в них
 * несравнимо меньше, чем в объявленных 12 МиБ: хранилище не обязано отвечать
 * планом, и именно его ответ должен попасть в строку.
 */
const PARTS = [Buffer.from("alpha"), Buffer.from("beta"), Buffer.from("gamma")];

describe("confirming an upload", () => {
  describe("a single signed PUT", () => {
    it("takes the size and etag off the stored object, not off the client's word", async () => {
      const { files, objectStore } = buildHarness();

      // Клиент объявил десять байт, а положил четыре: запомнить надо байты.
      const reserved = await reserveSingle(files, 10);
      const body = Buffer.from("four");

      objectStore.uploadObject(reserved.key, body, "text/plain");

      expect(await files.completeUpload(reserved.id)).toMatchObject({
        id: reserved.id,
        kind: "ready",
        size: body.byteLength,
        etag: etagOf(body),
        contentType: "text/plain",
      });
    });

    it("answers a repeated confirmation with the same result instead of an error", async () => {
      const { files, objectStore } = buildHarness();

      const reserved = await reserveSingle(files, 4);

      objectStore.uploadObject(reserved.key, Buffer.from("four"), "text/plain");

      const first = await files.completeUpload(reserved.id);

      // Объект убрали уже после подтверждения: источник истины — строка, и
      // повторный вопрос отвечается по ней, а не новым походом в хранилище.
      await objectStore.remove(reserved.key);

      expect(await files.completeUpload(reserved.id)).toEqual(first);
    });

    it("conflicts on «upload not completed» while storage holds no object", async () => {
      const { files, rowOf } = buildHarness();

      const reserved = await reserveSingle(files, 4);
      const error = await thrownBy(() => files.completeUpload(reserved.id));

      expect(error).toBeInstanceOf(UploadNotCompletedError);
      expect(error).toMatchObject({ details: { key: reserved.key } });
      // Строка осталась зарезервированной: клиент ещё может дослать байты.
      expect(await rowOf(reserved.id)).toMatchObject({ kind: "reserved" });
    });
  });

  describe("a multipart upload", () => {
    it("assembles the object and records what storage holds, not what was planned", async () => {
      const { files, objectStore, rowOf } = buildHarness();

      const reserved = await reserveMultipart(files);

      PARTS.forEach((part, index) => {
        objectStore.uploadPart(reserved.uploadId, index + 1, part);
      });

      const assembled = Buffer.concat(PARTS);
      const confirmed = await files.completeUpload(reserved.id);

      expect(confirmed).toMatchObject({
        kind: "ready",
        size: assembled.byteLength,
        etag: etagOf(assembled),
      });
      // Части склеены в объект по возрастанию номера, а загрузка закрыта.
      expect(objectStore.objectAt(reserved.key)?.body).toEqual(assembled);
      expect(objectStore.openUploads()).toEqual([]);
      // Подтверждённая строка больше не несёт плана: загрузка неживая.
      expect(await rowOf(reserved.id)).toMatchObject({ kind: "ready" });
      // И повторный вопрос по неживой загрузке отвечается тем же, а не отказом.
      expect(await files.completeUpload(reserved.id)).toEqual(confirmed);
    });

    it("lets the second racing confirmation read the result of the first", async () => {
      const { files, objectStore } = buildHarness();

      const reserved = await reserveMultipart(files);

      PARTS.forEach((part, index) => {
        objectStore.uploadPart(reserved.uploadId, index + 1, part);
      });

      // Обе видят строку зарезервированной и обе идут собирать объект: вторая
      // застаёт загрузку уже закрытой и читает готовый объект, а не падает.
      const [first, second] = await Promise.all([
        files.completeUpload(reserved.id),
        files.completeUpload(reserved.id),
      ]);

      expect(second).toEqual(first);
      expect(first).toMatchObject({ kind: "ready", size: Buffer.concat(PARTS).byteLength });
      // Объект собран один раз, и второй сборки под тем же ключом не случилось.
      expect(objectStore.objectKeys()).toEqual([reserved.key]);
    });

    it("conflicts on «no multipart upload» once the upload is gone and no object landed", async () => {
      const { files, objectStore, rowOf } = buildHarness();

      const reserved = await reserveMultipart(files);

      // Уборка успела отменить загрузку: ни частей, ни объекта под ключом.
      await objectStore.abortMultipart(reserved.key, reserved.uploadId);

      const error = await thrownBy(() => files.completeUpload(reserved.id));

      expect(error).toBeInstanceOf(MultipartNotFoundError);
      expect(error).toMatchObject({ details: { key: reserved.key } });
      expect(await rowOf(reserved.id)).toMatchObject({ kind: "multipart" });
    });
  });
});

describe("uploading through the server", () => {
  /** То, что попадает в сценарий: тело уже в памяти, без формы multer. */
  function uploadInput(body: Buffer): UploadThroughServerInput {
    return {
      filename: "report.bin",
      directory: "docs",
      contentType: "text/plain",
      bytes: body,
      size: body.byteLength,
    };
  }

  it("stores the bytes and confirms the row in one call", async () => {
    const { files, objectStore } = buildHarness();
    const body = Buffer.from("through the server");

    const uploaded = await files.uploadThroughServer(uploadInput(body));

    expect(uploaded).toMatchObject({
      kind: "ready",
      uploadSource: "server",
      directory: "docs",
      size: body.byteLength,
      etag: etagOf(body),
    });
    expect(objectStore.objectAt(uploaded.key)?.body).toEqual(body);
  });

  it("removes the bytes it wrote when the metadata row cannot be inserted", async () => {
    const { files, objectStore, fileRows, rowCount } = buildHarness();
    const failure = new Error("the metadata table is down");

    fileRows.failNext("insertFile", failure);

    await expect(files.uploadThroughServer(uploadInput(Buffer.from("orphan")))).rejects.toBe(
      failure,
    );
    // Ни строки, ни объекта: сироты, за которую хранилище тарифицирует, нет.
    expect(await rowCount()).toBe(0);
    expect(objectStore.objectKeys()).toEqual([]);
  });

  it("had written those bytes first, so it is the rollback that removes them", async () => {
    const { files, objectStore, fileRows } = buildHarness();
    const failure = new Error("the metadata table is down");

    fileRows.failNext("insertFile", failure);
    // Откат заминирован: если байты всё же остались под ключом, значит они
    // были записаны до строки и убирает их именно откат, а не их отсутствие.
    objectStore.failNext("remove", new Error("storage is down"));

    await expect(files.uploadThroughServer(uploadInput(Buffer.from("orphan")))).rejects.toBe(
      failure,
    );
    expect(objectStore.objectKeys()).toHaveLength(1);
  });
});

describe("handing out a signed download link", () => {
  it("refuses a link for a file whose upload was never confirmed", async () => {
    const { files } = buildHarness();

    const reserved = await reserveSingle(files, 4);
    const error = await thrownBy(() =>
      files.getDownloadUrl(reserved.id, { disposition: "attachment" }),
    );

    expect(error).toBeInstanceOf(FileNotReadyError);
  });

  it("serves the card of an unconfirmed file without a link rather than failing", async () => {
    const { files } = buildHarness();

    const reserved = await reserveSingle(files, 4);

    const card = await files.getFileCard(reserved.id, true);

    expect(card.file).toMatchObject({ kind: "reserved" });
    expect(card.downloadUrl).toBeUndefined();
  });

  it("signs a link once the upload is confirmed", async () => {
    const { files, objectStore } = buildHarness();

    const reserved = await reserveSingle(files, 4);

    objectStore.uploadObject(reserved.key, Buffer.from("four"), "text/plain");
    await files.completeUpload(reserved.id);

    const link = await files.getDownloadUrl(reserved.id, { disposition: "attachment" });

    expect(link).toMatchObject({ url: expect.stringContaining(reserved.key), name: "report.bin" });
  });
});
