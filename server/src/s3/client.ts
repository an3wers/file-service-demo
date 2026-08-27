import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "../config.js";

export const s3 = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  // Cloud.ru only resolves buckets through the path-style endpoint; the
  // virtual-hosted form (<bucket>.s3.cloud.ru) answers with NoSuchBucket.
  forcePathStyle: true,
  // Recent SDK versions attach x-amz-checksum-* headers (and aws-chunked
  // encoding) by default. The browser never sends those back, so a presigned
  // PUT signed with them fails as SignatureDoesNotMatch / UnsignedHeaders.
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  },
});

export const bucket = config.s3.bucket;

export async function checkBucket(): Promise<void> {
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
}
