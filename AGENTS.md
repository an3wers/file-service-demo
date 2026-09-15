# AGENTS.md

Демо-сервис хранения файлов: REST API (`server/`, Express 5 + PostgreSQL + Cloud.ru Object Storage) и
SPA (`client/`, Vue 3 + shadcn-vue). Обзор возможностей — в [README.md](README.md). Детали каждой части —
в её `AGENTS.md` и `README.md`; сюда вынесено только то, что касается обеих сразу.

## Устройство репозитория

- Это **не** монорепо с workspaces: корневого `package.json` нет, `server/` и `client/` — независимые
  npm-пакеты со своими `node_modules` и `package-lock.json`. Все `npm`-команды запускаются из папки
  пакета.
- Node 24 (Docker-образы `node:24-alpine`), минимум 20.19+ / 22.12+.
- Линтера и форматтера нет ни с одной стороны. Проверка изменений — `npm run typecheck && npm test` в
  каждом затронутом пакете.
- Документация и UI-тексты — на русском. Комментарии в `server/src` — на английском, в `client/src` и
  в конфигах (Dockerfile, `vitest.config.ts`, `nginx.conf`, `.env.example`) — на русском: пиши на
  языке окружающего кода.
- Коммиты — короткие, на английском, с префиксом `add:` / `update:` (`add: multipart upload on server side`).

## Контракты между server и client

Общих типов или пакета нет — контракт поддерживается руками зеркалами. При изменении одной стороны
обнови и другую:

| Что меняется | Сервер | Клиент |
|---|---|---|
| Коды ошибок | `server/src/errors.ts` (`ERROR_CODES`) + таблица в `server/README.md` | `client/src/lib/errors.ts` (`MESSAGES`) |
| DTO и ответы API | `server/src/modules/files/files.types.ts` | `client/src/types/api.ts` |
| Нормализация директории | `normalizeDirectory` в `server/src/s3/keys.ts` | `checkDirectory` в `client/src/lib/directory.ts` (те же лимиты: сегмент 100 символов, путь 700 байт UTF-8, плюс `.max(1024)` из zod-схемы) |
| Правила query-параметров | zod-схемы в `server/src/modules/files/files.schemas.ts` | `buildQuery` в `client/src/api/client.ts` |
| API-ключ | `API_KEY` в `server/.env` | `VITE_API_KEY` в `client/.env` |
| Лимит загрузки через сервер | `MAX_UPLOAD_SIZE_MB` | `VITE_MAX_UPLOAD_SIZE_MB` (справочный) и `client_max_body_size` в `client/nginx.conf` (держать выше лимита API) |

Семантика статусов общая и намеренная: **503** — повторять можно, **502** — сломана конфигурация,
повтор бесполезен, **429** `TOO_MANY_ACTIVE_UPLOADS` — заняты слоты multipart, а не rate limit. На
этом построена кнопка «Повторить» (`isRetryable` на клиенте). Не смешивай эти статусы.

## Порт 5173 закреплён

Presigned-PUT идёт из браузера напрямую в S3, а CORS бакета выставлен (`npm run s3:cors` в `server/`)
ровно на `CORS_ORIGIN=http://localhost:5173`. Vite запущен со `strictPort`, в Docker клиент тоже
публикуется на `5173`. Смена порта или origin требует правки `CORS_ORIGIN` и повторного `s3:cors`.

## Локальный запуск

```bash
cd server && npm install && npm run db:migrate && npm run dev   # :3000, нужен server/.env
cd client && npm install && npm run dev                          # :5173, нужен client/.env
```

Клиент ходит в API относительными путями `/api/*` через vite-прокси (в Docker — через nginx), поэтому
CORS самого API в разработке не участвует.

## Деплой

`docker-compose.yml` в корне: наружу публикуется только клиент (nginx, `5173:80`), который проксирует
`/api` и `/health` на `server:3000`. Сервер получает окружение из `server/.env` через `env_file` и
подключается к внешней сети `postgres_docker_db_network` (Postgres поднимается отдельным compose).
`VITE_*` впечатываются в бандл на сборке — без `client/.env` сборка образа клиента падает намеренно.

## Документация

- `server/README.md`, `client/README.md` — источник истины по API, переменным окружения, скриптам и
  устройству. Меняешь маршрут, код ошибки, переменную или скрипт — обнови соответствующий README.
- `docs/plans/` — исторические планы, по которым сервис собирался; текущее состояние кода они не
  описывают.
- `docs/client-multipart-upload.md` — описание фактической реализации multipart на клиенте.
- `docs/deploy.md` — в `.gitignore`, существует только локально.
