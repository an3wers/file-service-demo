import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "express";
import { createApp } from "../../../../app.js";
import { createUploadMiddleware } from "../../../../middleware/upload.js";
import {
  buildHarness,
  THREE_PART_SIZE,
} from "../../testing/files-module.harness.js";
import { createFilesRouter } from "./routes.js";
import { uploadOperationResponseSchema } from "./responses.js";

let server: Server | undefined;
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
});

describe("HTTP-контракт операций загрузки", () => {
  it("выясняет потерянный ответ, повторяет подтверждённую неудачу и сохраняет удаление", async () => {
    const { files, objectStore } = buildHarness();
    const app = createApp({
      healthRouter: Router(),
      authRouter: Router(),
      requireAuth: (_req, _res, next) => next(),
      filesRouter: createFilesRouter({
        uploads: files,
        catalog: files,
        uploadSingleFile: createUploadMiddleware(1024),
      }),
      directoriesRouter: Router(),
      corsOrigin: [],
    });
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
    expect(await status()).toEqual({ status: "failed" });
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
      const { files, objectStore, fileRows } = buildHarness();
      const app = createApp({
        healthRouter: Router(),
        authRouter: Router(),
        requireAuth: (_req, _res, next) => next(),
        filesRouter: createFilesRouter({
          uploads: files,
          catalog: files,
          uploadSingleFile: createUploadMiddleware(1024),
        }),
        directoriesRouter: Router(),
        corsOrigin: [],
      });
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
        `${base}/upload-operations/${operationId}`,
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
