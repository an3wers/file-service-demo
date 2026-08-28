import type { ValidationDetails } from "@/types/api"
import { ApiError } from "@/api/client"

/**
 * Единственное место, где коды API превращаются в текст для пользователя.
 * Компоненты формулировок не пишут.
 */
const MESSAGES: Record<string, string> = {
  UNAUTHORIZED:
    "Неверный API-ключ. Проверьте VITE_API_KEY и перезапустите dev-сервер",
  FILE_REQUIRED: "Файл не выбран",
  INVALID_DIRECTORY: "Недопустимый путь директории",
  INVALID_FILE_NAME: "Недопустимое имя файла",
  LIMIT_FILE_SIZE: "Файл больше 50 МБ — загрузите его напрямую в S3 (presigned)",
  PAYLOAD_TOO_LARGE: "Файл больше 50 МБ — загрузите его напрямую в S3 (presigned)",
  VALIDATION_ERROR: "Некорректные параметры запроса",
  FILE_NOT_FOUND: "Файл не найден — возможно, он уже удалён",
  UPLOAD_NOT_COMPLETED: "Объект не найден в хранилище: загрузка в S3 не завершилась",
  FILE_NOT_READY: "Файл ещё не готов к скачиванию",
  INTERNAL_SERVER_ERROR: "Внутренняя ошибка сервера",
  NETWORK_ERROR: "Сервер недоступен",
  S3_UPLOAD_FAILED: "Хранилище отклонило загрузку (проверьте CORS бакета и порт 5173)",
}

function isValidationDetails(details: unknown): details is ValidationDetails {
  return (
    typeof details === "object" &&
    details !== null &&
    "fieldErrors" in details &&
    typeof (details as ValidationDetails).fieldErrors === "object"
  )
}

/** Плоский список сообщений из `details` 422-ответа (результат `z.flatten()`). */
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
