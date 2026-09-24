import type { CookieOptions } from "express";

export const REFRESH_COOKIE = "refresh_token";

export const REFRESH_COOKIE_PATH = "/api/auth";

export function refreshCookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: "strict", path: REFRESH_COOKIE_PATH, secure };
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");

    if (separator === -1 || pair.slice(0, separator).trim() !== name) {
      continue;
    }

    const raw = pair.slice(separator + 1).trim().replace(/^"(.*)"$/, "$1");

    try {
      return decodeURIComponent(raw) || undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}
