import { describe, expect, it } from "vitest";
import { readCookie } from "./cookie.js";

describe("чтение cookie из заголовка", () => {
  it("находит значение по имени среди нескольких cookie", () => {
    expect(readCookie("theme=dark; refresh_token=abc.def.ghi; lang=ru", "refresh_token")).toBe(
      "abc.def.ghi",
    );
  });

  it("не путает имя с префиксом другого имени", () => {
    expect(readCookie("xrefresh_token=nope", "refresh_token")).toBeUndefined();
  });

  it("возвращает undefined без заголовка, без cookie и для пустого значения", () => {
    expect(readCookie(undefined, "refresh_token")).toBeUndefined();
    expect(readCookie("theme=dark", "refresh_token")).toBeUndefined();
    expect(readCookie("refresh_token=", "refresh_token")).toBeUndefined();
  });

  it("раскодирует значение и переживает испорченное кодирование", () => {
    expect(readCookie("refresh_token=a%20b", "refresh_token")).toBe("a b");
    expect(readCookie("refresh_token=%E0%A4%A", "refresh_token")).toBeUndefined();
  });
});
