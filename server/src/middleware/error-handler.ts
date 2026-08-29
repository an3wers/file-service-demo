import type { ErrorRequestHandler, RequestHandler } from "express";
import { MulterError } from "multer";
import { ZodError, z } from "zod";
import { AppError, ERROR_CODES, badRequest, payloadTooLarge } from "../errors.js";
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
 * Normalizes everything that can reach the handler into an AppError, so status,
 * code and logging are decided once rather than per branch. Client-facing codes
 * therefore all come from `errors.ts`, including the ones Multer raises.
 */
function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
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

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const appError = toAppError(error);
  // `req.log` is the pino-http child carrying `req.id`, so the error line can be
  // matched against the access line for the same request.
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
