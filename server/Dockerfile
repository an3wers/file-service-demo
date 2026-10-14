# syntax=docker/dockerfile:1

FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci -w server --include-workspace-root=false

COPY server/tsconfig.json ./server/tsconfig.json
COPY server/src ./server/src
RUN npm run build -w server

FROM node:24-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci -w server --include-workspace-root=false --omit=dev && npm cache clean --force

COPY --from=build /app/server/dist ./server/dist

WORKDIR /app/server

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
