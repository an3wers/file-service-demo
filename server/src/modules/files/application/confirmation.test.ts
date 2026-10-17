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
  expect(await h.confirmation.reconcile(reserved.id)).toMatchObject({
    status: "succeeded",
    file: { kind: "ready" },
  });
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
    status: "pending",
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
  expect(mismatch).toEqual({ status: "failed", reason: "size_mismatch" });
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
  await expect(h.confirmation.reconcile(started.id)).rejects.toThrow(
    "Нет связи",
  );
  expect(await h.rowOf(started.id)).toMatchObject({
    kind: "multipart",
    uploadId: started.uploadId,
  });
});

it.each(["cancelled", "deleted"] as const)(
  "очищает готовый результат по намерению %s и удаляет поздний объект повторно",
  async (reason) => {
    const h = buildHarness();
    const file = await h.files.uploadThroughServer({
      operationId: "cleanup-ready",
      filename: "a.txt",
      size: 5,
      bytes: Buffer.from("hello"),
    });
    await h.operations.terminate("cleanup-ready", reason);
    const clean = () =>
      h.operations.exclusive("cleanup-ready", (session) =>
        h.confirmation.cleanup(session),
      );
    expect(await clean()).toEqual({ status: reason });
    expect(await h.rowOf(file.id)).toMatchObject({ kind: "failed" });
    expect(h.objectStore.objectKeys()).toEqual([]);
    h.advance(24 * 365 * 30);
    expect(await h.operations.listTerminated()).toContain("cleanup-ready");
    h.objectStore.uploadObject(file.key, Buffer.from("hello"), "text/plain");
    expect(await clean()).toEqual({ status: reason });
    expect(h.objectStore.objectKeys()).toEqual([]);
  },
);

it("сохраняет идентификатор составной загрузки при частичном сбое очистки", async () => {
  const h = buildHarness();
  const started = await h.files.createPresignedUpload({
    operationId: "cleanup-multipart",
    filename: "a.bin",
    size: 12 * 1024 * 1024,
  });
  if (started.strategy !== "multipart")
    throw new Error("Ожидалась составная загрузка");
  await h.operations.terminate("cleanup-multipart", "failed");
  h.objectStore.failNext("abortMultipart", new Error("Нет связи"));
  await expect(
    h.operations.exclusive("cleanup-multipart", (session) =>
      h.confirmation.cleanup(session),
    ),
  ).rejects.toThrow("Нет связи");
  expect(await h.rowOf(started.id)).toMatchObject({ kind: "failed" });
  expect(h.objectStore.openUploads()).toHaveLength(1);
  expect(
    await h.operations.exclusive("cleanup-multipart", (session) =>
      h.confirmation.cleanup(session),
    ),
  ).toEqual({ status: "discarded" });
  expect(h.objectStore.openUploads()).toEqual([]);
});

it("подтверждение исполняет отмену, сохранённую во время проверки объекта", async () => {
  const h = buildHarness();
  const started = await h.files.createPresignedUpload({
    operationId: "cancel-head",
    filename: "a.txt",
    size: 5,
  });
  h.objectStore.uploadObject(started.key, Buffer.from("hello"), "text/plain");
  const head = h.objectStore.head.bind(h.objectStore);
  h.objectStore.head = async (key) => {
    const result = await head(key);
    await h.operations.terminate("cancel-head", "cancelled");
    return result;
  };
  await expect(
    h.operations.exclusive("cancel-head", (session) =>
      h.confirmation.confirm(started.id, session),
    ),
  ).rejects.toMatchObject({ name: "FileNotFoundError" });
  expect(await h.rowOf(started.id)).toMatchObject({ kind: "failed" });
  expect(h.objectStore.objectKeys()).toEqual([]);
});

it("новая попытка получает полный срок, сохраняя дату создания файла", async () => {
  const h = buildHarness();
  const input = { operationId: "ttl-retry", filename: "a.txt", size: 5 };
  const first = await h.files.createPresignedUpload(input);
  const original = await h.rowOf(first.id);
  h.advance(25);
  await h.cleanup.settleExpiredRows();
  expect(await h.rowOf(first.id)).toMatchObject({ kind: "failed" });
  expect(await h.operations.listTerminated()).toEqual([]);
  await h.files.createPresignedUpload(input);
  const retried = await h.rowOf(first.id);
  expect(retried.createdAt).toEqual(original.createdAt);
  expect(
    retried.attemptStartedAt.getTime() - original.attemptStartedAt.getTime(),
  ).toBe(25 * 60 * 60 * 1000);
  expect(retried.attemptGeneration).not.toBe(original.attemptGeneration);
  h.advance(24);
  expect((await h.cleanup.settleExpiredRows()).examined).toBe(0);
  h.advance(1 / 3600000);
  expect((await h.cleanup.settleExpiredRows()).failed).toBe(1);
});

it("сверка проверяет срок текущей попытки после повторного резервирования", async () => {
  const h = buildHarness();
  const input = { operationId: "stale-ttl", filename: "a.txt", size: 5 };
  const first = await h.files.createPresignedUpload(input);
  h.advance(25);
  await h.cleanup.settleExpiredRows();
  await h.files.createPresignedUpload(input);
  await h.confirmation.reconcile(first.id);
  expect(await h.rowOf(first.id)).toMatchObject({ kind: "reserved" });
  h.advance(23);
  const before = await h.rowOf(first.id);
  await h.confirmation.reconcile(first.id);
  expect((await h.rowOf(first.id)).attemptStartedAt).toEqual(
    before.attemptStartedAt,
  );
  h.advance(2);
  await h.confirmation.reconcile(first.id);
  expect(await h.rowOf(first.id)).toMatchObject({ kind: "failed" });
});

it("решение старой попытки не закрывает мгновенный повтор с теми же данными и временем", async () => {
  const h = buildHarness();
  const input = { operationId: "same-clock-retry", filename: "a.txt", size: 5 };
  const first = await h.files.createPresignedUpload(input);
  const before = await h.rowOf(first.id);
  h.objectStore.uploadObject(first.key, Buffer.from("bad"), "text/plain");
  h.fileRows.beforeNextClaim(async () => {
    await h.objectStore.remove(first.key);
    await h.fileRows.markFileFailed(first.id);
    await h.files.createPresignedUpload(input);
  });
  await h.confirmation.reconcile(first.id);
  const after = await h.rowOf(first.id);
  expect(after).toMatchObject({
    kind: "reserved",
    updatedAt: before.updatedAt,
    attemptStartedAt: before.attemptStartedAt,
  });
  expect(after.attemptGeneration).not.toBe(before.attemptGeneration);
});

it("продолжение составной загрузки сохраняет срок, план и части, а просрочка отменяет без сборки", async () => {
  const h = buildHarness();
  const input = {
    operationId: "multipart-ttl",
    filename: "a.bin",
    size: 12 * 1024 * 1024,
  };
  const first = await h.files.createPresignedUpload(input);
  if (first.strategy !== "multipart")
    throw new Error("Ожидалась составная загрузка");
  const original = await h.rowOf(first.id);
  for (const [index, size] of [5, 5, 2].entries())
    h.objectStore.uploadPart(
      first.uploadId,
      index + 1,
      Buffer.alloc(size * 1024 * 1024),
    );
  h.advance(23);
  h.policy.planLimits.partSize = 6 * 1024 * 1024;
  await h.files.getUploadOperation(input.operationId);
  const resumed = await h.files.createPresignedUpload(input);
  expect(resumed).toMatchObject({
    uploadId: first.uploadId,
    partSize: first.partSize,
    partCount: first.partCount,
  });
  expect(await h.files.getMultipartStatus(first.id)).toMatchObject({
    uploadedParts: [1, 2, 3],
    uploadedBytes: input.size,
  });
  expect(await h.rowOf(first.id)).toEqual(original);
  expect(h.objectStore.objectKeys()).toEqual([]);
  h.advance(1);
  expect((await h.cleanup.settleExpiredRows()).examined).toBe(0);
  expect(h.objectStore.openUploads()).toHaveLength(1);
  h.advance(1 / 3600000);
  expect(await h.cleanup.settleExpiredRows()).toMatchObject({
    failed: 1,
    aborted: 1,
  });
  expect(h.objectStore.openUploads()).toEqual([]);
  expect(h.objectStore.objectKeys()).toEqual([]);
  expect(await h.operations.listTerminated()).toEqual([]);
  h.objectStore.uploadObject(
    first.key,
    Buffer.alloc(input.size),
    "application/custom",
  );
  expect(await h.files.resolveUploadOperation(input.operationId)).toMatchObject(
    {
      status: "succeeded",
      file: {
        id: first.id,
        size: input.size,
        contentType: "application/custom",
      },
    },
  );
});

it("уборка пропускает занятую операцию без ожидания и завершает её после освобождения", async () => {
  const h = buildHarness();
  const input = { operationId: "locked-expiry", filename: "a.txt", size: 5 };
  const first = await h.files.createPresignedUpload(input);
  h.advance(25);
  await h.operations.exclusive(input.operationId, async () => {
    expect(await h.cleanup.settleExpiredRows()).toMatchObject({
      examined: 1,
      skipped: 1,
      failed: 0,
    });
    expect(await h.rowOf(first.id)).toMatchObject({ kind: "reserved" });
  });
  expect((await h.cleanup.settleExpiredRows()).failed).toBe(1);
});

it("уборка перечитывает попытку, сменившуюся после выбора просроченных резервирований", async () => {
  const h = buildHarness();
  const input = { operationId: "selected-expiry", filename: "a.txt", size: 5 };
  const first = await h.files.createPresignedUpload(input);
  h.advance(25);
  const list = h.fileRows.listExpiredPending.bind(h.fileRows);
  let selected!: () => void;
  let proceed!: () => void;
  const selection = new Promise<void>((resolve) => {
    selected = resolve;
  });
  const continuation = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  h.fileRows.listExpiredPending = async (ttl) => {
    const files = await list(ttl);
    selected();
    await continuation;
    return files;
  };
  const cleanup = h.cleanup.settleExpiredRows();
  await selection;
  await h.files.createPresignedUpload(input);
  const retry = await h.rowOf(first.id);
  proceed();
  await cleanup;
  expect(await h.rowOf(first.id)).toEqual(retry);
  expect(retry.kind).toBe("reserved");
});

it("подготовка повтора освобождает остановленную составную загрузку для серверной передачи", async () => {
  const h = buildHarness();
  const operationId = "server-retry";
  const started = await h.files.createPresignedUpload({
    operationId,
    filename: "a.bin",
    size: 12 * 1024 * 1024,
  });
  if (started.strategy !== "multipart")
    throw new Error("Ожидалась составная загрузка");
  h.objectStore.uploadPart(started.uploadId, 1, Buffer.alloc(5 * 1024 * 1024));
  await h.files.resolveUploadOperation(operationId, started.uploadId);
  expect(
    await h.operations.exclusive(operationId, (session) =>
      h.confirmation.prepareRetry(started.id, session),
    ),
  ).toEqual({ status: "failed" });
  expect(h.objectStore.openUploads()).toEqual([]);
  expect(await h.confirmation.reconcile(started.id)).toEqual({
    status: "failed",
  });
});

it("решение о просрочке не отменяет составную загрузку до конкурентного подтверждения", async () => {
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
  h.advance(25);
  h.fileRows.beforeNextClaim(async () => {
    await h.confirmation.confirm(started.id);
  });
  expect(await h.confirmation.reconcile(started.id)).toMatchObject({
    status: "succeeded",
    file: { kind: "ready", size: 12 * 1024 * 1024 },
  });
});

it("сбой отмены после установленной просрочки оставляет части уборке сирот и допускает позднее подтверждение", async () => {
  const h = buildHarness();
  const started = await h.multipart.createMultipartUpload({
    filename: "a.bin",
    size: 12 * 1024 * 1024,
  });
  h.advance(25);
  h.objectStore.failNext("abortMultipart", new Error("Нет хранилища"));
  await expect(h.confirmation.reconcile(started.id)).rejects.toThrow(
    "Нет хранилища",
  );
  expect(await h.confirmation.reconcile(started.id)).toEqual({
    status: "failed",
  });
  expect(h.objectStore.openUploads()).toHaveLength(1);
  expect(await h.cleanup.sweepOrphanUploads()).toEqual({
    examined: 1,
    aborted: 1,
  });
  expect(h.objectStore.openUploads()).toEqual([]);
  h.objectStore.uploadObject(
    started.key,
    Buffer.alloc(12 * 1024 * 1024),
    "application/octet-stream",
  );
  expect(await h.confirmation.reconcile(started.id)).toMatchObject({
    status: "succeeded",
    file: { kind: "ready" },
  });
});
