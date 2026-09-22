import { describe, expect, it } from "vitest";
import { decodeOriginalName } from "./decode-original-name.js";

describe("decodeOriginalName", () => {
  it("leaves ASCII names alone", () => {
    expect(decodeOriginalName("report.pdf")).toBe("report.pdf");
  });

  it("leaves already-decoded names alone", () => {
    expect(decodeOriginalName("Отчёт.pdf")).toBe("Отчёт.pdf");
  });

  it("repairs a UTF-8 name that arrived as latin1 bytes", () => {
    const original = "Отчёт за 2026.pdf";
    const mojibake = Buffer.from(original, "utf8").toString("latin1");

    expect(mojibake).not.toBe(original);
    expect(decodeOriginalName(mojibake)).toBe(original);
  });

  it("keeps a latin1 name that is not valid UTF-8", () => {
    expect(decodeOriginalName("café.txt")).toBe("café.txt");
  });
});
