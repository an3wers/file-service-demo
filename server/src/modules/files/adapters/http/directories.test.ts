import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildHttpHarness } from "../../testing/http.harness.js";
import { directoriesResponseSchema, directoryDtoSchema } from "./responses.js";

let server: Server | undefined;

afterEach(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
});

describe("HTTP-контракт каталогов", () => {
  it("создаёт каталог, читает пустой и различает ошибки родителя, дубликата и имени", async () => {
    const { app } = buildHttpHarness();
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", (error) =>
        error ? reject(error) : resolve(),
      );
      server.once("error", reject);
    });
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/directories`;
    const create = (body: unknown) =>
      fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const created = await create({ name: "Docs" });
    expect(created.status).toBe(201);
    expect(directoryDtoSchema.parse(await created.json())).toEqual({
      name: "Docs",
      path: "Docs",
      fileCount: 0,
    });
    const empty = await fetch(`${base}?parent=Docs`);
    expect(empty.status).toBe(200);
    expect(directoriesResponseSchema.parse(await empty.json())).toEqual({
      parent: "Docs",
      items: [],
    });
    const duplicate = await create({ name: " Docs " });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      error: { code: "DIRECTORY_ALREADY_EXISTS" },
    });
    const unknown = await fetch(`${base}?parent=unknown`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({
      error: { code: "DIRECTORY_NOT_FOUND" },
    });
    const parent = await create({ parent: "unknown", name: "child" });
    expect(parent.status).toBe(404);
    const invalid = await create({ name: "a/b" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "INVALID_DIRECTORY" },
    });
    const malformed = await create({ name: 42 });
    expect(malformed.status).toBe(422);
    expect(await malformed.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("удаляет пустой каталог, а корень, непустой и отсутствующий каталоги защищает", async () => {
    const { app } = buildHttpHarness();
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", (error) =>
        error ? reject(error) : resolve(),
      );
      server.once("error", reject);
    });
    const origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api`;
    const base = `${origin}/directories`;
    const create = (body: unknown) =>
      fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const remove = (path?: string) =>
      fetch(
        path === undefined
          ? base
          : `${base}?${new URLSearchParams({ path }).toString()}`,
        { method: "DELETE" },
      );
    expect((await create({ name: "Docs" })).status).toBe(201);
    expect((await create({ parent: "Docs", name: "Sub" })).status).toBe(201);
    expect((await create({ name: "Media" })).status).toBe(201);

    const withChild = await remove("Docs");
    expect(withChild.status).toBe(409);
    expect(await withChild.json()).toMatchObject({
      error: { code: "DIRECTORY_NOT_EMPTY" },
    });

    const form = new FormData();
    form.append("file", new Blob(["hello"]), "report.txt");
    form.append("directory", "Media");
    expect(
      (await fetch(`${origin}/files`, { method: "POST", body: form })).status,
    ).toBe(201);
    const withFile = await remove("Media");
    expect(withFile.status).toBe(409);
    expect(await withFile.json()).toMatchObject({
      error: { code: "DIRECTORY_NOT_EMPTY" },
    });

    const root = await remove("");
    expect(root.status).toBe(400);
    expect(await root.json()).toMatchObject({
      error: { code: "INVALID_DIRECTORY" },
    });
    const unknown = await remove("unknown");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({
      error: { code: "DIRECTORY_NOT_FOUND" },
    });
    expect((await remove()).status).toBe(422);

    expect((await remove("Docs/Sub")).status).toBe(204);
    expect((await remove("Docs/Sub")).status).toBe(404);
    expect((await remove(" Docs ")).status).toBe(204);
    expect(
      directoriesResponseSchema.parse(await (await fetch(base)).json()),
    ).toEqual({
      parent: "",
      items: [{ name: "Media", path: "Media", fileCount: 1 }],
    });
  });
});
