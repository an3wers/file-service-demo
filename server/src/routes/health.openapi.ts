import { z } from "zod";
import type { ZodOpenApiPathsObject } from "zod-openapi";

const checkSchema = z
  .object({
    status: z.enum(["ok", "error"]),
    message: z.string().optional(),
  })
  .meta({ id: "DependencyCheck" });

export const livenessResponseSchema = z
  .object({
    status: z.literal("ok"),
    timestamp: z.iso.datetime(),
  })
  .meta({ id: "LivenessResponse" });

export const readinessResponseSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    checks: z.object({ database: checkSchema, storage: checkSchema }),
    timestamp: z.iso.datetime(),
  })
  .meta({ id: "ReadinessResponse" });

export const healthPaths: ZodOpenApiPathsObject = {
  "/": {
    get: {
      tags: ["health"],
      summary: "Процесс жив",
      operationId: "getLiveness",
      security: [],
      responses: {
        200: {
          description: "Процесс отвечает",
          content: { "application/json": { schema: livenessResponseSchema } },
        },
      },
    },
  },
  "/ready": {
    get: {
      tags: ["health"],
      summary: "Зависимости доступны",
      operationId: "getReadiness",
      security: [],
      responses: {
        200: {
          description: "База и хранилище отвечают",
          content: { "application/json": { schema: readinessResponseSchema } },
        },
        503: {
          description: "База или хранилище недоступны",
          content: { "application/json": { schema: readinessResponseSchema } },
        },
      },
    },
  },
};
