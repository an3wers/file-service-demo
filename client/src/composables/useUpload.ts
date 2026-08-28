import { ref, shallowRef } from "vue"
import type { FileDto } from "@/types/api"
import {
  completeUpload,
  presignUpload,
  putToPresignedUrl,
  uploadViaServer,
} from "@/api/files"
import { isApiError } from "@/api/client"

export type UploadMode = "server" | "presigned"
export type UploadStage = "idle" | "presigning" | "sending" | "completing"

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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function uploadPresigned(file: File, directory: string): Promise<FileDto> {
  stage.value = "presigning"

  const reservation = await presignUpload({
    filename: file.name,
    directory,
    // Именно `|| undefined`: у `contentType` на сервере `min(1)`, пустая строка
    // даст 422. Если тип не определён браузером, сервер сам подставит octet-stream.
    contentType: file.type || undefined,
    size: file.size,
  })

  stage.value = "sending"
  // Если этот шаг упадёт, `complete` НЕ вызываем: запись останется pending и её
  // разберёт серверный `npm run db:cleanup` (PENDING_TTL_HOURS).
  await putToPresignedUrl(reservation.uploadUrl, file, reservation.requiredHeaders)

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

  try {
    return mode.value === "server"
      ? await uploadViaServer(file, directory)
      : await uploadPresigned(file, directory)
  } finally {
    uploading.value = false
    stage.value = "idle"
  }
}

export function useUpload() {
  return { mode, uploading, stage, selectedFile, upload }
}
