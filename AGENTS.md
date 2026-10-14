# AGENTS.md

**Пакетный менеджер:** npm

## Устройство репозитория

- Это монорепозиторий с npm workspaces: `server/` и `client/`, единый `package-lock.json` в корне.
  Установку выполняй из корня через `npm ci`; общие проверки — через `npm run check`.
- Зависимости сервисов объявляются в их `package.json` и устанавливаются внутри пакетов:
  корневой `.npmrc` задаёт `install-strategy=nested`. В корне — только служебный `concurrently`.
  Для управления зависимостями используй `npm install <package> -w server` или `-w client`;
  для отдельной команды — `npm run <script> -w <workspace>`.
- Не пиши комментарии в коде.
- Если пишется тест, то пиши имя теста на русском языке.
- Если пишется комментарий к коду, то пиши на русском языке. Правило хорошего комментария:
  - ЧТО делает блок кода
  - ПОЧЕМУ принято, какое-либо решение, если это не очевидно из контекста
  - Реализация (т.е. код) отвечает на вопрос КАК.

### Issue tracker

Issues живут в GitHub Issues репозитория `an3wers/file-service-demo` (работа через `gh` CLI).
См. `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` и `docs/adr/` в корне репозитория. См. `docs/agents/domain.md`.
