import { S3Client } from "@aws-sdk/client-s3";

/**
 * Builds the vendor client the S3 adapter talks through. Everything awkward
 * about this particular endpoint lives here, and nothing outside the adapter
 * and the assembly ever holds one.
 */
export interface S3ClientOptions {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function createS3Client(options: S3ClientOptions): S3Client {
  return new S3Client({
    region: options.region,
    endpoint: options.endpoint,
    // Cloud.ru only resolves buckets through the path-style endpoint; the
    // virtual-hosted form (<bucket>.s3.cloud.ru) answers with NoSuchBucket.
    forcePathStyle: true,
    // Recent SDK versions attach x-amz-checksum-* headers (and aws-chunked
    // encoding) by default. The browser never sends those back, so a presigned
    // PUT signed with them fails as SignatureDoesNotMatch / UnsignedHeaders.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 3,
    // Without explicit timeouts a wedged endpoint holds the request open far
    // longer than any caller is willing to wait, and `storageError` never gets
    // the TimeoutError it maps to a 503. `requestTimeout` is socket inactivity,
    // not a deadline, so it stays safe for large server-side uploads.
    requestHandler: {
      connectionTimeout: 3_000,
      requestTimeout: 30_000,
    },
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });
}
