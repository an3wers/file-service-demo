import type { Router, RequestHandler } from "express";
import { assembleFiles, type FilesModuleDependencies } from "./assembly.js";
import { assertValidPlanLimits } from "./domain/upload-plan.js";
import {
  createFilesRouter,
  createDirectoriesRouter,
} from "./adapters/http/routes.js";

export type {
  FilesModuleDependencies,
  FilesPersistence,
  FilesPorts,
} from "./assembly.js";
export type { UploadPolicy } from "./domain/upload-policy.js";
export { mapFilesError } from "./adapters/http/error-map.js";
export { filesPaths, directoriesPaths } from "./adapters/http/openapi.js";

export interface FilesHttpAssembly {
  filesRouter: Router;
  directoriesRouter: Router;
}

export function createFilesHttp(
  deps: FilesModuleDependencies & { uploadSingleFile: RequestHandler },
): FilesHttpAssembly {
  assertValidPlanLimits(deps.policy.planLimits);
  const scenarios = (ownerId: string) =>
    assembleFiles({ ...deps, ...deps.forOwner(ownerId) });
  return {
    filesRouter: createFilesRouter({
      scenarios,
      uploadSingleFile: deps.uploadSingleFile,
    }),
    directoriesRouter: createDirectoriesRouter(scenarios),
  };
}

export function createFilesMaintenance(
  deps: FilesModuleDependencies,
): () => Promise<void> {
  return assembleFiles(deps).maintain;
}
