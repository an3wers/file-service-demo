import { app } from "./app.js";
import { config } from "./config.js";
import { checkDatabase, pool } from "./db/pool.js";
import { logger } from "./logger.js";

// Fail at boot rather than on the first request that needs the database.
try {
  await checkDatabase();
  logger.info("Connected to PostgreSQL");
} catch (error) {
  logger.error({ err: error }, "Cannot reach PostgreSQL; aborting startup");
  process.exit(1);
}

const server = app.listen(config.port, () => {
  logger.info(`API listening on http://localhost:${config.port}`);
});

let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info(`${signal} received; shutting down gracefully`);

  server.close(async (error) => {
    if (error) {
      logger.error({ err: error }, "Failed to close HTTP server");
      process.exit(1);
    }

    await pool.end().catch((poolError: unknown) => {
      logger.error({ err: poolError }, "Failed to close the database pool");
    });

    process.exit(0);
  });

  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
