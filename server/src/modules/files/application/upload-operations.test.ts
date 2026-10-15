import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildHarness } from "../testing/files-module.harness.js";

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
