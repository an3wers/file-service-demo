# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# `npm run build` = tsc + cp -r src/db/migrations dist/db/migrations.
# SQL-файлы обязаны попасть в dist: migrate.js ищет каталог migrations рядом с
# собой, поэтому образ, собранный голым tsc, молча остаётся без миграций.
RUN npm run build

# ---------- runtime ----------
FROM node:24-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

USER node

EXPOSE 3000

# /health — liveness: не ходит в зависимости и не требует API-ключа
# (src/routes/health.ts). Готовность к работе проверяет /health/ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# exec-форма без обёртки npm: у сервера graceful shutdown по SIGTERM, а npm
# сигнал проглотит. Флаг --env-file-if-exists из npm start здесь не нужен —
# переменные приходят от compose через env_file.
CMD ["node", "dist/server.js"]
