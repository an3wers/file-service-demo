import { buildObjectKey, normalizeDirectory, sanitizeFileName } from "../../storage/keys.js";

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export function expiresAt(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** An id, a key and the names that go on the row, fixed before any bytes exist. */
export interface Reservation {
  id: string;
  key: string;
  directory: string;
  originalName: string;
  extension: string;
  contentType: string;
}

/**
 * The step every upload path starts with, whichever way the bytes arrive: the
 * client's directory and filename are normalized, and the key is derived from
 * the directory and a fresh id rather than from the name.
 */
export function reserveKey(input: {
  filename: string;
  directory?: string | undefined;
  contentType?: string | undefined;
}): Reservation {
  const directory = normalizeDirectory(input.directory);
  const originalName = sanitizeFileName(input.filename);
  const { id, key, extension } = buildObjectKey(directory, originalName);

  return {
    id,
    key,
    directory,
    originalName,
    extension,
    contentType: input.contentType || DEFAULT_CONTENT_TYPE,
  };
}
