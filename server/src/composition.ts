import { createFilesPersistence } from "./modules/files/persistence.js";
import type { FilesModuleDependencies } from "./modules/files/index.js";
import type { AppDeps } from "./app.js";
import { createNotification as assembleNotification } from "./modules/notification/index.js";
import type { Notification } from "./modules/notification/index.js";
import type { Express } from "express";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { checkDatabase } from "./db/pool.js";
import { createUploadMiddleware } from "./middleware/upload.js";
import { createHealthRouter } from "./routes/health.js";
import { buildOpenApiDocument } from "./openapi.js";
import { createS3Client } from "./storage/s3-client.js";
import {
  createS3ObjectStore,
  PROTOCOL_LIMITS,
} from "./storage/s3-object-store.js";
import type { ObjectStore } from "./storage/object-store.js";
import {
  createFilesMaintenance,
  createFilesHttp,
} from "./modules/files/index.js";
import { createAuthHttp } from "./modules/auth/index.js";
import type { UploadPolicy } from "./modules/files/index.js";

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
      minPartSize: PROTOCOL_LIMITS.minPartSize,
      maxPartSize: PROTOCOL_LIMITS.maxPartSize,
      // The configured ceilings are wishes; the protocol's are not negotiable.
      maxParts: Math.min(
        config.uploads.multipartMaxParts,
        PROTOCOL_LIMITS.maxParts,
      ),
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

export interface AppAssemblyDependencies {
  files: FilesModuleDependencies;
  healthRouter: AppDeps["healthRouter"];
  auth: Pick<AppDeps, "authRouter" | "requireAuth">;
  corsOrigin: string[];
  maxUploadSizeBytes: number;
  apiDocs?: object | undefined;
}

function productionFiles() {
  return {
    ...createFilesPersistence(config.s3.bucket),
    objectStore: createObjectStore(),
    policy: uploadPolicy(),
  };
}

function productionAppDependencies(): AppAssemblyDependencies {
  const files = productionFiles();
  return {
    files,
    healthRouter: createHealthRouter({
      objectStore: files.objectStore,
      checkDatabase,
    }),
    auth: createAuthHttp(config.auth),
    corsOrigin: config.corsOrigin,
    maxUploadSizeBytes: config.uploads.maxSizeBytes,
    apiDocs: config.apiDocsEnabled ? buildOpenApiDocument() : undefined,
  };
}

export function buildApp(
  deps: AppAssemblyDependencies = productionAppDependencies(),
): Express {
  const routers = createFilesHttp({
    ...deps.files,
    uploadSingleFile: createUploadMiddleware(deps.maxUploadSizeBytes),
  });
  return createApp({
    ...routers,
    ...deps.auth,
    corsOrigin: deps.corsOrigin,
    apiDocs: deps.apiDocs,
    healthRouter: deps.healthRouter,
  });
}

export function createNotification(): Notification {
  return assembleNotification(config.notification);
}

export function createUploadMaintenance(): () => Promise<void> {
  return createFilesMaintenance(productionFiles());
}
