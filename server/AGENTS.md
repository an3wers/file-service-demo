# AGENTS.md — server

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

**Конфигурация.** `process.env` напрямую не читается — только через `config` из `src/config.ts`.
Новая переменная: zod-схема в `config.ts` → поле в объекте `config` → `.env.example` → таблица в
`README.md`. Если у переменной нет default, **добавь её в `testEnv` в `vitest.config.ts`**: конфиг
валидируется на импорте и делает `process.exit(1)`, иначе упадут все тесты.

**Миграции.** Новый файл `src/db/migrations/NNN_description.sql` со следующим номером; применённые
миграции не редактируются. Применяются по порядку имён, каждая в своей транзакции, история — в
`schema_migrations`.

**Логи.** В обработчиках — `req.log` (несёт `req.id`, он же `requestId` в ответе), вне запроса —
`logger` из `src/logger.ts`. Ошибка передаётся полем `{ err }`.
