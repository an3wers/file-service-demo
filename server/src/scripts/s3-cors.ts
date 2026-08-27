import { GetBucketCorsCommand, PutBucketCorsCommand } from "@aws-sdk/client-s3";
import { bucket, s3 } from "../s3/client.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Bucket-level CORS, not server CORS: without it the browser's preflight for a
 * direct `PUT https://s3.cloud.ru/<bucket>/<key>` never succeeds and the whole
 * presigned upload flow is unusable from the client. Run once per bucket.
 */
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
