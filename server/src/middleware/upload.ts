import multer from "multer";
import type { RequestHandler } from "express";

/**
 * При загрузке через сервер весь файл помещается в память, поэтому ограничение
 * размера необходимо. Большие файлы загружаются по подписанной ссылке
 * напрямую из клиента в объектное хранилище.
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
