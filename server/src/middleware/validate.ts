import type { RequestHandler } from "express";
import type { ZodType } from "zod";

export function validateBody(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      return next(result.error);
    }

    req.body = result.data;
    next();
  };
}

/**
 * В Express 5 у `req.query` есть только геттер, поэтому результат разбора нельзя
 * записать обратно, как `validateBody` делает с `req.body`. Проверенные параметры
 * запроса и маршрута сохраняются в `res.locals` и читаются через
 * `validatedQuery` и `validatedParams`.
 */
export function validateQuery(schema: ZodType): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);

    if (!result.success) {
      return next(result.error);
    }

    res.locals.query = result.data;
    next();
  };
}

export function validateParams(schema: ZodType): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req.params);

    if (!result.success) {
      return next(result.error);
    }

    res.locals.params = result.data;
    next();
  };
}

export function validatedQuery<T>(res: { locals: Record<string, unknown> }): T {
  return res.locals.query as T;
}

export function validatedParams<T>(res: {
  locals: Record<string, unknown>;
}): T {
  return res.locals.params as T;
}
