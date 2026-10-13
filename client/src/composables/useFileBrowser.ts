import { computed, ref } from "vue"
import type { DirectoryDto, FileDto, Pagination, SortField, SortOrder } from "@/types/api"
import { listDirectories } from "@/api/directories"
import { listFiles } from "@/api/files"
import { isAbortError, isApiError } from "@/api/client"
import { errorMessage, isRetryable, requestReference } from "@/lib/errors"

/** Ошибка списка: текст плюс то, что решает, как её показать. */
export interface BrowserError {
  message: string
  directoryNotFound: boolean
  /** Повтор имеет смысл (503 или сетевой сбой) — в UI появляется «Повторить». */
  retryable: boolean
  /** «Код обращения: N» для 5xx, иначе `null`. */
  reference: string | null
}

/**
 * Состояние живёт на уровне модуля: страница одна, браузер файлов один. Так
 * `UploadPanel` читает текущую папку и дёргает `refresh()` без проброса пропсов
 * через три уровня.
 */
const directory = ref("") // "" = корень бакета
const searchInput = ref("") // то, что в поле
const search = ref("") // дебаунснутое значение, уходит в запрос
const page = ref(1)
const limit = ref(20)
const sort = ref<SortField>("created_at")
const order = ref<SortOrder>("desc")

const files = ref<FileDto[]>([])
const directories = ref<DirectoryDto[]>([])
const pagination = ref<Pagination | null>(null)
const loading = ref(false)
const error = ref<BrowserError | null>(null)

let controller: AbortController | null = null
let requestId = 0
export interface BrowserView {
  directory: string
  search: string
  page: number
}

let navigate: ((view: BrowserView) => void) | null = null

const breadcrumbs = computed<{ label: string; path: string }[]>(() => {
  const crumbs = [{ label: "Все файлы", path: "" }]
  const segments = directory.value.split("/").filter(Boolean)

  segments.forEach((segment, index) => {
    crumbs.push({ label: segment, path: segments.slice(0, index + 1).join("/") })
  })

  return crumbs
})

async function load(): Promise<void> {
  controller?.abort()
  controller = new AbortController()

  const { signal } = controller
  // `abort()` не гарантирует, что предыдущий ответ ещё не в пути, поэтому
  // результат дополнительно сверяется по инкрементному идентификатору.
  const id = ++requestId

  loading.value = true
  error.value = null

  const term = search.value
  try {
    const [filesResponse, directoriesResponse] = await Promise.all([
      listFiles(
        {
          directory: directory.value,
          // Пустой `recursive` не шлём вовсе: дефолт сервера — false.
          recursive: term ? true : undefined,
          search: term || undefined,
          page: page.value,
          limit: limit.value,
          sort: sort.value,
          order: order.value,
        },
        signal,
      ),
      listDirectories(directory.value, signal),
    ])

    if (id !== requestId) {
      return
    }

    files.value = filesResponse.items
    pagination.value = filesResponse.pagination
    directories.value = directoriesResponse.items
  } catch (cause) {
    if (isAbortError(cause) || id !== requestId) {
      return
    }

    files.value = []
    directories.value = []
    pagination.value = null
    error.value = {
      message: errorMessage(cause, "Не удалось загрузить список файлов"),
      directoryNotFound: isApiError(cause) && cause.code === "DIRECTORY_NOT_FOUND",
      retryable: isRetryable(cause),
      reference: requestReference(cause),
    }
  } finally {
    if (id === requestId) {
      loading.value = false
    }
  }
}

function applyFilters(): void {
  changeView({ directory: directory.value, search: search.value, page: 1 })
}

function changeView(view: BrowserView): void {
  if (navigate) navigate(view)
  else restoreView(view)
}

function applySearch(value: string): void {
  changeView({ directory: directory.value, search: value, page: 1 })
}

function openDirectory(path: string): void {
  changeView({ directory: path, search: "", page: 1 })
}

function goTo(path: string): void {
  openDirectory(path)
}

function toggleSort(field: SortField): void {
  if (sort.value === field) {
    order.value = order.value === "asc" ? "desc" : "asc"
  } else {
    sort.value = field
    order.value = "desc"
  }

  applyFilters()
}

function setLimit(next: number): void {
  limit.value = next
  applyFilters()
}

function setPage(next: number): void {
  changeView({ directory: directory.value, search: search.value, page: next })
}

function refresh(): void {
  void load()
}

function restoreView(view: BrowserView): void {
  directory.value = view.directory
  searchInput.value = view.search
  search.value = view.search
  page.value = view.page
  void load()
}

function bindNavigation(handler: (view: BrowserView) => void): () => void {
  navigate = handler
  return () => {
    if (navigate === handler) {
      navigate = null
      controller?.abort()
      requestId += 1
      loading.value = false
    }
  }
}

function reset(): void {
  controller?.abort()
  controller = null
  requestId += 1
  directory.value = ""
  searchInput.value = ""
  search.value = ""
  page.value = 1
  files.value = []
  directories.value = []
  pagination.value = null
  loading.value = false
  error.value = null
}

export function useFileBrowser() {
  return {
    directory,
    searchInput,
    search,
    page,
    limit,
    sort,
    order,
    files,
    directories,
    pagination,
    loading,
    error,
    breadcrumbs,
    openDirectory,
    goTo,
    toggleSort,
    setLimit,
    setPage,
    refresh,
    restoreView,
    bindNavigation,
    applySearch,
    reset,
  }
}
