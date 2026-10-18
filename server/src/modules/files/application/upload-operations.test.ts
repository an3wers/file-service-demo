import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildHarness,
  PENDING_TTL_HOURS,
  THREE_PART_SIZE,
} from "../testing/files-module.harness.js";
import {
  MultipartNotFoundError,
  UploadOperationProcessingError,
} from "../domain/errors.js";

const HOUR_MS = 60 * 60 * 1000;

function expiresIn(url: string) {
  return Number(new URL(url).searchParams.get("expiresIn"));
}

function multipartInput() {
  return {
    operationId: randomUUID(),
    filename: "big.bin",
    size: THREE_PART_SIZE,
  };
}

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

  it("оставляет отвергнутый PUT неизвестным и восстанавливает поздний объект без передачи", async () => {
    const { files, objectStore, operations, rowCount } = buildHarness();
    const upload = input();
    objectStore.failNext("put", new Error("Нет соединения"));
    await expect(files.uploadThroughServer(upload)).rejects.toThrow(
      "Нет соединения",
    );
    expect(await files.getUploadOperation(upload.operationId)).toEqual({
      status: "pending",
    });
    expect(await files.resolveUploadOperation(upload.operationId)).toEqual({
      status: "pending",
    });
    await expect(files.uploadThroughServer(upload)).rejects.toMatchObject({
      name: "UploadOperationProcessingError",
    });
    const { record } = await operations.read(upload.operationId);
    objectStore.uploadObject(
      record!.reservation.key,
      upload.bytes,
      "text/plain",
    );
    objectStore.failNext("put", new Error("Повторная передача запрещена"));
    expect(
      await files.resolveUploadOperation(upload.operationId),
    ).toMatchObject({ status: "succeeded" });
    expect((await files.uploadThroughServer(upload)).kind).toBe("ready");
    expect(await rowCount()).toBe(1);
  });

  it("сохраняет идентичность при сбое создания строки и не воссоздаёт удалённый результат", async () => {
    const { files, fileRows, objectStore } = buildHarness();
    const upload = input();
    fileRows.failNext("insertFile", new Error("Нет базы"));
    await expect(files.uploadThroughServer(upload)).rejects.toThrow();
    expect(await files.resolveUploadOperation(upload.operationId)).toEqual({
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
      await objectStore.put(first.key, Buffer.alloc(size), {
        contentType: "text/plain",
        contentLength: size,
      });
      const outcome = await files.resolveUploadOperation(upload.operationId);
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

describe("окончательная отмена и очистка", () => {
  it("удаляет уже готовый файл при отмене и не разрешает воскресить операцию", async () => {
    const { files, objectStore, rowOf } = buildHarness();
    const upload = input();
    const file = await files.uploadThroughServer(upload);
    expect(await files.cancelUploadOperation(upload.operationId)).toEqual({
      status: "cancelled",
    });
    expect(await objectStore.head(file.key)).toBeNull();
    expect(await rowOf(file.id)).toMatchObject({ kind: "failed" });
    await expect(files.uploadThroughServer(upload)).rejects.toMatchObject({
      name: "FileNotFoundError",
    });
    expect(await files.getUploadOperation(upload.operationId)).toEqual({
      status: "cancelled",
    });
  });

  it("после отмены до резервирования отклоняет запоздавший запрос загрузки", async () => {
    const { files, objectStore } = buildHarness();
    const upload = input();
    expect(await files.cancelUploadOperation(upload.operationId)).toEqual({
      status: "cancelled",
    });
    await expect(files.uploadThroughServer(upload)).rejects.toMatchObject({
      name: "FileNotFoundError",
    });
    expect(objectStore.objectKeys()).toEqual([]);
  });

  it("сохраняет отмену при ошибке удаления и завершает очистку без клиента", async () => {
    const { files, objectStore } = buildHarness();
    const upload = input();
    const file = await files.uploadThroughServer(upload);
    objectStore.failNext("remove", new Error("Хранилище недоступно"));
    await expect(
      files.cancelUploadOperation(upload.operationId),
    ).rejects.toThrow();
    expect(await objectStore.head(file.key)).not.toBeNull();
    await files.sweepTerminated();
    expect(await objectStore.head(file.key)).toBeNull();
    expect(await files.getUploadOperation(upload.operationId)).toEqual({
      status: "cancelled",
    });
  });

  it("не принимает объект неправильного размера как успешный результат", async () => {
    const { files, objectStore, rowOf } = buildHarness();
    const upload = input();
    const reserved = await files.createPresignedUpload(upload);
    await objectStore.put(reserved.key, Buffer.from("bad"), {
      contentLength: 3,
      contentType: "text/plain",
    });
    expect(await files.resolveUploadOperation(upload.operationId)).toEqual({
      status: "failed",
      reason: "size_mismatch",
    });
    await expect(files.completeUpload(reserved.id)).rejects.toMatchObject({
      name: "UploadNotCompletedError",
    });
    expect(await files.failUploadOperation(upload.operationId)).toEqual({
      status: "discarded",
    });
    expect(await rowOf(reserved.id)).toMatchObject({ kind: "failed" });
    expect(await objectStore.head(reserved.key)).toBeNull();
  });

  it("при окончательной неудаче сохраняет обнаруженный успешный результат", async () => {
    const { files, objectStore } = buildHarness();
    const upload = input();
    const reserved = await files.createPresignedUpload(upload);
    await objectStore.put(reserved.key, upload.bytes, {
      contentLength: upload.size,
      contentType: "text/plain",
    });
    expect(await files.failUploadOperation(upload.operationId)).toMatchObject({
      status: "succeeded",
      file: { id: reserved.id },
    });
    expect(await objectStore.head(reserved.key)).not.toBeNull();
  });

  it("после исчерпания попыток удаляет части и закрывает старую операцию", async () => {
    const { files, objectStore, rowOf, advance } = buildHarness();
    const upload = { ...input(), size: THREE_PART_SIZE };
    const reserved = await files.createPresignedUpload(upload);
    if (reserved.strategy !== "multipart")
      throw new Error("Ожидалась составная загрузка");
    objectStore.uploadPart(
      reserved.uploadId,
      1,
      Buffer.alloc(reserved.partSize),
    );
    advance(25);
    expect(await files.failUploadOperation(upload.operationId)).toEqual({
      status: "discarded",
    });
    expect(objectStore.openUploads()).toEqual([]);
    expect(await rowOf(reserved.id)).toMatchObject({ kind: "failed" });
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
    ).not.toBe(reserved.id);
  });
});

it("сохраняет отмену во время серверной передачи и удаляет её поздний результат", async () => {
  const { files, objectStore } = buildHarness();
  const upload = input();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = objectStore.put.bind(objectStore);
  vi.spyOn(objectStore, "put").mockImplementation(async (...args) => {
    entered();
    await gate;
    return await original(...args);
  });
  const running = files.uploadThroughServer(upload);
  const rejected = expect(running).rejects.toMatchObject({
    name: "FileNotFoundError",
  });
  await started;
  expect(await files.cancelUploadOperation(upload.operationId)).toEqual({
    status: "processing",
  });
  release();
  await rejected;
  await files.sweepTerminated();
  expect(objectStore.objectKeys()).toEqual([]);
  expect(await files.getUploadOperation(upload.operationId)).toEqual({
    status: "cancelled",
  });
});

it("читает сохранённое ожидание без хранилища и блокировки и явно выясняет исход", async () => {
  const { files, operations, objectStore } = buildHarness();
  const upload = input();
  const reserved = await files.createPresignedUpload(upload);
  const head = vi.spyOn(objectStore, "head");
  await operations.exclusive(upload.operationId, async () => {
    expect(await files.getUploadOperation(upload.operationId)).toEqual({
      status: "pending",
    });
    expect(await files.resolveUploadOperation(upload.operationId)).toEqual({
      status: "processing",
    });
  });
  expect(head).not.toHaveBeenCalled();
  expect(await files.resolveUploadOperation(upload.operationId)).toEqual({
    status: "pending",
  });
  await objectStore.put(reserved.key, upload.bytes, {
    contentLength: 5,
    contentType: "text/plain",
  });
  expect(await files.getUploadOperation(upload.operationId)).toEqual({
    status: "pending",
  });
  expect(await files.resolveUploadOperation(upload.operationId)).toMatchObject({
    status: "succeeded",
    file: { id: reserved.id },
  });
});

it("повтор подписанной ссылки не продлевает попытку и ожидание запрещает серверную передачу", async () => {
  const h = buildHarness();
  const upload = input();
  const first = await h.files.createPresignedUpload(upload);
  const before = await h.rowOf(first.id);
  h.advance(23);
  await h.files.createPresignedUpload(upload);
  expect(await h.rowOf(first.id)).toEqual(before);
  await expect(h.files.uploadThroughServer(upload)).rejects.toMatchObject({
    name: "UploadOperationProcessingError",
  });
  expect(h.objectStore.objectKeys()).toEqual([]);
  h.advance(2);
  expect(await h.files.resolveUploadOperation(upload.operationId)).toEqual({
    status: "failed",
  });
  expect((await h.files.uploadThroughServer(upload)).kind).toBe("ready");
});

it("устанавливает остановку только текущей составной передачи и сохраняет части и срок при повторе", async () => {
  const h = buildHarness();
  const upload = { ...input(), size: THREE_PART_SIZE };
  const first = await h.files.createPresignedUpload(upload);
  if (first.strategy !== "multipart")
    throw new Error("Ожидалась составная загрузка");
  h.objectStore.uploadPart(first.uploadId, 1, Buffer.alloc(first.partSize));
  const before = await h.rowOf(first.id);
  h.advance(2);
  expect(await h.files.resolveUploadOperation(upload.operationId)).toEqual({
    status: "pending",
  });
  expect(
    await h.files.resolveUploadOperation(
      upload.operationId,
      "старый идентификатор",
    ),
  ).toEqual({ status: "pending" });
  expect(
    await h.files.resolveUploadOperation(upload.operationId, first.uploadId),
  ).toEqual({ status: "failed" });
  expect(await h.files.getUploadOperation(upload.operationId)).toEqual({
    status: "failed",
  });
  expect(await h.files.resolveUploadOperation(upload.operationId)).toEqual({
    status: "failed",
  });
  expect(await h.rowOf(first.id)).toEqual(before);
  const repeated = await h.files.createPresignedUpload(upload);
  expect(repeated).toMatchObject({
    id: first.id,
    uploadId: first.uploadId,
    partSize: first.partSize,
  });
  expect(await h.files.getUploadOperation(upload.operationId)).toEqual({
    status: "pending",
  });
  expect(await h.rowOf(first.id)).toEqual(before);
  expect(await h.files.getMultipartStatus(first.id)).toMatchObject({
    uploadedParts: [1],
  });
  for (const part of [2, 3])
    h.objectStore.uploadPart(
      first.uploadId,
      part,
      Buffer.alloc(
        part === 2 ? first.partSize : THREE_PART_SIZE - 2 * first.partSize,
      ),
    );
  expect(await h.files.resolveUploadOperation(upload.operationId)).toEqual({
    status: "pending",
  });
  expect((await h.files.completeUpload(first.id)).kind).toBe("ready");
});

it("ошибка проверки остановленной передачи сохраняет ожидание, а отмена побеждает сообщение", async () => {
  const h = buildHarness();
  const upload = { ...input(), size: THREE_PART_SIZE };
  const first = await h.files.createPresignedUpload(upload);
  if (first.strategy !== "multipart")
    throw new Error("Ожидалась составная загрузка");
  const before = await h.rowOf(first.id);
  for (const method of ["head", "listParts"] as const) {
    h.objectStore.failNext(method, new Error("Нет хранилища"));
    await expect(
      h.files.resolveUploadOperation(upload.operationId, first.uploadId),
    ).rejects.toThrow("Нет хранилища");
    expect(await h.files.getUploadOperation(upload.operationId)).toEqual({
      status: "pending",
    });
    expect(await h.rowOf(first.id)).toEqual(before);
  }
  const list = h.objectStore.listParts.bind(h.objectStore);
  vi.spyOn(h.objectStore, "listParts").mockImplementationOnce(
    async (...args) => {
      await h.operations.terminate(upload.operationId, "cancelled");
      return await list(...args);
    },
  );
  expect(
    await h.files.resolveUploadOperation(upload.operationId, first.uploadId),
  ).toEqual({ status: "cancelled" });
  expect(await h.files.getUploadOperation(upload.operationId)).toEqual({
    status: "cancelled",
  });
  expect(h.objectStore.openUploads()).toEqual([]);
});

describe("срок попытки против уборки", () => {
  it("ссылки возобновлённой составной загрузки не переживают срок попытки", async () => {
    const h = buildHarness({ partUrlBatch: 1 });
    const upload = multipartInput();
    const first = await h.startMultipart(upload);
    h.objectStore.uploadPart(first.uploadId, 1, Buffer.alloc(first.partSize));
    const deadline = new Date(
      (await h.rowOf(first.id)).attemptStartedAt.getTime() +
        PENDING_TTL_HOURS * HOUR_MS,
    );
    h.advance(PENDING_TTL_HOURS - 0.125);
    const resumed = await h.files.createPresignedUpload(upload);
    expect(resumed).toMatchObject({
      strategy: "multipart",
      uploadId: first.uploadId,
      expiresAt: deadline,
    });
    if (resumed.strategy !== "multipart")
      throw new Error("Ожидалась составная загрузка");
    expect(resumed.parts.map((part) => expiresIn(part.url))).toEqual([450]);
    const batch = await h.files.getPartUrls(first.id, { partNumbers: [2] });
    expect(batch.expiresAt).toEqual(deadline);
    expect(batch.parts.map((part) => expiresIn(part.url))).toEqual([450]);
    h.advance(0.25);
    expect(await h.cleanup.settleExpiredRows()).toMatchObject({
      failed: 1,
      aborted: 1,
    });
    await expect(
      h.files.getPartUrls(first.id, { partNumbers: [3] }),
    ).rejects.toBeInstanceOf(MultipartNotFoundError);
  });

  it("пачка ссылок после срока попытки не выдаётся: операция сначала сверяется", async () => {
    const h = buildHarness({ partUrlBatch: 1 });
    const upload = multipartInput();
    const first = await h.startMultipart(upload);
    const signPart = vi.spyOn(h.objectStore, "signPart");
    h.advance(PENDING_TTL_HOURS + 1);
    await expect(
      h.files.getPartUrls(first.id, { partNumbers: [2] }),
    ).rejects.toBeInstanceOf(MultipartNotFoundError);
    expect(signPart).not.toHaveBeenCalled();
    expect(h.objectStore.openUploads()).toEqual([]);
    expect(await h.rowOf(first.id)).toMatchObject({ kind: "failed" });
  });

  it("возобновление после срока начинает новую составную загрузку с полным окном, и уборка её не отменяет", async () => {
    const h = buildHarness();
    const upload = multipartInput();
    const first = await h.startMultipart(upload);
    h.objectStore.uploadPart(first.uploadId, 1, Buffer.alloc(first.partSize));
    h.advance(PENDING_TTL_HOURS + 1);
    const resumed = await h.files.createPresignedUpload(upload);
    if (resumed.strategy !== "multipart")
      throw new Error("Ожидалась составная загрузка");
    expect(resumed.id).toBe(first.id);
    expect(resumed.uploadId).not.toBe(first.uploadId);
    expect(h.objectStore.openUploads().map((open) => open.uploadId)).toEqual([
      resumed.uploadId,
    ]);
    expect(resumed.parts.map((part) => expiresIn(part.url))).toEqual([
      900, 900,
    ]);
    expect(await h.cleanup.settleExpiredRows()).toMatchObject({
      examined: 0,
    });
    for (let part = 1; part <= resumed.partCount; part++)
      h.objectStore.uploadPart(
        resumed.uploadId,
        part,
        Buffer.alloc(
          Math.min(
            resumed.partSize,
            THREE_PART_SIZE - (part - 1) * resumed.partSize,
          ),
        ),
      );
    expect(await h.files.completeUpload(first.id)).toMatchObject({
      kind: "ready",
      size: THREE_PART_SIZE,
    });
  });

  it("подтверждение ждёт занятую операцию ограниченно и сообщает, что она ещё обрабатывается", async () => {
    const h = buildHarness({}, { lockWaitMs: 20 });
    const upload = { operationId: randomUUID(), filename: "a.txt", size: 5 };
    const reserved = await h.files.createPresignedUpload(upload);
    h.objectStore.uploadObject(reserved.key, Buffer.from("hello"));
    let release!: () => void;
    const held = h.operations.exclusive(
      upload.operationId,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await expect(h.files.completeUpload(reserved.id)).rejects.toBeInstanceOf(
      UploadOperationProcessingError,
    );
    const waiting = h.files.completeUpload(reserved.id);
    release();
    await held;
    await expect(waiting).resolves.toMatchObject({ kind: "ready" });
  });
});
