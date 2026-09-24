# Файловый сервис — клиент

Одностраничный интерфейс к [файловому сервису](../server/README.md): загрузка файлов в двух режимах
(через API и напрямую в объектное хранилище по presigned-ссылке), дерево папок, список с поиском,
сортировкой и пагинацией, карточка файла, скачивание и удаление. Две страницы на `vue-router`:
`/login` — форма входа, `/` — шапка плюс `FileBrowser`.

Vue 3 (`<script setup>`), TypeScript, Vite 8, Tailwind CSS v4, shadcn-vue (new-york / neutral /
lucide), тосты — `vue-sonner`, утилиты — `@vueuse/core`.

## Запуск

```bash
npm install
cp .env.example .env
npm run dev                 # http://localhost:5173
```

Сервер должен быть поднят на `:3000` (см. `server/README.md`): первый же экран запрашивает список
файлов, без сервера будет только ошибка «Сервер недоступен». Нужен Node 20.19+ / 22.12+ (в
репозитории — 24).

| Скрипт | Что делает |
|---|---|
| `npm run dev` | Vite dev-сервер на `:5173` (порт закреплён, см. ниже) |
| `npm run build` | `vue-tsc -b` + `vite build` в `dist/` |
| `npm run preview` | локальный показ `dist/` с тем же прокси |
| `npm run typecheck` | `vue-tsc --noEmit` по `tsconfig.app.json` |
| `npm test` | один прогон vitest |
| `npm run test:watch` | vitest в watch-режиме |
| `npm run test:coverage` | покрытие (нужен `npm i -D @vitest/coverage-v8`) |
| `npm run api:generate` | типы API из `../server/openapi.json` в `src/api/generated/` |

## Конфигурация

Значения из `.env` (`client/.env`) подставляются в бандл на сборке — своего рантайм-конфига у
приложения нет.

| Переменная | По умолчанию | Примечания |
|---|---|---|
| `VITE_MAX_UPLOAD_SIZE_MB` | `50` | справочный порог для режима «через сервер»; настоящий лимит живёт на сервере и приходит как 413 |
| `VITE_S3_HOST` | — | базовый URL хранилища для ссылки «Статичный url» в карточке файла |
| `VITE_API_TARGET` | `http://localhost:3000` | цель dev/preview-прокси; это переменная окружения процесса, а не ключ из `.env` |

## Как клиент общается с API

Все запросы идут относительными путями (`/api/...`) через vite-прокси на `VITE_API_TARGET`, поэтому
CORS сервера в игру не вступает ни в dev, ни в `vite preview`. `apiRequest` — обычный `fetch` для
JSON; файл отправляется через XHR (`apiUpload` / `xhrSend`) — только он даёт прогресс отправки тела.

Порт **5173 закреплён** (`strictPort`): presigned-PUT уходит напрямую в S3 с origin браузера, а CORS
бакета настроен ровно на `http://localhost:5173` (`npm run s3:cors` на сервере). Молчаливый сдвиг на
5174 сломал бы presigned-загрузку непрозрачной CORS-ошибкой.

## Вход

Логин и пароль пользователя задаёт окружение сервера (`LOGIN_USER_APP`, `PASSWORD_USER_APP`).

- **`api/session.ts`** — обычный TS без Vue: токен доступа только в памяти, `expiresAt`, общий промис
  продления, колбэк `onSessionExpired`. Токен обновления — httpOnly-cookie, скрипты его не видят.
- **`apiRequest` / `apiUpload`** — подставляют `Authorization: Bearer`. Если до `expiresAt` меньше
  30 секунд, сначала продлевают сессию. На `401 UNAUTHORIZED` — одно продление на все параллельные
  запросы и повтор; на `SESSION_EXPIRED` — `onSessionExpired` без повтора.
- **`useAuth`** — реактивный синглтон поверх `session.ts`: статус старта, пользователь, вход, выход,
  `BroadcastChannel` между вкладками (рассылаются вход и выход, истечение — нет).
- **`router/`** — guard ждёт один `POST /api/auth/refresh` на старте: `401` → `/login`, другая ошибка
  → полноэкранная ошибка с «Повторить». Выход и истечение сессии отменяют загрузку и ведут на
  `/login`; навигация браузера файлов сбрасывается только при выходе.

## Устройство

Состояние приложения живёт на уровне модулей в `src/composables/` — страница одна, браузер файлов
один, поэтому пропсы через три уровня не гоняются.

- **`useFileBrowser`** — список: директория, поиск (дебаунс 350 мс), пагинация, сортировка, крошки.
  `load()` отменяемый и защищён инкрементным id от гонок ответов; первый запрос уходит при монтировании
  `FileBrowser`, `reset()` при выходе возвращает к корню.
- **`useUpload`** — загрузка: режим (`server` / `presigned`), стадии, прогресс, отмена через
  `AbortController`. В presigned-режиме выбор single / multipart делает сервер (поле `strategy`),
  клиент исполняет присланный план. Multipart: параллельность по `maxConcurrency` сервера, повтор
  части со свежей ссылкой, догрузка недостающих частей по `GET /:id/multipart`, уборка (`DELETE`) за
  сорвавшейся загрузкой.
- **`useFileActions`** — скачивание (переход по presigned-GET, а не `window.open`) и удаление (тост,
  404 трактуется как «уже удалён»).

`src/lib/` — вспомогательное без состояния:

- **`errors.ts`** — единственное место, где коды API становятся текстом для пользователя; таблица
  зеркалит `ERROR_CODES` сервера плюс коды самого клиента (`NETWORK_ERROR`, `S3_UPLOAD_FAILED`).
- **`directory.ts`** — клиентское зеркало серверного `normalizeDirectory`: показывает ошибку под
  полем до отправки и возвращает ровно то нормализованное значение, которое вычислит сервер.
- **`parts.ts`** — `range` / `chunk` / `runPool` для multipart. Арифметики разбиения здесь нет:
  `offset` / `size` / `partCount` присылает сервер.
- **`format.ts`** — байты, даты (`Intl`), русская плюрализация, иконки по типу файла.

`src/api/generated/` — типы API, сгенерированные `@hey-api/openapi-ts` из `server/openapi.json`;
руками не правятся и коммитятся (Docker-сборка клиента не видит `server/` и генерацию не запускает).
После `npm run openapi` на сервере — `npm run api:generate` здесь. `src/types/api.ts` реэкспортирует
их под привычными именами и держит клиентские типы, которых нет в контракте.

`src/components/ui/` — примитивы shadcn-vue; правятся через CLI, а не руками.

## Загрузка

Режим выбирается явным переключателем в диалоге, а не авто по размеру. Оба сценария создают запись
одного вида и для остального интерфейса неразличимы.

- **Через сервер** — `POST /api/files` (multipart-форма: `file`, `directory`). Байты идут через API,
  потолок — `VITE_MAX_UPLOAD_SIZE_MB` (реальный на сервере). Прогресс берётся из XHR.
- **Напрямую в S3** — `presign-upload` → `PUT` в хранилище → `complete`. Клиент шлёт `size`; по нему
  сервер выбирает стратегию и присылает готовый план. `complete` не опционален: пока его нет, запись
  висит в статусе `pending`.
- **Частями** — тот же `presign-upload`, если `size ≥ MULTIPART_THRESHOLD_MB`. Части
  (`file.slice(offset, offset + size)`) льются параллельно, протухшую ссылку заменяет `part-urls`,
  недостающее после сбоя добирается по `GET /:id/multipart`. Брошенную загрузку клиент отменяет
  `DELETE` (`AbortMultipartUpload` на стороне сервера).

Отмена имеет смысл, только пока тело не ушло целиком: после этого сервер или S3 доведут загрузку до
конца независимо от клиента.

## Ошибки

Каждый провал API становится `ApiError` со стабильным `code`; `errorMessage()` из `lib/errors.ts`
переводит его в текст. У ответов 5xx есть `requestId` — он показывается как «Код обращения: N», по
нему причина ищется в логе сервера. Кнопка «Повторить» появляется только там, где повтор осмыслен:
503 и сетевой сбой — да; 502 (сломана конфигурация) и 429 (заняты слоты multipart) — нет.

## Тесты

Vitest + happy-dom, тесты лежат рядом с кодом (`src/**/*.test.ts`), `globals: false`. Отдельный
`vitest.config.ts` — при нём `vite.config.ts` не подхватывается, и тестам не тянутся ни
tailwind-плагин, ни dev-proxy. `src/test/setup.ts` доставляет браузерные API, которых нет в
happy-dom, но которые нужны reka-ui (`matchMedia`, `ResizeObserver`, pointer-capture).

Покрыты оркестровка `useUpload` (модуль API замокан целиком), продление сессии в `api/client`,
guard и синхронизация вкладок в `router/`, форма входа, помощники `parts.ts` и `format.ts`, плюс
дымовой mount SFC через алиас `@`.

## Структура

```
src/
  main.ts  App.vue  style.css  env.d.ts
  api/          client.ts — fetch + XHR-загрузка, ApiError, buildQuery, разбор ошибок, продление
                session.ts — токен доступа в памяти
                auth.ts, files.ts, directories.ts — по функции на эндпоинт
  router/       index.ts — маршруты и guard, реакция на выход и истечение сессии
  pages/        LoginPage.vue, FilesPage.vue
  composables/  useAuth.ts        — сессия для UI, BroadcastChannel между вкладками
                useFileBrowser.ts — состояние списка
                useUpload.ts       — оркестровка загрузки (server / presigned / multipart)
                useFileActions.ts  — скачивание и удаление
  components/   FileBrowser.vue — точка сборки
                FileTable.vue, DirectoryBreadcrumbs.vue, UploadPanel.vue,
                FileCardDialog.vue, DeleteFileDialog.vue
    ui/         вендоренные примитивы shadcn-vue
  lib/          errors.ts, directory.ts, parts.ts, format.ts, utils.ts
  types/        api.ts — зеркало server/src/modules/files/files.types.ts
  test/         setup.ts — заглушки браузерных API для reka-ui
  **/*.test.ts  тесты рядом с модулями
```
