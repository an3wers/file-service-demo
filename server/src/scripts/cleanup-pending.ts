import { bucket, createObjectStore, uploadPolicy } from "../composition.js";
import { pool } from "../db/pool.js";
import { logger } from "../logger.js";
import { createFilesMaintenance } from "../modules/files/index.js";

/**
 * The cleanup pass on a schedule: a second assembly next to the app's, building
 * only what its module asks for out of the same parts. The rules live in the
 * module; this file picks the adapters, runs the two passes and reports what
 * they settled.
 */
async function main(): Promise<void> {
  const maintain = createFilesMaintenance({
    objectStore: createObjectStore(),
    bucket: bucket(),
    policy: uploadPolicy(),
  });
  await maintain();
  logger.info("Уборка загрузок завершена");
}

try {
  await main();
  await pool.end();
} catch (error) {
  logger.error({ err: error }, "Cleanup failed");
  await pool.end();
  process.exit(1);
}
