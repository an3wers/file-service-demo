import { computed, ref, shallowRef } from "vue"
import type { UploadOptions } from "@/api/client"
import type { FileDto } from "@/types/api"
import {
  completeUpload,
  presignUpload,
  putToPresignedUrl,
  uploadViaServer,
} from "@/api/files"
import { isApiError } from "@/api/client"

export type UploadMode = "server" | "presigned"
export type UploadStage =
  | "idle"
  | "presigning"
  | "sending"
  | "processing"
  | "completing"

/** Справочная константа: настоящий лимит живёт на сервере и приходит как 413. */
export const MAX_UPLOAD_SIZE_MB = Number(
  import.meta.env.VITE_MAX_UPLOAD_SIZE_MB ?? "50",
)
export const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024

const mode = ref<UploadMode>("server")
const uploading = ref(false)
const stage = ref<UploadStage>("idle")
// Глубокая реактивность на File не нужна и только мешает.
const selectedFile = shallowRef<File | null>(null)

const sentBytes = ref(0)
const totalBytes = ref(0)
/** 0…100 по отправленному телу. Ответ сервера сюда не входит — см. `stage`. */
const percent = computed(() =>
  totalBytes.value > 0
    ? Math.min(100, Math.round((sentBytes.value / totalBytes.value) * 100))
    : // Пустой файл: отправлять нечего, и событий прогресса по нему не будет.
      100,
)
// Отмена имеет смысл, только пока тело не ушло целиком: после этого сервер (или
// S3) доведёт загрузку до конца независимо от нас.
const cancellable = computed(
  () =>
    uploading.value &&
    (stage.value === "presigning" || stage.value === "sending"),
)

// Не ref: контроллер нужен только императивно, реактивность на нём бесполезна.
let controller: AbortController | null = null

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Колбэки XHR: прогресс тела и переход в стадию ожидания ответа. */
function trackSending(signal: AbortSignal, next: UploadStage): UploadOptions {
  return {
    signal,
    onProgress: ({ loaded, total }) => {
      sentBytes.value = loaded

      // У multipart тело больше файла, а при неизвестном размере оставляем оценку.
      if (total !== null) {
        totalBytes.value = total
      }
    },
    // Байты ушли, но работа не закончена: дальше сервер или S3.
    onSent: () => {
      stage.value = next
    },
  }
}

async function uploadPresigned(
  file: File,
  directory: string,
  signal: AbortSignal,
): Promise<FileDto> {
  stage.value = "presigning"

  const reservation = await presignUpload(
    {
      filename: file.name,
      directory,
      // Именно `|| undefined`: у `contentType` на сервере `min(1)`, пустая строка
      // даст 422. Если тип не определён браузером, сервер сам подставит octet-stream.
      contentType: file.type || undefined,
      size: file.size,
    },
    signal,
  )

  stage.value = "sending"
  // Если этот шаг упадёт (в том числе от отмены), `complete` НЕ вызываем: запись
  // останется pending и её разберёт серверный `npm run db:cleanup` (PENDING_TTL_HOURS).
  await putToPresignedUrl(
    reservation.uploadUrl,
    file,
    reservation.requiredHeaders,
    trackSending(signal, "processing"),
  )

  stage.value = "completing"

  try {
    return await completeUpload(reservation.id)
  } catch (error) {
    // S3 бывает виден не мгновенно — одна повторная попытка и только потом ошибка.
    if (isApiError(error) && error.code === "UPLOAD_NOT_COMPLETED") {
      await delay(800)

      return await completeUpload(reservation.id)
    }

    throw error
  }
}

/** Директория должна быть уже нормализована через `checkDirectory`. */
async function upload(file: File, directory: string): Promise<FileDto> {
  uploading.value = true
  sentBytes.value = 0
  // Размер файла как стартовая оценка: до первого события прогресса шкала уже нужна.
  totalBytes.value = file.size
  controller = new AbortController()

  const { signal } = controller

  try {
    return mode.value === "server"
      ? await uploadViaServer(
          file,
          directory,
          trackSending(signal, "processing"),
        )
      : await uploadPresigned(file, directory, signal)
  } finally {
    uploading.value = false
    stage.value = "idle"
    controller = null
  }
}

/** Прерывает отправку: вызывающий получит `AbortError` из `upload`. */
function cancel(): void {
  controller?.abort()
}

export function useUpload() {
  return {
    mode,
    uploading,
    stage,
    selectedFile,
    sentBytes,
    totalBytes,
    percent,
    cancellable,
    upload,
    cancel,
  }
}
