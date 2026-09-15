# AGENTS.md

## Пакетный менеджер

npm

## Устройство репозитория

- Это **не** монорепо с workspaces: корневого `package.json` нет, `server/` и `client/` — независимые
  npm-пакеты со своими `node_modules` и `package-lock.json`. Все `npm`-команды запускаются из папки
  пакета.
