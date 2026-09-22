# AGENTS.md — server

## Архитектура

```
composition.ts → modules/files/index.ts (createFilesHttp)    → adapters/http → application → domain/ports
scripts/cleanup-pending.ts → modules/files/index.ts (createFilesCleanup) → application/cleanup → те же порты
```

`modules/files` разложен по слоям (`domain/`, `application/`, `adapters/{http,persistence}`,
`testing/`), направление зависимостей проверяет линтер, а не соглашение. Подробности — рисунок
зависимостей, правило «что нельзя импортировать откуда» и разбор ключевых решений — в
`modules/files/README.md`. Наружу модуль отдаёт только `index.ts`: две сборки
(`createFilesHttp`, `createFilesCleanup`) и тип их входных зависимостей
(`FilesModuleDependencies`) — `composition.ts` и `scripts/cleanup-pending.ts` не импортируют из
`modules/files` ничего глубже `index.ts`.

- **Зависимости передаются, а не импортируются.** Сценарии — фабрики: принимают `objectStore`
  (узкий интерфейс порта хранилища из `domain/ports/object-storage.ts`), узкий интерфейс
  репозитория строк из `domain/ports/file-rows.ts`, `UploadPolicy` и `Clock`. `bucket` в сценарий
  не приходит: колонку заполняет адаптер БД, собранный внутри `modules/files/index.ts` через
  `createSqlFileRows(bucket)`.
- **Сборка** — `src/composition.ts`: единственное место, где называются конкретные адаптеры
  (`createS3ObjectStore`) и читается `config`. Дальше она передаёт объектное хранилище, `bucket` и
  политику в `modules/files/index.ts`, который уже сам решает, каким репозиторием строк и какими
  часами их собрать. Скрипт уборки — тонкая оболочка: он строит те же зависимости из тех же частей
  композиции и не зависит от сборки приложения.
- **`adapters/http`** — только валидация и HTTP: статус, `res.json(await uploads.x(...))` /
  `res.json(await catalog.x(...))`. Express 5 сам ловит отклонённые промисы, поэтому `try/catch` и
  `next(err)` в async-хендлерах не нужны — просто `throw`.
- **`application/`** — бизнес-логика и оркестровка, сгруппированная по потоку в четыре файла
  (`uploads.ts`, `multipart.ts`, `catalog.ts`, `cleanup.ts`), а не по одному сценарию на файл;
  работает с хранилищем через узкий `ObjectStoreFor*`, со строками — через узкий `FileRowsFor*`,
  со временем — через `Clock`. Вендор за швом: имя `S3` в этом слое не встречается.
- **`adapters/persistence`** — сырой SQL через `query` из `src/db/pool.ts` (не `pool.query`
  напрямую: `query` транслирует ошибки pg в `AppError`). Параметры только через `$1, $2…`, SQL в
  нижнем регистре. `createSqlFileRows(bucket): FileRows` доказывает при компиляции, что отвечает
  за все узкие интерфейсы; `bucket` в нём фиксирован при сборке, а не приходит с каждым вызовом.
- `adapters/http/schemas.ts` — zod-схемы запросов; `adapters/http/dto.ts` — `FileDto` (camelCase)
  и `toFileDto: StoredFile → FileDto`; `adapters/persistence/row-mapper.ts` — строка БД (`FileRow`,
  snake_case) и `toStoredFile: FileRow → StoredFile`, единственное место, где сочетание полей
  строки проверяется на законность; `domain/stored-file.ts` — сама сущность `StoredFile` (сумма
  состояний). `FileRow` не выходит за пределы `row-mapper.ts`, `sql-file-rows.ts` и
  `testing/memory-file-rows.ts` — остальной код работает с `StoredFile`.

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
