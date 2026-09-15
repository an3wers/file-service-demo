# AGENTS.md — client

SPA на Vue 3 (`<script setup lang="ts">`), Vite 8, Tailwind CSS v4, shadcn-vue (reka-ui, new-york /
neutral, иконки `@lucide/vue`), тосты `vue-sonner`, `@vueuse/core`. Роутинга и стор-библиотек нет.
Подробности — в [README.md](README.md), контракты с сервером — в [../AGENTS.md](../AGENTS.md).

## Команды

```bash
npm run dev            # :5173 (strictPort), прокси /api и /health на VITE_API_TARGET (по умолчанию :3000)
npm run typecheck      # vue-tsc --noEmit -p tsconfig.app.json
npm test               # vitest run
npx vitest run src/lib/parts.test.ts   # один файл
npm run build          # vue-tsc -b + vite build
```

Порт 5173 не менять: на него настроен CORS бакета для presigned-загрузок (см. корневой AGENTS.md).

## Структура и слои

```
components/*.vue  →  composables/use*.ts  →  api/*.ts  →  api/client.ts
                         ↓
                      lib/*.ts (без состояния)
```

- **`api/client.ts`** — транспорт: `apiRequest` (fetch, JSON), `apiUpload` / `xhrSend` (XHR ради
  прогресса отправки), `ApiError`, `buildQuery`, `parseErrorBody` (понимает JSON сервера и XML S3).
- **`api/files.ts`, `api/directories.ts`** — по функции на эндпоинт. Новый эндпоинт добавляется сюда,
  компоненты `fetch` не вызывают.
- **`composables/`** — состояние на уровне **модуля** (refs объявлены вне функции `use*`), то есть
  синглтоны: `useFileBrowser` (список, папка, поиск, пагинация), `useUpload` (загрузка: server /
  presigned / multipart), `useFileActions` (скачивание, удаление). Компоненты берут состояние
  отсюда, а не через пропсы.
- **`lib/`** — чистые функции: `errors.ts`, `directory.ts`, `parts.ts`, `format.ts`, `utils.ts` (`cn`).
- **`types/api.ts`** — ручное зеркало `server/src/modules/files/files.types.ts`.
- **`components/ui/`** — вендоренные примитивы shadcn-vue. Не правь их руками: добавляй и обновляй
  через CLI (`npx shadcn-vue@latest add <component>`), кастомизацию делай в прикладных компонентах.

## Правила

**TypeScript.** `erasableSyntaxOnly` запрещает `enum`, `namespace` и параметры-свойства в
конструкторе (`constructor(readonly x)`) — используй union-литералы и явное присваивание полей.
Импорты из `src` — через алиас `@/`. `noUnusedLocals` / `noUnusedParameters` включены.

**Ошибки и тексты.** Компоненты не пишут формулировки ошибок сами: `errorMessage(error)` из
`lib/errors.ts` — единственное место, где код API становится текстом. Рядом `isRetryable` (кнопка
«Повторить» только для 503 и `status === 0`) и `requestReference` («Код обращения» для 5xx).
Новый код ошибки на сервере → запись в `MESSAGES`. `AbortError` (`isAbortError`) гасится молча.

**Запросы.**
- Пути относительные (`/api/...`), абсолютного адреса API в коде нет.
- `Content-Type` для `FormData` не выставлять — boundary ставит браузер.
- В `buildQuery` пустая строка передаётся как есть: `directory=""` — это корень, а отсутствие
  параметра — все директории. Пустой `search` отбрасывает вызывающий (`search || undefined`).
- PUT в S3 идёт голым `xhrSend` без `X-API-Key` и ровно с заголовками из подписи
  (`requiredHeaders`); части multipart — вообще без заголовков.

**Multipart.** Клиент не считает разбиение: `offset`, `size`, `partCount`, `maxConcurrency` приходят
от сервера. Своих констант параллельности и размера части не заводить.

**Директория.** `checkDirectory` в `lib/directory.ts` зеркалит серверный `normalizeDirectory` и
должен возвращать то же нормализованное значение — меняются только вместе.

**Окружение.** `VITE_*` впечатываются в бандл на сборке; новая переменная объявляется в
`src/env.d.ts` (в этом файле не должно быть `import`/`export`, иначе типы перестанут сливаться с
`vite/client`) и добавляется в `.env.example` и README.

**Стиль.** Форматтера нет, стиль в файлах разный (в `.vue` и части `.ts` точки с запятой есть, в
`api/files.ts`, `lib/`, `types/` — нет). Следуй стилю редактируемого файла. Комментарии и UI-тексты —
на русском.

## Тесты

- Vitest + happy-dom, `src/**/*.test.ts` рядом с кодом, `globals: false` — импорты из `"vitest"`.
- Отдельный `vitest.config.ts`, `vite.config.ts` в тестах не подхватывается (нет tailwind и прокси).
  `css: false`.
- `src/test/setup.ts` — заглушки `matchMedia`, `ResizeObserver`, pointer capture для reka-ui и
  `enableAutoUnmount`. Если новый примитив падает на mount в тестах — дополни заглушки там.
- Composables тестируются с замоканным модулем API целиком (`vi.mock("@/api/files", …)`, см.
  `useUpload.test.ts`). Состояние composables модульное и переживает тест-кейсы файла —
  нужные значения выставляй в `beforeEach`.

## Docker

Сборка требует `client/.env` (иначе ключ уйдёт в бандл как `undefined` — Dockerfile падает намеренно).
Рантайм — nginx (`nginx.conf`): отдаёт статику и проксирует `/api`, `/health` на `server:3000`;
`client_max_body_size` должен оставаться выше `MAX_UPLOAD_SIZE_MB` сервера, чтобы 413 приходил JSON'ом
от API.
