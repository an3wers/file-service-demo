import type { Express } from "express";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { checkDatabase } from "./db/pool.js";
import { createUploadMiddleware } from "./middleware/upload.js";
import { createHealthRouter } from "./routes/health.js";
import { buildOpenApiDocument } from "./openapi.js";
import { createS3Client } from "./storage/s3-client.js";
import { createS3ObjectStore, PROTOCOL_LIMITS } from "./storage/s3-object-store.js";
import type { ObjectStore } from "./storage/object-store.js";
import { createFilesHttp } from "./modules/files/index.js";
import type { UploadPolicy } from "./modules/files/index.js";

/**
 * The assembly: the one place that names concrete adapters and reads the
 * environment. Everything below it takes what it needs as an argument, so the
 * choice of vendor and the choice of limits are made here and nowhere else.
 *
 * The cleanup script is a second, independent assembly and builds only the
 * pieces its module needs out of the same parts.
 */

export function createObjectStore(): ObjectStore {
  return createS3ObjectStore(
    createS3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
    }),
    config.s3.bucket,
  );
}

/** The bucket every row is written under; the object store keeps its own copy. */
export function bucket(): string {
  return config.s3.bucket;
}

/** This deployment's upload policy, read off the environment exactly once. */
export function uploadPolicy(): UploadPolicy {
  return {
    multipartThresholdBytes: config.uploads.multipartThresholdBytes,
    planLimits: {
      partSize: config.uploads.multipartPartSizeBytes,
      minPartSize: PROTOCOL_LIMITS.minPartSize,
      maxPartSize: PROTOCOL_LIMITS.maxPartSize,
      // The configured ceilings are wishes; the protocol's are not negotiable.
      maxParts: Math.min(config.uploads.multipartMaxParts, PROTOCOL_LIMITS.maxParts),
      maxObjectSize: Math.min(
        config.uploads.maxObjectSizeBytes,
        PROTOCOL_LIMITS.maxObjectSize,
      ),
    },
    partUrlBatch: config.uploads.multipartUrlBatch,
    maxConcurrency: config.uploads.multipartMaxConcurrency,
    maxActiveUploads: config.uploads.multipartMaxActiveUploads,
    presignUploadTtlSeconds: config.uploads.presignUploadTtlSeconds,
    presignDownloadTtlSeconds: config.uploads.presignDownloadTtlSeconds,
    presignPartTtlSeconds: config.uploads.presignPartTtlSeconds,
    pendingTtlHours: config.uploads.pendingTtlHours,
  };
}

export function buildApp(): Express {
  const objectStore = createObjectStore();
  const { filesRouter, directoriesRouter } = createFilesHttp({
    objectStore,
    bucket: bucket(),
    policy: uploadPolicy(),
    uploadSingleFile: createUploadMiddleware(config.uploads.maxSizeBytes),
  });

  return createApp({
    corsOrigin: config.corsOrigin,
    apiDocs: config.apiDocsEnabled ? buildOpenApiDocument() : undefined,
    healthRouter: createHealthRouter({ objectStore, checkDatabase }),
    filesRouter,
    directoriesRouter,
  });
}
