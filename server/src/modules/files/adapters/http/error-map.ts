import { AppError, ERROR_CODES, badRequest, conflict, notFound, payloadTooLarge, tooManyRequests } from "../../../../errors.js";
import {
  FileNotFoundError,
  FileNotReadyError,
  FileTooLargeError,
  FilesDomainError,
  InvalidDirectoryError,
  InvalidFileNameError,
  MultipartNotFoundError,
  TooManyActiveUploadsError,
  UploadNotCompletedError,
} from "../../domain/errors.js";

export function mapFilesError(error: unknown): AppError | undefined {
  if (!(error instanceof FilesDomainError)) {
    return undefined;
  }

  const options = { cause: error };

  if (error instanceof FileNotFoundError) {
    return notFound(ERROR_CODES.FILE_NOT_FOUND, error.message, error.details, options);
  }

  if (error instanceof FileNotReadyError) {
    return conflict(ERROR_CODES.FILE_NOT_READY, error.message, error.details, options);
  }

  if (error instanceof UploadNotCompletedError) {
    return conflict(ERROR_CODES.UPLOAD_NOT_COMPLETED, error.message, error.details, options);
  }

  if (error instanceof MultipartNotFoundError) {
    return conflict(ERROR_CODES.MULTIPART_NOT_FOUND, error.message, error.details, options);
  }

  if (error instanceof TooManyActiveUploadsError) {
    return tooManyRequests(ERROR_CODES.TOO_MANY_ACTIVE_UPLOADS, error.message, error.details, options);
  }

  if (error instanceof InvalidDirectoryError) {
    return badRequest(ERROR_CODES.INVALID_DIRECTORY, error.message, error.details, options);
  }

  if (error instanceof InvalidFileNameError) {
    return badRequest(ERROR_CODES.INVALID_FILE_NAME, error.message, error.details, options);
  }

  if (error instanceof FileTooLargeError) {
    return payloadTooLarge(error.message, error.details, options);
  }

  return undefined;
}
