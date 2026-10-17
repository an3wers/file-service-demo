import type { Router, RequestHandler } from "express";
import { assembleFiles, type FilesModuleDependencies } from "./assembly.js";
import {
  createFilesRouter,
  createDirectoriesRouter,
} from "./adapters/http/routes.js";

export type { FilesModuleDependencies, FilesPersistence } from "./assembly.js";
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
  const { uploads, catalog } = assembleFiles(deps);
  return {
    filesRouter: createFilesRouter({
      uploads,
      catalog,
      uploadSingleFile: deps.uploadSingleFile,
    }),
    directoriesRouter: createDirectoriesRouter(catalog),
  };
}

export function createFilesMaintenance(
  deps: FilesModuleDependencies,
): () => Promise<void> {
  return assembleFiles(deps).maintain;
}
