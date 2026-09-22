import type { Router } from "express";
import type { RequestHandler } from "express";
import { createSqlFileRows } from "./files.repo.js";
import { createFilesModule } from "./files.service.js";
import { createMultipartModule } from "./multipart.service.js";
import { createCleanupModule } from "./cleanup.service.js";
import type { CleanupModule } from "./cleanup.service.js";
import { createFilesRouter, createDirectoriesRouter } from "./files.routes.js";
import { systemClock } from "./clock.js";
import type { Clock } from "./clock.js";
import type {
  ObjectStoreForCleanup,
  ObjectStoreForFiles,
  ObjectStoreForMultipart,
} from "./object-storage.js";
import { assertValidPlanLimits } from "./upload-plan.js";
import type { UploadPolicy } from "./upload-policy.js";

export type { UploadPolicy } from "./upload-policy.js";

/**
 * The whole surface the rest of the app is allowed to know about this module:
 * two builds and the type of what they take. No domain type and no DTO crosses
 * this line — `composition.ts` and `scripts/cleanup-pending.ts` import nothing
 * from `modules/files` but this file.
 */
export interface FilesModuleDependencies {
  /** The one object store instance, structurally wide enough for all three scenarios. */
  objectStore: ObjectStoreForFiles & ObjectStoreForMultipart & ObjectStoreForCleanup;
  /** Filled onto every row by the adapter that writes it, not by a scenario. */
  bucket: string;
  policy: UploadPolicy;
  /** Defaults to the wall clock; a test hands in a second implementation. */
  clock?: Clock;
}

export interface FilesHttpAssembly {
  filesRouter: Router;
  directoriesRouter: Router;
}

/** The app's assembly: routers over the files and multipart scenarios. */
export function createFilesHttp(
  deps: FilesModuleDependencies & { uploadSingleFile: RequestHandler },
): FilesHttpAssembly {
  // Caught here rather than only on the first upload: a misconfigured
  // deployment fails at startup, not on the first request that needs a plan.
  assertValidPlanLimits(deps.policy.planLimits);

  const clock = deps.clock ?? systemClock;
  const fileRows = createSqlFileRows(deps.bucket);
  const multipart = createMultipartModule({
    objectStore: deps.objectStore,
    fileRows,
    policy: deps.policy,
    clock,
  });
  const files = createFilesModule({
    objectStore: deps.objectStore,
    fileRows,
    policy: deps.policy,
    multipart,
    clock,
  });

  return {
    filesRouter: createFilesRouter({ files, uploadSingleFile: deps.uploadSingleFile }),
    directoriesRouter: createDirectoriesRouter(files),
  };
}

/** The cleanup script's assembly: the sweep, built on the same three parts. */
export function createFilesCleanup(deps: FilesModuleDependencies): CleanupModule {
  assertValidPlanLimits(deps.policy.planLimits);

  const clock = deps.clock ?? systemClock;
  const fileRows = createSqlFileRows(deps.bucket);

  return createCleanupModule({ objectStore: deps.objectStore, fileRows, policy: deps.policy, clock });
}
