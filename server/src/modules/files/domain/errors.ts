export class FilesDomainError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class FileNotFoundError extends FilesDomainError {}

export class FileNotReadyError extends FilesDomainError {}

export class UploadNotCompletedError extends FilesDomainError {}

export class MultipartNotFoundError extends FilesDomainError {}

export class TooManyActiveUploadsError extends FilesDomainError {}

export class InvalidDirectoryError extends FilesDomainError {}

export class InvalidFileNameError extends FilesDomainError {}

export class FileTooLargeError extends FilesDomainError {}

export class InvalidPlanLimitsError extends FilesDomainError {}
