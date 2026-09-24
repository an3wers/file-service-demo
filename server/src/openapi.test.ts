import { readFileSync } from "node:fs";
import type { Router } from "express";
import { describe, expect, it } from "vitest";
import { MOUNTS } from "./app.js";
import { createFilesHttp } from "./modules/files/index.js";
import { createAuthHttp } from "./modules/auth/index.js";
import type { UploadPolicy } from "./modules/files/index.js";
import {
  OPENAPI_FILE,
  buildOpenApiDocument,
  serializeOpenApiDocument,
  toOpenApiPath,
} from "./openapi.js";
import { createHealthRouter } from "./routes/health.js";
import { createMemoryObjectStore } from "./storage/memory-object-store.js";

const MIB = 1024 * 1024;

const policy: UploadPolicy = {
  multipartThresholdBytes: 100 * MIB,
  planLimits: {
    partSize: 16 * MIB,
    minPartSize: 5 * MIB,
    maxPartSize: 5 * 1024 * MIB,
    maxParts: 10_000,
    maxObjectSize: 200 * 1024 * MIB,
  },
  partUrlBatch: 100,
  maxConcurrency: 4,
  maxActiveUploads: 10,
  presignUploadTtlSeconds: 900,
  presignDownloadTtlSeconds: 300,
  presignPartTtlSeconds: 3600,
  pendingTtlHours: 24,
};

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

function operationsOf(prefix: string, router: Router): string[] {
  return (router.stack as RouteLayer[]).flatMap((layer) => {
    if (!layer.route) {
      return [];
    }

    const { path, methods } = layer.route;
    const fullPath = path === "/" ? prefix : `${prefix}${toOpenApiPath(path)}`;

    return Object.keys(methods)
      .filter((method) => method !== "_all")
      .map((method) => `${method.toUpperCase()} ${fullPath}`);
  });
}

describe("OpenAPI-документ", () => {
  it("server/openapi.json совпадает с документом, собранным из кода", () => {
    const expected = serializeOpenApiDocument(buildOpenApiDocument());
    const committed = readFileSync(OPENAPI_FILE, "utf8");

    expect(
      committed === expected,
      "server/openapi.json устарел: выполните `npm run openapi` в server/, " +
        "затем `npm run api:generate` в client/",
    ).toBe(true);
  });

  it("описывает каждый маршрут роутеров и не описывает лишних", () => {
    const objectStore = createMemoryObjectStore();
    const { filesRouter, directoriesRouter } = createFilesHttp({
      objectStore,
      bucket: "test-bucket",
      policy,
      uploadSingleFile: (_req, _res, next) => next(),
    });
    const healthRouter = createHealthRouter({
      objectStore,
      checkDatabase: async () => undefined,
    });

    const { authRouter } = createAuthHttp({
      login: "operator",
      password: "test-password",
      accessSecret: "a".repeat(32),
      refreshSecret: "r".repeat(32),
      accessTtlSeconds: 900,
      refreshTtlSeconds: 604800,
      cookieSecure: false,
    });

    const registered = [
      ...operationsOf(MOUNTS.health, healthRouter),
      ...operationsOf(MOUNTS.auth, authRouter),
      ...operationsOf(MOUNTS.files, filesRouter),
      ...operationsOf(MOUNTS.directories, directoriesRouter),
    ].sort();

    const documented = Object.entries(buildOpenApiDocument().paths ?? {})
      .flatMap(([path, item]) =>
        Object.keys(item ?? {})
          .filter((key) => ["get", "post", "put", "patch", "delete"].includes(key))
          .map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort();

    expect(documented).toEqual(registered);
  });
});
