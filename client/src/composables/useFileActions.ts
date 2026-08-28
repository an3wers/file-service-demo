import { toast } from "vue-sonner"
import type { FileDto } from "@/types/api"
import { deleteFile, getDownloadUrl } from "@/api/files"
import { isApiError } from "@/api/client"
import { errorMessage } from "@/lib/errors"
import { useFileBrowser } from "./useFileBrowser"

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
    toast.error(errorMessage(error, "Не удалось получить ссылку на скачивание"))
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

    toast.error(errorMessage(error, "Не удалось удалить файл"))
    throw error
  }
}

export function useFileActions() {
  return { download, downloadByUrl, remove }
}
