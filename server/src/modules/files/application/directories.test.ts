import { describe, expect, it } from "vitest";
import { buildHarness } from "../testing/files-module.harness.js";

describe("постоянные каталоги", () => {
  it("создаёт пустой каталог в корне и позволяет открыть его", async () => {
    const { files } = buildHarness();
    expect(await files.createDirectory({ name: "Документы" })).toEqual({
      name: "Документы", path: "Документы", fileCount: 0,
    });
    expect(await files.listDirectories("")).toEqual({
      parent: "", items: [{ name: "Документы", path: "Документы", fileCount: 0 }],
    });
    expect(await files.listDirectories("Документы")).toEqual({ parent: "Документы", items: [] });
  });
  it("отличает неизвестный каталог и не создаёт неизвестного родителя", async () => {
    const { files } = buildHarness();
    await expect(files.listDirectories("unknown")).rejects.toMatchObject({ name: "DirectoryNotFoundError" });
    await expect(files.createDirectory({ parent: "unknown", name: "child" })).rejects.toMatchObject({ name: "DirectoryNotFoundError" });
    expect((await files.listDirectories("")).items).toEqual([]);
  });

  it("нормализует имя и запрещает дубликаты включая конкурентное создание", async () => {
    const { files } = buildHarness();
    await files.createDirectory({ name: "  Cafe\u0301  " });
    expect((await files.listDirectories("")).items[0]?.path).toBe("Café");
    await expect(files.createDirectory({ name: "Café" })).rejects.toMatchObject({ name: "DirectoryAlreadyExistsError" });
    const results = await Promise.allSettled([files.createDirectory({ name: "same" }), files.createDirectory({ name: "same" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it.each(["", "   ", ".", "..", "a/b", "a\\b", "a\u0000b", "\nname\t", "a".repeat(101)])("отклоняет недопустимое имя каталога %j", async (name) => {
    const { files } = buildHarness();
    await expect(files.createDirectory({ name })).rejects.toMatchObject({ name: "InvalidDirectoryError" });
    expect((await files.listDirectories("")).items).toEqual([]);
  });
  it("отклоняет полный путь длиннее 700 байт", async () => {
    const { files } = buildHarness();
    const name = "я".repeat(100);
    await files.createDirectory({ name });
    await files.createDirectory({ parent: name, name });
    const parent = `${name}/${name}/${name}`;
    await files.createDirectory({ parent: `${name}/${name}`, name });
    await expect(files.createDirectory({ parent, name })).rejects.toMatchObject({ name: "InvalidDirectoryError" });
  });

  it.each(["server", "single", "multipart", "multipart-direct"])("не загружает в неизвестный каталог способом %s", async (mode) => {
    const { files, multipart, rowCount, objectStore } = buildHarness();
    const input = { filename: "a.txt", directory: "unknown", size: 12 * 1024 * 1024 };
    const run = mode === "server" ? files.uploadThroughServer({ ...input, size: 1, bytes: Buffer.from("a") })
      : mode === "multipart-direct" ? multipart.createMultipartUpload(input)
      : files.createPresignedUpload({ ...input, size: mode === "single" ? 1 : input.size });
    await expect(run).rejects.toMatchObject({ name: "DirectoryNotFoundError" });
    expect(await rowCount()).toBe(0);
    expect(objectStore.openUploads()).toEqual([]);
    expect(objectStore.objectKeys()).toEqual([]);
  });

  it("сохраняет вложенные каталоги после удаления последнего файла и считает файлы поддерева", async () => {
    const { files } = buildHarness();
    await files.createDirectory({ name: "docs" });
    await files.createDirectory({ parent: "docs", name: "reports" });
    const file = await files.uploadThroughServer({ filename: "a.txt", directory: "docs/reports", bytes: Buffer.from("a"), size: 1 });
    expect((await files.listDirectories("")).items).toEqual([{ name: "docs", path: "docs", fileCount: 1 }]);
    await files.deleteFile(file.id);
    expect((await files.listDirectories("docs")).items).toEqual([{ name: "reports", path: "docs/reports", fileCount: 0 }]);
    expect(await files.listDirectories("docs/reports")).toEqual({ parent: "docs/reports", items: [] });
  });
  it("учитывает регистр, допускает одинаковые имена у разных родителей и совпадение с файлом", async () => {
    const { files } = buildHarness();
    await files.createDirectory({ name: "Docs" });
    await files.createDirectory({ name: "docs" });
    await files.createDirectory({ parent: "Docs", name: "reports" });
    await files.createDirectory({ parent: "docs", name: "reports" });
    await files.uploadThroughServer({ filename: "Docs", bytes: Buffer.from("a"), size: 1 });
    expect((await files.listDirectories("")).items.map((d) => d.path)).toEqual(["Docs", "docs"]);
    expect((await files.listDirectories("Docs")).items[0]?.path).toBe("Docs/reports");
    expect((await files.listDirectories("docs")).items[0]?.path).toBe("docs/reports");
  });
  it.each(["", "docs"])("все способы загрузки принимают существующий каталог %j", async (directory) => {
    const { files } = buildHarness();
    if (directory) await files.createDirectory({ name: directory });
    const server = await files.uploadThroughServer({ filename: "a.txt", directory, bytes: Buffer.from("a"), size: 1 });
    const single = await files.createPresignedUpload({ filename: "b.txt", directory, size: 1 });
    const multipart = await files.createPresignedUpload({ filename: "c.txt", directory, size: 12 * 1024 * 1024 });
    expect([server.directory, single.directory, multipart.directory]).toEqual([directory, directory, directory]);
    expect([single.strategy, multipart.strategy]).toEqual(["single", "multipart"]);
  });
  it("список файлов отличает неизвестный каталог от пустого", async () => {
    const { files } = buildHarness();
    const query = { directory: "unknown", recursive: false, status: "ready" as const, page: 1, limit: 20, sort: "created_at" as const, order: "desc" as const };
    await expect(files.listFiles(query)).rejects.toMatchObject({ name: "DirectoryNotFoundError" });
    await files.createDirectory({ name: "empty" });
    expect(await files.listFiles({ ...query, directory: "empty" })).toEqual({ items: [], total: 0 });
  });

});
