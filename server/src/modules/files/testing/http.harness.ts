import { Router } from "express";
import { buildApp } from "../../../composition.js";
import { buildHarness } from "./files-module.harness.js";
import { assembleFiles } from "../assembly.js";
import { operationIdFor } from "../adapters/http/routes.js";

export const HTTP_OWNER = "00000000-0000-4000-8000-0000000000aa";

export function buildHttpHarness() {
  const harness = buildHarness();
  const app = buildApp({
    files: harness.dependencies,
    healthRouter: Router(),
    auth: {
      authRouter: Router(),
      requireAuth: (_req, res, next) => {
        res.locals.userId = HTTP_OWNER;
        next();
      },
    },
    corsOrigin: [],
    maxUploadSizeBytes: 1024,
  });
  const { uploads, catalog } = assembleFiles({
    ...harness.dependencies,
    ...harness.dependencies.forOwner(HTTP_OWNER),
  });
  return {
    ...harness,
    files: { ...uploads, ...catalog },
    app,
    operationId: (id: string) => operationIdFor(HTTP_OWNER, id),
  };
}
