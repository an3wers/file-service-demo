# AGENTS.md — server

## Архитектура

```
composition.ts → modules/files/index.ts (createFilesHttp)    → routes → module → ObjectStore, FileRows*
scripts/cleanup-pending.ts → modules/files/index.ts (createFilesCleanup) → module → те же два шва
```

`modules/files/index.ts` — фасад модуля: единственный файл внутри `src/modules`, которому можно
называть `files.repo.ts` и собирать `createFilesModule`/`createMultipartModule`/`createCleanupModule`
в готовый узел. Наружу он отдаёт только эти две сборки и тип их входных зависимостей
(`FilesModuleDependencies`) — `composition.ts` и `scripts/cleanup-pending.ts` не импортируют из
`modules/files` ничего глубже `index.ts`.

- **Зависимости передаются, а не импортируются.** Модули — фабрики: принимают `objectStore` (узкий
  интерфейс порта хранилища из `object-storage.ts`), узкий интерфейс репозитория строк, `UploadPolicy`
  и `Clock`. `bucket` в сценарии не приходит: колонку заполняет адаптер БД, собранный внутри
  `modules/files/index.ts` через `createSqlFileRows(bucket)`. Внутри `src/modules` (кроме
  `files/index.ts`), `src/routes` и `src/app.ts` нельзя импортировать `config.ts`, `files.repo.ts` и
  адаптеры.
- **Сборка** — `src/composition.ts`: единственное место, где называются конкретные адаптеры
  (`createS3ObjectStore`) и читается `config`. Дальше она передаёт объектное хранилище, `bucket` и
  политику в `modules/files/index.ts`, который уже сам решает, каким репозиторием строк и какими
  часами их собрать. Скрипт уборки — тонкая оболочка: он строит те же зависимости из тех же частей
  композиции и не зависит от сборки приложения.
- **Routes** — только валидация и HTTP: статус, `res.json(await files.x(...))`. Express 5 сам
  ловит отклонённые промисы, поэтому `try/catch` и `next(err)` в async-хендлерах не нужны — просто
  `throw`.
- **Module** — бизнес-логика и оркестровка; работает с хранилищем через узкий `ObjectStoreFor*` из
  `object-storage.ts`, со строками через узкий интерфейс из `file-rows.ts`, со временем — через
  `Clock` из `clock.ts`. Вендор за швом: имя `S3` внутри модулей не встречается.
- **Repo** — сырой SQL через `query` из `src/db/pool.ts` (не `pool.query` напрямую: `query`
  транслирует ошибки pg в `AppError`). Параметры только через `$1, $2…`, SQL в нижнем регистре.
  `createSqlFileRows(bucket): FileRows` доказывает при компиляции, что отвечает за все узкие
  интерфейсы; `bucket` в нём фиксирован при сборке, а не приходит с каждым вызовом.
- `files.schemas.ts` — zod-схемы запросов и выведенные из них типы; `files.types.ts` — строки БД
  (`FileRow`, snake_case) и DTO (camelCase); `stored-file.ts` — сущность `StoredFile` (сумма
  состояний) и `toStoredFile: FileRow → StoredFile`, единственное место, где сочетание полей
  проверяется на законность; `files.mapper.ts` — `StoredFile → FileDto`. `FileRow` не выходит за
  пределы `files.repo.ts` и `memory-file-rows.ts` — остальной код работает с `StoredFile`.

## Правила

**Конфигурация.** `process.env` напрямую не читается — только через `config` из `src/config.ts`.
Новая переменная: zod-схема в `config.ts` → поле в объекте `config` → `.env.example` → таблица в
`README.md`. Если у переменной нет default, **добавь её в `testEnv` в `vitest.config.ts`**: конфиг
валидируется на импорте и делает `process.exit(1)`, иначе упадут все тесты.

**Миграции.** Новый файл `src/db/migrations/NNN_description.sql` со следующим номером; применённые
миграции не редактируются. Применяются по порядку имён, каждая в своей транзакции, история — в
`schema_migrations`.

**Логи.** В обработчиках — `req.log` (несёт `req.id`, он же `requestId` в ответе), вне запроса —
`logger` из `src/logger.ts`. Ошибка передаётся полем `{ err }`.
