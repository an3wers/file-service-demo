# Клиентская часть файлового сервиса (MVP) — Vue 3 + shadcn-vue

## Context

Сервер (`server/`) реализован целиком и задокументирован в [`server/README.md`](../server/README.md):
загрузка через прокси и через presigned URL, метаданные в PostgreSQL, список файлов, дерево
директорий, карточка файла, скачивание по presigned-ссылке, мягкое удаление.

В `client/` при этом только каркас: `App.vue` содержит `<p>my app</p>`. Настроены Vite 8, Tailwind v4,
shadcn-vue (new-york / neutral / lucide), алиас `@/`, dev+preview прокси `/api` и `/health` на
`http://localhost:3000`, и лежат 13 ui-компонентов. Ни одного запроса к API, ни одного экрана нет.

Нужно собрать одностраничный интерфейс, который закрывает четыре сценария: загрузка файла в двух
режимах, указание директории, просмотр дерева папок и файлов, скачивание файла и просмотр его
метаданных. Роутинг не используем — всё на одной странице.

**Решения, принятые пользователем:** режим загрузки выбирается явным переключателем (не авто по
размеру); список — в стиле файлового менеджера (крошки + таблица «папки сверху, файлы ниже»);
карточка файла — в модальном `Dialog`; в объём входят удаление файла, поиск и пагинация; API-ключ
берётся из `.env` при сборке (`VITE_API_KEY`) — то, что он попадает в бандл, принято осознанно.

---

## Что уже есть и переиспользуется

| Актив | Путь | Как используем |
|---|---|---|
| `cn()` | `src/lib/utils.ts` | без изменений |
| Тема shadcn (все CSS-переменные, `.dark`) | `src/style.css` | без изменений |
| Алиас `@/` | `vite.config.ts` + `tsconfig.app.json` | без изменений |
| Прокси `/api` и `/health` (dev **и** preview) | `vite.config.ts` | клиент ходит по относительным путям, CORS сервера в игру не вступает |
| 13 ui-компонентов | `src/components/ui/{accordion,badge,button,card,checkbox,collapsible,input,input-group,label,select,separator,skeleton,textarea}` | badge, button, card, input, input-group, label, select, separator, skeleton — в дело |
| `@vueuse/core` 14.4 (установлен, нигде не используется) | — | `useDebounceFn` для поиска, `useFileDialog` для выбора файла |
| `@lucide/vue` | — | иконки |

Ничего из этого не пересоздаём.

---

## Ограничения окружения, которые определяют код

Это не догадки — они вытекают из конфигов проекта и кода сервера.

- **`erasableSyntaxOnly: true`** в `tsconfig.app.json` → **нельзя** TS-`enum`, **нельзя** параметры-свойства
  в конструкторе (`constructor(readonly x: number)`), нельзя namespace. Union-типы и `as const` — можно.
- **`noUnusedLocals` / `noUnusedParameters`** → неиспользуемый импорт валит `npm run build`.
- **`verbatimModuleSyntax: true`** (из `@vue/tsconfig`) → типы импортировать только через `import type`.
- **`undefined as T` не компилируется** при строгом режиме — для ветки 204 писать `undefined as unknown as T`.
- **`src/env.d.ts` не должен содержать ни одного `import`/`export`** — иначе объявление станет модульным
  и не сольётся с `ImportMetaEnv` из `vite/client`.
- **Ошибки валидации сервера — `422`, а не `400`** (`VALIDATION_ERROR`, `details = { formErrors, fieldErrors }`).
- **Булевы query-параметры** принимают только строки `"true" | "false" | "1" | "0"`; пустое числовое
  значение (`page=`) даёт 422. Параметр нужно **опускать**, а не слать пустым.
- **`directory=` (пустая строка) ≠ отсутствие `directory`.** Пустая строка = корень бакета; отсутствие =
  файлы из всех директорий. Обе формы нужны, поэтому сборщик query-строки не должен выбрасывать `""`.
- **`DELETE` возвращает 204 без тела** — `res.json()` на нём упадёт.
- **CORS сервера разрешает только заголовки `Content-Type` и `X-API-Key`**, credentials не разрешены.
- **Presigned `PUT` идёт напрямую в S3, мимо vite-прокси**, с origin браузера. Бакетный CORS настроен
  на `CORS_ORIGIN` сервера — по умолчанию `http://localhost:5173`. Если Vite поднимется на 5174
  (порт 5173 занят), presigned-загрузка сломается непрозрачной CORS-ошибкой. **Порт надо закрепить.**
- Для `FormData` **не выставлять `Content-Type` вручную** — иначе потеряется boundary.
- **Vite не переносит `.env` в `process.env`.** `vite.config.ts` читает `process.env.VITE_API_TARGET`, и это
  значение из `.env` никогда не подхватится — только из shell. Дефолт `http://localhost:3000` верный,
  трогать не нужно; менять адрес API — `VITE_API_TARGET=… npm run dev`.
- **Правка `.env` требует перезапуска dev-сервера** — HMR её не подхватывает. Классический симптом:
  «поправил ключ, а всё равно 401».
- **Имена иконок в `@lucide/vue@1.34` сверены:** `FileVideoIcon` и `FileAudioIcon` **не существуют** —
  нужны `FileVideoCameraIcon` и `FileMusicIcon`. Есть `FileIcon`, `FileTextIcon`, `FileImageIcon`,
  `FileSpreadsheetIcon`, `FileArchiveIcon`, `FileCodeIcon`.

---

## Доустановка ui-компонентов

Одной командой:

```bash
npx shadcn-vue@latest add dialog alert-dialog table breadcrumb field toggle-group empty spinner sonner alert pagination
```

| Компонент | Зачем |
|---|---|
| `dialog` | карточка файла с метаданными |
| `alert-dialog` | подтверждение удаления (правило: деструктивное действие → `AlertDialog`) |
| `table` | таблица папок и файлов |
| `breadcrumb` | хлебные крошки текущего пути |
| `field` | правило скилла: формы строятся на `FieldGroup`/`Field`/`FieldLabel`/`FieldError`, а не на `div` со `space-y` |
| `toggle-group` | правило скилла: набор из 2–7 вариантов → `ToggleGroup`; здесь — переключатель режима загрузки |
| `empty` | пустая папка / пустой результат поиска |
| `spinner` | у `Button` нет `isLoading`; состояние «идёт загрузка» собирается из `Spinner` + `disabled` |
| `sonner` | тосты об успехе/ошибке действий (тянет зависимость `vue-sonner`) |
| `alert` | inline-ошибка загрузки списка с кнопкой «Повторить» |
| `pagination` | постраничная навигация по списку файлов |

Сразу после установки — четыре обязательные проверки, иначе билд упадёт на ровном месте:

1. `git diff` — CLI может тронуть `src/style.css` и `package.json`.
2. Прочитать `index.ts` каждой новой папки в `src/components/ui/` и сверить реальные имена экспортов:
   состав `Pagination*`, наличие `FieldError`, `TableEmpty` различаются между версиями реестра.
   Импорт несуществующего экспорта + `noUnusedLocals` роняют `npm run build`.
3. Проверить `src/components/ui/sonner/Sonner.vue`: в `vue-sonner` v2 нужен `import "vue-sonner/style.css"`
   — если его там нет, добавить в `src/main.ts`.
4. Если CLI вставил импорты из `lucide-vue-next` — заменить на `@lucide/vue` (в проекте установлен именно он).

Если какого-то компонента не окажется в реестре (`field`, `empty`, `spinner` — относительно новые),
заменяем минимальным аналогом: `Label` + `<p class="text-destructive text-sm">` вместо `Field`,
карточка с текстом вместо `Empty`, `Loader2Icon` с `animate-spin` вместо `Spinner`. Остальной план
это не меняет.

Не добавляем: `dropdown-menu`, `tooltip`, `tabs`, `progress`, `sheet` — под выбранный UX не нужны.
Действия в строке — две icon-кнопки с `aria-label`, меню на три пункта здесь избыточно.
Сортировка — кликом по заголовкам таблицы, отдельный `Select` для неё не нужен.
`sonner` — единственный компонент, тянущий новую npm-зависимость (`vue-sonner`).

---

## Структура файлов

Всё новое, кроме помеченного:

```
client/
  .env                          [править] VITE_-префиксы
  .env.example                  новый, без реального ключа
  index.html                    [править] <title>
  vite.config.ts                [править] закрепить порт 5173
  src/
    env.d.ts                    типы для import.meta.env
    main.ts                     [без изменений]
    App.vue                     [переписать] каркас страницы + <Toaster />
    types/
      api.ts                    FileDto, DirectoryDto, ответы эндпоинтов, union-типы
    lib/
      utils.ts                  [без изменений]
      directory.ts              валидация/нормализация директории — зеркало server/src/s3/keys.ts
      format.ts                 formatBytes, formatDate, plural, iconForFile
      errors.ts                 код ошибки API → русский текст (единственное место с формулировками)
    api/
      client.ts                 apiRequest, ApiError, buildQuery
      files.ts                  все /api/files/*
      directories.ts            /api/directories
    composables/
      useFileBrowser.ts         состояние списка: директория, поиск, страница, сортировка
      useUpload.ts              оба режима загрузки
      useFileActions.ts         скачивание и удаление
    components/
      UploadPanel.vue
      FileBrowser.vue
      DirectoryBreadcrumbs.vue
      FileTable.vue
      FileCardDialog.vue
      DeleteFileDialog.vue
      ui/…                      [есть + доустановленные]
```

Разбиение плоское намеренно: `types` → `lib` → `api` → `composables` → `components`, каждый слой знает
только о нижних.

---

## Слой 1 — типы (`src/types/api.ts`)

Зеркалим `server/src/modules/files/files.types.ts` дословно. Без `enum` (запрещён `erasableSyntaxOnly`):

```ts
export type FileStatus = "pending" | "ready" | "failed"
export type UploadSource = "server" | "presigned"
export type SortField = "created_at" | "original_name" | "size_bytes"
export type SortOrder = "asc" | "desc"
export type ListStatusFilter = FileStatus | "any"

export interface FileDto {
  id: string
  name: string
  directory: string
  extension: string
  contentType: string
  size: number | null      // null, пока presigned-загрузка не подтверждена
  etag: string | null
  status: FileStatus
  uploadSource: UploadSource
  bucket: string
  key: string
  createdAt: string
  updatedAt: string
  downloadUrl?: string     // ключ отсутствует, а не null
}

export interface DirectoryDto { name: string; path: string; fileCount: number }
export interface Pagination { page: number; limit: number; total: number; totalPages: number }
export interface ListFilesResponse { items: FileDto[]; pagination: Pagination }
export interface DirectoriesResponse { parent: string; items: DirectoryDto[] }
export interface PresignUploadResponse {
  id: string; key: string; directory: string
  uploadUrl: string; expiresAt: string
  requiredHeaders: Record<string, string>   // фактически { "Content-Type": string }
}
export interface DownloadUrlResponse { url: string; expiresAt: string; name: string }
export interface ApiErrorBody { error: { code: string; message: string; details?: unknown } }
export interface ValidationDetails { formErrors: string[]; fieldErrors: Record<string, string[]> }
```

---

## Слой 2 — `src/lib/directory.ts`

Чистый модуль без зависимостей, повторяющий правила `normalizeDirectory` из `server/src/s3/keys.ts`.
Смысл — показать ошибку под инпутом до отправки, а не ловить 400 с сервера.

```ts
const MAX_RAW_LENGTH = 1024        // zod max() на сервере → иначе 422
const MAX_SEGMENT_LENGTH = 100
const MAX_DIRECTORY_BYTES = 700    // UTF-8 БАЙТ: кириллица = 2 байта/символ
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/   // те же управляющие символы, что режет сервер

export type DirectoryCheck =
  | { ok: true; value: string }
  | { ok: false; message: string }

export function checkDirectory(input: string): DirectoryCheck
```

Алгоритм (тот же, что на сервере, в том же порядке):
1. пустой/пробельный ввод → `{ ok: true, value: "" }` (корень — валидное значение);
2. длина сырого ввода > 1024 → ошибка;
3. `input.normalize("NFC")`, все `\` → `/`, split по `/`, `trim` каждого сегмента, пустые выбрасываем;
4. сегмент `.` или `..` → «Сегменты `.` и `..` запрещены»;
5. `CONTROL_CHARS.test(segment)` → «Управляющие символы запрещены»;
6. `segment.length > 100` → «Сегмент длиннее 100 символов»;
7. соединяем через `/`, `new TextEncoder().encode(joined).length > 700` → «Путь длиннее 700 байт».

Возвращаем нормализованное значение — его же и отправляем на сервер, чтобы то, что видит пользователь
в поле, совпадало с тем, что окажется в `directory` ответа.

---

## Слой 3 — `src/lib/format.ts`

```ts
export function formatBytes(bytes: number | null): string        // null → "—"; 1024-основание, 1 знак
export function formatDate(iso: string): string                  // Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" })
export function plural(count: number, forms: [string, string, string]): string   // Intl.PluralRules("ru-RU")
export function iconForFile(file: Pick<FileDto, "contentType" | "extension">): Component
```

Форматтеры `Intl.*` создавать один раз на модуль, а не на каждый вызов. `plural` нужен для бейджа
папки: `plural(fileCount, ["файл", "файла", "файлов"])`.

`iconForFile` возвращает **компонент иконки**, а не строковый ключ (правило скилла). Сначала смотрим
`contentType`, затем расширение. Имена сверены с `@lucide/vue@1.34` — часть привычных не существует:

| Категория | Иконка |
|---|---|
| `image/*` | `FileImageIcon` |
| `video/*` | `FileVideoCameraIcon` (`FileVideoIcon` **нет**) |
| `audio/*` | `FileMusicIcon` (`FileAudioIcon` **нет**) |
| `application/pdf`, `text/*`, doc/docx/rtf/md | `FileTextIcon` |
| xls/xlsx/csv | `FileSpreadsheetIcon` |
| zip/rar/7z/tar/gz | `FileArchiveIcon` |
| js/ts/json/xml/html/css/py/sh | `FileCodeIcon` |
| прочее | `FileIcon` |

---

## Слой 3b — `src/lib/errors.ts`

Одно место, где коды API превращаются в текст для пользователя. Компоненты не пишут формулировки сами.

```ts
export function errorMessage(error: unknown, fallback?: string): string
export function validationFieldErrors(error: unknown): string[]   // разбор details (zod flatten)
```

| Код | Текст |
|---|---|
| `UNAUTHORIZED` | «Неверный API-ключ. Проверьте `VITE_API_KEY` и перезапустите dev-сервер» |
| `FILE_REQUIRED` | «Файл не выбран» |
| `INVALID_DIRECTORY` | «Недопустимый путь директории» |
| `INVALID_FILE_NAME` | «Недопустимое имя файла» |
| `LIMIT_FILE_SIZE` | «Файл больше 50 МБ — загрузите его напрямую в S3 (presigned)» |
| `VALIDATION_ERROR` | «Некорректные параметры запроса» + поля из `details.fieldErrors` |
| `FILE_NOT_FOUND` | «Файл не найден — возможно, он уже удалён» |
| `UPLOAD_NOT_COMPLETED` | «Объект не найден в хранилище: загрузка в S3 не завершилась» |
| `FILE_NOT_READY` | «Файл ещё не готов к скачиванию» |
| `INTERNAL_SERVER_ERROR` | «Внутренняя ошибка сервера» |
| `NETWORK_ERROR` | «Сервер недоступен» |
| `S3_UPLOAD_FAILED` | «Хранилище отклонило загрузку (проверьте CORS бакета и порт 5173)» |

---

## Слой 4 — API (`src/api/`)

### `client.ts`

```ts
export class ApiError extends Error {
  status: number
  code: string
  details?: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = "ApiError"
    this.status = status      // параметры-свойства запрещены erasableSyntaxOnly
    this.code = code
    this.details = details
  }
}
```

```ts
type QueryValue = string | number | boolean | undefined | null

export function buildQuery(params: Record<string, QueryValue>): string
```

Правила сборки, продиктованные zod-схемами сервера:
- `undefined` и `null` — **пропускаем** (иначе `page=` → 422);
- `boolean` → строки `"true"` / `"false"` (иначе 422);
- `number` → `String(v)`, нечисловые (`NaN`) пропускаем;
- `string` — кладём **как есть, включая пустую строку**: `directory=""` означает «корень» и терять её нельзя.
  Ответственность вызывающего — передать `search: value || undefined`, чтобы пустой поиск не уезжал в запрос.

```ts
export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T>
```
- URL — относительный: `/api${path}` (работает через прокси и в dev, и в `vite preview`);
- всегда добавляет `X-API-Key: import.meta.env.VITE_API_KEY`;
- **никогда не выставляет `Content-Type` сам** — JSON-вызовы ставят его явно, `FormData` оставляет браузеру;
- `credentials` не трогаем (сервер не разрешает);
- `204` → `return undefined as unknown as T` до попытки распарсить тело (простое `as T` не компилируется);
- тело читаем через `res.text()`, парсим в `try/catch` (страница ошибки прокси — не JSON);
- `!res.ok` → `throw new ApiError(res.status, body?.error?.code ?? "UNKNOWN", body?.error?.message ?? \`HTTP ${res.status}\`, body?.error?.details)`;
- `fetch` бросает `TypeError` при сетевом сбое → `new ApiError(0, "NETWORK_ERROR", "Сервер недоступен")`;
- `AbortError` (`DOMException`) **пробрасываем как есть** — вызывающий код его молча игнорирует;
  для этого же экспортируем `isApiError(e)` и `isAbortError(e)`;
- `signal` пробрасывается из `init` для отмены.

Отдельная функция `parseErrorBody(status, body)` используется и для ответов S3: там тело — XML, код
достаём регуляркой `/<Code>([^<]+)<\/Code>/`, иначе `S3_UPLOAD_FAILED`.

### `files.ts`

```ts
listFiles(params: {
  directory?: string; recursive?: boolean; search?: string
  status?: ListStatusFilter; page?: number; limit?: number
  sort?: SortField; order?: SortOrder
}, signal?: AbortSignal): Promise<ListFilesResponse>

getFile(id: string, withUrl?: boolean): Promise<FileDto>

uploadViaServer(file: File, directory: string): Promise<FileDto>
// FormData: append("file", file) + append("directory", directory) — имя поля ровно "file";
// Content-Type не задаём.

presignUpload(body: { filename: string; directory?: string; contentType?: string; size?: number })
  : Promise<PresignUploadResponse>

putToPresignedUrl(url: string, file: File, headers: Record<string, string>): Promise<void>
// Голый fetch(url, { method: "PUT", body: file, headers }) — БЕЗ apiRequest:
// это чужой origin (S3), никакого X-API-Key, никаких credentials,
// заголовки — РОВНО requiredHeaders из ответа сервера (Content-Type входит в подпись).
// !res.ok → ApiError(res.status, "S3_UPLOAD_FAILED", …)

completeUpload(id: string): Promise<FileDto>   // POST без тела
getDownloadUrl(id: string, disposition?: "attachment" | "inline"): Promise<DownloadUrlResponse>
deleteFile(id: string): Promise<void>          // 204, тело не читаем
```

### `directories.ts`

```ts
listDirectories(parent: string, signal?: AbortSignal): Promise<DirectoriesResponse>
```

---

## Слой 5 — composables

### `useFileBrowser.ts` — состояние одно на страницу

Состояние объявляем **на уровне модуля** (синглтон), функция возвращает ссылки на него. Страница одна,
браузер файлов один — так `UploadPanel` читает текущую папку и вызывает `refresh()` без проброса пропсов
через три уровня.

```ts
const directory = ref("")                    // "" = корень
const searchInput = ref("")                  // то, что в поле
const search = ref("")                       // дебаунснутое значение, уходит в запрос
const page = ref(1)
const limit = ref(20)
const sort = ref<SortField>("created_at")
const order = ref<SortOrder>("desc")

const files = ref<FileDto[]>([])
const directories = ref<DirectoryDto[]>([])
const pagination = ref<Pagination | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
```

`load()`:
- отменяет предыдущий `AbortController` и заводит новый; дополнительно сверяет инкрементный
  `requestId` перед записью результата — быстрое переключение папок не должно оставлять чужие данные
  (ответ может прийти раньше, чем сработает `abort()`);
- параллельно `Promise.all([listFiles(...), listDirectories(directory.value)])`;
- при непустом `search` шлёт `recursive: true` — искать логично по всему поддереву текущей папки;
  при пустом — `recursive` **не шлём вовсе** (дефолт сервера `false`, а `recursive=false` лишний);
- **папки запрашиваем только при пустом поиске и `page === 1`.** Сервер не фильтрует директории по
  `search`, и смешивать «отфильтрованные файлы» со «всеми папками» — вводить в заблуждение; на второй
  странице списка папки тоже неуместны. В остальных случаях подставляем пустой список без запроса;
- `directory` передаём всегда, включая `""` (это и есть «корень»);
- `AbortError` игнорируем (и до записи в `error`, и в `finally` для `loading`), остальное прогоняем
  через `errorMessage()` из `lib/errors.ts`.

Реактивность строим так, чтобы не было двойных запросов: наблюдаем **только** `page`, а все прочие
изменения проходят через хелпер `applyFilters()` — если `page !== 1`, он ставит `page = 1` (сработает
вотчер), иначе вызывает `load()` напрямую. `searchInput` отдельно:
`watch(searchInput, useDebounceFn(() => { search.value = searchInput.value.trim(); applyFilters() }, 350))`.
Первый `load()` вызываем прямо в теле composable — приложение только клиентское.

Экшены и производные:
```ts
openDirectory(path: string)         // переход внутрь; page = 1; searchInput = ""
goTo(path: string)                  // клик по крошке
toggleSort(field: SortField)        // тот же столбец → инверсия order, иначе новый sort + desc
refresh()                           // после загрузки/удаления
const breadcrumbs = computed<{ label: string; path: string }[]>(...)  // [{ "Все файлы", "" }, { "docs", "docs" }, { "reports", "docs/reports" }]
```

**Важная особенность модели данных:** `/api/directories` выводит папки из путей уже загруженных файлов,
и считает только `status = 'ready'`. Пустых папок не существует — папка появляется в списке ровно тогда,
когда в неё (или в её поддерево) загружен файл. Это надо отразить в пустом состоянии, чтобы поведение
не выглядело багом.

### `useUpload.ts`

```ts
export type UploadMode = "server" | "presigned"

const mode = ref<UploadMode>("server")
const uploading = ref(false)
const stage = ref<"idle" | "presigning" | "sending" | "completing">("idle")

async function upload(file: File, directory: string): Promise<FileDto>
```

Режим «через сервер» — один вызов `uploadViaServer`.

Режим presigned — три обязательных шага, ровно по контракту:
1. `presignUpload({ filename: file.name, directory, contentType: file.type || undefined, size: file.size })`
   — именно `|| undefined`, а не пустая строка: у `contentType` на сервере `min(1)`, пустое значение даст 422.
   Тип не определён браузером → сервер сам подставит `application/octet-stream`;
2. `putToPresignedUrl(res.uploadUrl, file, res.requiredHeaders)` — заголовки берём **из ответа**, а не
   собираем сами: именно они попали в подпись. Ничего сверх них: ни `X-API-Key`, ни credentials;
3. `completeUpload(res.id)` — не опционален; без него запись остаётся `pending`, не видна в списке
   (дефолт `status=ready`) и не скачивается.

Отправляем **нормализованное** значение директории (`checkDirectory(...).value`) — оно гарантированно
совпадёт с тем, что вычислит сервер, поэтому после загрузки можно сразу перейти в `file.directory`.

Обработка сбоев по шагам:
- падение на шаге 2 → `complete` **не вызываем**: запись остаётся `pending` и будет разобрана серверным
  `npm run db:cleanup` (`PENDING_TTL_HOURS=24`). Пользователю — текст ошибки, а при `S3_UPLOAD_FAILED` /
  `NETWORK_ERROR` ещё и подсказка про CORS бакета и порт 5173;
- `409 UPLOAD_NOT_COMPLETED` на шаге 3 → одна повторная попытка `completeUpload` через ~800 мс, затем ошибка;
- `413 LIMIT_FILE_SIZE` в режиме «через сервер» → тост с подсказкой переключиться на «Напрямую в S3».

Предварительная проверка размера: константа `MAX_UPLOAD_SIZE_MB` приходит из
`import.meta.env.VITE_MAX_UPLOAD_SIZE_MB` (по умолчанию 50). Если режим «через сервер» и файл больше —
показываем **предупреждение, но не блокируем** отправку: сценарий проверки требует получить настоящий 413
от сервера, а клиентская константа носит справочный характер.

`selectedFile` держим в `shallowRef` — глубокая реактивность на `File` не нужна и вредна.

### `useFileActions.ts`

```ts
async function download(file: FileDto): Promise<void>
```
Берём **свежую** ссылку (`getDownloadUrl(id, "attachment")`, TTL 300 с — кэшировать нельзя) и делаем
`window.location.assign(url)`. Именно `assign`, а не `window.open`: после `await` открытие окна попадает
под блокировку всплывающих окон, а навигация — нет. Страница при этом никуда не уйдёт, потому что
presigned-GET уже несёт `Content-Disposition: attachment` с RFC 5987 `filename*` — браузер сохраняет файл
под оригинальным именем, включая кириллицу. Blob не нужен и вреден: байты не должны проходить через JS.
Атрибут `download` на кросс-origin ссылке браузер игнорирует — работает именно серверный заголовок.
`409 FILE_NOT_READY` → тост «файл ещё не готов к скачиванию».

В карточке файла, где `downloadUrl` уже получен через `?withUrl=true`, лишний запрос не делаем —
сразу `window.location.assign(file.downloadUrl)`.

```ts
async function remove(file: FileDto): Promise<void>
```
`deleteFile(id)` → тост → `refresh()`. `404 FILE_NOT_FOUND` трактуем как «уже удалён» и тоже обновляем список.

---

## Слой 6 — компоненты

### `App.vue`
Каркас: шапка с названием сервиса, `<main class="mx-auto flex max-w-6xl flex-col gap-6 p-6">` с
`<UploadPanel />` и `<FileBrowser />`, внизу `<Toaster />` из `@/components/ui/sonner`.

### `UploadPanel.vue`
`Card` с `CardHeader` / `CardContent` / `CardFooter`. Внутри — `FieldGroup`:
- `Field`: `FieldLabel` «Режим загрузки» + `ToggleGroup type="single"` с двумя `ToggleGroupItem`:
  «Через сервер» и «Напрямую в S3». Под ним `FieldDescription` — одна строка, поясняющая разницу
  (через сервер: лимит 50 МБ, байты идут через API; напрямую: presigned PUT в хранилище + подтверждение).
- `Field`: `FieldLabel` «Директория» + `Input` с `placeholder="docs/reports"`. Предзаполняется текущей
  папкой браузера и следует за ней, **пока пользователь не тронул поле** (флаг `dirty`); кнопка
  «Текущая папка» возвращает синхронизацию. Валидация через `checkDirectory` на каждое изменение:
  при ошибке `data-invalid` на `Field`, `aria-invalid` на `Input`, текст в `FieldError`.
  Пустое поле — валидно, это корень; в `FieldDescription` — счётчик «N/700 байт».
- `Field`: выбор файла через `useFileDialog({ multiple: false, reset: true })` из `@vueuse/core` +
  `Button variant="outline"`. `reset: true` обязателен — иначе повторный выбор того же файла не вызовет
  `onChange`. Значение берём как `files.value?.[0] ?? null` (`files` — это `Ref<FileList | null>`).
  Рядом — имя и размер выбранного файла (`Badge` с расширением, `formatBytes`).
- `CardFooter`: `Button` «Загрузить», `disabled` пока нет файла / есть ошибка директории / идёт загрузка;
  при загрузке — `<Spinner data-icon="inline-start" />` и текст по `stage`
  («Готовим ссылку…» / «Отправляем…» / «Подтверждаем…»).

После успеха: тост с именем файла и режимом, сброс выбранного файла, `browser.refresh()`, и если файл
ушёл не в текущую папку — переход в неё (`openDirectory(result.directory)`), чтобы результат было видно.

### `DirectoryBreadcrumbs.vue`
`Breadcrumb` по `browser.breadcrumbs`. Первый элемент — «Все файлы» (path `""`), последний — `BreadcrumbPage`
без ссылки. Пропсы не нужны, читает синглтон.

### `FileTable.vue`
Одна `Table`. Заголовки: Имя · Размер · Тип · Загружен · Источник · (действия).
- Клик по «Имя» / «Размер» / «Загружен» вызывает `toggleSort("original_name" | "size_bytes" | "created_at")`,
  в заголовке — стрелка направления.
- **Строки папок идут первыми** (скрываются, когда активен поиск): `FolderIcon`, имя,
  `Badge variant="secondary"` с `fileCount`, вся строка кликабельна → `openDirectory(path)`,
  `cursor-pointer` + `hover:bg-muted/50`.
- **Строки файлов**: `<component :is="iconForFile(file)" />`, имя (с `truncate`), `formatBytes(file.size)`,
  расширение в `Badge variant="outline"`, `formatDate(file.createdAt)`, источник —
  `Badge` (`server` / `presigned`). Клик по строке открывает карточку.
- Колонка действий: `Button variant="ghost" size="icon"` со `DownloadIcon` и второй с `Trash2Icon`
  (`class="text-destructive"`), оба с `@click.stop`.
- `loading` → 5 строк со `Skeleton` в ячейках; `error` → `Alert variant="destructive"` с кнопкой «Повторить»;
  пусто → `Empty` с `EmptyMedia variant="icon"`, разным текстом для «папка пуста» и «ничего не найдено
  по запросу», и пояснением, что пустых папок не бывает — папка появляется вместе с первым файлом.

### `FileBrowser.vue`
`Card`, внутри: строка инструментов — `InputGroup` + `InputGroupInput` (поиск, `v-model` на `searchInput`)
с `InputGroupAddon` и `SearchIcon`; `Select` для `limit` (10 / 20 / 50). Ниже `DirectoryBreadcrumbs`,
`Separator`, `FileTable`, и `Pagination` по `pagination.totalPages` (скрыта, если страница одна).
Держит локальный `selectedFile` и `fileToDelete`, монтирует `FileCardDialog` и `DeleteFileDialog`.

### `FileCardDialog.vue`
Props: `file: FileDto | null`, `open: boolean`; emits: `update:open`, `download`, `delete`.
`DialogTitle` — имя файла (обязателен для доступности), `DialogDescription` — путь.
Тело — определения через `<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">`: ID, директория
(«Корень», если `""`), расширение, `contentType`, размер, ETag, статус (`Badge`), источник, бакет,
ключ объекта (`font-mono text-xs break-all`), созд./обновл. `DialogFooter` — «Скачать» и «Удалить»
(`variant="destructive"`). Кнопка «Скачать» отключена, если `status !== "ready"`.

Открывая карточку, дозапрашиваем `getFile(id)` — в списке данные могут быть устаревшими; до ответа
показываем `Skeleton`.

### `DeleteFileDialog.vue`
`AlertDialog` с именем файла в описании и пометкой, что действие необратимо. Действие — `AlertDialogAction`
с `variant="destructive"`, на время запроса — `Spinner` и `disabled`.

---

## Конфигурация окружения

`client/.env` (сейчас переменные **без** `VITE_`-префикса, поэтому в браузер не попадают — `import.meta.env`
их не увидит; `API_HOST_DEV` вообще ни на что не влияет):

```
VITE_API_KEY=<значение API_KEY из server/.env>
VITE_MAX_UPLOAD_SIZE_MB=50
```

`client/.env.example` (новый, коммитим — `.env` игнорируется правилом `*/**/.env` в корневом `.gitignore`):

```
VITE_API_KEY=replace-me
VITE_MAX_UPLOAD_SIZE_MB=50
```

Старые `API_KEY` и `API_HOST_DEV` из `.env` удалить — без префикса они в браузер не попадают и создают
иллюзию работающей конфигурации.

`src/env.d.ts` — **ни одного `import`/`export` в файле**, иначе объявление станет модульным и не сольётся
с типом Vite:
```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_KEY: string
  readonly VITE_MAX_UPLOAD_SIZE_MB?: string
}
```

**Порт 5173 — критично для presigned.** `PUT` уходит напрямую на `https://s3.cloud.ru/...`, минуя
vite-прокси, то есть с origin браузера. Бакетный CORS (`server/src/scripts/s3-cors.ts`) разрешает только
`CORS_ORIGIN` = `http://localhost:5173`. Если 5173 занят, Vite молча возьмёт 5174 — **preflight упадёт,
и presigned-режим перестанет работать при полностью исправном коде.** Два способа:

- не трогая конфиг: `npm run dev -- --port 5173 --strictPort`;
- или один раз в `vite.config.ts`: `server: { port: 5173, strictPort: true, proxy: apiProxy }`.

`vite preview` слушает 4173 — presigned оттуда работать не будет, пока этот origin не добавлен в
`CORS_ORIGIN` и не перезапущен `npm run s3:cors`. Загрузка через сервер из preview работает (там прокси).

Обычные вызовы `/api/*` идут через vite-прокси на том же origin, поэтому CORS сервера их не касается —
`X-API-Key` доезжает без preflight-сюрпризов.

Заодно две мелочи. `index.html` — заменить `<title>Поиск товаров</title>` на название сервиса.
`src/style.css` — Inter импортируется, но `--font-heading: var(--font-sans)` ссылается на переменную,
которой нет, поэтому шрифт не применяется. Добавить **отдельным блоком** после `@theme inline { … }`
(именно `@theme`, не `@theme inline`):
```css
@theme {
  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
}
```

---

## Порядок работ

1. `.env` + `.env.example` + `src/env.d.ts`; порт 5173 в `vite.config.ts`; `<title>`; `--font-sans`.
2. `npx shadcn-vue@latest add dialog alert-dialog table breadcrumb field toggle-group empty spinner sonner alert pagination`.
3. `src/types/api.ts`.
4. `src/lib/directory.ts`, `src/lib/format.ts`, `src/lib/errors.ts`.
5. `src/api/client.ts` → `src/api/files.ts` → `src/api/directories.ts`.
6. **Контрольная точка:** `npm run typecheck` — слой типов, `lib` и `api` должен компилироваться
   до того, как появится хоть один компонент.
7. `src/composables/useFileBrowser.ts` → `useUpload.ts` → `useFileActions.ts`.
8. Компоненты снизу вверх: `DirectoryBreadcrumbs` → `FileTable` → `FileCardDialog` → `DeleteFileDialog`
   → `FileBrowser` → `UploadPanel`.
9. `App.vue` + `<Toaster />`.
10. **Ранняя вертикальная проверка:** как только собраны `FileBrowser` + `FileTable`, запустить
    `npm run dev -- --port 5173 --strictPort` и убедиться, что список грузится и в Network нет 401/422.
    Формы и диалоги доводить уже после этого — так ошибки в api-слое не смешаются с ошибками вёрстки.
11. `npm run typecheck` и `npm run build`, затем ручной прогон сценариев.

---

## Проверка

Подготовка: в `server/` — `npm run db:migrate`, `npm run s3:cors` (один раз на бакет), `npm run dev`,
проверить `curl http://localhost:3000/health`; в `client/` — `npm run dev -- --port 5173 --strictPort`.

```
npm run typecheck     # чисто; помнить про noUnusedLocals — лишний импорт валит билд
npm run build         # vue-tsc -b && vite build
```

Сценарии в браузере:

0. **Первая загрузка страницы.** В Network — `GET /api/files?directory=&page=1&limit=20&sort=created_at&order=desc`
   и `GET /api/directories?parent=`. Проверить глазами: **пустых `search=` и `recursive=` в строке нет**,
   а `directory=` есть. Это ровно та граница, на которой сервер отвечает 422.
1. **Загрузка через сервер.** Файл с кириллическим именем (`Отчёт за Q3.pdf`), директория `docs/reports`
   → появляется в списке с исходным именем, `Источник: server`, размер и дата заполнены.
   В запросе **нет** выставленного вручную `Content-Type` — только boundary от браузера.
2. **Загрузка напрямую в S3.** Тот же файл, директория `docs`, режим «Напрямую в S3» → в Network видны
   три запроса: `presign-upload` (201), `PUT` на `s3.cloud.ru` (200), `complete` (200). В карточке
   `Источник: presigned`, `size` и `etag` непустые — значит `complete` отработал.
   Если `PUT` падает с CORS-ошибкой — проверить порт 5173 и что `npm run s3:cors` прогонялся.
3. **Навигация.** Корень → видны папки `docs` с `fileCount` по всему поддереву; клик → внутрь;
   крошки возвращают на любой уровень. В `docs` виден файл из шага 2 и подпапка `reports`.
4. **Карточка.** Клик по строке → диалог со всеми полями `FileDto`, ключ вида
   `docs/reports/<uuid>.pdf` (не исходное имя — так и задумано).
5. **Скачивание.** Кнопка «Скачать» → файл сохраняется под **оригинальным** именем с кириллицей.
   Повторный клик через 6 минут тоже работает (ссылка берётся заново, TTL 300 с).
6. **Поиск.** Ввод части имени → запрос уходит один раз после паузы (debounce), ищет по поддереву,
   строки папок скрываются, страница сбрасывается на 1.
7. **Пагинация и сортировка.** `limit=10`, загрузить 12+ файлов → две страницы; клик по «Размер» и
   «Имя» меняет порядок, повторный клик инвертирует.
8. **Удаление.** Кнопка → `AlertDialog` → подтверждение → 204, тост, файл исчезает из списка.
9. **Негатив:**
   - директория `../etc` → ошибка под инпутом **до** отправки, запроса в Network нет;
   - директория из 400 кириллических символов → «Путь длиннее 700 байт в UTF-8», счётчик показывает >700;
   - файл > 50 МБ в режиме «через сервер» → предупреждение на клиенте, отправка не блокируется,
     сервер отвечает 413 `LIMIT_FILE_SIZE`, тост предлагает переключиться на «Напрямую в S3».
     Тот же файл в режиме presigned загружается успешно — лимит на него не распространяется;
   - подменить `VITE_API_KEY` на мусор (**и перезапустить dev-сервер** — HMR `.env` не подхватывает)
     → 401 `UNAUTHORIZED` и внятное сообщение про ключ, а не пустой список;
   - выключить сервер и нажать «Обновить» → `Alert` «Сервер недоступен», интерфейс не падает;
   - удалить один файл из двух вкладок → вторая получает 404 `FILE_NOT_FOUND` и трактует как «уже удалён»;
   - запустить клиент на 5174 (`--port 5174`) и попробовать presigned → должно появиться понятное
     сообщение про CORS и порт, а не пустая ошибка.
10. **Гонки.** Быстро прокликать несколько папок подряд и подергать поиск → в Network видны `canceled`
    запросы, в списке содержимое последней выбранной папки, промежуточные данные не «моргают»
    (отбрасываются по `AbortController` + `requestId`).

---

## Осознанно вне MVP

- **Прогресс загрузки и drag & drop.** Пользователь этот пункт не выбирал, поэтому загрузка идёт на
  `fetch`, а состояние показывается через `Spinner` и `stage`. Если понадобится — апгрейд локальный:
  добавить `src/api/xhr.ts` (~60 строк) с `xhr.upload.onprogress`, переключить на него
  `uploadViaServer` и `putToPresignedUrl`, поставить `npx shadcn-vue@latest add progress` и вывести
  `<Progress :model-value="progress" />` в `UploadPanel`. `fetch` прогресса аплоада не даёт в принципе.
  Тот же `AbortController` заодно даёт кнопку «Отменить» во время загрузки.
  Drag & drop — `useDropZone` из уже установленного `@vueuse/core`, ~10 строк, без новых зависимостей.
- **Фильтр «показывать незавершённые»** (`status=any` вместо дефолтного `ready`) — `Checkbox` уже
  установлен. Полезен при отладке presigned-флоу: видно записи, застрявшие в `pending`.
- **Синхронизация текущей папки с URL** — `useUrlSearchParams("hash")` из `@vueuse/core`
  (`#?dir=docs/reports`), чтобы работали перезагрузка и «назад». Роутер для этого не нужен.
- Множественная загрузка, переименование/перемещение (эндпоинтов нет), создание пустой папки
  (модель данных этого не позволяет), тёмная тема (`.dark` в CSS есть, переключателя нет), тесты и линтер.
