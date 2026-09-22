import { describe, expect, it } from "vitest";
import { contentDisposition } from "./content-disposition.js";

describe("contentDisposition", () => {
  it("carries both an ASCII fallback and the UTF-8 name", () => {
    const name = 'Отчёт "v2".pdf';
    const header = contentDisposition(name, "attachment");

    expect(header).toBe(
      `attachment; filename="_____ _v2_.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
  });

  it("honours the inline disposition", () => {
    expect(contentDisposition("a.png", "inline")).toBe(
      "inline; filename=\"a.png\"; filename*=UTF-8''a.png",
    );
  });
});
