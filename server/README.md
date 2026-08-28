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
Ошибки всегда имеют вид `{ "error": { "code", "message", "details"? } }`.

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
появился объект.

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
  db/        pool.ts, migrate.ts, migrations/
  s3/        client.ts (специфика Cloud.ru), keys.ts (именование и санитизация)
  middleware/ api-key.ts, upload.ts, validate.ts, error-handler.ts
  modules/files/  routes → service → repo, плюс schemas/types/mapper
  scripts/   s3-cors.ts, cleanup-pending.ts
```
