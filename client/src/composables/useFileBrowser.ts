import { computed, ref, watch } from "vue"
import { useDebounceFn } from "@vueuse/core"
import type { DirectoryDto, FileDto, Pagination, SortField, SortOrder } from "@/types/api"
import { listDirectories } from "@/api/directories"
import { listFiles } from "@/api/files"
import { isAbortError } from "@/api/client"
import { errorMessage, isRetryable, requestReference } from "@/lib/errors"

/** Ошибка списка: текст плюс то, что решает, как её показать. */
export interface BrowserError {
  message: string
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
  // Сервер не фильтрует директории по `search`, а на второй странице списка
  // папки неуместны — в этих случаях подставляем пустой список без запроса.
  const wantDirectories = !term && page.value === 1

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
      wantDirectories
        ? listDirectories(directory.value, signal)
        : Promise.resolve({ parent: directory.value, items: [] }),
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
  page.value = 1
  void load()
}

watch(
  searchInput,
  useDebounceFn(() => {
    const next = searchInput.value.trim()

    if (next === search.value) {
      return
    }

    search.value = next
    applyFilters()
  }, 350),
)

function openDirectory(path: string): void {
  directory.value = path
  searchInput.value = ""
  search.value = ""
  applyFilters()
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
  page.value = next
  void load()
}

function refresh(): void {
  void load()
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
    reset,
  }
}
