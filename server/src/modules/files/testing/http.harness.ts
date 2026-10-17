import { Router } from "express";
import { buildApp } from "../../../composition.js";
import { buildHarness } from "./files-module.harness.js";

export function buildHttpHarness() {
  const harness = buildHarness();
  const app = buildApp({
    files: harness.dependencies,
    healthRouter: Router(),
    auth: { authRouter: Router(), requireAuth: (_req, _res, next) => next() },
    corsOrigin: [],
    maxUploadSizeBytes: 1024,
  });
  return { ...harness, app };
}
