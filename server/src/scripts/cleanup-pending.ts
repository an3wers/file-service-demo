import { bucket, createObjectStore, uploadPolicy } from "../composition.js";
import { pool } from "../db/pool.js";
import { logger } from "../logger.js";
import { createFilesCleanup } from "../modules/files/index.js";

/**
 * The cleanup pass on a schedule: a second assembly next to the app's, building
 * only what its module asks for out of the same parts. The rules live in the
 * module; this file picks the adapters, runs the two passes and reports what
 * they settled.
 */
async function main(): Promise<void> {
  const cleanup = createFilesCleanup({
    objectStore: createObjectStore(),
    bucket: bucket(),
    policy: uploadPolicy(),
  });

  const counters = await cleanup.settleExpiredRows();

  if (counters.examined === 0) {
    logger.info("No expired pending uploads");
  } else {
    logger.info(counters, "Cleanup finished");
  }

  const orphans = await cleanup.sweepOrphanUploads();

  logger.info(orphans, "Orphan multipart sweep finished");
}

try {
  await main();
  await pool.end();
} catch (error) {
  logger.error({ err: error }, "Cleanup failed");
  await pool.end();
  process.exit(1);
}
