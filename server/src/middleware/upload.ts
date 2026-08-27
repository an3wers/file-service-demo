import multer from "multer";
import { config } from "../config.js";

/**
 * Server-side uploads buffer the whole file in memory, so the size limit is
 * load-bearing rather than cosmetic. Anything larger belongs in the presigned
 * flow, which streams straight from the client to S3.
 */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.uploads.maxSizeBytes,
    files: 1,
    fields: 10,
  },
});
