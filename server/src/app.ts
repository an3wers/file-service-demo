import cors from "cors";
import express from "express";
import type { Express, RequestHandler, Router } from "express";
import { pinoHttp } from "pino-http";
import swaggerUi from "swagger-ui-express";
import { logger } from "./logger.js";
import type { ErrorMapper } from "./errors.js";
import {
  createErrorHandler,
  notFoundHandler,
} from "./middleware/error-handler.js";

export const MOUNTS = {
  health: "/health",
  auth: "/api/auth",
  files: "/api/files",
  directories: "/api/directories",
} as const;

export const API_DOCS_PATH = "/api/docs";
export const API_SPEC_PATH = "/api/openapi.json";

export interface AppDeps {
  healthRouter: Router;
  authRouter: Router;
  requireAuth: RequestHandler;
  filesRouter: Router;
  directoriesRouter: Router;
  corsOrigin: string[];
  errorMappers: readonly ErrorMapper[];
  apiDocs?: object | undefined;
}

/**
 * Подключает уже собранные маршрутизаторы и задаёт HTTP-интерфейс сервиса.
 * Выбор хранилища и базы данных для маршрутов выполняется при сборке.
 */
export function createApp({
  healthRouter,
  authRouter,
  requireAuth,
  filesRouter,
  directoriesRouter,
  corsOrigin,
  errorMappers,
  apiDocs,
}: AppDeps): Express {
  const app = express();

  app.disable("x-powered-by");

  app.use(pinoHttp({ logger }));
  app.use(
    cors({
      origin: corsOrigin,
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/", (_req, res) => {
    res.json({
      name: "file-service-api",
      version: "0.1.0",
    });
  });

  app.use(MOUNTS.health, healthRouter);

  if (apiDocs) {
    app.get(API_SPEC_PATH, (_req, res) => {
      res.json(apiDocs);
    });
    app.use(
      API_DOCS_PATH,
      swaggerUi.serve,
      swaggerUi.setup(apiDocs, {
        swaggerOptions: { persistAuthorization: true },
      }),
    );
  }

  app.use(MOUNTS.auth, authRouter);
  app.use("/api", requireAuth);
  app.use(MOUNTS.files, filesRouter);
  app.use(MOUNTS.directories, directoriesRouter);

  // Маршрут для всех остальных адресов в синтаксисе Express 5.
  app.all("/{*path}", notFoundHandler);

  // Обработчик ошибок регистрируется последним.
  app.use(createErrorHandler(errorMappers));

  return app;
}
