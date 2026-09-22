import { describe, expect, it } from "vitest";
import { AppError } from "../../errors.js";
import type { FileRow } from "./files.types.js";
import { toStoredFile } from "./stored-file.js";

function row(overrides: Partial<FileRow> = {}): FileRow {
  return {
    id: "8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
    bucket: "test-bucket",
    object_key: "docs/8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f.pdf",
    directory: "docs",
    original_name: "report.pdf",
    extension: "pdf",
    content_type: "application/pdf",
    size_bytes: null,
    etag: null,
    status: "pending",
    upload_source: "presigned",
    upload_id: null,
    part_size: null,
    part_count: null,
    created_at: new Date("2026-08-27T12:45:43.437Z"),
    updated_at: new Date("2026-08-28T09:00:00.000Z"),
    deleted_at: null,
    ...overrides,
  };
}

describe("toStoredFile", () => {
  describe("законные сочетания", () => {
    it("строка без загрузки становится зарезервированным файлом", () => {
      const file = toStoredFile(row({ size_bytes: 10 }));

      expect(file).toMatchObject({ kind: "reserved", size: 10 });
    });

    it("зарезервированный файл не обязан знать размер заранее", () => {
      const file = toStoredFile(row({ size_bytes: null }));

      expect(file).toMatchObject({ kind: "reserved", size: null });
    });

    it("строка с upload_id и планом становится живой составной загрузкой", () => {
      const file = toStoredFile(
        row({ upload_id: "upload-1", size_bytes: 12, part_size: 5, part_count: 3 }),
      );

      expect(file).toMatchObject({
        kind: "multipart",
        uploadId: "upload-1",
        plan: { size: 12, partSize: 5, partCount: 3, lastPartSize: 2 },
      });
    });

    it("строка status=ready становится готовым файлом с размером и etag", () => {
      const file = toStoredFile(
        row({ status: "ready", size_bytes: 2048, etag: '"abc123"' }),
      );

      expect(file).toMatchObject({ kind: "ready", size: 2048, etag: '"abc123"' });
    });

    it("готовый файл допускает неизвестные размер и etag", () => {
      const file = toStoredFile(row({ status: "ready", size_bytes: null, etag: null }));

      expect(file).toMatchObject({ kind: "ready", size: null, etag: null });
    });

    it("строка status=failed становится неудавшимся файлом без плана и размера", () => {
      const file = toStoredFile(
        row({ status: "failed", size_bytes: 12, part_size: 5, part_count: 3 }),
      );

      expect(file).toMatchObject({ kind: "failed" });
      expect(file).not.toHaveProperty("size");
      expect(file).not.toHaveProperty("uploadId");
      expect(file).not.toHaveProperty("plan");
    });

    it("сущность несёт общие поля независимо от состояния", () => {
      const file = toStoredFile(row());

      expect(file).toMatchObject({
        id: "8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
        bucket: "test-bucket",
        key: "docs/8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f.pdf",
        directory: "docs",
        originalName: "report.pdf",
        extension: "pdf",
        contentType: "application/pdf",
        uploadSource: "presigned",
        createdAt: row().created_at,
        updatedAt: row().updated_at,
      });
    });
  });

  describe("незаконные сочетания", () => {
    it("резервирование с планом без upload_id — внутренняя ошибка", () => {
      expect(() => toStoredFile(row({ part_size: 5, part_count: 3 }))).toThrow(AppError);
      expect(() => toStoredFile(row({ part_size: 5 }))).toThrow(AppError);
      expect(() => toStoredFile(row({ part_count: 3 }))).toThrow(AppError);
    });

    it("резервирование с etag до завершения загрузки — внутренняя ошибка", () => {
      expect(() => toStoredFile(row({ etag: '"abc"' }))).toThrow(AppError);
    });

    it("живая составная загрузка без размера — внутренняя ошибка", () => {
      expect(() =>
        toStoredFile(row({ upload_id: "upload-1", size_bytes: null, part_size: 5, part_count: 3 })),
      ).toThrow(AppError);
    });

    it("живая составная загрузка без плана частей — внутренняя ошибка", () => {
      expect(() =>
        toStoredFile(row({ upload_id: "upload-1", size_bytes: 12, part_size: null, part_count: null })),
      ).toThrow(AppError);
    });

    it("живая составная загрузка без размера части — внутренняя ошибка", () => {
      expect(() =>
        toStoredFile(row({ upload_id: "upload-1", size_bytes: 12, part_size: null, part_count: 3 })),
      ).toThrow(AppError);
    });

    it("живая составная загрузка без числа частей — внутренняя ошибка", () => {
      expect(() =>
        toStoredFile(row({ upload_id: "upload-1", size_bytes: 12, part_size: 5, part_count: null })),
      ).toThrow(AppError);
    });

    it("живая составная загрузка с etag — внутренняя ошибка", () => {
      expect(() =>
        toStoredFile(
          row({
            upload_id: "upload-1",
            size_bytes: 12,
            part_size: 5,
            part_count: 3,
            etag: '"abc"',
          }),
        ),
      ).toThrow(AppError);
    });

    it("готовый файл с upload_id — внутренняя ошибка", () => {
      expect(() =>
        toStoredFile(row({ status: "ready", upload_id: "upload-1" })),
      ).toThrow(AppError);
    });

    it("готовый файл с остатком плана частей — внутренняя ошибка", () => {
      expect(() =>
        toStoredFile(row({ status: "ready", part_size: 5, part_count: 3 })),
      ).toThrow(AppError);
      expect(() => toStoredFile(row({ status: "ready", part_size: 5 }))).toThrow(AppError);
      expect(() => toStoredFile(row({ status: "ready", part_count: 3 }))).toThrow(AppError);
    });

    it("неудавшийся файл с живым upload_id — внутренняя ошибка", () => {
      expect(() =>
        toStoredFile(row({ status: "failed", upload_id: "upload-1" })),
      ).toThrow(AppError);
    });
  });
});
