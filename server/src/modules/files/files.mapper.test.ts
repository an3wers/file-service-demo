import { describe, expect, it } from "vitest";
import type { FileRow } from "./files.types.js";
import { toFileDto } from "./files.mapper.js";

const row: FileRow = {
  id: "8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
  bucket: "test-bucket",
  object_key: "docs/8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f.pdf",
  directory: "docs",
  original_name: "Отчёт.pdf",
  extension: "pdf",
  content_type: "application/pdf",
  size_bytes: 2048,
  etag: '"abc123"',
  status: "ready",
  upload_source: "presigned",
  upload_id: null,
  part_size: null,
  part_count: null,
  created_at: new Date("2026-08-27T12:45:43.437Z"),
  updated_at: new Date("2026-08-28T09:00:00.000Z"),
  deleted_at: null,
};

describe("toFileDto", () => {
  it("renames the storage columns into the client contract", () => {
    expect(toFileDto(row)).toEqual({
      id: row.id,
      name: "Отчёт.pdf",
      directory: "docs",
      extension: "pdf",
      contentType: "application/pdf",
      size: 2048,
      etag: '"abc123"',
      status: "ready",
      uploadSource: "presigned",
      bucket: "test-bucket",
      key: row.object_key,
      createdAt: "2026-08-27T12:45:43.437Z",
      updatedAt: "2026-08-28T09:00:00.000Z",
    });
  });

  it("never leaks internal columns", () => {
    expect(toFileDto(row)).not.toHaveProperty("deleted_at");
    expect(toFileDto(row)).not.toHaveProperty("object_key");
  });

  it("omits downloadUrl unless one was built", () => {
    expect(toFileDto(row)).not.toHaveProperty("downloadUrl");
    expect(toFileDto(row, "https://s3.test.local/signed")).toMatchObject({
      downloadUrl: "https://s3.test.local/signed",
    });
  });

  it("keeps a pending upload's unknown size and etag as null", () => {
    const pending: FileRow = { ...row, status: "pending", size_bytes: null, etag: null };

    expect(toFileDto(pending)).toMatchObject({ status: "pending", size: null, etag: null });
  });
});
