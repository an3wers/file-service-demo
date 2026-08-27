> **Статус: реализовано 27.08.2026.** План выполнен целиком; ниже — исходный документ
> без изменений. Отличия итогового кода от плана:
> - `decodeOriginalName` сделан строже: перед перекодировкой проверяет, что строка
>   действительно похожа на latin1-байты, иначе уже корректное имя было бы испорчено;
> - дополнительно написан `server/README.md` с контрактом API для клиента;
> - `dotenv` удалён из зависимостей (скрипты используют `node --env-file-if-exists`).
>
> Контракт API и заметки по архитектуре — в [`server/README.md`](../server/README.md).

---

# Серверная часть файлового сервиса (MVP) — Express 5 + Cloud.ru S3 + PostgreSQL

## Context

В `server/` сейчас пустой каркас: Express 5 на ESM/TypeScript, `pino-http`, `cors`, `zod`,
готовые `AppError` + `errorHandler` + хелперы `validateBody/validateQuery/validateParams`
и единственный роут `/health`. Ни S3-клиента, ни драйвера БД, ни таблиц нет.

Нужно довести его до рабочего MVP файлового сервиса: загрузка файлов в S3 с «директорией»
(она же — префикс ключа объекта), presigned-загрузка/скачивание, метаданные в PostgreSQL,
API списка файлов и карточки файла. Клиент (`client/`, Vue 3 + shadcn-vue) на выходе должен
уметь показать дерево папок, залить файл двумя способами и скачать его.

---

## Проверенные факты об окружении

Это результаты реальных проб, а не предположения — они определяют конфигурацию клиентов.

| Что | Значение | Как проверено |
|---|---|---|
| Провайдер S3 | Cloud.ru Object Storage, `https://s3.cloud.ru`, регион `ru-central-1` | `.env` |
| **Access Key ID** | **`<S3_TENANT_ID>:<KEY_ID>`** (через двоеточие), secret = `KEY_SECRET` | [док Cloud.ru](https://cloud.ru/docs/s3e/ug/topics/tools__sdk-python); путь без tenant отдаёт `AuthorizationQueryParametersError: missing tenant id` |
| **Адресация** | **только path-style** (`forcePathStyle: true`) | `GET https://s3.cloud.ru/bucket-4f84ee/` → 400 «missing tenant id» (бакет найден); `GET https://bucket-4f84ee.s3.cloud.ru/` → 404 `NoSuchBucket` |
| `S3_DOMAIN` | `https://s3-answ.s3.cloud.ru` — витринный домен, **для SDK не используется** | 4-уровневый поддомен не резолвится |
| PostgreSQL | `176.108.243.12:5432/file_service_db`, порт открыт, таблиц нет | TCP-проба |
| Node | v24.19.0, npm 11.17.0 | `node -v` |

## Принятые решения

- **Ключ объекта:** `<directory>/<uuid><ext>` (например `docs/reports/9f3a1c2e-….pdf`).
  Оригинальное имя живёт в БД и подставляется при скачивании через `Content-Disposition`.
  Ключ известен **до** загрузки — это то, что делает presigned-флоу возможным.
- **Прокси-загрузка:** `multer.memoryStorage()` + `PutObjectCommand`, с жёстким лимитом размера.
  Крупные файлы — задача presigned-флоу.
- **Авторизация:** статический `X-API-Key` из `.env` на всех `/api/*` (`/health` открыт).
- **Доп. объём:** список директорий, удаление файла, скрипт настройки CORS бакета, очистка «висящих» загрузок.

---

## Зависимости

```bash
npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner pg multer
npm i -D @types/pg @types/multer
```

`dotenv` в зависимостях лишний — скрипты уже используют `node --env-file-if-exists=.env`. Удалить.

## Переменные окружения (дописать в `.env`)

```
PORT=3000
API_KEY=<придумать длинную строку>
CORS_ORIGIN=http://localhost:5173
MAX_UPLOAD_SIZE_MB=50
PRESIGN_UPLOAD_TTL_SECONDS=900
PRESIGN_DOWNLOAD_TTL_SECONDS=300
PENDING_TTL_HOURS=24
DATABASE_SSL=false
```

---

## Структура файлов

Новое, если не помечено иначе:

```
src/
  config.ts                       zod-схема над process.env, падаем на старте при нехватке
  logger.ts                       общий инстанс pino (переиспользовать в pino-http)
  errors.ts                       [править] добавить поле code
  app.ts                          [править] подключить роутеры + apiKeyAuth
  server.ts                       [править] прогрев пула и pool.end() при shutdown
  db/
    pool.ts                       pg.Pool + парсер bigint
    migrate.ts                    раннер миграций
    migrations/001_init.sql
  s3/
    client.ts                     S3Client (path-style, checksum WHEN_REQUIRED)
    keys.ts                       normalizeDirectory / buildObjectKey / contentDisposition / decodeOriginalName
  middleware/
    api-key.ts
    upload.ts                     инстанс multer
    error-handler.ts              [править] MulterError → 413/400, реальный code
    validate.ts                   [без изменений] переиспользовать как есть
  routes/health.ts                [править] добавить GET /health/ready (БД + S3)
  modules/files/
    files.schemas.ts  files.repo.ts  files.service.ts  files.mapper.ts  files.routes.ts
    directories.repo.ts  directories.routes.ts
  scripts/
    s3-cors.ts  cleanup-pending.ts
```

Скрипты в `package.json`: убрать мёртвые `search:init` / `search:seed` (файлов нет), добавить
`db:migrate`, `db:cleanup`, `s3:cors`. **Важно:** `tsc` не копирует `.sql`, поэтому
`"build": "tsc -p tsconfig.json && cp -r src/db/migrations dist/db/migrations"`.

---

## Схема БД — `src/db/migrations/001_init.sql`

```sql
create table if not exists files (
  id            uuid        primary key,
  bucket        text        not null,
  object_key    text        not null,
  directory     text        not null default '',   -- '' = корень, без ведущих/хвостовых '/'
  original_name text        not null,
  extension     text        not null default '',
  content_type  text        not null default 'application/octet-stream',
  size_bytes    bigint,
  etag          text,
  status        text        not null default 'pending',
  upload_source text        not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint files_status_check check (status in ('pending','ready','failed')),
  constraint files_source_check check (upload_source in ('server','presigned'))
);

create unique index if not exists files_object_key_uniq on files (bucket, object_key);
create index if not exists files_dir_created_idx on files (directory, created_at desc) where deleted_at is null;
create index if not exists files_status_created_idx on files (status, created_at);
create index if not exists files_name_lower_idx on files (lower(original_name));
```

`id` генерируем в приложении через `crypto.randomUUID()` (он нужен ещё до вставки, чтобы
построить ключ) — так схема не зависит от версии PostgreSQL и наличия `pgcrypto`.

`migrate.ts`: таблица `schema_migrations (name text primary key, applied_at timestamptz default now())`,
читаем `migrations/*.sql` по алфавиту, каждый непримененный — в транзакции, затем запись в журнал.

---

## API

Все `/api/*` требуют заголовок `X-API-Key`. Ошибки — в существующем формате `{ error: { code, message, details } }`.

### 1. `POST /api/files` — загрузка через сервер
`multipart/form-data`: `file` (обяз.), `directory` (опц., например `docs/reports`).
→ нормализовать директорию → построить ключ → `PutObjectCommand` → `INSERT status='ready'` → `201 FileDto`.
Если S3 записал, а вставка в БД упала — компенсирующий `DeleteObject`, затем пробросить ошибку.

### 2. `POST /api/files/presign-upload`
Body: `{ directory?, filename, contentType?, size? }`
→ `INSERT status='pending'` → `getSignedUrl(PutObjectCommand)`
→ `201 { id, key, directory, uploadUrl, expiresAt, requiredHeaders: { "Content-Type": … } }`
Клиент делает `PUT uploadUrl` с **ровно теми** заголовками, что вернул сервер.

### 3. `POST /api/files/:id/complete` — подтверждение presigned-загрузки
`HeadObjectCommand` по ключу; нет объекта → `409`. Есть → записать реальные `size_bytes`,
`etag`, `content_type`, `status='ready'` → `200 FileDto`.
Идемпотентно: для уже `ready` просто возвращаем карточку.
**Шаг обязателен** — иначе БД копит записи о загрузках, которых не было, а размер, присланный клиентом, никем не проверен.

### 4. `GET /api/files/:id/download-url`
Query: `disposition=attachment|inline` (по умолч. `attachment`), `expiresIn?`.
→ `getSignedUrl(GetObjectCommand)` с `ResponseContentDisposition` и `ResponseContentType`
→ `200 { url, expiresAt }`.

### 5. `GET /api/files` — список
Query: `directory?`, `recursive=false`, `search?`, `status=ready`, `page=1`, `limit=50` (max 200),
`sort=created_at|original_name|size_bytes`, `order=desc`.
→ `{ items: FileDto[], pagination: { page, limit, total, totalPages } }`.
Условие директории: `directory = $1` либо, при `recursive`, `directory = $1 or directory like $1 || '/%'`.
`total` брать через `count(*) over()` в том же запросе — второй round-trip не нужен.
Сортировку подставлять из белого списка колонок, а не из строки запроса.

### 6. `GET /api/files/:id` — карточка
Полные метаданные. `?withUrl=true` — доложить свежий presigned-URL на скачивание.

### 7. `DELETE /api/files/:id`
`deleted_at = now()` в БД (источник истины), затем best-effort `DeleteObjectCommand`;
неудачу удаления в S3 логировать, но ответ не ломать. → `204`.

### 8. `GET /api/directories?parent=`
→ `{ parent, items: [{ name, path, fileCount }] }` — непосредственные подпапки,
`fileCount` = число файлов во всём поддереве. Выводится из `files.directory`:

```sql
with children as (
  select case
           when $1 = '' then split_part(directory, '/', 1)
           else $1 || '/' || split_part(right(directory, -(length($1) + 1)), '/', 1)
         end as path
  from files
  where deleted_at is null and status = 'ready'
    and ($1 = '' or directory = $1 or directory like $1 || '/%')
    and directory <> $1 and directory <> ''
)
select path, count(*)::int as file_count
from children where path <> '' group by path order by path;
```

### FileDto
`{ id, name, directory, extension, contentType, size, etag, status, uploadSource, bucket, key, createdAt, updatedAt }`

---

## Ключевые детали реализации

**`s3/client.ts` — три обязательных настройки:**
```ts
new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,                    // https://s3.cloud.ru
  forcePathStyle: true,                            // virtual-hosted у Cloud.ru отдаёт NoSuchBucket
  requestChecksumCalculation: "WHEN_REQUIRED",     // иначе SDK шлёт x-amz-checksum-crc32 + aws-chunked
  responseChecksumValidation: "WHEN_REQUIRED",
  credentials: {
    accessKeyId: `${config.s3.tenantId}:${config.s3.keyId}`,
    secretAccessKey: config.s3.keySecret,
  },
});
```
Про checksum: свежие `@aws-sdk/client-s3` по умолчанию добавляют checksum-заголовки, из-за чего
presigned PUT ломается с `SignatureDoesNotMatch`/`UnsignedHeaders` — браузер эти заголовки не шлёт
([aws-sdk-js-v3#3906](https://github.com/aws/aws-sdk-js-v3/issues/3906), [#4849](https://github.com/aws/aws-sdk-js-v3/issues/4849)).
Многие S3-совместимые хранилища ломаются на этом же.

**`s3/keys.ts` — нормализация директории.** Это точка входа недоверенных данных, ключ S3 собирается
из строки клиента:
- `\` → `/`, `NFC`-нормализация, split по `/`, `trim`, выбросить пустые сегменты;
- отвергнуть `.`, `..`, управляющие символы (` -`, ``);
- сегмент ≤ 100 символов, вся директория ≤ 700 (лимит ключа S3 — 1024 байта);
- на выходе `docs/reports` или `''` для корня.

Расширение брать из `path.extname(name).toLowerCase()` и пропускать только по `/^\.[a-z0-9]+$/`,
иначе — пустая строка.

`contentDisposition(name, type)` → `attachment; filename="ascii-fallback"; filename*=UTF-8''<encodeURIComponent>`
— иначе кириллические имена не доедут до браузера.

**Кириллица в именах при прокси-загрузке.** busboy (внутри multer) по умолчанию декодирует
`filename` как `latin1`, multer не пробрасывает `defParamCharset`. Нужен хелпер:
```ts
export const decodeOriginalName = (name: string) =>
  Buffer.from(name, "latin1").toString("utf8");
```
Без него `Отчёт.pdf` превратится в мусор ([multer#1104](https://github.com/expressjs/multer/issues/1104)).

**bigint в `pg`.** `size_bytes bigint` возвращается драйвером как **строка**. В `db/pool.ts`:
`pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)))`.

**`errors.ts` / `error-handler.ts`.** Сейчас обработчик отдаёт `code: error.name`, а это всегда
`"AppError"` — клиент не может различить ошибки. Добавить в `AppError` поле `code`
(`FILE_NOT_FOUND`, `INVALID_DIRECTORY`, `UPLOAD_NOT_COMPLETED`, …) и отдавать его.
Отдельной веткой обработать `MulterError`: `LIMIT_FILE_SIZE` → `413`, остальное → `400`.

**Порядок middleware в `app.ts`:**
`pinoHttp(logger)` → `cors({ origin: CORS_ORIGIN, allowedHeaders: ["Content-Type","X-API-Key"] })`
→ `express.json()` → `/health` (публично) → `apiKeyAuth` → `/api/files` → `/api/directories`
→ `notFoundHandler` → `errorHandler`.
Сравнение API-ключа делать через `crypto.timingSafeEqual` на буферах равной длины.

**`server.ts`:** при старте `select 1` по пулу (падать сразу, а не на первом запросе),
в `shutdown()` — `await pool.end()` перед `process.exit(0)`.

**CORS бакета — обязателен для presigned-загрузки из браузера.** Это настройка *хранилища*,
а не сервера; без неё preflight на `PUT https://s3.cloud.ru/...` не пройдёт.
`scripts/s3-cors.ts` шлёт `PutBucketCorsCommand`: `AllowedOrigins: [CORS_ORIGIN]`,
`AllowedMethods: ["PUT","GET","HEAD"]`, `AllowedHeaders: ["*"]`, `ExposeHeaders: ["ETag"]`,
`MaxAgeSeconds: 3000`. Запускается один раз.

**`scripts/cleanup-pending.ts`:** для записей `status='pending'` старше `PENDING_TTL_HOURS`
сделать `HeadObject`; объект есть → добить до `ready` (загрузка прошла, клиент не позвал
`/complete`), нет → `status='failed'`.

---

## Порядок работ

1. Установить зависимости, дописать `.env`, поправить скрипты в `package.json`.
2. `config.ts`, `logger.ts`, обновлённые `errors.ts` / `error-handler.ts`.
3. `db/pool.ts`, `db/migrations/001_init.sql`, `db/migrate.ts` → прогнать `npm run db:migrate`.
4. `s3/client.ts`, `s3/keys.ts` (+ `middleware/api-key.ts`, `middleware/upload.ts`).
5. `scripts/s3-cors.ts` → прогнать `npm run s3:cors`.
6. Слой файлов: `files.repo.ts` → `files.service.ts` → `files.mapper.ts` → `files.schemas.ts` → `files.routes.ts`.
7. `directories.repo.ts` + `directories.routes.ts`.
8. Подключить всё в `app.ts`, обновить `server.ts` и `/health/ready`.
9. `scripts/cleanup-pending.ts`.

---

## Проверка

`npm run typecheck` — чисто. `npm run dev` и далее вручную, полный круг:

```bash
API=http://localhost:3000; H="X-API-Key: <ключ>"

curl -s $API/health/ready                     # ожидаем ok по БД и по S3

# 1) прокси-загрузка, в т.ч. с кириллическим именем
curl -s -H "$H" -F "file=@./Отчёт.pdf" -F "directory=docs/reports" $API/api/files

# 2) presigned-загрузка
curl -s -H "$H" -H 'Content-Type: application/json' \
  -d '{"filename":"big.bin","directory":"docs","contentType":"application/octet-stream"}' \
  $API/api/files/presign-upload
curl -X PUT -H 'Content-Type: application/octet-stream' --data-binary @big.bin "<uploadUrl>"
curl -s -X POST -H "$H" $API/api/files/<id>/complete     # size/etag должны прийти из HeadObject

# 3) чтение
curl -s -H "$H" "$API/api/files?directory=docs/reports"
curl -s -H "$H" "$API/api/files/<id>?withUrl=true"
curl -s -H "$H" "$API/api/directories?parent=docs"       # ожидаем reports с fileCount

# 4) скачивание — файл должен сохраниться под оригинальным именем
curl -sL -OJ "$(curl -s -H "$H" $API/api/files/<id>/download-url | jq -r .url)"

# 5) удаление
curl -s -X DELETE -H "$H" $API/api/files/<id> -w '%{http_code}\n'
```

Отдельно проверить негатив:
- `directory=../../etc` → `400`, объект в S3 не создан;
- файл больше `MAX_UPLOAD_SIZE_MB` → `413`;
- запрос без `X-API-Key` → `401`;
- `/complete` для id, по которому ничего не залито → `409`.

Presigned-загрузку из браузера (не curl) проверить только после `npm run s3:cors` — иначе
preflight упрётся в CORS бакета.
