import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildHarness,
  THREE_PART_SIZE,
} from "../testing/files-module.harness.js";

function input() {
  return {
    operationId: randomUUID(),
    filename: "report.txt",
    bytes: Buffer.from("hello"),
    size: 5,
  };
}

describe("повтор операции загрузки через сервер", () => {
  it("возвращает исходный результат после потери ответа и допускает новую операцию с тем же файлом", async () => {
    const { files, rowCount } = buildHarness();
    const upload = input();
    const first = await files.uploadThroughServer(upload);
    expect(await files.getUploadOperation(upload.operationId)).toEqual({
      status: "succeeded",
      file: first,
    });
    expect(await files.uploadThroughServer(upload)).toEqual(first);
    const second = await files.uploadThroughServer({
      ...upload,
      operationId: randomUUID(),
    });
    expect(second.id).not.toBe(first.id);
    expect(await rowCount()).toBe(2);
  });

  it("сверяет объект после потерянного подтверждения и не отправляет его повторно", async () => {
    const { files, objectStore, fileRows, rowCount } = buildHarness();
    const upload = input();
    fileRows.failNext("markFileReady", new Error("Ответ потерян"));
    await expect(files.uploadThroughServer(upload)).rejects.toThrow(
      "Ответ потерян",
    );
    objectStore.failNext("put", new Error("Повторная передача запрещена"));
    const result = await files.uploadThroughServer(upload);
    expect(await files.getUploadOperation(upload.operationId)).toEqual({
      status: "succeeded",
      file: result,
    });
    expect(await rowCount()).toBe(1);
  });

  it("подтверждает неудачу и повторяет передачу в существующее резервирование", async () => {
    const { files, objectStore, rowCount } = buildHarness();
    const upload = input();
    objectStore.failNext("put", new Error("Нет соединения"));
    await expect(files.uploadThroughServer(upload)).rejects.toThrow(
      "Нет соединения",
    );
    expect(await files.getUploadOperation(upload.operationId)).toEqual({
      status: "failed",
    });
    expect((await files.uploadThroughServer(upload)).kind).toBe("ready");
    expect(await rowCount()).toBe(1);
  });

  it("сохраняет идентичность при сбое создания строки и не воссоздаёт удалённый результат", async () => {
    const { files, fileRows, objectStore } = buildHarness();
    const upload = input();
    fileRows.failNext("insertFile", new Error("Нет базы"));
    await expect(files.uploadThroughServer(upload)).rejects.toThrow();
    expect(await files.getUploadOperation(upload.operationId)).toEqual({
      status: "failed",
    });
    const file = await files.uploadThroughServer(upload);
    await files.deleteFile(file.id);
    expect(await files.getUploadOperation(upload.operationId)).toEqual({
      status: "deleted",
    });
    await expect(files.uploadThroughServer(upload)).rejects.toMatchObject({
      name: "FileNotFoundError",
    });
    expect(objectStore.objectKeys()).toEqual([]);
  });

  it("отклоняет повтор с другими параметрами до записи объекта", async () => {
    const { files, objectStore } = buildHarness();
    const upload = input();
    await files.uploadThroughServer(upload);
    await expect(
      files.uploadThroughServer({ ...upload, filename: "other.txt" }),
    ).rejects.toMatchObject({ name: "UploadOperationConflictError" });
    expect(objectStore.objectKeys()).toHaveLength(1);
  });
});

describe.each([5, THREE_PART_SIZE])(
  "повтор прямой загрузки размером %i",
  (size) => {
    it("сохраняет резервирование после потери ответа и подтверждает единственный файл", async () => {
      const { files, objectStore, rowCount } = buildHarness();
      const upload = { ...input(), size };
      const first = await files.createPresignedUpload(upload);
      const repeated = await files.createPresignedUpload(upload);
      expect(repeated.id).toBe(first.id);
      expect(repeated.key).toBe(first.key);
      if (first.strategy === "multipart" && repeated.strategy === "multipart") {
        expect(repeated.uploadId).toBe(first.uploadId);
        expect(repeated.partSize).toBe(first.partSize);
      }
      await objectStore.put(first.key, Buffer.from("hello"), {
        contentType: "text/plain",
        contentLength: 5,
      });
      const outcome = await files.getUploadOperation(upload.operationId);
      expect(outcome).toMatchObject({
        status: "succeeded",
        file: { id: first.id },
      });
      expect(await rowCount()).toBe(1);
      expect(await files.completeUpload(first.id)).toMatchObject({
        id: first.id,
        kind: "ready",
      });
      await files.deleteFile(first.id);
      expect(await files.getUploadOperation(upload.operationId)).toEqual({
        status: "deleted",
      });
      await expect(files.createPresignedUpload(upload)).rejects.toMatchObject({
        name: "FileNotFoundError",
      });
      expect(
        (
          await files.createPresignedUpload({
            ...upload,
            operationId: randomUUID(),
          })
        ).id,
      ).not.toBe(first.id);
    });
  },
);

it("повторяет исчезнувшую составную загрузку с прежним файлом", async () => {
  const { files, objectStore, rowCount } = buildHarness();
  const upload = { ...input(), size: THREE_PART_SIZE };
  const first = await files.createPresignedUpload(upload);
  if (first.strategy !== "multipart")
    throw new Error("Ожидалась составная загрузка");
  await objectStore.abortMultipart(first.key, first.uploadId);
  const repeated = await files.createPresignedUpload(upload);
  expect(repeated.id).toBe(first.id);
  if (repeated.strategy !== "multipart")
    throw new Error("Ожидалась составная загрузка");
  expect(repeated.uploadId).not.toBe(first.uploadId);
  expect(await rowCount()).toBe(1);
});
