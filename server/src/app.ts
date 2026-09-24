import cors from "cors";
import express from "express";
import type { Express, RequestHandler, Router } from "express";
import { pinoHttp } from "pino-http";
import swaggerUi from "swagger-ui-express";
import { logger } from "./logger.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";

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
  apiDocs?: object | undefined;
}

/**
 * Mounts routers that are already built. This is the HTTP shape of the service
 * and nothing more: which storage or database is behind a route is decided in
 * the assembly, not here.
 */
export function createApp({
  healthRouter,
  authRouter,
  requireAuth,
  filesRouter,
  directoriesRouter,
  corsOrigin,
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
      swaggerUi.setup(apiDocs, { swaggerOptions: { persistAuthorization: true } }),
    );
  }

  app.use(MOUNTS.auth, authRouter);
  app.use("/api", requireAuth);
  app.use(MOUNTS.files, filesRouter);
  app.use(MOUNTS.directories, directoriesRouter);

  // Express 5-compatible catch-all route.
  app.all("/{*path}", notFoundHandler);

  // Error middleware must be registered last.
  app.use(errorHandler);

  return app;
}
