import type { Express } from "express";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { checkDatabase } from "./db/pool.js";
import { createUploadMiddleware } from "./middleware/upload.js";
import { createHealthRouter } from "./routes/health.js";
import { createS3Client } from "./storage/s3-client.js";
import { createS3ObjectStore } from "./storage/s3-object-store.js";
import type { ObjectStore } from "./storage/object-store.js";
import { sqlFileRows } from "./modules/files/files.repo.js";
import { createFilesRouter, createDirectoriesRouter } from "./modules/files/files.routes.js";
import { createFilesModule } from "./modules/files/files.service.js";
import { createMultipartModule } from "./modules/files/multipart.service.js";
import { PROTOCOL_LIMITS } from "./modules/files/upload-plan.js";
import type { UploadPolicy } from "./modules/files/upload-policy.js";

/**
 * The assembly: the one place that names concrete adapters and reads the
 * environment. Everything below it takes what it needs as an argument, so the
 * choice of vendor and the choice of limits are made here and nowhere else.
 *
 * The cleanup script is a second, independent assembly and builds only the two
 * pieces it needs out of the same parts.
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

/** This deployment's upload policy, read off the environment exactly once. */
export function uploadPolicy(): UploadPolicy {
  return {
    multipartThresholdBytes: config.uploads.multipartThresholdBytes,
    planLimits: {
      partSize: config.uploads.multipartPartSizeBytes,
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
  };
}

export function buildApp(): Express {
  const objectStore = createObjectStore();
  const policy = uploadPolicy();
  // Recorded on rows; the store keeps its own copy for the calls it makes.
  const bucket = config.s3.bucket;

  const fileRows = sqlFileRows;
  const multipart = createMultipartModule({ objectStore, fileRows, policy, bucket });
  const files = createFilesModule({ objectStore, fileRows, policy, multipart, bucket });

  return createApp({
    corsOrigin: config.corsOrigin,
    healthRouter: createHealthRouter({ objectStore, checkDatabase }),
    filesRouter: createFilesRouter({
      files,
      uploadSingleFile: createUploadMiddleware(config.uploads.maxSizeBytes),
    }),
    directoriesRouter: createDirectoriesRouter(files),
  });
}
