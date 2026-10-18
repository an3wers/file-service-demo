import {
  buildObjectKey,
  normalizeDirectory,
  sanitizeFileName,
} from "./keys.js";
import type { Clock } from "./ports/clock.js";

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/** Читает общие часы сценариев вместо прямого вызова `Date.now()`. */
export function expiresAt(clock: Clock, seconds: number): Date {
  return new Date(clock.now().getTime() + seconds * 1000);
}

/** Идентификатор, объектный ключ и имена фиксируются до появления байтов. */
export interface Reservation {
  id: string;
  key: string;
  directory: string;
  originalName: string;
  extension: string;
  contentType: string;
}

/**
 * Первый шаг любого способа загрузки: нормализует каталог и имя файла
 * от клиента. Объектный ключ строится из каталога и нового идентификатора,
 * а не из имени файла.
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
