import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { InvalidDirectoryError, InvalidFileNameError } from "./errors.js";

const MAX_SEGMENT_LENGTH = 100;
const MAX_DIRECTORY_BYTES = 700;
const MAX_NAME_LENGTH = 255;
// eslint-disable-next-line no-control-regex -- намеренно вырезаем управляющие символы из ключа
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Превращает каталог от клиента в безопасный префикс объектного ключа.
 *
 * Результат не содержит начальных, конечных и повторяющихся слешей;
 * пустая строка означает корень бакета. Здесь недоверенный ввод становится
 * частью объектного ключа, поэтому сегменты обхода пути отклоняются,
 * а не исправляются молча.
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
      throw new InvalidDirectoryError(
        `Directory segment "${segment}" is not allowed`,
      );
    }

    if (CONTROL_CHARS.test(segment)) {
      throw new InvalidDirectoryError("Directory contains control characters");
    }

    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new InvalidDirectoryError(
        `Directory segment exceeds ${MAX_SEGMENT_LENGTH} characters`,
      );
    }
  }

  const directory = segments.join("/");

  if (Buffer.byteLength(directory, "utf8") > MAX_DIRECTORY_BYTES) {
    throw new InvalidDirectoryError(
      `Directory path exceeds ${MAX_DIRECTORY_BYTES} bytes`,
    );
  }

  return directory;
}

/** Убирает путь, который клиент мог передать вместе с именем файла. */
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
 * Объектный ключ задаётся до появления байтов, чтобы сервер мог выдать
 * подписанную ссылку на ключ, уже сохранённый в строке метаданных.
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

export function normalizeDirectoryName(input: string): string {
  const name = input.normalize("NFC").trim();
  if (
    !name ||
    name.includes("/") ||
    name.includes("\\") ||
    CONTROL_CHARS.test(input)
  ) {
    throw new InvalidDirectoryError(
      "Directory name must be one non-empty segment",
    );
  }
  return normalizeDirectory(name);
}
