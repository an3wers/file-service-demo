import type { UploadPlan } from "./upload-plan.js";

export type FileStatus = "pending" | "ready" | "failed";
export type UploadSource = "server" | "presigned" | "multipart";

interface StoredFileBase {
  id: string;
  bucket: string;
  key: string;
  directory: string;
  originalName: string;
  extension: string;
  contentType: string;
  uploadSource: UploadSource;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReservedFile extends StoredFileBase {
  kind: "reserved";
  size: number | null;
}

export interface LiveMultipartUpload extends StoredFileBase {
  kind: "multipart";
  uploadId: string;
  plan: UploadPlan;
}

export interface ReadyFile extends StoredFileBase {
  kind: "ready";
  size: number | null;
  etag: string | null;
}

export interface FailedFile extends StoredFileBase {
  kind: "failed";
}

export type StoredFile = ReservedFile | LiveMultipartUpload | ReadyFile | FailedFile;

export function statusOf(file: StoredFile): FileStatus {
  switch (file.kind) {
    case "reserved":
    case "multipart":
      return "pending";
    case "ready":
      return "ready";
    case "failed":
      return "failed";
  }
}
