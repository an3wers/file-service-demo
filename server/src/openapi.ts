import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDocument } from "zod-openapi";
import type { ZodOpenApiPathsObject } from "zod-openapi";
import { MOUNTS } from "./app.js";
import { API_KEY_SECURITY } from "./http-contract.js";
import { directoriesPaths, filesPaths } from "./modules/files/index.js";
import { healthPaths } from "./routes/health.openapi.js";

export const OPENAPI_FILE = fileURLToPath(new URL("../openapi.json", import.meta.url));

export type OpenApiDocument = ReturnType<typeof createDocument>;

function packageVersion(): string {
  const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");

  return (JSON.parse(packageJson) as { version: string }).version;
}

export function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:(\w+)/g, "{$1}");
}

function mount(prefix: string, paths: ZodOpenApiPathsObject): ZodOpenApiPathsObject {
  return Object.fromEntries(
    Object.entries(paths).map(([path, item]) => [
      path === "/" ? prefix : `${prefix}${path}`,
      item,
    ]),
  );
}

export function buildOpenApiDocument(): OpenApiDocument {
  return createDocument({
    openapi: "3.1.0",
    info: {
      title: "File Service API",
      version: packageVersion(),
      description:
        "Файлы в S3-совместимом хранилище и их метаданные в PostgreSQL. " +
        "Все /api/* требуют заголовок X-API-Key.",
    },
    security: [{ [API_KEY_SECURITY]: [] }],
    components: {
      securitySchemes: {
        [API_KEY_SECURITY]: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
    },
    tags: [
      { name: "files", description: "Каталог файлов и загрузка через сервер" },
      { name: "uploads", description: "Загрузка в обход сервера по подписанным ссылкам" },
      { name: "directories", description: "Каталоги" },
      { name: "health", description: "Пробы живости и готовности, без ключа" },
    ],
    paths: {
      ...mount(MOUNTS.health, healthPaths),
      ...mount(MOUNTS.files, filesPaths),
      ...mount(MOUNTS.directories, directoriesPaths),
    },
  });
}

export function serializeOpenApiDocument(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
