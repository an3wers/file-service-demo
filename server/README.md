# Файловый сервис — сервер

REST API для хранения файлов в Cloud.ru Object Storage (S3-совместимое) с метаданными в PostgreSQL.
Переданная клиентом «директория» становится префиксом ключа S3-объекта — именно это и даёт сервису
структуру папок, ведь в самом S3 никаких папок нет.

## Запуск

```bash
npm install
npm run db:migrate     # создать схему (идемпотентно)
npm run s3:cors        # один раз на бакет, необходимо для presigned-загрузок из браузера
npm run dev
```

| Скрипт | Что делает |
|---|---|
| `npm run dev` | сервер в watch-режиме |
| `npm run build` / `npm start` | сборка в `dist/` и запуск |
| `npm run typecheck` | `tsc` по `tsconfig.test.json` — исходники и тесты одним проходом |
| `npm test` | один прогон vitest |
| `npm run test:watch` | vitest в watch-режиме |
| `npm run test:coverage` | покрытие (нужен `@vitest/coverage-v8`) |
| `npm run db:migrate` | применяет `src/db/migrations/*.sql`, история в `schema_migrations` |
| `npm run db:cleanup` | разбирает presigned-загрузки, которые так и не подтвердили |
| `npm run s3:cors` | применяет CORS-правила бакета для `CORS_ORIGIN` |
| `npm run openapi` | пересобирает `openapi.json` из Zod-схем; после него — `npm run api:generate` в `client/` |

## Конфигурация

Весь `.env` валидируется в `src/config.ts` при старте; при любом пропущенном значении процесс завершается.

Ключи хранилища специфичны для Cloud.ru: **access key id для S3 — это `S3_TENANT_ID:KEY_ID`**, а бакет
резолвится только через **path-style** эндпоинт (`forcePathStyle: true`), но не через
`<bucket>.s3.cloud.ru`.

| Переменная | По умолчанию | Примечания |
|---|---|---|
| `PORT` | `3000` | |
| `LOGIN_USER_APP` | — | логин единственного пользователя; непустой, без пробелов по краям |
| `PASSWORD_USER_APP` | — | его пароль, ≥ 8 символов; смена + рестарт завершают все сессии |
| `JWT_ACCESS_SECRET` | — | ключ подписи токенов доступа, ≥ 32 символов |
| `JWT_REFRESH_SECRET` | — | ключ подписи токенов обновления, ≥ 32 символов, отличный от предыдущего |
| `JWT_ACCESS_TTL_MINUTES` | `15` | срок токена доступа |
| `JWT_REFRESH_TTL_DAYS` | `7` | срок токена обновления и `Max-Age` его cookie |
| `COOKIE_SECURE` | `false` | флаг `Secure` у cookie; `true` только за HTTPS |
| `CORS_ORIGIN` | `http://localhost:5173` | через запятую; используется и в `npm run s3:cors` |
| `API_DOCS_ENABLED` | `true` вне production, `false` в production | Swagger UI на `/api/docs` и спецификация на `/api/openapi.json` |
| `MAX_UPLOAD_SIZE_MB` | `50` | только для загрузок через сервер |
| `PRESIGN_UPLOAD_TTL_SECONDS` | `900` | |
| `PRESIGN_DOWNLOAD_TTL_SECONDS` | `300` | |
| `PENDING_TTL_HOURS` | `24` | возраст, при котором `db:cleanup` разбирает запись в статусе pending; `0` — разобрать всё прямо сейчас |
| `MULTIPART_THRESHOLD_MB` | `100` | от какого размера `presign-upload` отвечает multipart-планом |
| `MULTIPART_PART_SIZE_MB` | `16` | желаемый размер части; не меньше 5 — это floor самого S3 |
| `MULTIPART_MAX_PARTS` | `10000` | потолок S3; часть растёт, лишь бы уложиться в него |
| `MULTIPART_URL_BATCH` | `100` | ссылок за один запрос: размер ответа и длина всплеска на подписи |
| `MULTIPART_MAX_CONCURRENCY` | `4` | уезжает клиенту как `maxConcurrency` |
| `MULTIPART_MAX_ACTIVE_UPLOADS` | `10` | незакрытых multipart-загрузок во всём сервисе |
| `PRESIGN_PART_TTL_SECONDS` | `3600` | TTL ссылки на часть |
| `MAX_OBJECT_SIZE_GB` | `200` | потолок размера одного объекта |
| `DATABASE_SSL` | `false` | |

## API

`/health` и `/health/ready` открыты. Всё под `/api` требует `Authorization: Bearer <токен доступа>`,
кроме `/api/auth/*` и документации. Токен проверяется только по подписи, сроку и типу, без базы.

### Аутентификация

Пользователь один, его задают `LOGIN_USER_APP` и `PASSWORD_USER_APP`; регистрации нет. На старте,
после проверки базы, сервер заводит для него строку в `users` (без дублей и при одновременных
стартах), а если пароль в `.env` сменился — перехеширует его и поднимает `token_version`, то есть
завершает все сессии. Строки с другими логинами не трогаются, но войти может только логин из
окружения. Без применённой миграции `004_users.sql` сервер не стартует. Почему так —
[ADR-0007](../docs/adr/0007-autentifikatsiya-polzovatelya-iz-okruzheniya.md).

| Эндпоинт | Успех | Ошибка |
|---|---|---|
| `POST /api/auth/login` `{ login, password }` | `200 { accessToken, expiresIn, user: { login } }` + cookie | `401 INVALID_CREDENTIALS` |
| `POST /api/auth/refresh` (по cookie) | тот же ответ и новая cookie | `401 SESSION_EXPIRED` |
| `POST /api/auth/logout` | `204`, cookie очищена; ничего не отзывает | — |

Токен обновления живёт в cookie `refresh_token` (`HttpOnly`, `SameSite=Strict`, `Path=/api/auth`,
`Max-Age` = `JWT_REFRESH_TTL_DAYS`, `Secure` = `COOKIE_SECURE`). Пароли хешируются `scrypt` из
`node:crypto`, токены — JWT HS256 на `jose`. Модуль — `src/modules/auth/`, слои как у `files`.

Контракт описан в `openapi.json` — он собирается из Zod-схем запросов и ответов
(`src/modules/files/adapters/http/schemas.ts`, `responses.ts`, `openapi.ts`) командой
`npm run openapi` и коммитится; клиент генерирует из него типы. Тест `src/openapi.test.ts` падает,
если файл устарел или маршрут не описан. Почему так — [ADR-0006](../docs/adr/0006-kontrakt-api-iz-zod-shem.md).

Swagger UI — `/api/docs` (через vite-прокси: `http://localhost:5173/api/docs`). Токен доступа из
ответа `POST /api/auth/login` вводится в **Authorize** и переживает перезагрузку страницы. Включается `API_DOCS_ENABLED`.

### Ошибки

Ответ с ошибкой всегда имеет один и тот же вид:

```jsonc
{
  "error": {
    "code": "STORAGE_UNAVAILABLE",  // стабильный код, по нему клиент выбирает текст
    "message": "Object storage is unreachable right now; please try again shortly",
    "details": { "operation": "PutObject" },   // необязательное, зависит от кода
    "requestId": 42                            // тот же id, что и в строке лога
  }
}
```

`requestId` присваивает `pino-http`; по нему в логе находятся и access-строка, и строка ошибки —
это единственный способ связать жалобу клиента с тем, что реально произошло на сервере. Внутренности
зависимостей (имя ошибки AWS, ключ объекта, SQLSTATE, имя констрейнта) в ответ не попадают: они
уходят только в лог.

| Код | Статус | Когда |
|---|---|---|
| `UNAUTHORIZED` | 401 | нет токена доступа, он истёк или недействителен |
| `INVALID_CREDENTIALS` | 401 | вход не удался; не говорит, что именно неверно — логин или пароль |
| `SESSION_EXPIRED` | 401 | продление не удалось: нет cookie, токен истёк или сессии отозваны — нужен вход |
| `ROUTE_NOT_FOUND` | 404 | такого маршрута нет |
| `VALIDATION_ERROR` | 422 | не прошла zod-схема; `details` — `{ formErrors, fieldErrors }` |
| `FILE_REQUIRED` | 400 | в `multipart/form-data` нет поля `file` |
| `INVALID_DIRECTORY`, `INVALID_FILE_NAME` | 400 | путь или имя не пережили нормализацию |
| `UPLOAD_REJECTED` | 400 | multer отверг форму (лишнее поле, больше одного файла) |
| `PAYLOAD_TOO_LARGE` | 413 | файл больше `MAX_UPLOAD_SIZE_MB` — нужен presigned-сценарий |
| `FILE_NOT_FOUND` | 404 | записи нет или она уже удалена |
| `FILE_NOT_READY` | 409 | файл ещё не `ready`, скачивать нечего |
| `UPLOAD_NOT_COMPLETED` | 409 | по зарезервированному ключу так и не появился объект |
| `INVALID_UPLOAD_SIZE` | 400 | `size` не положительное число |
| `INVALID_PART_NUMBER` | 400 | номер части вне `1..partCount` либо в запросе больше `MULTIPART_URL_BATCH` номеров |
| `MULTIPART_NOT_FOUND` | 409 | у записи нет незавершённой multipart-загрузки |
| `MULTIPART_INCOMPLETE` | 409 | при завершении в хранилище лежат не все части |
| `TOO_MANY_ACTIVE_UPLOADS` | 429 | исчерпан `MULTIPART_MAX_ACTIVE_UPLOADS` |
| `DUPLICATE_RESOURCE` | 409 | нарушен уникальный индекс |
| `STORAGE_MISCONFIGURED` | 502 | S3 отверг запрос: не тот бакет или ключи |
| `STORAGE_ERROR` | 502 | S3 ответил тем, с чем сервис работать не может |
| `STORAGE_UNAVAILABLE` | 503 | до S3 не достучаться |
| `DATABASE_TIMEOUT` | 503 | запрос снят по `statement_timeout` |
| `DATABASE_UNAVAILABLE` | 503 | БД недоступна |
| `INTERNAL_SERVER_ERROR` | 500 | всё остальное; вне production в `details` кладётся стек |

Разделение 502 и 503 намеренное: 502 повторять бессмысленно (сломана конфигурация — это чинится
деплоем), 503 — стоит, зависимость может ответить через секунду. `TOO_MANY_ACTIVE_UPLOADS` — про
занятые слоты, а не про частоту запросов: автоматический повтор упрётся в тот же занятый слот, место
освобождает только `complete` или `DELETE` одной из идущих загрузок.

### Загрузка

Оба сценария создают запись одного и того же вида и взаимозаменяемы с точки зрения клиента.

**Через сервер** — просто, ограничено `MAX_UPLOAD_SIZE_MB`:

```
POST /api/files          multipart/form-data: file, directory?
→ 201 FileDto
```

**Напрямую в S3** — для файлов побольше; байты не проходят через процесс API:

```
POST /api/files/presign-upload   { filename, directory?, contentType?, size? }
→ 201 { id, key, directory, uploadUrl, expiresAt, requiredHeaders }

PUT <uploadUrl>                  ровно с теми заголовками, что в requiredHeaders
                                 (Content-Type входит в подпись)

POST /api/files/:id/complete
→ 200 FileDto
```

Вызов `complete` не опционален. Пока он не выполнен, запись остаётся в статусе `pending`, и именно он
заполняет `size` и `etag` — они вычитываются из S3 через `HeadObject`, а не берутся на веру у клиента.
Вызов идемпотентен и возвращает `409 UPLOAD_NOT_COMPLETED`, если по зарезервированному ключу так и не
появился объект. Запись в статусе `failed` (её уже успел разобрать `db:cleanup`) он тоже примет, если
объект в хранилище всё-таки есть: это значит, что загрузка прошла, а потерялось лишь подтверждение.

**Частями напрямую в S3** — для файлов, которые не стоит лить одним запросом. Тот же
`presign-upload`: если в теле есть `size` и он не меньше `MULTIPART_THRESHOLD_MB`, ответ приходит с
`strategy: "multipart"` вместо `strategy: "single"`. Без `size` сценарий всегда single.

```
POST /api/files/presign-upload   { filename, directory?, contentType?, size }
→ 201 { strategy: "multipart", id, key, directory, uploadId, size, partSize, partCount,
        maxConcurrency, expiresAt,
        parts: [{ partNumber, offset, size, url }, …] }   // первые MULTIPART_URL_BATCH

PUT <parts[i].url>               тело = file.slice(offset, offset + size)
                                 не больше maxConcurrency запросов одновременно

POST /api/files/:id/multipart/part-urls   { partNumbers: [ … ] }
→ 200 { expiresAt, parts: [{ partNumber, offset, size, url }, …] }

GET  /api/files/:id/multipart
→ 200 { id, uploadId, size, partSize, partCount, uploadedParts, uploadedBytes }

POST /api/files/:id/complete     → 200 FileDto
DELETE /api/files/:id            → 204 (отменяет незавершённую загрузку)
```

**На сколько частей резать, решает сервер.** `src/modules/files/upload-plan.ts` получает желаемый
`partSize` из политики загрузки и, если частей выходит больше `MULTIPART_MAX_PARTS`, увеличивает часть до
`ceil(size / maxParts)`, округлённого вверх до мегабайта. Клиент получает готовые `offset`/`size` и
ничего не пересчитывает.

| Размер файла | `partSize` | `partCount` |
|---|---|---|
| 80 МиБ | — | `strategy: "single"` |
| 100 МиБ | 16 МиБ | 7 (последняя — 4 МиБ) |
| 1 ГиБ | 16 МиБ | 64 |
| 160 ГиБ | **17 МиБ** | 9 638 |

Последняя часть почти всегда меньше 5 МиБ — правило минимума на неё не распространяется.

`part-urls` выдаёт и следующую пачку ссылок, и замену протухшим: подписи живут
`PRESIGN_PART_TTL_SECONDS`, а загрузка может идти дольше. `GET /:id/multipart` отвечает тем, что
реально лежит в S3, — этого достаточно, чтобы продолжить прерванную загрузку, в том числе после
перезагрузки страницы.

Завершение и отмена — **те же маршруты, что у single-сценария**. `complete` смотрит на запись: если
это multipart, он собирает объект из частей и только потом читает результат через `HeadObject`.
`DELETE` по незавершённой загрузке делает `AbortMultipartUpload`, а не `DeleteObject`: объекта по
ключу ещё нет, убирать надо залитые части.

### Чтение

```
GET /api/files?directory=&recursive=&search=&status=&page=&limit=&sort=&order=
→ { items: FileDto[], pagination: { page, limit, total, totalPages } }
```

`directory` сопоставляется точно, если не указано `recursive=true`. `status` по умолчанию `ready`
(`any` — все), `limit` ограничен сверху значением 200, `sort` — одно из `created_at` |
`original_name` | `size_bytes`.

```
GET /api/files/:id?withUrl=true          → FileDto (withUrl добавляет свежий downloadUrl)
GET /api/files/:id/download-url?disposition=attachment|inline&expiresIn=
                                         → { url, expiresAt, name }
DELETE /api/files/:id                    → 204
GET /api/directories?parent=docs         → { parent, items: [{ name, path, fileCount }] }
```

`/api/directories` выводит дерево папок из сохранённых путей директорий; `fileCount` учитывает всё
поддерево. Ссылки на скачивание несут `Content-Disposition`, восстанавливающий исходное имя файла,
включая не-ASCII, через RFC 5987 `filename*`.

### FileDto

```jsonc
{
  "id": "a5e1ee53-…",              // он же — базовое имя ключа S3
  "name": "Отчёт за Q3.pdf",       // исходное имя, сохраняется в БД
  "directory": "docs/reports",     // нормализовано: без ведущих/конечных/повторяющихся слэшей
  "extension": "pdf",
  "contentType": "application/pdf",
  "size": 74,                      // null, пока presigned-загрузка не подтверждена
  "etag": "\"9020e7b4…\"",
  "status": "ready",               // pending | ready | failed
  "uploadSource": "server",        // server | presigned | multipart
  "bucket": "bucket-4f84ee",
  "key": "docs/reports/a5e1ee53-….pdf",
  "createdAt": "2026-08-27T12:45:43.437Z",
  "updatedAt": "2026-08-27T12:45:43.437Z"
}
```

## Заметки по устройству

- **Ключи объектов — это `<directory>/<uuid>.<ext>`,** а не исходное имя файла. Поэтому ключ известен
  ещё до того, как появятся байты, — именно это делает возможным presigned-сценарий, — а загрузки не
  могут ни столкнуться друг с другом, ни споткнуться о символы, неудобные в URL. Отображаемое имя
  живёт в базе и возвращается через `Content-Disposition`.
- **Строка директории — единственный недоверенный ввод, попадающий в ключ,** поэтому
  `normalizeDirectory` в `src/storage/keys.ts` прямо отвергает `..`, управляющие символы и слишком длинные
  сегменты, а не пытается их переписать.
- **Удаление мягкое в базе и best-effort в S3.** Источник истины — запись с метаданными, поэтому её
  выводят из обращения первой; неудачное удаление в хранилище оставит лишь объект, на который никто
  не ссылается.
- **Частями multipart-загрузки владеет S3, а не база.** Отдельной таблицы частей нет: при завершении
  и при возобновлении список берётся из `ListParts`. Это то же решение, по которому `size` и `etag`
  вычитываются из `HeadObject`, и оно же бесплатно даёт возобновление с другой вкладки или машины. В
  записи живут только `upload_id`, `part_size` и `part_count`, и все три обнуляются, как только
  загрузка завершилась или была разобрана.
- **Гонки в multipart разрешаются без блокировок.** Два одновременных `complete` разводит сам S3:
  проигравший получает `NoSuchUpload` и дочитывает результат победителя через `HeadObject`. Уборщик
  же сначала захватывает строку одним `update` (`claimExpiredMultipart`) и только потом отменяет
  загрузку, поэтому не может снести файл, который клиент дособирает прямо сейчас.
- **`src/middleware/validate.ts`** кладёт провалидированные query-строки и параметры маршрута в
  `res.locals`, потому что в Express 5 `req.query` доступен только на чтение.

## Тесты

Vitest, конфигурация в `vitest.config.ts`.

```bash
npm test               # один прогон
npm run test:watch     # watch-режим
npm run test:coverage  # покрытие; требует npm i -D @vitest/coverage-v8
```

Тесты лежат рядом с кодом — `src/**/*.test.ts`. В `tsconfig.json` они исключены, поэтому в `dist/` не
попадают, а `npm run typecheck` проверяет их вместе с исходниками через `tsconfig.test.json`.

Окружение задано фиктивными значениями прямо в `vitest.config.ts` (`test.env`) и перекрывает `.env`.
Иначе никак: `src/config.ts` валидирует переменные на импорте и завершает процесс при нехватке любой
из них, так что без полного набора не поднимется ни один модуль, который его импортирует. Заодно
прогон перестаёт зависеть от того, что лежит в локальном `.env`.

Набор покрывает логику, которой не нужны ни S3, ни база: именование и санитизация ключей, трансляция
ошибок pg и AWS SDK, маппер `FileDto`, вход, продление и `requireAuth` поверх in-memory строк пользователей. Маршруты `/api/auth/*` и
`requireAuth` проверяются по HTTP на поднятом через `app.listen(0)` приложении, без `supertest`.

## Структура

```
src/
  config.ts logger.ts errors.ts app.ts server.ts
  composition.ts  сборка: единственное место, где называются конкретные адаптеры
  db/        pool.ts, errors.ts (трансляция ошибок pg), migrate.ts, migrations/
  storage/   object-store.ts (шов), s3-object-store.ts и s3-client.ts (специфика
             Cloud.ru), s3-errors.ts (трансляция ошибок SDK), memory-object-store.ts
             (реализация для тестов), keys.ts (именование и санитизация)
  middleware/ upload.ts, validate.ts, error-handler.ts
  modules/auth/   вход, продление, выход, requireAuth и пользователь из окружения
  modules/files/  routes → module → rows: фабрики, принимающие зависимости, плюс
                  file-rows.ts (узкие интерфейсы) и memory-file-rows.ts, files.repo.ts
                  (SQL), cleanup.service.ts (уборка), upload-plan.ts, upload-policy.ts,
                  schemas/types/mapper
  scripts/   s3-cors.ts, cleanup-pending.ts (вторая сборка: собирает модуль уборки)
  testing/   clock.ts и failure-switch.ts — ручки вторых реализаций
  **/*.test.ts  тесты рядом с модулями, которые они проверяют
```
