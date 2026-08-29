import { toast } from "vue-sonner"
import type { FileDto } from "@/types/api"
import { deleteFile, getDownloadUrl } from "@/api/files"
import { isApiError } from "@/api/client"
import { errorMessage, isRetryable, requestReference } from "@/lib/errors"
import { useFileBrowser } from "./useFileBrowser"

/**
 * Общая обвязка тоста ошибки: номер обращения для 5xx (по нему причина ищется в
 * логе сервера) и повтор действия там, где он осмыслен — при 502 конфигурация
 * сервера сломана, и повторять нечего.
 */
function errorToast(error: unknown, fallback: string, retry: () => void): void {
  toast.error(errorMessage(error, fallback), {
    description: requestReference(error) ?? undefined,
    action: isRetryable(error)
      ? { label: "Повторить", onClick: () => retry() }
      : undefined,
  })
}

/**
 * Навигация, а не `window.open`: после `await` открытие окна попадает под
 * блокировку всплывающих окон, а `location.assign` — нет. Страница при этом
 * никуда не уходит, потому что presigned-GET несёт `Content-Disposition:
 * attachment` с RFC 5987 `filename*` — браузер просто сохраняет файл. Гонять
 * байты через Blob не нужно и вредно; атрибут `download` на кросс-origin ссылке
 * браузер всё равно игнорирует.
 */
function navigateToDownload(url: string): void {
  window.location.assign(url)
}

async function download(file: FileDto): Promise<void> {
  try {
    // Ссылка живёт 300 секунд, поэтому её всегда берут заново, а не кэшируют.
    const { url } = await getDownloadUrl(file.id, "attachment")

    navigateToDownload(url)
  } catch (error) {
    errorToast(error, "Не удалось получить ссылку на скачивание", () =>
      void download(file),
    )
  }
}

/** В карточке `downloadUrl` уже получен через `?withUrl=true` — лишний запрос не делаем. */
function downloadByUrl(url: string): void {
  navigateToDownload(url)
}

async function remove(file: FileDto): Promise<void> {
  const browser = useFileBrowser()

  try {
    await deleteFile(file.id)
    toast.success(`Файл «${file.name}» удалён`)
    browser.refresh()
  } catch (error) {
    // 404 означает «уже удалён» — список всё равно надо обновить.
    if (isApiError(error) && error.status === 404) {
      toast.info(`Файл «${file.name}» уже был удалён`)
      browser.refresh()
      return
    }

    // Повтор из тоста идёт мимо диалога, поэтому проброс наверх здесь гасим:
    // ошибку второй попытки покажет тот же `errorToast`.
    errorToast(error, "Не удалось удалить файл", () => {
      void remove(file).catch(() => undefined)
    })
    throw error
  }
}

export function useFileActions() {
  return { download, downloadByUrl, remove }
}
