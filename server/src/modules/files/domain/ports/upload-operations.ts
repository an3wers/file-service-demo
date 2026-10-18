import type { FileRowsForFiles, FileRowsForMultipart } from "./file-rows.js";
import type { DirectoriesForUpload } from "./directories.js";
import type { Reservation } from "../reservation.js";

export type UploadTerminationReason = "cancelled" | "failed" | "deleted";

export interface UploadTermination {
  reason: UploadTerminationReason;
  uploadId: string | null;
}

export interface UploadOperationRecord {
  reservation: Reservation;
  size: number | null;
  stoppedMultipartUploadId?: string | null;
}

export type UploadOperationFileRows = Pick<
  FileRowsForFiles,
  | "findFileById"
  | "isFileDeleted"
  | "reserveFile"
  | "markFileReady"
  | "markFileFailed"
  | "failFileIfUnchanged"
> &
  Pick<FileRowsForMultipart, "countActiveMultipart">;

export interface UploadOperationSessionPorts {
  fileRows: UploadOperationFileRows;
  directories: DirectoriesForUpload;
}

export interface UploadOperationSession extends UploadOperationSessionPorts {
  read(): Promise<UploadOperationRecord | null>;
  termination(): Promise<UploadTermination | null>;
  terminate(reason: UploadTerminationReason, uploadId?: string): Promise<void>;
  checked(): Promise<void>;
  markMultipartStopped(uploadId: string | null): Promise<void>;
  save(record: UploadOperationRecord): Promise<void>;
}

export type ExclusiveResult<T> = { busy: false; value: T } | { busy: true };

export interface ExclusiveOptions {
  wait?: boolean;
}

export interface UploadOperations {
  read(id: string): Promise<{
    record: UploadOperationRecord | null;
    termination: UploadTermination | null;
  }>;
  terminate(
    id: string,
    reason: UploadTerminationReason,
    uploadId?: string,
  ): Promise<void>;
  listTerminated(): Promise<string[]>;
  findIdByFileId(fileId: string): Promise<string | null>;
  exclusive<T>(
    id: string,
    run: (session: UploadOperationSession) => Promise<T>,
    options?: ExclusiveOptions,
  ): Promise<ExclusiveResult<T>>;
}
