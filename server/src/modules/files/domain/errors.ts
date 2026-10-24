export class FilesDomainError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UploadOperationConflictError extends FilesDomainError {}

export class UploadOperationProcessingError extends FilesDomainError {}

export class FileNotFoundError extends FilesDomainError {}

export class FileNotReadyError extends FilesDomainError {}

export class UploadNotCompletedError extends FilesDomainError {}

export class MultipartNotFoundError extends FilesDomainError {}

export class MultipartIncompleteError extends FilesDomainError {}

export class InvalidPartNumberError extends FilesDomainError {}

export class TooManyActiveUploadsError extends FilesDomainError {}

export class InvalidDirectoryError extends FilesDomainError {}

export class InvalidFileNameError extends FilesDomainError {}

export class FileTooLargeError extends FilesDomainError {}

export class InvalidPlanLimitsError extends FilesDomainError {}

export class InvalidUploadSizeError extends FilesDomainError {}

export class DirectoryNotFoundError extends FilesDomainError {}

export class DirectoryAlreadyExistsError extends FilesDomainError {}

export class DirectoryNotEmptyError extends FilesDomainError {}

export class ImpossibleFileRowError extends FilesDomainError {
  constructor(
    message: string,
    public override readonly details: Record<string, unknown>,
  ) {
    super(message, details);
  }
}
