/**
 * Клиентское зеркало `normalizeDirectory` из `server/src/s3/keys.ts`.
 *
 * Смысл — показать ошибку под инпутом до отправки, а не ловить 400 с сервера, и
 * вернуть ровно то нормализованное значение, которое вычислит сервер: тогда
 * `directory` в ответе совпадёт с тем, что пользователь видит в поле.
 */

const MAX_RAW_LENGTH = 1024 // zod `.max(1024)` на сервере — иначе 422
const MAX_SEGMENT_LENGTH = 100
const MAX_DIRECTORY_BYTES = 700 // именно БАЙТ: кириллица — 2 байта на символ

// Ровно тот диапазон, что режет сервер: C0-управляющие плюс DEL.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]")

export type DirectoryCheck =
  | { ok: true; value: string }
  | { ok: false; message: string }

const encoder = new TextEncoder()

function normalizeSegments(input: string): string[] {
  return input
    .normalize("NFC")
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
}

/** Длина нормализованного пути в UTF-8 байтах — та же величина, что меряет сервер. */
export function directoryByteLength(input: string): number {
  return encoder.encode(normalizeSegments(input).join("/")).length
}

export function checkDirectory(input: string): DirectoryCheck {
  // Пустой ввод валиден: это корень бакета, а не «значение не задано».
  if (!input.trim()) {
    return { ok: true, value: "" }
  }

  if (input.length > MAX_RAW_LENGTH) {
    return { ok: false, message: `Путь длиннее ${MAX_RAW_LENGTH} символов` }
  }

  const segments = normalizeSegments(input)

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      return { ok: false, message: "Сегменты «.» и «..» запрещены" }
    }

    if (CONTROL_CHARS.test(segment)) {
      return { ok: false, message: "Управляющие символы запрещены" }
    }

    if (segment.length > MAX_SEGMENT_LENGTH) {
      return {
        ok: false,
        message: `Сегмент длиннее ${MAX_SEGMENT_LENGTH} символов: «${segment.slice(0, 20)}…»`,
      }
    }
  }

  const value = segments.join("/")

  if (encoder.encode(value).length > MAX_DIRECTORY_BYTES) {
    return { ok: false, message: `Путь длиннее ${MAX_DIRECTORY_BYTES} байт в UTF-8` }
  }

  return { ok: true, value }
}

export { MAX_DIRECTORY_BYTES }
