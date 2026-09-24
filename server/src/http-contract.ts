import { z } from "zod";
import type { ZodOpenApiResponseObject, ZodOpenApiResponsesObject } from "zod-openapi";

export const BEARER_SECURITY = "BearerAuth";

export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
      requestId: z.union([z.string(), z.number()]).optional(),
    }),
  })
  .meta({ id: "ErrorResponse" });

export type Serialized<T> = T extends Date
  ? string
  : T extends (infer Item)[]
    ? Serialized<Item>[]
    : T extends object
      ? { [K in keyof T]: Serialized<T[K]> }
      : T;

export function errorResponse(description: string): ZodOpenApiResponseObject {
  return {
    description,
    content: { "application/json": { schema: errorResponseSchema } },
  };
}

export function apiErrors(
  specific: Record<number, string> = {},
): ZodOpenApiResponsesObject {
  const descriptions: Record<number, string> = {
    401: "Нет токена доступа или он недействителен",
    422: "Запрос не прошёл валидацию; details — результат z.flattenError()",
    ...specific,
    500: "Непредвиденная ошибка сервера",
    503: "Хранилище или база данных недоступны",
  };

  return Object.fromEntries(
    Object.entries(descriptions).map(([status, description]) => [
      status,
      errorResponse(description),
    ]),
  );
}
