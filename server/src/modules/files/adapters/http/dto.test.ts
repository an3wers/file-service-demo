import { describe, expect, it } from "vitest";
import type { StoredFile } from "../../domain/stored-file.js";
import { toFileDto } from "./dto.js";

const base = {
  id: "8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
  bucket: "test-bucket",
  key: "docs/8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f.pdf",
  directory: "docs",
  originalName: "Отчёт.pdf",
  extension: "pdf",
  contentType: "application/pdf",
  uploadSource: "presigned" as const,
  createdAt: new Date("2026-08-27T12:45:43.437Z"),
  updatedAt: new Date("2026-08-28T09:00:00.000Z"),
};

const readyFile: StoredFile = {
  ...base,
  kind: "ready",
  size: 2048,
  etag: '"abc123"',
};

describe("toFileDto", () => {
  it("переносит поля сущности в контракт клиента", () => {
    expect(toFileDto(readyFile)).toEqual({
      id: base.id,
      name: "Отчёт.pdf",
      directory: "docs",
      extension: "pdf",
      contentType: "application/pdf",
      size: 2048,
      etag: '"abc123"',
      status: "ready",
      uploadSource: "presigned",
      bucket: "test-bucket",
      key: base.key,
      createdAt: "2026-08-27T12:45:43.437Z",
      updatedAt: "2026-08-28T09:00:00.000Z",
    });
  });

  it("не отдаёт downloadUrl, пока он не построен", () => {
    expect(toFileDto(readyFile)).not.toHaveProperty("downloadUrl");
    expect(toFileDto(readyFile, "https://storage.test.local/signed")).toMatchObject({
      downloadUrl: "https://storage.test.local/signed",
    });
  });

  it("резервирование и живая составная загрузка отвечают статусом pending", () => {
    const reserved: StoredFile = { ...base, kind: "reserved", size: null };
    const multipart: StoredFile = {
      ...base,
      kind: "multipart",
      uploadId: "upload-1",
      plan: { size: 12, partSize: 5, partCount: 3, lastPartSize: 2 },
    };

    expect(toFileDto(reserved)).toMatchObject({ status: "pending", size: null, etag: null });
    expect(toFileDto(multipart)).toMatchObject({ status: "pending", size: 12, etag: null });
  });

  it("неудавшийся файл отвечает без размера и etag", () => {
    const failed: StoredFile = { ...base, kind: "failed" };

    expect(toFileDto(failed)).toMatchObject({ status: "failed", size: null, etag: null });
  });
});
