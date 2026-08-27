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
 * Express 5 defines `req.query` as a getter-only property, so the parsed value
 * cannot be written back the way `validateBody` does with `req.body`. Validated
 * query strings and route params are published on `res.locals` instead, and
 * read back through the `validatedQuery` / `validatedParams` helpers below.
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

export function validatedParams<T>(res: { locals: Record<string, unknown> }): T {
  return res.locals.params as T;
}
