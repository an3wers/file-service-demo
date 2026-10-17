import { createUploadMaintenance } from "../composition.js";
import { pool } from "../db/pool.js";
import { logger } from "../logger.js";

async function main(): Promise<void> {
  const maintain = createUploadMaintenance();
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
