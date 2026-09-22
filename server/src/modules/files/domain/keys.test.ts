import { describe, expect, it } from "vitest";
import { InvalidDirectoryError, InvalidFileNameError } from "./errors.js";
import {
  buildObjectKey,
  fileExtension,
  normalizeDirectory,
  sanitizeFileName,
} from "./keys.js";

/** Возвращает выброшенную ошибку, чтобы проверить её код, а не только факт броска. */
function thrownBy(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }

  throw new Error("Expected the call to throw, but it returned");
}

describe("normalizeDirectory", () => {
  it("treats empty input as the bucket root", () => {
    expect(normalizeDirectory(undefined)).toBe("");
    expect(normalizeDirectory(null)).toBe("");
    expect(normalizeDirectory("")).toBe("");
    expect(normalizeDirectory("///")).toBe("");
  });

  it("collapses separators and trims segments", () => {
    expect(normalizeDirectory("//docs// 2026 /reports/")).toBe("docs/2026/reports");
  });

  it("accepts backslashes as separators", () => {
    expect(normalizeDirectory("docs\\2026")).toBe("docs/2026");
  });

  it("rejects traversal segments", () => {
    for (const input of ["..", "docs/../etc", "./docs"]) {
      expect(thrownBy(() => normalizeDirectory(input))).toBeInstanceOf(InvalidDirectoryError);
    }
  });

  it("rejects control characters", () => {
    expect(thrownBy(() => normalizeDirectory("docs/a\u0007b"))).toBeInstanceOf(
      InvalidDirectoryError,
    );
  });

  it("rejects an over-long segment", () => {
    expect(thrownBy(() => normalizeDirectory("a".repeat(101)))).toBeInstanceOf(
      InvalidDirectoryError,
    );
  });

  it("rejects a path over the byte budget", () => {
    const path = Array.from({ length: 8 }, () => "a".repeat(100)).join("/");

    expect(thrownBy(() => normalizeDirectory(path))).toBeInstanceOf(InvalidDirectoryError);
  });
});

describe("sanitizeFileName", () => {
  it("keeps only the last path segment", () => {
    expect(sanitizeFileName("/tmp/report.pdf")).toBe("report.pdf");
    expect(sanitizeFileName("C:\\Users\\me\\photo.png")).toBe("photo.png");
    expect(sanitizeFileName("  spaced.txt  ")).toBe("spaced.txt");
  });

  it("truncates to 255 characters", () => {
    expect(sanitizeFileName(`${"n".repeat(300)}.txt`)).toHaveLength(255);
  });

  it("rejects names that carry no usable file name", () => {
    for (const input of ["", "   ", "docs/", "..", "bad\u0000name"]) {
      expect(thrownBy(() => sanitizeFileName(input))).toBeInstanceOf(InvalidFileNameError);
    }
  });
});

describe("fileExtension", () => {
  it("lowercases and drops the dot", () => {
    expect(fileExtension("Report.PDF")).toBe("pdf");
    expect(fileExtension("archive.tar.gz")).toBe("gz");
  });

  it("returns an empty string when there is nothing usable", () => {
    expect(fileExtension("README")).toBe("");
    expect(fileExtension("trailing.")).toBe("");
    expect(fileExtension("файл.документ")).toBe("");
  });
});

describe("buildObjectKey", () => {
  it("names the object after a fresh uuid, not the original file", () => {
    const { id, key, extension } = buildObjectKey("docs/2026", "Отчёт.PDF");

    expect(extension).toBe("pdf");
    expect(key).toBe(`docs/2026/${id}.pdf`);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps root keys free of a leading slash", () => {
    const { id, key } = buildObjectKey("", "notes");

    expect(key).toBe(id);
  });

  it("never repeats a key", () => {
    const first = buildObjectKey("docs", "a.txt");
    const second = buildObjectKey("docs", "a.txt");

    expect(first.key).not.toBe(second.key);
  });
});
