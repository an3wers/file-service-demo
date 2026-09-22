import multer from "multer";
import type { RequestHandler } from "express";

/**
 * Server-side uploads buffer the whole file in memory, so the size limit is
 * load-bearing rather than cosmetic. Anything larger belongs in the presigned
 * flow, which streams straight from the client to storage.
 */
export function createUploadMiddleware(maxSizeBytes: number): RequestHandler {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxSizeBytes,
      files: 1,
      fields: 10,
    },
  }).single("file");
}
