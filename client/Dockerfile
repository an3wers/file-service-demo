# syntax=docker/dockerfile:1

FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci -w client --include-workspace-root=false

COPY client ./client
RUN test -f client/.env || { echo "ERROR: client/.env not found — см. README.md" >&2; exit 1; }
RUN npm run build -w client

FROM nginx:1.29-alpine AS runtime

COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
