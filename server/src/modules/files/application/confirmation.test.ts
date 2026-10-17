import { expect, it } from "vitest";
import { buildHarness } from "../testing/files-module.harness.js";

it("подтверждает прямую загрузку по метаданным объекта и безопасно повторяется", async () => {
  const h = buildHarness();
  const reserved = await h.files.createPresignedUpload({
    filename: "a.txt",
    size: 5,
  });
  h.objectStore.uploadObject(reserved.key, Buffer.from("hello"), "text/plain");
  const ready = await h.confirmation.confirm(reserved.id);
  expect(ready).toMatchObject({
    kind: "ready",
    size: 5,
    contentType: "text/plain",
  });
  expect(await h.confirmation.confirm(reserved.id)).toEqual(ready);
});

it("серверная передача подтверждает фактический объект вместо данных запроса", async () => {
  const h = buildHarness();
  const put = h.objectStore.put.bind(h.objectStore);
  h.objectStore.put = async (key, bytes, options) => {
    await put(key, bytes, options);
    h.objectStore.uploadObject(key, bytes, "application/custom");
    return { etag: "неверный ответ передачи" };
  };
  const file = await h.files.uploadThroughServer({
    filename: "a.txt",
    size: 5,
    bytes: Buffer.from("hello"),
  });
  expect(file).toMatchObject({
    kind: "ready",
    contentType: "application/custom",
  });
});

it("просрочка не перезаписывает конкурентное подтверждение", async () => {
  const h = buildHarness();
  const reserved = await h.files.createPresignedUpload({
    filename: "a.txt",
    size: 5,
  });
  h.advance(25);
  h.fileRows.beforeNextClaim(async () => {
    h.objectStore.uploadObject(
      reserved.key,
      Buffer.from("hello"),
      "text/plain",
    );
    await h.confirmation.confirm(reserved.id);
  });
  expect(
    await h.confirmation.reconcile(reserved.id, undefined, { expired: true }),
  ).toMatchObject({ status: "succeeded", file: { kind: "ready" } });
  expect(await h.rowOf(reserved.id)).toMatchObject({ kind: "ready" });
});

it("уборка сохраняет подтверждение после решения об отсутствующем объекте", async () => {
  const h = buildHarness();
  const reserved = await h.files.createPresignedUpload({
    filename: "a.txt",
    size: 5,
  });
  h.advance(25);
  h.fileRows.beforeNextClaim(async () => {
    h.objectStore.uploadObject(
      reserved.key,
      Buffer.from("hello"),
      "text/plain",
    );
    await h.confirmation.confirm(reserved.id);
  });
  await h.cleanup.settleExpiredRows();
  expect(await h.rowOf(reserved.id)).toMatchObject({ kind: "ready" });
});

it("сверяет готовые части без сборки и подтверждает составную загрузку только явно", async () => {
  const h = buildHarness();
  const started = await h.multipart.createMultipartUpload({
    filename: "a.bin",
    size: 12 * 1024 * 1024,
  });
  for (const [index, size] of [5, 5, 2].entries())
    h.objectStore.uploadPart(
      started.uploadId,
      index + 1,
      Buffer.alloc(size * 1024 * 1024),
    );
  expect(await h.confirmation.reconcile(started.id)).toEqual({
    status: "failed",
  });
  expect(await h.rowOf(started.id)).toMatchObject({
    kind: "multipart",
    plan: { size: 12 * 1024 * 1024, partCount: 3 },
  });
  expect(h.objectStore.objectKeys()).toEqual([]);
  expect(await h.confirmation.confirm(started.id)).toMatchObject({
    kind: "ready",
    size: 12 * 1024 * 1024,
  });
});

it("восстанавливает историческую неудачу по фактическому размеру без выдуманного ожидания", async () => {
  const h = buildHarness();
  const started = await h.multipart.createMultipartUpload({
    filename: "a.bin",
    size: 12 * 1024 * 1024,
  });
  await h.fileRows.markFileFailed(started.id);
  h.objectStore.uploadObject(started.key, Buffer.from("late"), "text/plain");
  expect(await h.confirmation.reconcile(started.id)).toMatchObject({
    status: "succeeded",
    file: { size: 4, contentType: "text/plain" },
  });
});

it("при восстановлении неудачи использует ожидаемый размер операции", async () => {
  const h = buildHarness();
  const reserved = await h.files.createPresignedUpload({
    operationId: "size-operation",
    filename: "a.txt",
    size: 5,
  });
  await h.fileRows.markFileFailed(reserved.id);
  h.objectStore.uploadObject(reserved.key, Buffer.from("bad"), "text/plain");
  const mismatch = await h.operations.exclusive(
    "size-operation",
    async (session) => await h.confirmation.reconcile(reserved.id, session),
  );
  expect(mismatch).toEqual({ status: "failed" });
  expect(await h.rowOf(reserved.id)).toMatchObject({ kind: "failed" });
  h.objectStore.uploadObject(reserved.key, Buffer.from("hello"), "text/plain");
  expect(
    await h.operations.exclusive(
      "size-operation",
      async (session) => await h.confirmation.reconcile(reserved.id, session),
    ),
  ).toMatchObject({ status: "succeeded", file: { size: 5 } });
});

it("сохранённое окончательное намерение запрещает позднее подтверждение даже без контекста", async () => {
  const h = buildHarness();
  const reserved = await h.files.createPresignedUpload({
    operationId: "terminal-operation",
    filename: "a.txt",
    size: 5,
  });
  h.objectStore.uploadObject(reserved.key, Buffer.from("hello"), "text/plain");
  await h.operations.terminate("terminal-operation", "cancelled");
  expect(await h.confirmation.reconcile(reserved.id)).toEqual({
    status: "deleted",
  });
  await expect(h.confirmation.confirm(reserved.id)).rejects.toMatchObject({
    name: "FileNotFoundError",
  });
  expect(await h.rowOf(reserved.id)).toMatchObject({ kind: "reserved" });
});

it("отказ проверки хранилища при просрочке сохраняет живую составную загрузку", async () => {
  const h = buildHarness();
  const started = await h.multipart.createMultipartUpload({
    filename: "a.bin",
    size: 12 * 1024 * 1024,
  });
  h.advance(25);
  h.objectStore.failNext("head", new Error("Нет связи"));
  await expect(
    h.confirmation.reconcile(started.id, undefined, { expired: true }),
  ).rejects.toThrow("Нет связи");
  expect(await h.rowOf(started.id)).toMatchObject({
    kind: "multipart",
    uploadId: started.uploadId,
  });
});
