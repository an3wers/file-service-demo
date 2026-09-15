# AGENTS.md — server

REST API: Express 5, TypeScript, `pg`, AWS SDK v3 (Cloud.ru Object Storage), zod 4, pino, multer.
Полное описание маршрутов, переменных и кодов ошибок — в [README.md](README.md). Общие для
server/client контракты — в [../AGENTS.md](../AGENTS.md).

## Команды

```bash
npm run dev            # watch через tsx, читает .env
npm run typecheck      # tsc по tsconfig.test.json — исходники и тесты вместе
npm test               # vitest run
npx vitest run src/s3/keys.test.ts   # один файл
npm run build          # tsc + копирование src/db/migrations в dist
npm run db:migrate     # применить новые миграции
npm run db:cleanup     # разобрать неподтверждённые presigned/multipart-загрузки
npm run s3:cors        # CORS бакета для CORS_ORIGIN
```

`npm run build` без `typecheck` тесты не проверяет: `tsconfig.json` их исключает.

## TypeScript и модули

- ESM (`"type": "module"`, `module: NodeNext`): **относительные импорты пишутся с расширением `.js`**
  (`import { config } from "../config.js"`), даже из `.ts`-файлов.
- `verbatimModuleSyntax` — типы импортируются через `import type`.
- `noUncheckedIndexedAccess` — `rows[0]` имеет тип `T | undefined`; в repo принято `rows[0]!` после
  `insert … returning` и `rows[0] ?? null` для поиска.

## Архитектура

```
routes (files.routes.ts) → service (files.service.ts, multipart.service.ts) → repo (files.repo.ts)
```

- **Routes** — только валидация и HTTP: статус, `res.json(await service.x(...))`. Express 5 сам
  ловит отклонённые промисы, поэтому `try/catch` и `next(err)` в async-хендлерах не нужны — просто
  `throw`.
- **Service** — бизнес-логика, S3 и оркестровка; вызывает repo как `import * as repo`.
- **Repo** — сырой SQL через `query` из `src/db/pool.ts` (не `pool.query` напрямую: `query`
  транслирует ошибки pg в `AppError`). Параметры только через `$1, $2…`, SQL в нижнем регистре.
- `files.schemas.ts` — zod-схемы запросов и выведенные из них типы; `files.types.ts` — строки БД
  (`FileRow`, snake_case) и DTO (camelCase); `files.mapper.ts` — `FileRow → FileDto`.

## Правила

**Ошибки.** Бросай `AppError` через помощники из `src/errors.ts` (`badRequest`, `notFound`,
`conflict`, `badGateway`, `serviceUnavailable`…). Код — только из `ERROR_CODES`, строкой не пишется.
Новый код = `ERROR_CODES` + таблица в `README.md` + `MESSAGES` в `client/src/lib/errors.ts`.
`details` уходит клиенту; имена бакетов, ключи объектов, имена ошибок AWS, SQLSTATE кладутся в
`options.logContext`, а исходная ошибка — в `options.cause`. Ошибки AWS SDK оборачивай через
`storageError(error, context)` из `src/s3/errors.ts` — он же решает 502 или 503.

**Валидация.** `validateBody` перезаписывает `req.body`. Query и params в Express 5 доступны только
на чтение, поэтому `validateQuery` / `validateParams` кладут результат в `res.locals` — читай через
`validatedQuery<T>(res)` / `validatedParams<T>(res)`, а не из `req.query`.

**Конфигурация.** `process.env` напрямую не читается — только через `config` из `src/config.ts`.
Новая переменная: zod-схема в `config.ts` → поле в объекте `config` → `.env.example` → таблица в
`README.md`. Если у переменной нет default, **добавь её в `testEnv` в `vitest.config.ts`**: конфиг
валидируется на импорте и делает `process.exit(1)`, иначе упадут все тесты.

**База.** Удаление мягкое: каждый запрос чтения фильтрует `deleted_at is null`. `bigint` приходит
числом (парсер в `pool.ts`). Пользовательский ввод в `LIKE` экранируется `escapeLike`.

**Миграции.** Новый файл `src/db/migrations/NNN_description.sql` со следующим номером; применённые
миграции не редактируются. Применяются по порядку имён, каждая в своей транзакции, история — в
`schema_migrations`.

**S3.**
- Ключ объекта — `<directory>/<uuid>.<ext>` (`buildObjectKey`), исходное имя хранится только в БД и
  отдаётся через `Content-Disposition` (`contentDisposition`, RFC 5987).
- Директория — единственный недоверенный ввод в ключе: `normalizeDirectory` **отвергает** `..` и
  управляющие символы, а не переписывает. Меняешь правила — синхронизируй `client/src/lib/directory.ts`.
- `size` и `etag` берутся из `HeadObject`, а не от клиента. Части multipart — из `ListParts`;
  таблицы частей нет, в записи только `upload_id`, `part_size`, `part_count`.
- В `src/s3/client.ts` не трогай `forcePathStyle: true` (Cloud.ru не резолвит virtual-hosted) и
  `requestChecksumCalculation: "WHEN_REQUIRED"` (иначе presigned PUT из браузера падает с
  `SignatureDoesNotMatch`).
- Статусы записи: `pending → ready | failed`. `complete` идемпотентен и принимает `failed`, если
  объект в S3 всё-таки есть. Гонки multipart разрешаются без блокировок — см. «Заметки по
  устройству» в README.

**Логи.** В обработчиках — `req.log` (несёт `req.id`, он же `requestId` в ответе), вне запроса —
`logger` из `src/logger.ts`. Ошибка передаётся полем `{ err }`.

## Тесты

- Vitest, файлы `src/**/*.test.ts` рядом с кодом, `globals: false` — импортируй `describe/it/expect`
  из `"vitest"`.
- Окружение фиктивное и задано в `vitest.config.ts` (`test.env`), перекрывает `.env`.
- Покрывается только логика без S3 и БД (ключи, мапперы, трансляция ошибок, разбиение на части,
  API-ключ). Тестов HTTP-маршрутов нет, `supertest` не установлен — не пытайся ходить в реальные
  S3/Postgres из тестов.

## Docker

`Dockerfile` запускает `node dist/server.js` напрямую, без `npm start`: иначе npm проглотит SIGTERM и
graceful shutdown не сработает. `/health` (liveness, без зависимостей) и `/health/ready` открыты без
API-ключа; при старте сервер проверяет БД и завершается, если она недоступна.
