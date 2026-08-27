import { Router } from "express";
import { checkDatabase } from "../db/pool.js";
import { checkBucket } from "../s3/client.js";
import { logger } from "../logger.js";

export const healthRouter = Router();

/** Liveness: the process is up and serving. */
healthRouter.get("/", (_req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

/** Readiness: the dependencies this service cannot work without are reachable. */
healthRouter.get("/ready", async (_req, res) => {
  const [database, storage] = await Promise.all([
    checkDatabase().then(
      () => ({ status: "ok" as const }),
      (error: unknown) => {
        logger.error({ err: error }, "Database readiness check failed");
        return { status: "error" as const, message: (error as Error).message };
      },
    ),
    checkBucket().then(
      () => ({ status: "ok" as const }),
      (error: unknown) => {
        logger.error({ err: error }, "S3 readiness check failed");
        return { status: "error" as const, message: (error as Error).message };
      },
    ),
  ]);

  const ready = database.status === "ok" && storage.status === "ok";

  res.status(ready ? 200 : 503).json({
    status: ready ? "ok" : "degraded",
    checks: { database, storage },
    timestamp: new Date().toISOString(),
  });
});
