export class FilesDomainError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export class FileNotFoundError extends FilesDomainError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = "FileNotFoundError";
  }
}

export class FileNotReadyError extends FilesDomainError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = "FileNotReadyError";
  }
}

export class UploadNotCompletedError extends FilesDomainError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = "UploadNotCompletedError";
  }
}

export class MultipartNotFoundError extends FilesDomainError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = "MultipartNotFoundError";
  }
}

export class TooManyActiveUploadsError extends FilesDomainError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = "TooManyActiveUploadsError";
  }
}

export class InvalidDirectoryError extends FilesDomainError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = "InvalidDirectoryError";
  }
}

export class InvalidFileNameError extends FilesDomainError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = "InvalidFileNameError";
  }
}

export class FileTooLargeError extends FilesDomainError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = "FileTooLargeError";
  }
}
