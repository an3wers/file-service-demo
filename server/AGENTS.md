# AGENTS.md — server

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
