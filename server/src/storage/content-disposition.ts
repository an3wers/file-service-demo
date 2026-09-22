/** RFC 5987 header so browsers save the file under its original name. */
export function contentDisposition(
  name: string,
  type: "attachment" | "inline",
): string {
  const asciiFallback = name.replaceAll(/[^\x20-\x7e]/g, "_").replaceAll(/["\\]/g, "_");

  return `${type}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
