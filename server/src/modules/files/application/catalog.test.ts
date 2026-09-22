import { describe, expect, it } from "vitest";
import { FileNotReadyError } from "../domain/errors.js";
import { buildHarness, thrownBy } from "../testing/files-module.harness.js";
import type { UploadsModule, PresignSingleResult } from "./uploads.js";

/**
 * Правила каталога через интерфейс фабрики модуля: объектное хранилище и
 * репозиторий строк метаданных подменены вторыми реализациями поверх Map.
 * Загрузка здесь — только подготовка сцены для проверки ссылки и карточки.
 */

/** Резервирование под один подписанный PUT: размер ниже порога составной. */
async function reserveSingle(files: UploadsModule, size?: number): Promise<PresignSingleResult> {
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
