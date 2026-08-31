# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
# devDependencies нужны: `npm run build` = vue-tsc -b + vite build, а
# tsconfig.node.json тайпчекает в том числе vitest.config.ts.
RUN npm ci

COPY . .

# VITE_* впечатываются в бандл на сборке — своего рантайм-конфига у SPA нет.
# Без .env ключ уедет в бандл как undefined, и приложение будет молча получать
# 401 на каждый запрос. Лучше упасть здесь и громко.
RUN test -f .env || { echo "ERROR: client/.env not found — см. docs/deploy.md" >&2; exit 1; }

RUN npm run build

# ---------- runtime ----------
# Тег закреплён намеренно: обновление nginx должно быть осознанным шагом.
FROM nginx:1.29-alpine AS runtime

# Заменяет дефолтный server-блок образа. Отдаёт статику и проксирует /api и
# /health на server:3000 — тот же контракт, что даёт vite-прокси в разработке.
COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

# CMD наследуется от базового образа: nginx -g "daemon off;"
