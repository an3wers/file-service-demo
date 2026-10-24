import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildHttpHarness } from "../../testing/http.harness.js";
import { fileDtoSchema } from "./responses.js";

let server: Server | undefined;
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
});

async function setup() {
  const harness = buildHttpHarness();
  await new Promise<void>((resolve, reject) => {
    server = harness.app.listen(0, "127.0.0.1", (error) =>
      error ? reject(error) : resolve(),
    );
    server.once("error", reject);
  });
  const api = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api`;
  const base = `${api}/files`;
  const patch = (id: string, body: unknown) =>
    fetch(`${base}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const mkdir = (name: string, parent?: string) =>
    fetch(`${api}/directories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parent }),
    });
  const form = new FormData();
  form.append(
    "file",
    new Blob(["hello"], { type: "text/plain" }),
    "report.txt",
  );
  const response = await fetch(base, { method: "POST", body: form });
  expect(response.status).toBe(201);
  const file = fileDtoSchema.parse(await response.json());
  return { ...harness, api, base, file, patch, mkdir };
}

describe("переименование и перемещение личного файла", () => {
  it("меняет имя и каталог, сохраняя идентификатор, ключ и содержимое", async () => {
    const { api, base, file, patch, mkdir, objectStore } = await setup();
    expect((await mkdir("docs")).status).toBe(201);

    const renamed = await patch(file.id, { name: "Итоги.md" });
    expect(renamed.status).toBe(200);
    expect(fileDtoSchema.parse(await renamed.json())).toMatchObject({
      id: file.id,
      key: file.key,
      name: "Итоги.md",
      extension: "md",
      directory: "",
    });

    const moved = await patch(file.id, { directory: "docs" });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({
      id: file.id,
      key: file.key,
      name: "Итоги.md",
      directory: "docs",
    });

    expect((await (await fetch(`${base}?directory=`)).json()).items).toEqual(
      [],
    );
    expect(
      (await (await fetch(`${base}?directory=docs`)).json()).items,
    ).toMatchObject([{ id: file.id, name: "Итоги.md" }]);
    expect(
      (await (await fetch(`${base}?recursive=true&search=итоги`)).json()).items,
    ).toMatchObject([{ id: file.id }]);
    expect(
      (await (await fetch(`${base}?recursive=true&search=report`)).json())
        .items,
    ).toEqual([]);
    expect((await (await fetch(`${api}/directories`)).json()).items).toEqual([
      { name: "docs", path: "docs", fileCount: 1 },
    ]);

    const download = await (
      await fetch(`${base}/${file.id}/download-url`)
    ).json();
    expect(download.name).toBe("Итоги.md");
    expect(objectStore.objectAt(file.key)!.body.toString()).toBe("hello");

    const back = await patch(file.id, { directory: "", name: "report.txt" });
    expect(await back.json()).toMatchObject({
      directory: "",
      name: "report.txt",
      key: file.key,
    });
    expect((await (await fetch(`${api}/directories`)).json()).items).toEqual([
      { name: "docs", path: "docs", fileCount: 0 },
    ]);
  });

  it("отклоняет недопустимые имя, каталог и пустой запрос, не меняя файл", async () => {
    const { base, file, patch } = await setup();
    const cases: Array<[unknown, number, string]> = [
      [{ name: "a/b.txt" }, 400, "INVALID_FILE_NAME"],
      [{ name: "  " }, 400, "INVALID_FILE_NAME"],
      [{ name: ".." }, 400, "INVALID_FILE_NAME"],
      [{ directory: "../etc" }, 400, "INVALID_DIRECTORY"],
      [{ directory: "missing" }, 404, "DIRECTORY_NOT_FOUND"],
      [{}, 422, "VALIDATION_ERROR"],
    ];
    for (const [body, status, code] of cases) {
      const response = await patch(file.id, body);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
    expect(await (await fetch(`${base}/${file.id}`)).json()).toEqual(file);
  });

  it("не находит отсутствующий и удалённый файл", async () => {
    const { base, file, patch } = await setup();
    const missing = await patch(crypto.randomUUID(), { name: "x.txt" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: "FILE_NOT_FOUND" },
    });
    expect(
      (await fetch(`${base}/${file.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect((await patch(file.id, { name: "x.txt" })).status).toBe(404);
  });

  it("явно отказывает в изменении файла, загрузка которого не завершена", async () => {
    const { base, patch, rowOf } = await setup();
    const reserved = await fetch(`${base}/presign-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "draft.txt", size: 5 }),
    });
    const { id } = await reserved.json();
    const response = await patch(id, { name: "renamed.txt" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "FILE_NOT_READY" },
    });
    expect((await rowOf(id)).originalName).toBe("draft.txt");
  });

  it("повтор загрузки той же операции возвращает файл с новым размещением, а удаление убирает объект", async () => {
    const { base, patch, mkdir, objectStore } = await setup();
    expect((await mkdir("docs")).status).toBe(201);
    const operation = crypto.randomUUID();
    const send = () => {
      const form = new FormData();
      form.append("operationId", operation);
      form.append("file", new Blob(["data"]), "first.txt");
      return fetch(base, { method: "POST", body: form });
    };
    const uploaded = await (await send()).json();
    expect(
      (await patch(uploaded.id, { name: "second.txt", directory: "docs" }))
        .status,
    ).toBe(200);

    const repeated = await send();
    expect(repeated.status).toBe(201);
    expect(await repeated.json()).toMatchObject({
      id: uploaded.id,
      key: uploaded.key,
      name: "second.txt",
      directory: "docs",
    });

    expect(
      (await fetch(`${base}/${uploaded.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect(await objectStore.head(uploaded.key)).toBeNull();
  });
});
