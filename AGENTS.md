# AGENTS.md

## Пакетный менеджер

npm

## Устройство репозитория

- Это **не** монорепо с workspaces: корневого `package.json` нет, `server/` и `client/` — независимые
  npm-пакеты со своими `node_modules` и `package-lock.json`. Все `npm`-команды запускаются из папки
  пакета.

## Agent skills

### Issue tracker

Issues живут в GitHub Issues репозитория `an3wers/file-service-demo` (работа через `gh` CLI).
См. `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` и `docs/adr/` в корне репозитория. См. `docs/agents/domain.md`.
