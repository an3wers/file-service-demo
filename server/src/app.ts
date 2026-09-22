import cors from "cors";
import express from "express";
import type { Express, Router } from "express";
import { pinoHttp } from "pino-http";
import { logger } from "./logger.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { apiKeyAuth } from "./middleware/api-key.js";

export interface AppDeps {
  healthRouter: Router;
  filesRouter: Router;
  directoriesRouter: Router;
  corsOrigin: string[];
}

/**
 * Mounts routers that are already built. This is the HTTP shape of the service
 * and nothing more: which storage or database is behind a route is decided in
 * the assembly, not here.
 */
export function createApp({
  healthRouter,
  filesRouter,
  directoriesRouter,
  corsOrigin,
}: AppDeps): Express {
  const app = express();

  app.disable("x-powered-by");

  app.use(pinoHttp({ logger }));
  app.use(
    cors({
      origin: corsOrigin,
      allowedHeaders: ["Content-Type", "X-API-Key"],
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

  // Health checks stay open so probes do not need the API key.
  app.use("/health", healthRouter);

  app.use("/api", apiKeyAuth);
  app.use("/api/files", filesRouter);
  app.use("/api/directories", directoriesRouter);

  // Express 5-compatible catch-all route.
  app.all("/{*path}", notFoundHandler);

  // Error middleware must be registered last.
  app.use(errorHandler);

  return app;
}
