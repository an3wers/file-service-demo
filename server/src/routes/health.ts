import { Router } from "express";
import { logger } from "../logger.js";
import type { ObjectStore } from "../storage/object-store.js";

export interface HealthRouterDeps {
  objectStore: ObjectStore;
  /** Rejects when the database is not answering. */
  checkDatabase: () => Promise<unknown>;
}

/**
 * Readiness asks each dependency the same way the working code does — storage
 * through the object store — so a deployment cannot pass its probe against one
 * client while every upload goes through another. Both checks arrive as
 * arguments for the same reason.
 */
export function createHealthRouter({ objectStore, checkDatabase }: HealthRouterDeps): Router {
  const healthRouter = Router();

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
      objectStore.checkAvailable().then(
        () => ({ status: "ok" as const }),
        (error: unknown) => {
          logger.error({ err: error }, "Object storage readiness check failed");
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

  return healthRouter;
}
