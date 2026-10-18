import type { ErrorRequestHandler, RequestHandler } from "express";
import { MulterError } from "multer";
import { ZodError, z } from "zod";
import {
  AppError,
  ERROR_CODES,
  badRequest,
  payloadTooLarge,
} from "../errors.js";
import type { ErrorMapper } from "../errors.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(
    new AppError(
      404,
      ERROR_CODES.ROUTE_NOT_FOUND,
      `Route not found: ${req.method} ${req.originalUrl}`,
    ),
  );
};

/**
 * Приводит ошибки к AppError, чтобы статус, код и запись в журнал выбирались
 * единообразно. Все коды ошибок для клиента, включая ошибки Multer,
 * берутся из `errors.ts`.
 */
function toAppError(error: unknown, mappers: readonly ErrorMapper[]): AppError {
  if (error instanceof AppError) {
    return error;
  }

  for (const map of mappers) {
    const moduleError = map(error);

    if (moduleError) {
      return moduleError;
    }
  }

  if (error instanceof ZodError) {
    return new AppError(
      422,
      ERROR_CODES.VALIDATION_ERROR,
      "Request validation failed",
      z.flattenError(error),
      { cause: error },
    );
  }

  if (error instanceof MulterError) {
    const details = { field: error.field, multerCode: error.code };

    return error.code === "LIMIT_FILE_SIZE"
      ? payloadTooLarge(
          `File exceeds the ${config.uploads.maxSizeMb} MB limit for server-side uploads; use the presigned upload flow instead`,
          details,
          { cause: error },
        )
      : badRequest(ERROR_CODES.UPLOAD_REJECTED, error.message, details, {
          cause: error,
        });
  }

  return new AppError(
    500,
    ERROR_CODES.INTERNAL_SERVER_ERROR,
    "An unexpected error occurred",
    !config.isProduction && error instanceof Error
      ? { message: error.message, stack: error.stack }
      : undefined,
    { cause: error },
  );
}

export const createErrorHandler =
  (mappers: readonly ErrorMapper[]): ErrorRequestHandler =>
  (error, req, res, _next) => {
    const appError = toAppError(error, mappers);
    // `req.log` — дочерний журнал pino-http с `req.id`, позволяющий сопоставить
    // ошибку с записью доступа для того же запроса.
    const log = req.log ?? logger;

    log[appError.statusCode >= 500 ? "error" : "warn"](
      { err: appError, ...appError.logContext },
      appError.message,
    );

    res.status(appError.statusCode).json({
      error: {
        code: appError.code,
        message: appError.message,
        details: appError.details,
        requestId: req.id,
      },
    });
  };
