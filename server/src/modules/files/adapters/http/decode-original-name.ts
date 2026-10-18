/**
 * busboy внутри multer декодирует обычный параметр `filename` как latin1,
 * поэтому имя в UTF-8 искажается. Повторное чтение этих байтов как UTF-8
 * восстанавливает имя только тогда, когда строка похожа на исходные байты;
 * иначе можно испортить уже правильно декодированное имя.
 */
export function decodeOriginalName(name: string): string {
  let hasHighByte = false;

  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;

    if (code > 0xff) {
      return name; // Строка уже содержит декодированные символы за пределами одного байта.
    }

    if (code > 0x7f) {
      hasHighByte = true;
    }
  }

  if (!hasHighByte) {
    return name; // Только ASCII: исправлять нечего.
  }

  const bytes = Buffer.from(name, "latin1");
  const decoded = bytes.toString("utf8");

  return Buffer.from(decoded, "utf8").equals(bytes) ? decoded : name;
}
