import { describe, expect, it } from "vitest";
import { AppError } from "../../errors.js";
import { createMemoryFileRows } from "./memory-file-rows.js";
import type { MemoryFileRows } from "./memory-file-rows.js";
import type { InsertFileInput, ListFilesParams } from "./files.types.js";

/**
 * Every later test believes whatever this implementation says about a row, so
 * the SQL rules it claims to model are checked here rather than assumed.
 */
describe("memory file rows", () => {
  let nextId = 0;

  function reserve(overrides: Partial<InsertFileInput> = {}): InsertFileInput {
    nextId += 1;

    const id = overrides.id ?? `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;

    return {
      id,
      objectKey: `docs/${id}.bin`,
      directory: "docs",
      originalName: "report.bin",
      extension: "bin",
      contentType: "application/octet-stream",
      sizeBytes: null,
      etag: null,
      status: "pending",
      uploadSource: "presigned",
      ...overrides,
    };
  }

  async function multipartRow(store: MemoryFileRows, overrides: Partial<InsertFileInput> = {}) {
    return store.insertFile(
      reserve({
        uploadSource: "multipart",
        sizeBytes: 16,
        uploadId: "upload-1",
        partSize: 8,
        partCount: 2,
        ...overrides,
      }),
    );
  }

  const listing = (overrides: Partial<ListFilesParams> = {}): ListFilesParams => ({
    recursive: false,
    page: 1,
    limit: 10,
    sort: "created_at",
    order: "desc",
    ...overrides,
  });

  describe("reserving and reading", () => {
    it("reads back the row that was inserted", async () => {
      const store = createMemoryFileRows();
      const input = reserve();

      await store.insertFile(input);

      expect(await store.findFileById(input.id)).toMatchObject({
        id: input.id,
        key: input.objectKey,
        originalName: input.originalName,
        kind: "reserved",
      });
    });

    it("knows nothing about an id that was never reserved", async () => {
      const store = createMemoryFileRows();

      expect(await store.findFileById(reserve().id)).toBeNull();
    });

    it("refuses a second row on the same object key", async () => {
      const store = createMemoryFileRows();
      const first = reserve();

      await store.insertFile(first);

      await expect(store.insertFile(reserve({ objectKey: first.objectKey }))).rejects.toBeInstanceOf(
        AppError,
      );
    });

    it("hides a soft-deleted row from reads", async () => {
      const store = createMemoryFileRows();
      const input = reserve();

      await store.insertFile(input);
      await store.softDeleteFile(input.id);

      expect(await store.findFileById(input.id)).toBeNull();
    });

    it("reports nothing to delete the second time", async () => {
      const store = createMemoryFileRows();
      const input = reserve();

      await store.insertFile(input);

      expect(await store.softDeleteFile(input.id)).not.toBeNull();
      expect(await store.softDeleteFile(input.id)).toBeNull();
    });
  });

  describe("confirmation", () => {
    it("moves the row to ready and clears the multipart plan with it", async () => {
      const store = createMemoryFileRows();
      const row = await multipartRow(store);

      const confirmed = await store.markFileReady(row.id, {
        sizeBytes: 16,
        etag: '"abc"',
        contentType: "text/plain",
      });

      expect(confirmed).toMatchObject({
        kind: "ready",
        size: 16,
        etag: '"abc"',
        contentType: "text/plain",
      });
    });

    it("leaves the row ready when it is confirmed twice", async () => {
      const store = createMemoryFileRows();
      const row = await multipartRow(store);
      const values = { sizeBytes: 16, etag: '"abc"', contentType: "text/plain" };

      await store.markFileReady(row.id, values);
      const again = await store.markFileReady(row.id, values);

      expect(again).toMatchObject({ kind: "ready", size: 16 });
      expect(await store.findFileById(row.id)).toMatchObject({ kind: "ready" });
    });

    it("confirms nothing for a row that is gone", async () => {
      const store = createMemoryFileRows();
      const row = await multipartRow(store);

      await store.softDeleteFile(row.id);

      expect(
        await store.markFileReady(row.id, { sizeBytes: 1, etag: null, contentType: "text/plain" }),
      ).toBeNull();
    });

    it("marks a row failed", async () => {
      const store = createMemoryFileRows();
      const row = await store.insertFile(reserve());

      await store.markFileFailed(row.id);

      expect(await store.findFileById(row.id)).toMatchObject({ kind: "failed" });
    });
  });

  describe("active multipart uploads", () => {
    it("counts only rows that are still pending and still carry an upload id", async () => {
      const store = createMemoryFileRows();
      const live = await multipartRow(store);
      const confirmed = await multipartRow(store);
      const deleted = await multipartRow(store);

      await store.markFileReady(confirmed.id, {
        sizeBytes: 1,
        etag: null,
        contentType: "text/plain",
      });
      await store.softDeleteFile(deleted.id);
      await store.insertFile(reserve());

      expect(await store.countActiveMultipart()).toBe(1);
      expect(await store.findFileById(live.id)).toMatchObject({
        kind: "multipart",
        uploadId: "upload-1",
      });
    });

    it("tells which upload ids the table still knows about", async () => {
      const store = createMemoryFileRows();

      await multipartRow(store, { uploadId: "known" });

      expect(await store.findKnownUploadIds(["known", "orphan"])).toEqual(new Set(["known"]));
      expect(await store.findKnownUploadIds([])).toEqual(new Set());
    });
  });

  describe("expiry", () => {
    it("lists reserved rows past their ttl, oldest first", async () => {
      const store = createMemoryFileRows();
      const old = await store.insertFile(reserve());

      store.advance(2);

      const recent = await store.insertFile(reserve());

      store.advance(2);

      const ready = await store.insertFile(reserve());

      await store.markFileReady(ready.id, { sizeBytes: 1, etag: null, contentType: "text/plain" });

      const expired = await store.listExpiredPending(3);

      expect(expired.map((row) => row.id)).toEqual([old.id]);
      expect(recent.createdAt.getTime()).toBeGreaterThan(old.createdAt.getTime());
    });

    it("hands the claimed upload id back exactly once when two sweeps race", async () => {
      const store = createMemoryFileRows();
      const row = await multipartRow(store, { uploadId: "upload-race" });

      store.advance(4);

      // The claim is one read-modify-write with nothing awaited in between, so
      // the second caller can only ever find the row already settled.
      const claims = await Promise.all([
        store.claimExpiredMultipart(row.id, 3),
        store.claimExpiredMultipart(row.id, 3),
      ]);

      expect(claims.filter((claim) => claim !== null)).toEqual(["upload-race"]);
      expect(await store.findFileById(row.id)).toMatchObject({ kind: "failed" });
    });

    it("claims nothing while the row is still within its ttl", async () => {
      const store = createMemoryFileRows();
      const row = await multipartRow(store);

      store.advance(1);

      expect(await store.claimExpiredMultipart(row.id, 3)).toBeNull();
      expect(await store.findFileById(row.id)).toMatchObject({ kind: "multipart" });
    });
  });

  describe("listing", () => {
    it("pages a directory and reports the total it was cut from", async () => {
      const store = createMemoryFileRows();

      for (let index = 0; index < 3; index += 1) {
        await store.insertFile(reserve({ originalName: `file-${index}.bin` }));
        store.advance(1);
      }

      const page = await store.listFiles(listing({ directory: "docs", limit: 2 }));

      expect(page.total).toBe(3);
      expect(page.items.map((row) => row.originalName)).toEqual(["file-2.bin", "file-1.bin"]);
    });

    it("keeps a nested directory out of a non-recursive listing and in a recursive one", async () => {
      const store = createMemoryFileRows();

      await store.insertFile(reserve({ directory: "docs" }));
      await store.insertFile(reserve({ directory: "docs/2026", objectKey: "docs/2026/a.bin" }));

      const flat = await store.listFiles(listing({ directory: "docs" }));
      const deep = await store.listFiles(listing({ directory: "docs", recursive: true }));

      expect(flat.items).toHaveLength(1);
      expect(deep.items).toHaveLength(2);
    });

    it("matches the search case-insensitively and skips deleted rows", async () => {
      const store = createMemoryFileRows();
      const kept = await store.insertFile(reserve({ originalName: "Quarterly Report.pdf" }));
      const dropped = await store.insertFile(reserve({ originalName: "quarterly draft.pdf" }));

      await store.softDeleteFile(dropped.id);

      const found = await store.listFiles(listing({ search: "QUARTERLY" }));

      expect(found.items.map((row) => row.id)).toEqual([kept.id]);
    });

    it("sorts rows with no size the way postgres does: last ascending, first descending", async () => {
      const store = createMemoryFileRows();
      const pending = await store.insertFile(reserve());
      const sized = await store.insertFile(reserve());

      await store.markFileReady(sized.id, {
        sizeBytes: 10,
        etag: null,
        contentType: "text/plain",
      });

      const ascending = await store.listFiles(listing({ sort: "size_bytes", order: "asc" }));
      const descending = await store.listFiles(listing({ sort: "size_bytes", order: "desc" }));

      expect(ascending.items.map((row) => row.id)).toEqual([sized.id, pending.id]);
      expect(descending.items.map((row) => row.id)).toEqual([pending.id, sized.id]);
    });

    it("counts a whole subtree under each immediate child folder", async () => {
      const store = createMemoryFileRows();

      const ready = async (directory: string, key: string) => {
        const row = await store.insertFile(reserve({ directory, objectKey: key }));

        await store.markFileReady(row.id, { sizeBytes: 1, etag: null, contentType: "text/plain" });
      };

      await ready("docs", "docs/a.bin");
      await ready("docs/2026", "docs/2026/b.bin");
      await ready("docs/2026/q1", "docs/2026/q1/c.bin");
      await ready("images", "images/d.bin");

      expect(await store.listChildDirectories("")).toEqual([
        { path: "docs", name: "docs", fileCount: 3 },
        { path: "images", name: "images", fileCount: 1 },
      ]);
      expect(await store.listChildDirectories("docs")).toEqual([
        { path: "docs/2026", name: "2026", fileCount: 2 },
      ]);
    });
  });
  describe("failNext", () => {
    it("fails the next call to that method and only that one", async () => {
      const store = createMemoryFileRows();
      const boom = new Error("the metadata table is down");
      const input = reserve();

      store.failNext("insertFile", boom);

      await expect(store.insertFile(input)).rejects.toBe(boom);
      await expect(store.insertFile(input)).resolves.toMatchObject({ id: input.id });
    });
  });
});
