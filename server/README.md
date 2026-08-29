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
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:migrate` | применяет `src/db/migrations/*.sql`, история в `schema_migrations` |
| `npm run db:cleanup` | разбирает presigned-загрузки, которые так и не подтвердили |
| `npm run s3:cors` | применяет CORS-правила бакета для `CORS_ORIGIN` |

## Конфигурация

Весь `.env` валидируется в `src/config.ts` при старте; при любом пропущенном значении процесс завершается.

Ключи хранилища специфичны для Cloud.ru: **access key id для S3 — это `S3_TENANT_ID:KEY_ID`**, а бакет
резолвится только через **path-style** эндпоинт (`forcePathStyle: true`), но не через
`<bucket>.s3.cloud.ru`.

| Переменная | По умолчанию | Примечания |
|---|---|---|
| `PORT` | `3000` | |
| `API_KEY` | — | обязателен в `X-API-Key` на каждом маршруте `/api/*` |
| `CORS_ORIGIN` | `http://localhost:5173` | через запятую; используется и в `npm run s3:cors` |
| `MAX_UPLOAD_SIZE_MB` | `50` | только для загрузок через сервер |
| `PRESIGN_UPLOAD_TTL_SECONDS` | `900` | |
| `PRESIGN_DOWNLOAD_TTL_SECONDS` | `300` | |
| `PENDING_TTL_HOURS` | `24` | возраст, при котором `db:cleanup` разбирает запись в статусе pending |
| `DATABASE_SSL` | `false` | |

## API

`/health` и `/health/ready` открыты. Всё под `/api` требует `X-API-Key`.

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
| `UNAUTHORIZED` | 401 | нет или неверен `X-API-Key` |
| `ROUTE_NOT_FOUND` | 404 | такого маршрута нет |
| `VALIDATION_ERROR` | 422 | не прошла zod-схема; `details` — `{ formErrors, fieldErrors }` |
| `FILE_REQUIRED` | 400 | в `multipart/form-data` нет поля `file` |
| `INVALID_DIRECTORY`, `INVALID_FILE_NAME` | 400 | путь или имя не пережили нормализацию |
| `UPLOAD_REJECTED` | 400 | multer отверг форму (лишнее поле, больше одного файла) |
| `PAYLOAD_TOO_LARGE` | 413 | файл больше `MAX_UPLOAD_SIZE_MB` — нужен presigned-сценарий |
| `FILE_NOT_FOUND` | 404 | записи нет или она уже удалена |
| `FILE_NOT_READY` | 409 | файл ещё не `ready`, скачивать нечего |
| `UPLOAD_NOT_COMPLETED` | 409 | по зарезервированному ключу так и не появился объект |
| `DUPLICATE_RESOURCE` | 409 | нарушен уникальный индекс |
| `STORAGE_MISCONFIGURED` | 502 | S3 отверг запрос: не тот бакет или ключи |
| `STORAGE_ERROR` | 502 | S3 ответил тем, с чем сервис работать не может |
| `STORAGE_UNAVAILABLE` | 503 | до S3 не достучаться |
| `DATABASE_TIMEOUT` | 503 | запрос снят по `statement_timeout` |
| `DATABASE_UNAVAILABLE` | 503 | БД недоступна |
| `INTERNAL_SERVER_ERROR` | 500 | всё остальное; вне production в `details` кладётся стек |

Разделение 502 и 503 намеренное: 502 повторять бессмысленно (сломана конфигурация — это чинится
деплоем), 503 — стоит, зависимость может ответить через секунду.

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
  "uploadSource": "server",        // server | presigned
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
  `normalizeDirectory` в `src/s3/keys.ts` прямо отвергает `..`, управляющие символы и слишком длинные
  сегменты, а не пытается их переписать.
- **Удаление мягкое в базе и best-effort в S3.** Источник истины — запись с метаданными, поэтому её
  выводят из обращения первой; неудачное удаление в хранилище оставит лишь объект, на который никто
  не ссылается.
- **`src/middleware/validate.ts`** кладёт провалидированные query-строки и параметры маршрута в
  `res.locals`, потому что в Express 5 `req.query` доступен только на чтение.

## Структура

```
src/
  config.ts logger.ts errors.ts app.ts server.ts
  db/        pool.ts, errors.ts (трансляция ошибок pg), migrate.ts, migrations/
  s3/        client.ts (специфика Cloud.ru), keys.ts (именование и санитизация),
             errors.ts (трансляция ошибок AWS SDK)
  middleware/ api-key.ts, upload.ts, validate.ts, error-handler.ts
  modules/files/  routes → service → repo, плюс schemas/types/mapper
  scripts/   s3-cors.ts, cleanup-pending.ts
```
