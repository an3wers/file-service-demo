import type { ValidationDetails } from "@/types/api"
import { ApiError } from "@/api/client"

/**
 * Единственное место, где коды API превращаются в текст для пользователя.
 * Компоненты формулировок не пишут. Список зеркалит `ERROR_CODES` сервера
 * (`server/src/errors.ts`) плюс коды, которые заводит сам клиент.
 */
const MESSAGES: Record<string, string> = {
  UNAUTHORIZED:
    "Неверный API-ключ. Проверьте VITE_API_KEY и перезапустите dev-сервер",
  ROUTE_NOT_FOUND: "Метод API не найден — клиент и сервер разошлись по версиям",
  VALIDATION_ERROR: "Некорректные параметры запроса",
  INTERNAL_SERVER_ERROR: "Внутренняя ошибка сервера",

  FILE_REQUIRED: "Файл не выбран",
  UPLOAD_REJECTED: "Форма загрузки отклонена: отправьте ровно один файл",
  PAYLOAD_TOO_LARGE: "Файл больше 50 МБ — загрузите его напрямую в S3 (presigned)",
  INVALID_DIRECTORY: "Недопустимый путь директории",
  INVALID_FILE_NAME: "Недопустимое имя файла",

  FILE_NOT_FOUND: "Файл не найден — возможно, он уже удалён",
  FILE_NOT_READY: "Файл ещё не готов к скачиванию",
  UPLOAD_NOT_COMPLETED: "Объект не найден в хранилище: загрузка в S3 не завершилась",
  DUPLICATE_RESOURCE: "Такая запись уже существует",

  STORAGE_UNAVAILABLE: "Хранилище временно недоступно — попробуйте ещё раз",
  STORAGE_MISCONFIGURED:
    "Хранилище отклонило запрос: на сервере не тот бакет или ключи",
  STORAGE_ERROR: "Ошибка хранилища — операция не выполнена",

  DATABASE_UNAVAILABLE: "База данных недоступна — попробуйте ещё раз",
  DATABASE_TIMEOUT: "База данных не ответила вовремя — попробуйте ещё раз",

  // Коды самого клиента: сервер их не отдаёт.
  NETWORK_ERROR: "Сервер недоступен",
  S3_UPLOAD_FAILED: "Хранилище отклонило загрузку (проверьте CORS бакета и порт 5173)",
  UNKNOWN: "Непонятный ответ сервера — попробуйте ещё раз",
}

function isValidationDetails(details: unknown): details is ValidationDetails {
  return (
    typeof details === "object" &&
    details !== null &&
    "fieldErrors" in details &&
    typeof (details as ValidationDetails).fieldErrors === "object"
  )
}

/** Плоский список сообщений из `details` 422-ответа (результат `z.flattenError()`). */
export function validationFieldErrors(error: unknown): string[] {
  if (!(error instanceof ApiError) || !isValidationDetails(error.details)) {
    return []
  }

  const { formErrors, fieldErrors } = error.details
  const fields = Object.entries(fieldErrors ?? {}).flatMap(([field, messages]) =>
    (messages ?? []).map((message) => `${field}: ${message}`),
  )

  return [...(formErrors ?? []), ...fields]
}

export function errorMessage(error: unknown, fallback = "Что-то пошло не так"): string {
  if (error instanceof ApiError) {
    const base = MESSAGES[error.code]

    if (error.code === "VALIDATION_ERROR") {
      const fields = validationFieldErrors(error)

      return fields.length > 0
        ? `${MESSAGES.VALIDATION_ERROR}: ${fields.join("; ")}`
        : MESSAGES.VALIDATION_ERROR
    }

    // Сообщение сервера — осмысленный запасной вариант для кодов, которых нет в таблице.
    return base ?? error.message ?? fallback
  }

  return error instanceof Error ? error.message : fallback
}

/**
 * Имеет ли смысл повторить операцию. Сервер специально развёл 502 и 503: 503 —
 * зависимость не ответила, через секунду может ответить; 502 — сломана
 * конфигурация сервера, и повтором она не чинится. `status === 0` — сетевой
 * сбой или непрозрачный CORS: деталей браузер не дал, повторить стоит.
 */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return false
  }

  return error.status === 503 || error.status === 0
}

/**
 * «Код обращения» для 5xx — тот же `requestId`, что и в строке лога `pino-http`.
 * Без него по жалобе пользователя причину в логе не найти.
 */
export function requestReference(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status < 500) {
    return null
  }

  return error.requestId === undefined ? null : `Код обращения: ${error.requestId}`
}
