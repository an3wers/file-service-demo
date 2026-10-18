import { Router } from "express";
import { logger } from "../logger.js";
import type { ObjectStore } from "../storage/object-store.js";

export interface HealthRouterDeps {
  objectStore: ObjectStore;
  /** Отклоняет вызов, если база данных не отвечает. */
  checkDatabase: () => Promise<unknown>;
}

/**
 * Проверка готовности обращается к зависимостям так же, как рабочий код:
 * к хранилищу — через его адаптер. Иначе проверка могла бы пройти на одном
 * клиенте, пока загрузки используют другой. Обе проверки передаются извне,
 * чтобы использовать те же зависимости, что и сервис.
 */
export function createHealthRouter({
  objectStore,
  checkDatabase,
}: HealthRouterDeps): Router {
  const healthRouter = Router();

  /** Проверка работоспособности: процесс запущен и обслуживает запросы. */
  healthRouter.get("/", (_req, res) => {
    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  /** Проверка готовности: необходимые сервису зависимости доступны. */
  healthRouter.get("/ready", async (_req, res) => {
    const [database, storage] = await Promise.all([
      checkDatabase().then(
        () => ({ status: "ok" as const }),
        (error: unknown) => {
          logger.error({ err: error }, "Database readiness check failed");
          return {
            status: "error" as const,
            message: (error as Error).message,
          };
        },
      ),
      objectStore.checkAvailable().then(
        () => ({ status: "ok" as const }),
        (error: unknown) => {
          logger.error({ err: error }, "Object storage readiness check failed");
          return {
            status: "error" as const,
            message: (error as Error).message,
          };
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
