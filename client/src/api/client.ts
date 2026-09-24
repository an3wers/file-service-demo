import type { AuthSession } from "@/api/generated";
import type { ApiErrorBody } from "@/types/api";
import {
  expireSession,
  getAccessToken,
  isRenewalDue,
  shareRenewal,
} from "./session";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  /** Тот же id, что и в строке лога сервера; есть только у JSON-ошибок API. */
  requestId?: string | number;

  // Параметры-свойства (`constructor(readonly x)`) запрещены `erasableSyntaxOnly`.
  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    requestId?: string | number,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

type QueryValue = string | number | boolean | undefined | null;

/**
 * Правила сборки продиктованы zod-схемами сервера:
 * - `undefined`/`null` пропускаем — `page=` даёт 422, а не «значение по умолчанию»;
 * - булевы уходят как "true"/"false" — других литералов схема не принимает;
 * - строку кладём как есть, **включая пустую**: `directory=""` означает «корень»,
 *   и это не то же самое, что отсутствие параметра (= файлы из всех директорий).
 *   Отбросить пустой `search` — ответственность вызывающего (`search || undefined`).
 */
export function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value === "boolean") {
      search.set(key, value ? "true" : "false");
      continue;
    }

    if (typeof value === "number") {
      if (Number.isFinite(value)) {
        search.set(key, String(value));
      }
      continue;
    }

    search.set(key, value);
  }

  const query = search.toString();

  return query ? `?${query}` : "";
}

function parseBody(text: string): unknown {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    // Страница ошибки прокси или ответ S3 — не JSON.
    return null;
  }
}

/** Достаёт code/message из тела ответа; понимает и JSON сервера, и XML от S3. */
export function parseErrorBody(
  status: number,
  text: string,
): {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string | number;
} {
  const body = parseBody(text) as ApiErrorBody | null;

  if (body?.error?.code) {
    return {
      code: body.error.code,
      message: body.error.message || `HTTP ${status}`,
      details: body.error.details,
      // Только у ответа сервера: ни у XML от S3, ни у фолбэка ниже его нет.
      requestId: body.error.requestId,
    };
  }

  const s3Code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];

  if (s3Code) {
    const s3Message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];

    return {
      code: "S3_UPLOAD_FAILED",
      message: s3Message ?? s3Code,
      details: { s3Code },
    };
  }

  return { code: "UNKNOWN", message: `HTTP ${status}` };
}

/**
 * Запросы идут по относительному пути через vite-прокси, поэтому CORS сервера
 * в игру не вступает ни в dev, ни в `vite preview`.
 */
export async function sendRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`/api${path}`, init);
  } catch (error) {
    // AbortError вызывающий код гасит молча, сетевой сбой — показывает.
    if (isAbortError(error)) {
      throw error;
    }

    throw new ApiError(0, "NETWORK_ERROR", "Сервер недоступен");
  }

  if (response.status === 204) {
    // Простое `undefined as T` не компилируется в строгом режиме.
    return undefined as unknown as T;
  }

  const text = await response.text();

  if (!response.ok) {
    const { code, message, details, requestId } = parseErrorBody(
      response.status,
      text,
    );

    throw new ApiError(response.status, code, message, details, requestId);
  }

  return parseBody(text) as T;
}

export function renewSession(): Promise<void> {
  return shareRenewal(async () => {
    try {
      return await sendRequest<AuthSession>("/auth/refresh", { method: "POST" });
    } catch (error) {
      if (isApiError(error) && error.status === 401) {
        expireSession();
      }

      throw error;
    }
  });
}

async function withSession<T>(
  run: (authorization: Record<string, string>) => Promise<T>,
): Promise<T> {
  if (isRenewalDue()) {
    await renewSession();
  }

  const token = getAccessToken();
  const authorize = (value: string | null): Record<string, string> =>
    value ? { Authorization: `Bearer ${value}` } : {};

  try {
    return await run(authorize(token));
  } catch (error) {
    if (!isApiError(error) || error.status !== 401) {
      throw error;
    }

    if (error.code !== "UNAUTHORIZED") {
      expireSession();
      throw error;
    }

    if (token === null) {
      throw error;
    }

    if (getAccessToken() === token) {
      await renewSession();
    }

    return await run(authorize(getAccessToken()));
  }
}

export function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Content-Type здесь не выставляем никогда: JSON-вызовы ставят его сами, а у
  // FormData его должен проставить браузер — иначе потеряется boundary.
  return withSession((authorization) => {
    const headers = new Headers(init.headers);

    for (const [name, value] of Object.entries(authorization)) {
      headers.set(name, value);
    }

    return sendRequest<T>(path, { ...init, headers });
  });
}

/** Прогресс отправки тела запроса. `total === null` — размер неизвестен. */
export interface UploadProgress {
  loaded: number;
  total: number | null;
}

export interface UploadOptions {
  onProgress?: (progress: UploadProgress) => void;
  /** Тело ушло целиком, но ответ ещё не получен: дальше ждём сервер/хранилище. */
  onSent?: () => void;
  signal?: AbortSignal;
}

type XhrOptions = UploadOptions & { headers?: Record<string, string> };

function abortError(): DOMException {
  // Ровно та же форма ошибки, что у fetch, — её ловит `isAbortError`.
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * fetch не сообщает, сколько байт тела уже ушло, поэтому файлы отправляем через
 * XHR. Возвращает сырой ответ: трактовка статуса — на вызывающем, у сервера и у
 * S3 она разная.
 */
export function xhrSend(
  method: string,
  url: string,
  body: XMLHttpRequestBodyInit,
  options: XhrOptions = {},
): Promise<{ status: number; text: string }> {
  const { headers = {}, onProgress, onSent, signal } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());

      return;
    }

    const xhr = new XMLHttpRequest();
    const abort = (): void => xhr.abort();
    const settle = (finish: () => void): void => {
      signal?.removeEventListener("abort", abort);
      finish();
    };

    xhr.open(method, url, true);

    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }

    // События прогресса живут на xhr.upload — на самом xhr это загрузка ОТВЕТА.
    xhr.upload.addEventListener("progress", (event) => {
      onProgress?.({
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : null,
      });
    });

    xhr.upload.addEventListener("load", () => onSent?.());

    xhr.addEventListener("load", () => {
      settle(() => resolve({ status: xhr.status, text: xhr.responseText }));
    });

    xhr.addEventListener("error", () => {
      // Сюда же приходит непрозрачный CORS-сбой: деталей браузер не даёт.
      settle(() => reject(new ApiError(0, "NETWORK_ERROR", "Сервер недоступен")));
    });

    xhr.addEventListener("timeout", () => {
      settle(() => reject(new ApiError(0, "NETWORK_ERROR", "Сервер недоступен")));
    });

    xhr.addEventListener("abort", () => {
      settle(() => reject(abortError()));
    });

    signal?.addEventListener("abort", abort, { once: true });

    xhr.send(body);
  });
}

/**
 * Аналог `apiRequest` для отправки файла: тот же префикс, токен и разбор ошибок,
 * но поверх XHR — ради прогресса.
 */
export function apiUpload<T>(
  path: string,
  body: XMLHttpRequestBodyInit,
  options: UploadOptions = {},
): Promise<T> {
  // Content-Type не трогаем: у FormData его вместе с boundary ставит браузер.
  return withSession((headers) => sendUpload<T>(path, body, { ...options, headers }));
}

async function sendUpload<T>(
  path: string,
  body: XMLHttpRequestBodyInit,
  options: XhrOptions,
): Promise<T> {
  const { status, text } = await xhrSend("POST", `/api${path}`, body, options);

  if (status === 204) {
    return undefined as unknown as T;
  }

  if (status < 200 || status >= 300) {
    const { code, message, details, requestId } = parseErrorBody(status, text);

    throw new ApiError(status, code, message, details, requestId);
  }

  return parseBody(text) as T;
}
