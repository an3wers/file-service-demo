import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildHttpHarness } from "../../testing/http.harness.js";
import { directoryDtoSchema, fileDtoSchema } from "./responses.js";

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
  const mkdir = async (name: string, parent?: string) =>
    expect(
      (
        await fetch(`${api}/directories`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, parent }),
        })
      ).status,
    ).toBe(201);
  const patch = (path: string | undefined, body: unknown) =>
    fetch(
      path === undefined
        ? `${api}/directories`
        : `${api}/directories?${new URLSearchParams({ path }).toString()}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  const upload = async (directory: string, name: string) => {
    const form = new FormData();
    form.append("file", new Blob(["hello"], { type: "text/plain" }), name);
    form.append("directory", directory);
    const response = await fetch(`${api}/files`, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(201);
    return fileDtoSchema.parse(await response.json());
  };
  const listing = (parent = "") =>
    fetch(`${api}/directories?${new URLSearchParams({ parent }).toString()}`);
  const children = async (parent = "") =>
    (await (await listing(parent)).json()).items;
  return { ...harness, api, mkdir, patch, upload, listing, children };
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

describe("переименование и перемещение личного каталога", () => {
  it("переносит каталог с подкаталогами и файлами, сохраняя ключи и скачивание", async () => {
    const { api, mkdir, patch, upload, listing, children } = await setup();
    await mkdir("docs");
    await mkdir("sub", "docs");
    await mkdir("archive");
    const top = await upload("docs", "top.txt");
    const deep = await upload("docs/sub", "deep.txt");

    const renamed = await patch("docs", { name: "Документы" });
    expect(renamed.status).toBe(200);
    expect(directoryDtoSchema.parse(await renamed.json())).toEqual({
      name: "Документы",
      path: "Документы",
      fileCount: 2,
    });

    const moved = await patch("Документы", { parent: "archive" });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({
      name: "Документы",
      path: "archive/Документы",
      fileCount: 2,
    });

    expect(await children()).toEqual([
      { name: "archive", path: "archive", fileCount: 2 },
    ]);
    expect(await children("archive/Документы")).toEqual([
      { name: "sub", path: "archive/Документы/sub", fileCount: 1 },
    ]);
    expect((await listing("docs")).status).toBe(404);
    const listed = await (
      await fetch(
        `${api}/files?${new URLSearchParams({ directory: "archive/Документы/sub" }).toString()}`,
      )
    ).json();
    expect(listed.items).toMatchObject([
      { id: deep.id, key: deep.key, directory: "archive/Документы/sub" },
    ]);
    const found = await (
      await fetch(`${api}/files?recursive=true&search=top`)
    ).json();
    expect(found.items).toMatchObject([
      { id: top.id, key: top.key, directory: "archive/Документы" },
    ]);
    const download = await fetch(`${api}/files/${deep.id}/download-url`);
    expect(download.status).toBe(200);
    expect(await download.json()).toMatchObject({ url: expect.any(String) });

    await mkdir("next", "archive/Документы/sub");
    await upload("archive/Документы/sub/next", "after.txt");
  });

  it("отказывает в переносе, пока в дереве каталога идёт загрузка, и разрешает после её отмены", async () => {
    const { api, mkdir, patch, children } = await setup();
    await mkdir("docs");
    await mkdir("sub", "docs");
    const presigned = await fetch(`${api}/files/presign-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "big.bin",
        directory: "docs/sub",
        size: 5,
      }),
    });
    expect(presigned.status).toBe(201);
    const { id } = await presigned.json();

    await expectError(
      await patch("docs", { name: "moved" }),
      409,
      "DIRECTORY_BUSY",
    );
    expect(await children()).toEqual([
      { name: "docs", path: "docs", fileCount: 0 },
    ]);
    expect(await children("docs")).toEqual([
      { name: "sub", path: "docs/sub", fileCount: 0 },
    ]);

    expect(
      (await fetch(`${api}/files/${id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect((await patch("docs", { name: "moved" })).status).toBe(200);
  });

  it("отказывает для корня, себя, потомка, занятого пути и отсутствующих каталогов", async () => {
    const { mkdir, patch, children } = await setup();
    await mkdir("a");
    await mkdir("b", "a");
    await mkdir("c");
    await mkdir("b");

    await expectError(await patch("", { name: "x" }), 400, "INVALID_DIRECTORY");
    await expectError(
      await patch("a", { parent: "a" }),
      400,
      "INVALID_DIRECTORY",
    );
    await expectError(
      await patch("a", { parent: "a/b" }),
      400,
      "INVALID_DIRECTORY",
    );
    await expectError(
      await patch("a", { name: "c" }),
      409,
      "DIRECTORY_ALREADY_EXISTS",
    );
    await expectError(
      await patch("a/b", { parent: "" }),
      409,
      "DIRECTORY_ALREADY_EXISTS",
    );
    await expectError(
      await patch("missing", { name: "x" }),
      404,
      "DIRECTORY_NOT_FOUND",
    );
    await expectError(
      await patch("a", { parent: "missing" }),
      404,
      "DIRECTORY_NOT_FOUND",
    );
    await expectError(
      await patch("a", { name: "x/y" }),
      400,
      "INVALID_DIRECTORY",
    );
    await expectError(await patch("a", {}), 422, "VALIDATION_ERROR");
    await expectError(
      await patch(undefined, { name: "x" }),
      422,
      "VALIDATION_ERROR",
    );

    const same = await patch("a", { name: " a ", parent: "" });
    expect(same.status).toBe(200);
    expect(await children()).toEqual([
      { name: "a", path: "a", fileCount: 0 },
      { name: "b", path: "b", fileCount: 0 },
      { name: "c", path: "c", fileCount: 0 },
    ]);
    expect(await children("a")).toEqual([
      { name: "b", path: "a/b", fileCount: 0 },
    ]);
  });
});
