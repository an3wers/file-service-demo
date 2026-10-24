export function safeReturnTo(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    [...value].some((character) => character.charCodeAt(0) <= 32)
  )
    return "/";
  try {
    const url = new URL(value, "https://internal.invalid");
    const path = decodeURIComponent(url.pathname).toLowerCase();
    if (
      url.origin !== "https://internal.invalid" ||
      path.startsWith("//") ||
      path.includes("\\") ||
      /^\/(login|register|activation|password-reset)(\/|$)/.test(path)
    )
      return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
