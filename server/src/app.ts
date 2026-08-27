import cors from "cors";
import express from "express";
import { pinoHttp } from "pino-http";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { apiKeyAuth } from "./middleware/api-key.js";
import { healthRouter } from "./routes/health.js";
import { directoriesRouter, filesRouter } from "./modules/files/files.routes.js";

export const app = express();

app.disable("x-powered-by");

app.use(pinoHttp({ logger }));
app.use(
  cors({
    origin: config.corsOrigin,
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
