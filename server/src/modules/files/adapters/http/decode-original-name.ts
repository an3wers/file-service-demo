/**
 * busboy (inside multer) decodes non-extended `filename` parameters as latin1,
 * so a UTF-8 name arrives as mojibake. Re-reading those latin1 bytes as UTF-8
 * recovers the original, but only when the string really does look like raw
 * bytes — otherwise an already-correct name would be destroyed.
 */
export function decodeOriginalName(name: string): string {
  let hasHighByte = false;

  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;

    if (code > 0xff) {
      return name; // Contains real multi-byte characters: already decoded.
    }

    if (code > 0x7f) {
      hasHighByte = true;
    }
  }

  if (!hasHighByte) {
    return name; // Pure ASCII: nothing to repair.
  }

  const bytes = Buffer.from(name, "latin1");
  const decoded = bytes.toString("utf8");

  return Buffer.from(decoded, "utf8").equals(bytes) ? decoded : name;
}
