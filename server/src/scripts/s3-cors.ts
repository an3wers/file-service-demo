import { GetBucketCorsCommand, PutBucketCorsCommand } from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { createS3Client } from "../storage/s3-client.js";

/**
 * Настраивает CORS бакета для прямого `PUT https://s3.cloud.ru/<bucket>/<key>`.
 * Без этого предварительный запрос браузера не пройдёт и загрузка
 * по подписанной ссылке не заработает. Запускается один раз для бакета.
 *
 * Управление бакетом зависит от поставщика, поэтому скрипт напрямую
 * собирает нужный клиент SDK и обращается к нему.
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
