import { describe, expect, it } from "vitest"
import { formatBytes, formatDate, plural } from "./format"

describe("formatBytes", () => {
  it("оставляет байты целыми до первого килобайта", () => {
    expect(formatBytes(0)).toBe("0 Б")
    expect(formatBytes(1023)).toBe("1023 Б")
  })

  it("поднимается по единицам с одним знаком после запятой", () => {
    expect(formatBytes(1024)).toBe("1.0 КБ")
    expect(formatBytes(1024 ** 2)).toBe("1.0 МБ")
    expect(formatBytes(1024 ** 4 * 5)).toBe("5.0 ТБ")
  })

  it("отдаёт прочерк вместо неизвестного размера", () => {
    expect(formatBytes(null)).toBe("—")
    expect(formatBytes(Number.NaN)).toBe("—")
  })
})

describe("formatDate", () => {
  it("отдаёт прочерк на неразбираемой дате", () => {
    expect(formatDate("не дата")).toBe("—")
  })
})

describe("plural", () => {
  it("выбирает русскую форму по числу", () => {
    const forms: [string, string, string] = ["файл", "файла", "файлов"]

    expect(plural(1, forms)).toBe("файл")
    expect(plural(3, forms)).toBe("файла")
    expect(plural(11, forms)).toBe("файлов")
  })
})
