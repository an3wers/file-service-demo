import {
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { checkCleanState, cleanOldState } from "../db/transition.js";
import { logger } from "../logger.js";
import { createS3Client } from "../storage/s3-client.js";

async function verify(): Promise<boolean> {
  const { nonEmptyTables, pendingMigrations } = await checkCleanState();
  const s3 = createS3Client({
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  });
  const objects = await s3.send(
    new ListObjectsV2Command({ Bucket: config.s3.bucket, MaxKeys: 1 }),
  );
  const uploads = await s3.send(
    new ListMultipartUploadsCommand({
      Bucket: config.s3.bucket,
      MaxUploads: 1,
    }),
  );
  const result = {
    nonEmptyTables,
    pendingMigrations,
    bucketHasObjects: Boolean(objects.KeyCount),
    bucketHasMultipartUploads: Boolean(uploads.Uploads?.length),
  };
  const clean =
    !nonEmptyTables.length &&
    !pendingMigrations.length &&
    !result.bucketHasObjects &&
    !result.bucketHasMultipartUploads;
  logger.info(
    result,
    clean ? "Состояние чистое" : "Состояние не чистое: сервис не открывать",
  );
  return clean;
}

async function main(): Promise<boolean> {
  const [command, flag, database] = process.argv.slice(2);
  if (command === "verify") return verify();
  if (
    command === "clean" &&
    flag === "--confirm" &&
    database === config.database.database
  ) {
    const tables = await cleanOldState();
    logger.info({ tables }, "Данные приложения удалены");
    return true;
  }
  logger.error(
    "Использование: transition verify | transition clean --confirm <DATABASE_NAME>",
  );
  return false;
}

let ok = false;
try {
  ok = await main();
} catch (error) {
  logger.error({ err: error }, "Transition step failed");
}
await pool.end().catch((error: unknown) => {
  logger.error({ err: error }, "Failed to close the database pool");
});
process.exit(ok ? 0 : 1);
