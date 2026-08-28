import { HeadObjectCommand, NotFound } from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { logger } from "../logger.js";
import { s3 } from "../s3/client.js";
import * as repo from "../modules/files/files.repo.js";

/**
 * Rows stay `pending` when a client asked for a presigned URL and never called
 * complete. Ask S3 what actually happened: if the object is there the upload
 * did succeed and only the confirmation was lost, otherwise the row is dead.
 */
async function main(): Promise<void> {
  const expired = await repo.listExpiredPending(config.uploads.pendingTtlHours);

  if (expired.length === 0) {
    logger.info("No expired pending uploads");
    return;
  }

  let recovered = 0;
  let failed = 0;

  for (const file of expired) {
    try {
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: file.bucket, Key: file.object_key }),
      );

      await repo.markFileReady(file.id, {
        sizeBytes: head.ContentLength ?? null,
        etag: head.ETag ?? null,
        contentType: head.ContentType ?? file.content_type,
      });

      recovered += 1;
      logger.info(
        { id: file.id, key: file.object_key },
        "Recovered pending upload",
      );
    } catch (error) {
      if (
        error instanceof NotFound ||
        (error as { name?: string }).name === "NotFound"
      ) {
        await repo.markFileFailed(file.id);
        failed += 1;
        logger.info(
          { id: file.id, key: file.object_key },
          "Marked pending upload failed",
        );
        continue;
      }

      logger.error(
        { err: error, id: file.id },
        "Could not inspect pending upload",
      );
    }
  }

  logger.info(
    { examined: expired.length, recovered, failed },
    "Cleanup finished",
  );
}

try {
  await main();
  await pool.end();
} catch (error) {
  logger.error({ err: error }, "Cleanup failed");
  await pool.end();
  process.exit(1);
}
