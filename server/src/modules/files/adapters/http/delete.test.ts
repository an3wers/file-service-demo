import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "express";
import { createApp } from "../../../../app.js";
import { createUploadMiddleware } from "../../../../middleware/upload.js";
import { buildHarness } from "../../testing/files-module.harness.js";
import { createFilesRouter } from "./routes.js";

let server: Server | undefined;
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
});

async function setup() {
  const harness = buildHarness();
  const app = createApp({
    healthRouter: Router(),
    authRouter: Router(),
    requireAuth: (_req, _res, next) => next(),
    filesRouter: createFilesRouter({
      uploads: harness.files,
      catalog: harness.files,
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
  const form = new FormData();
  form.append(
    "file",
    new Blob(["hello"], { type: "text/plain" }),
    "report.txt",
  );
  const response = await fetch(base, { method: "POST", body: form });
  expect(response.status).toBe(201);
  const file: { id: string; key: string } = await response.json();
  return { ...harness, base, file };
}

describe("публичный сценарий удаления файла", () => {
  it("удаляет готовый файл и допускает безопасный повтор удаления", async () => {
    const { base, file, objectStore } = await setup();
    expect(
      (await fetch(`${base}/${file.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect(await objectStore.head(file.key)).toBeNull();
    expect((await fetch(`${base}/${file.id}`)).status).toBe(404);
    expect(await (await fetch(base)).json()).toMatchObject({ items: [] });
    const repeated = await fetch(`${base}/${file.id}`, { method: "DELETE" });
    expect(repeated.status).toBe(204);
  });

  it("сохраняет задачу очистки при сбое хранилища и завершает удаление в фоне", async () => {
    const { base, file, objectStore, files } = await setup();
    let hiddenBeforeRemoval = false;
    vi.spyOn(objectStore, "remove").mockImplementation(async () => {
      const card = await fetch(`${base}/${file.id}`);
      const list = await (await fetch(base)).json();
      hiddenBeforeRemoval = card.status === 404 && list.items.length === 0;
      throw new Error("Хранилище недоступно");
    });
    expect(
      (await fetch(`${base}/${file.id}`, { method: "DELETE" })).status,
    ).toBe(500);
    expect(hiddenBeforeRemoval).toBe(true);
    expect(await objectStore.head(file.key)).not.toBeNull();
    const repeated = await fetch(`${base}/${file.id}`, { method: "DELETE" });
    expect(repeated.status).toBe(500);
    vi.mocked(objectStore.remove).mockRestore();
    await files.sweepTerminated();
    expect(await objectStore.head(file.key)).toBeNull();
    expect(await (await fetch(base)).json()).toMatchObject({ items: [] });
  });
  it("сохраняет файл при сбое API и разрешает повтор удаления", async () => {
    const { base, file, fileRows, objectStore } = await setup();
    fileRows.failNext("softDeleteFile", new Error("База недоступна"));
    expect(
      (await fetch(`${base}/${file.id}`, { method: "DELETE" })).status,
    ).toBe(500);
    expect((await fetch(`${base}/${file.id}`)).status).toBe(200);
    expect(await objectStore.head(file.key)).not.toBeNull();
    expect(
      (await fetch(`${base}/${file.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect((await fetch(`${base}/${file.id}`)).status).toBe(404);
  });
});
