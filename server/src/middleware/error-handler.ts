import type { ErrorRequestHandler, RequestHandler } from "express";
import { MulterError } from "multer";
import { ZodError } from "zod";
import { AppError } from "../errors.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(
    new AppError(
      404,
      "ROUTE_NOT_FOUND",
      `Route not found: ${req.method} ${req.originalUrl}`,
    ),
  );
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(422).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: error.flatten(),
      },
    });

    return;
  }

  if (error instanceof MulterError) {
    const tooLarge = error.code === "LIMIT_FILE_SIZE";

    res.status(tooLarge ? 413 : 400).json({
      error: {
        code: error.code,
        message: tooLarge
          ? `File exceeds the ${config.uploads.maxSizeMb} MB limit for server-side uploads; use the presigned upload flow instead`
          : error.message,
        details: { field: error.field },
      },
    });

    return;
  }

  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });

    return;
  }

  logger.error({ err: error }, "Unhandled error");

  res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred",
      ...(!config.isProduction && error instanceof Error
        ? { details: { message: error.message, stack: error.stack } }
        : {}),
    },
  });
};
