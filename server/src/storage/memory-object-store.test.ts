import { describe, expect, it } from "vitest";
import { createMemoryObjectStore } from "./memory-object-store.js";

/**
 * Every later test believes whatever this adapter says, so the S3 rules it
 * claims to model are checked here rather than assumed.
 */
describe("memory object store", () => {
  const key = "docs/8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f.bin";

  describe("objects", () => {
    it("reports nothing at a key nothing was written to", async () => {
      const store = createMemoryObjectStore();

      expect(await store.head(key)).toBeNull();
    });

    it("reports the size and content type of what was written", async () => {
      const store = createMemoryObjectStore();

      await store.put(key, Buffer.from("hello"), {
        contentType: "text/plain",
        contentLength: 5,
      });

      expect(await store.head(key)).toMatchObject({ size: 5, contentType: "text/plain" });
    });

    it("quotes etags the way completion expects to echo them back", async () => {
      const store = createMemoryObjectStore();

      const { etag } = await store.put(key, Buffer.from("hello"), {
        contentType: "text/plain",
        contentLength: 5,
      });

      expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    });

    it("removes without complaining about a key that was never there", async () => {
      const store = createMemoryObjectStore();

      await expect(store.remove(key)).resolves.toBeUndefined();
    });
  });

  describe("multipart uploads", () => {
    it("holds no object at the key until the upload is assembled", async () => {
      const store = createMemoryObjectStore();
      const uploadId = await store.beginMultipart(key, { contentType: "text/plain" });

      store.uploadPart(uploadId, 1, Buffer.from("one"));

      expect(await store.head(key)).toBeNull();
    });

    it("returns parts ascending by part number whatever order they arrived in", async () => {
      const store = createMemoryObjectStore();
      const uploadId = await store.beginMultipart(key, { contentType: "text/plain" });

      store.uploadPart(uploadId, 3, Buffer.from("c"));
      store.uploadPart(uploadId, 1, Buffer.from("a"));
      store.uploadPart(uploadId, 2, Buffer.from("b"));

      expect((await store.listParts(key, uploadId))?.map((part) => part.partNumber)).toEqual([
        1, 2, 3,
      ]);
    });

    it("assembles the object out of the parts in the order given", async () => {
      const store = createMemoryObjectStore();
      const uploadId = await store.beginMultipart(key, { contentType: "text/plain" });

      store.uploadPart(uploadId, 1, Buffer.from("Оте"));
      store.uploadPart(uploadId, 2, Buffer.from("чёт"));

      const parts = await store.listParts(key, uploadId);

      expect(await store.completeMultipart(key, uploadId, parts!)).toBe("assembled");
      expect(store.objectAt(key)?.body.toString()).toBe("Отечёт");
    });

    it("answers gone once the upload has been completed", async () => {
      const store = createMemoryObjectStore();
      const uploadId = await store.beginMultipart(key, { contentType: "text/plain" });

      store.uploadPart(uploadId, 1, Buffer.from("one"));
      await store.completeMultipart(key, uploadId, (await store.listParts(key, uploadId))!);

      expect(await store.listParts(key, uploadId)).toBeNull();
      expect(await store.completeMultipart(key, uploadId, [])).toBe("gone");
    });

    it("answers gone once the upload has been aborted", async () => {
      const store = createMemoryObjectStore();
      const uploadId = await store.beginMultipart(key, { contentType: "text/plain" });

      await store.abortMultipart(key, uploadId);

      expect(await store.listParts(key, uploadId)).toBeNull();
      expect(await store.completeMultipart(key, uploadId, [])).toBe("gone");
    });

    it("aborts without complaining about an upload that is already gone", async () => {
      const store = createMemoryObjectStore();

      await expect(store.abortMultipart(key, "never-existed")).resolves.toBeUndefined();
    });

    it("lists uploads still open, and only those", async () => {
      const store = createMemoryObjectStore();
      const kept = await store.beginMultipart(key, { contentType: "text/plain" });
      const abandoned = await store.beginMultipart("other.bin", {
        contentType: "text/plain",
      });

      await store.abortMultipart("other.bin", abandoned);

      expect(await store.listMultipartUploads()).toEqual([
        { uploadId: kept, key, initiatedAt: expect.any(Date) },
      ]);
    });
  });

  describe("failNext", () => {
    it("fails the next call to that method and only that one", async () => {
      const store = createMemoryObjectStore();
      const boom = new Error("storage is down");

      store.failNext("head", boom);

      await expect(store.head(key)).rejects.toBe(boom);
      await expect(store.head(key)).resolves.toBeNull();
    });
  });
});
