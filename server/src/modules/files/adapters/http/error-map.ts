import { AppError, ERROR_CODES } from "../../../../errors.js";
import type { ErrorCode } from "../../../../errors.js";
import {
  UploadOperationConflictError,
  UploadOperationProcessingError,
  DirectoryAlreadyExistsError,
  DirectoryBusyError,
  DirectoryNotEmptyError,
  DirectoryNotFoundError,
  FileNotFoundError,
  FileNotReadyError,
  FileTooLargeError,
  FilesDomainError,
  ImpossibleFileRowError,
  InvalidDirectoryError,
  InvalidFileNameError,
  InvalidPartNumberError,
  InvalidUploadSizeError,
  MultipartIncompleteError,
  MultipartNotFoundError,
  TooManyActiveUploadsError,
  UploadNotCompletedError,
} from "../../domain/errors.js";

type DomainErrorClass = abstract new (...args: never[]) => FilesDomainError;

interface HttpResponse {
  status: number;
  code: ErrorCode;
}

const RESPONSES: ReadonlyArray<[DomainErrorClass, HttpResponse]> = [
  [
    UploadOperationConflictError,
    { status: 409, code: ERROR_CODES.UPLOAD_OPERATION_CONFLICT },
  ],
  [
    UploadOperationProcessingError,
    { status: 409, code: ERROR_CODES.UPLOAD_OPERATION_PROCESSING },
  ],
  [
    DirectoryNotFoundError,
    { status: 404, code: ERROR_CODES.DIRECTORY_NOT_FOUND },
  ],
  [
    DirectoryAlreadyExistsError,
    { status: 409, code: ERROR_CODES.DIRECTORY_ALREADY_EXISTS },
  ],
  [
    DirectoryNotEmptyError,
    { status: 409, code: ERROR_CODES.DIRECTORY_NOT_EMPTY },
  ],
  [DirectoryBusyError, { status: 409, code: ERROR_CODES.DIRECTORY_BUSY }],
  [FileNotFoundError, { status: 404, code: ERROR_CODES.FILE_NOT_FOUND }],
  [FileNotReadyError, { status: 409, code: ERROR_CODES.FILE_NOT_READY }],
  [
    UploadNotCompletedError,
    { status: 409, code: ERROR_CODES.UPLOAD_NOT_COMPLETED },
  ],
  [
    MultipartNotFoundError,
    { status: 409, code: ERROR_CODES.MULTIPART_NOT_FOUND },
  ],
  [
    MultipartIncompleteError,
    { status: 409, code: ERROR_CODES.MULTIPART_INCOMPLETE },
  ],
  [
    TooManyActiveUploadsError,
    { status: 429, code: ERROR_CODES.TOO_MANY_ACTIVE_UPLOADS },
  ],
  [InvalidDirectoryError, { status: 400, code: ERROR_CODES.INVALID_DIRECTORY }],
  [InvalidFileNameError, { status: 400, code: ERROR_CODES.INVALID_FILE_NAME }],
  [
    InvalidUploadSizeError,
    { status: 400, code: ERROR_CODES.INVALID_UPLOAD_SIZE },
  ],
  [
    InvalidPartNumberError,
    { status: 400, code: ERROR_CODES.INVALID_PART_NUMBER },
  ],
  [FileTooLargeError, { status: 413, code: ERROR_CODES.PAYLOAD_TOO_LARGE }],
];

export function mapFilesError(error: unknown): AppError | undefined {
  if (!(error instanceof FilesDomainError)) {
    return undefined;
  }

  if (error instanceof ImpossibleFileRowError) {
    return new AppError(
      500,
      ERROR_CODES.INTERNAL_SERVER_ERROR,
      "An unexpected error occurred",
      undefined,
      {
        cause: error,
        logContext: error.details,
      },
    );
  }

  const response = RESPONSES.find(([Kind]) => error instanceof Kind)?.[1];

  return response
    ? new AppError(
        response.status,
        response.code,
        error.message,
        error.details,
        {
          cause: error,
        },
      )
    : undefined;
}
