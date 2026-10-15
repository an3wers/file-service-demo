import type { FileRowsForFiles } from "./file-rows.js";
import type { Reservation } from "../reservation.js";

export interface UploadOperationRecord {
  reservation: Reservation;
  size: number;
}

export type UploadOperationFileRows = Pick<
  FileRowsForFiles,
  "findFileById" | "isFileDeleted" | "insertFile" | "markFileReady"
>;

export interface UploadOperationSession {
  fileRows: UploadOperationFileRows;
  read(): Promise<UploadOperationRecord | null>;
  save(record: UploadOperationRecord): Promise<void>;
}

export interface UploadOperations {
  exclusive<T>(
    id: string,
    run: (session: UploadOperationSession) => Promise<T>,
  ): Promise<T | null>;
}
