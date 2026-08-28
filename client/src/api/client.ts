import type { ApiErrorBody } from "@/types/api"

export class ApiError extends Error {
  status: number
  code: string
  details?: unknown

  // Параметры-свойства (`constructor(readonly x)`) запрещены `erasableSyntaxOnly`.
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.details = details
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

type QueryValue = string | number | boolean | undefined | null

/**
 * Правила сборки продиктованы zod-схемами сервера:
 * - `undefined`/`null` пропускаем — `page=` даёт 422, а не «значение по умолчанию»;
 * - булевы уходят как "true"/"false" — других литералов схема не принимает;
 * - строку кладём как есть, **включая пустую**: `directory=""` означает «корень»,
 *   и это не то же самое, что отсутствие параметра (= файлы из всех директорий).
 *   Отбросить пустой `search` — ответственность вызывающего (`search || undefined`).
 */
export function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue
    }

    if (typeof value === "boolean") {
      search.set(key, value ? "true" : "false")
      continue
    }

    if (typeof value === "number") {
      if (Number.isFinite(value)) {
        search.set(key, String(value))
      }
      continue
    }

    search.set(key, value)
  }

  const query = search.toString()

  return query ? `?${query}` : ""
}

function parseBody(text: string): unknown {
  if (!text) {
    return null
  }

  try {
    return JSON.parse(text)
  } catch {
    // Страница ошибки прокси или ответ S3 — не JSON.
    return null
  }
}

/** Достаёт code/message из тела ответа; понимает и JSON сервера, и XML от S3. */
export function parseErrorBody(
  status: number,
  text: string,
): { code: string; message: string; details?: unknown } {
  const body = parseBody(text) as ApiErrorBody | null

  if (body?.error?.code) {
    return {
      code: body.error.code,
      message: body.error.message || `HTTP ${status}`,
      details: body.error.details,
    }
  }

  const s3Code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1]

  if (s3Code) {
    const s3Message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1]

    return { code: "S3_UPLOAD_FAILED", message: s3Message ?? s3Code, details: { s3Code } }
  }

  return { code: "UNKNOWN", message: `HTTP ${status}` }
}

/**
 * Запросы идут по относительному пути через vite-прокси, поэтому CORS сервера
 * в игру не вступает ни в dev, ни в `vite preview`.
 */
export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)

  headers.set("X-API-Key", import.meta.env.VITE_API_KEY)
  // Content-Type здесь не выставляем никогда: JSON-вызовы ставят его сами, а у
  // FormData его должен проставить браузер — иначе потеряется boundary.

  let response: Response

  try {
    response = await fetch(`/api${path}`, { ...init, headers })
  } catch (error) {
    // AbortError вызывающий код гасит молча, сетевой сбой — показывает.
    if (isAbortError(error)) {
      throw error
    }

    throw new ApiError(0, "NETWORK_ERROR", "Сервер недоступен")
  }

  if (response.status === 204) {
    // Простое `undefined as T` не компилируется в строгом режиме.
    return undefined as unknown as T
  }

  const text = await response.text()

  if (!response.ok) {
    const { code, message, details } = parseErrorBody(response.status, text)

    throw new ApiError(response.status, code, message, details)
  }

  return parseBody(text) as T
}
