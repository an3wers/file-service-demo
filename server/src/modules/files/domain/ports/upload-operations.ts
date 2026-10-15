import type { FileRowsForFiles, FileRowsForMultipart } from "./file-rows.js";
import type { Reservation } from "../reservation.js";

export interface UploadOperationRecord {
  reservation: Reservation;
  size: number | null;
}

export type UploadOperationFileRows = Pick<
  FileRowsForFiles,
  | "findFileById"
  | "isFileDeleted"
  | "insertFile"
  | "reserveFile"
  | "markFileReady"
> &
  Pick<FileRowsForMultipart, "countActiveMultipart">;

export interface UploadOperationSession {
  fileRows: UploadOperationFileRows;
  read(): Promise<UploadOperationRecord | null>;
  save(record: UploadOperationRecord): Promise<void>;
}

export interface UploadOperations {
  findIdByFileId(fileId: string): Promise<string | null>;
  exclusive<T>(
    id: string,
    run: (session: UploadOperationSession) => Promise<T>,
    wait?: boolean,
  ): Promise<T | null>;
}
