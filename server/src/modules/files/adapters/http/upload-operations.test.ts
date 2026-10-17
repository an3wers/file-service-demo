import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ERROR_CODES, serviceUnavailable } from "../../../../errors.js";
import { buildHttpHarness } from "../../testing/http.harness.js";
import { THREE_PART_SIZE } from "../../testing/files-module.harness.js";
import { uploadOperationResponseSchema } from "./responses.js";

let server: Server | undefined;
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
});

describe("HTTP-контракт операций загрузки", () => {
  it("выясняет потерянный ответ, повторяет подтверждённую неудачу и сохраняет удаление", async () => {
    const { objectStore, advance, app } = buildHttpHarness();
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", (error) =>
        error ? reject(error) : resolve(),
      );
      server.once("error", reject);
    });
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/files`;
    const id = randomUUID();
    async function upload(operationId = id, filename = "report.txt") {
      const form = new FormData();
      form.append("operationId", operationId);
      form.append(
        "file",
        new Blob(["hello"], { type: "text/plain" }),
        filename,
      );
      return await fetch(base, { method: "POST", body: form });
    }
    const status = async () => {
      const response = await fetch(`${base}/upload-operations/${id}`);
      expect(response.status).toBe(200);
      return uploadOperationResponseSchema.parse(await response.json());
    };
    expect(await status()).toEqual({ status: "absent" });
    objectStore.failNext("put", new Error("Хранилище недоступно"));
    expect((await upload()).status).toBe(500);
    expect(await status()).toEqual({ status: "pending" });
    advance(25);
    expect(
      await (
        await fetch(`${base}/upload-operations/${id}/resolve`, {
          method: "POST",
        })
      ).json(),
    ).toEqual({ status: "failed" });
    const success = await upload();
    expect(success.status).toBe(201);
    const file = await success.json();
    expect(await status()).toEqual({ status: "succeeded", file });
    expect(await (await upload()).json()).toEqual(file);
    expect((await upload(id, "other.txt")).status).toBe(409);
    const another = await (await upload(randomUUID())).json();
    expect(another.id).not.toBe(file.id);
    expect(
      (await fetch(`${base}/${file.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect(await status()).toEqual({ status: "deleted" });
    expect((await upload()).status).toBe(404);
    expect((await fetch(`${base}/upload-operations/invalid`)).status).toBe(422);
    const cancelledId = randomUUID();
    expect((await upload(cancelledId)).status).toBe(201);
    const cancelled = await fetch(
      `${base}/upload-operations/${cancelledId}/cancel`,
      { method: "POST" },
    );
    expect(cancelled.status).toBe(200);
    expect(uploadOperationResponseSchema.parse(await cancelled.json())).toEqual(
      { status: "cancelled" },
    );
    expect((await upload(cancelledId)).status).toBe(404);
    const failedId = randomUUID();
    const failed = await fetch(`${base}/upload-operations/${failedId}/fail`, {
      method: "POST",
    });
    expect(failed.status).toBe(200);
    expect(uploadOperationResponseSchema.parse(await failed.json())).toEqual({
      status: "discarded",
    });
    expect((await upload(failedId)).status).toBe(404);
  });
});

describe.each([5, THREE_PART_SIZE])(
  "HTTP-повтор прямой загрузки размером %i",
  (size) => {
    it("сохраняет резервирование, повторяет подтверждение и не воссоздаёт удалённый результат", async () => {
      const { objectStore, fileRows, app } = buildHttpHarness();
      await new Promise<void>((resolve, reject) => {
        server = app.listen(0, "127.0.0.1", (error) =>
          error ? reject(error) : resolve(),
        );
        server.once("error", reject);
      });
      const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/files`;
      const operationId = randomUUID();
      const body = { operationId, filename: "report.txt", size };
      const reserve = (value = body) =>
        fetch(`${base}/presign-upload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        });
      const firstResponse = await reserve();
      expect(firstResponse.status).toBe(201);
      const first = await firstResponse.json();
      expect(await (await reserve()).json()).toEqual(first);
      expect((await reserve({ ...body, filename: "other.txt" })).status).toBe(
        409,
      );
      if (first.strategy === "multipart") {
        for (let number = 1; number <= first.partCount; number++)
          objectStore.uploadPart(
            first.uploadId,
            number,
            Buffer.alloc(
              Math.min(first.partSize, size - (number - 1) * first.partSize),
            ),
          );
      } else
        await objectStore.put(first.key, Buffer.from("hello"), {
          contentType: "text/plain",
          contentLength: 5,
        });
      fileRows.failNext("markFileReady", new Error("Подтверждение потеряно"));
      expect(
        (await fetch(`${base}/${first.id}/complete`, { method: "POST" }))
          .status,
      ).toBe(500);
      const statusResponse = await fetch(
        `${base}/upload-operations/${operationId}/resolve`,
        { method: "POST" },
      );
      const status = uploadOperationResponseSchema.parse(
        await statusResponse.json(),
      );
      expect(status).toMatchObject({
        status: "succeeded",
        file: { id: first.id },
      });
      const confirmed = await fetch(`${base}/${first.id}/complete`, {
        method: "POST",
      });
      expect(confirmed.status).toBe(200);
      const file = await confirmed.json();
      expect(await (await reserve()).json()).toMatchObject({
        strategy: "ready",
        file,
      });
      expect(
        (await fetch(`${base}/${first.id}`, { method: "DELETE" })).status,
      ).toBe(204);
      expect((await reserve()).status).toBe(404);
      expect(
        await (await fetch(`${base}/upload-operations/${operationId}`)).json(),
      ).toEqual({ status: "deleted" });
      expect(
        (await (await reserve({ ...body, operationId: randomUUID() })).json())
          .id,
      ).not.toBe(first.id);
    });
  },
);

it("HTTP чтение не блокирует и не сверяет, а команда различает ожидание, занятость, размер и недоступность", async () => {
  const h = buildHttpHarness();
  const app = h.app;
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", (error) =>
      error ? reject(error) : resolve(),
    );
    server.once("error", reject);
  });
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/files/upload-operations`;
  const operationId = randomUUID();
  const reserved = await h.files.createPresignedUpload({
    operationId,
    filename: "a.txt",
    size: 5,
  });
  const path = `${base}/${operationId}`;
  const resolve = () => fetch(`${path}/resolve`, { method: "POST" });
  const head = vi.spyOn(h.objectStore, "head");
  const lock = vi.spyOn(h.operations, "exclusive");
  expect(await (await fetch(path)).json()).toEqual({ status: "pending" });
  expect(head).not.toHaveBeenCalled();
  expect(lock).not.toHaveBeenCalled();
  await h.operations.exclusive(operationId, async () => {
    expect(await (await fetch(path)).json()).toEqual({ status: "pending" });
    expect(await (await resolve()).json()).toEqual({ status: "processing" });
  });
  expect(await (await resolve()).json()).toEqual({ status: "pending" });
  h.objectStore.failNext(
    "head",
    serviceUnavailable(ERROR_CODES.STORAGE_UNAVAILABLE, "Нет хранилища"),
  );
  expect((await resolve()).status).toBe(503);
  expect(await (await fetch(path)).json()).toEqual({ status: "pending" });
  h.objectStore.uploadObject(reserved.key, Buffer.from("bad"), "text/plain");
  expect(await (await resolve()).json()).toEqual({
    status: "failed",
    reason: "size_mismatch",
  });
  h.objectStore.failNext(
    "head",
    serviceUnavailable(ERROR_CODES.STORAGE_UNAVAILABLE, "Нет хранилища"),
  );
  expect((await resolve()).status).toBe(503);
  expect(await (await fetch(path)).json()).toEqual({ status: "failed" });
  h.objectStore.uploadObject(reserved.key, Buffer.from("hello"), "text/plain");
  expect(await (await resolve()).json()).toMatchObject({
    status: "succeeded",
    file: { id: reserved.id },
  });
  h.objectStore.failNext(
    "remove",
    serviceUnavailable(ERROR_CODES.STORAGE_UNAVAILABLE, "Нет хранилища"),
  );
  expect((await fetch(`${path}/cancel`, { method: "POST" })).status).toBe(503);
  const remove = vi.spyOn(h.objectStore, "remove");
  expect(await (await fetch(path)).json()).toEqual({ status: "cancelled" });
  expect(remove).not.toHaveBeenCalled();
  expect(await (await resolve()).json()).toEqual({ status: "cancelled" });
  expect(await h.objectStore.head(reserved.key)).toBeNull();
});

it("HTTP принимает сообщение об остановке только текущей составной загрузки", async () => {
  const h = buildHttpHarness();
  const app = h.app;
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/files`;
  const operationId = randomUUID();
  const upload = { operationId, filename: "big.bin", size: THREE_PART_SIZE };
  const first = await h.files.createPresignedUpload(upload);
  if (first.strategy !== "multipart")
    throw new Error("Ожидалась составная загрузка");
  const resolve = (stoppedUploadId?: string) =>
    fetch(`${base}/upload-operations/${operationId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stoppedUploadId }),
    });
  expect(await (await resolve("другая загрузка")).json()).toEqual({
    status: "pending",
  });
  await h.operations.exclusive(operationId, async () => {
    expect(await (await resolve(first.uploadId)).json()).toEqual({
      status: "processing",
    });
  });
  expect(await (await resolve(first.uploadId)).json()).toEqual({
    status: "failed",
  });
  expect(
    await (await fetch(`${base}/upload-operations/${operationId}`)).json(),
  ).toEqual({ status: "failed" });
  expect(await h.files.createPresignedUpload(upload)).toMatchObject({
    uploadId: first.uploadId,
  });
  expect(await (await resolve()).json()).toEqual({ status: "pending" });
  const singleId = randomUUID();
  await h.files.createPresignedUpload({
    operationId: singleId,
    filename: "a.txt",
    size: 5,
  });
  expect(
    await (
      await fetch(`${base}/upload-operations/${singleId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stoppedUploadId: first.uploadId }),
      })
    ).json(),
  ).toEqual({ status: "pending" });
});
