import { GetBucketCorsCommand, PutBucketCorsCommand } from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { createS3Client } from "../storage/s3-client.js";

/**
 * Bucket-level CORS, not server CORS: without it the browser's preflight for a
 * direct `PUT https://s3.cloud.ru/<bucket>/<key>` never succeeds and the whole
 * presigned upload flow is unusable from the client. Run once per bucket.
 *
 * Administration of the bucket itself, which is vendor work by nature: it talks
 * to the SDK directly rather than through the object store, and assembles the
 * one client it needs.
 */
const bucket = config.s3.bucket;
const s3 = createS3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  accessKeyId: config.s3.accessKeyId,
  secretAccessKey: config.s3.secretAccessKey,
});

async function main(): Promise<void> {
  await s3.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: [...config.corsOrigin],
            AllowedMethods: ["PUT", "GET", "HEAD"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag"],
            MaxAgeSeconds: 3000,
          },
        ],
      },
    }),
  );

  const current = await s3.send(new GetBucketCorsCommand({ Bucket: bucket }));

  logger.info(
    { bucket, rules: current.CORSRules },
    "Bucket CORS configuration applied",
  );
}

try {
  await main();
} catch (error) {
  logger.error({ err: error }, "Failed to apply bucket CORS configuration");
  process.exit(1);
}
