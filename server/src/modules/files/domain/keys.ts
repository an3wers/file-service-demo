import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { InvalidDirectoryError, InvalidFileNameError } from "./errors.js";

const MAX_SEGMENT_LENGTH = 100;
const MAX_DIRECTORY_BYTES = 700;
const MAX_NAME_LENGTH = 255;
// eslint-disable-next-line no-control-regex -- намеренно вырезаем управляющие символы из ключа
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Turns a client-supplied directory into a safe object key prefix.
 *
 * The result never has leading, trailing or repeated slashes; the empty string
 * means "bucket root". This is the only place untrusted input becomes part of
 * an object key, so traversal segments are rejected outright rather than
 * silently rewritten.
 */
export function normalizeDirectory(input: string | undefined | null): string {
  if (!input) {
    return "";
  }

  const segments = input
    .normalize("NFC")
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new InvalidDirectoryError(`Directory segment "${segment}" is not allowed`);
    }

    if (CONTROL_CHARS.test(segment)) {
      throw new InvalidDirectoryError("Directory contains control characters");
    }

    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new InvalidDirectoryError(`Directory segment exceeds ${MAX_SEGMENT_LENGTH} characters`);
    }
  }

  const directory = segments.join("/");

  if (Buffer.byteLength(directory, "utf8") > MAX_DIRECTORY_BYTES) {
    throw new InvalidDirectoryError(`Directory path exceeds ${MAX_DIRECTORY_BYTES} bytes`);
  }

  return directory;
}

/** Strips any path the client may have sent along with the file name. */
export function sanitizeFileName(input: string): string {
  const name = input
    .normalize("NFC")
    .replaceAll("\\", "/")
    .split("/")
    .pop()
    ?.trim();

  if (!name || name === "." || name === ".." || CONTROL_CHARS.test(name)) {
    throw new InvalidFileNameError("File name is missing or not usable");
  }

  return name.slice(0, MAX_NAME_LENGTH);
}

export function fileExtension(name: string): string {
  const extension = extname(name).toLowerCase();

  return /^\.[a-z0-9]+$/.test(extension) ? extension.slice(1) : "";
}

/**
 * The key is derived before the bytes exist, which is what makes the presigned
 * flow possible: the server hands out a URL for a key it has already recorded.
 */
export function buildObjectKey(
  directory: string,
  originalName: string,
): { id: string; key: string; extension: string } {
  const id = randomUUID();
  const extension = fileExtension(originalName);
  const fileName = extension ? `${id}.${extension}` : id;

  return {
    id,
    key: directory ? `${directory}/${fileName}` : fileName,
    extension,
  };
}
