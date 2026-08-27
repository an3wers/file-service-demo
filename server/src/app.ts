import cors from "cors";
import express from "express";
import { healthRouter } from "./routes/health.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { pinoHttp } from "pino-http";

export const app = express();

app.disable("x-powered-by");

app.use(pinoHttp());
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

app.get("/", (_req, res) => {
  res.json({
    name: "express-ts-api",
    version: "0.1.0",
  });
});

app.use("/health", healthRouter);

// Express 5-compatible catch-all route.
app.all("/{*path}", notFoundHandler);

// Error middleware must be registered last.
app.use(errorHandler);
