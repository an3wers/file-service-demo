import { createConfirmationModule } from "./application/confirmation.js";
import { createUploadsModule } from "./application/uploads.js";
import { createCatalogModule } from "./application/catalog.js";
import { createCleanupModule } from "./application/cleanup.js";
import { systemClock, type Clock } from "./domain/ports/clock.js";
import type { FileRows } from "./domain/ports/file-rows.js";
import type { DirectoriesForCatalog } from "./domain/ports/directories.js";
import type { UploadOperations } from "./domain/ports/upload-operations.js";
import type {
  ObjectStoreForFiles,
  ObjectStoreForMultipart,
  ObjectStoreForCleanup,
} from "./domain/ports/object-storage.js";
import { assertValidPlanLimits } from "./domain/upload-plan.js";
import type { UploadPolicy } from "./domain/upload-policy.js";

export interface FilesPorts {
  fileRows: FileRows;
  directories: DirectoriesForCatalog;
  operations: UploadOperations;
}

export interface FilesPersistence extends FilesPorts {
  forOwner(ownerId: string): FilesPorts;
}

export interface FilesModuleDependencies extends FilesPersistence {
  objectStore: ObjectStoreForFiles &
    ObjectStoreForMultipart &
    ObjectStoreForCleanup;
  policy: UploadPolicy;
  clock?: Clock;
}

export function assembleFiles(
  dependencies: Omit<FilesModuleDependencies, "forOwner">,
) {
  assertValidPlanLimits(dependencies.policy.planLimits);
  const deps = { ...dependencies, clock: dependencies.clock ?? systemClock };
  const confirmation = createConfirmationModule(deps);
  const uploads = createUploadsModule({ ...deps, confirmation });
  const catalog = createCatalogModule({ ...deps, confirmation });
  const cleanup = createCleanupModule({ ...deps, confirmation });
  return {
    confirmation,
    uploads,
    catalog,
    cleanup,
    async maintain() {
      await uploads.sweepTerminated();
      await cleanup.settleExpiredRows();
      await cleanup.sweepOrphanUploads();
    },
  };
}
