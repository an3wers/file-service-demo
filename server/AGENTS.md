# AGENTS.md — server

## Архитектура

```
composition.ts → routes (createFilesRouter) → module (createFilesModule, createMultipartModule)
                 → объектное хранилище (ObjectStore) и строки метаданных (FileRows*)
```

- **Зависимости передаются, а не импортируются.** Модули и роутеры — фабрики: принимают
  `objectStore`, узкий интерфейс репозитория, `UploadPolicy` и `bucket`. Внутри `src/modules`,
  `src/routes` и `src/app.ts` нельзя импортировать `config.ts`, `files.repo.ts` и адаптеры.
- **Сборка** — `src/composition.ts`: единственное место, где называются конкретные адаптеры
  (`createS3ObjectStore`, `sqlFileRows`) и читается `config`. Скрипт уборки собирает свою пару
  зависимостей из тех же частей и не зависит от сборки приложения.
- **Routes** — только валидация и HTTP: статус, `res.json(await files.x(...))`. Express 5 сам
  ловит отклонённые промисы, поэтому `try/catch` и `next(err)` в async-хендлерах не нужны — просто
  `throw`.
- **Module** — бизнес-логика и оркестровка; работает с хранилищем через `ObjectStore`, со строками
  через узкий интерфейс из `file-rows.ts`. Вендор за швом: имя `S3` внутри модулей не встречается.
- **Repo** — сырой SQL через `query` из `src/db/pool.ts` (не `pool.query` напрямую: `query`
  транслирует ошибки pg в `AppError`). Параметры только через `$1, $2…`, SQL в нижнем регистре.
  Связка `sqlFileRows` доказывает, что он отвечает за все узкие интерфейсы.
- `files.schemas.ts` — zod-схемы запросов и выведенные из них типы; `files.types.ts` — строки БД
  (`FileRow`, snake_case) и DTO (camelCase); `files.mapper.ts` — `FileRow → FileDto`.

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
