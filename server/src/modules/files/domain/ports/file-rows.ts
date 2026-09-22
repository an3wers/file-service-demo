import type { StoredFile, FileStatus, UploadSource } from "../stored-file.js";

/**
 * The seam between the modules that reason about files and the table the
 * metadata rows live in.
 *
 * There is no single wide repository interface here on purpose. Each module
 * declares only the operations it actually calls, so its dependency reads as a
 * list of the things it does to rows: the files module never claims an expired
 * upload, the cleanup pass never lists directories, and a test double only ever
 * has to answer for the narrow interface it is standing in for.
 *
 * Values, not exceptions, carry the outcomes a caller has to react to: a row
 * that is not there (or is already soft-deleted) reads as `null`, and a claim
 * somebody else won reads as `null` too. Only failures of the database itself
 * cross this seam as `AppError`.
 *
 * `hardDeleteFile` is deliberately absent: nothing calls it, and a narrow
 * interface is the wrong place to keep an operation alive for later.
 */

/** No `bucket` field: the row writer fills that column from its own construction, not per call. */
export interface InsertFileInput {
  id: string;
  objectKey: string;
  directory: string;
  originalName: string;
  extension: string;
  contentType: string;
  sizeBytes: number | null;
  etag: string | null;
  status: FileStatus;
  uploadSource: UploadSource;
  uploadId?: string | null;
  partSize?: number | null;
  partCount?: number | null;
}

export interface ListFilesParams {
  directory?: string;
  recursive: boolean;
  search?: string;
  status?: FileStatus;
  page: number;
  limit: number;
  sort: "created_at" | "original_name" | "size_bytes";
  order: "asc" | "desc";
}

export interface DirectoryDto {
  name: string;
  path: string;
  fileCount: number;
}

/** What confirmation knows about an upload that finished. */
export interface ReadyValues {
  sizeBytes: number | null;
  etag: string | null;
  contentType: string;
}

/** Rows as the files module handles them: reserve, confirm, list, delete. */
export interface FileRowsForFiles {
  insertFile(input: InsertFileInput): Promise<StoredFile>;

  /** `null` for a row that never existed or has been soft-deleted. */
  findFileById(id: string): Promise<StoredFile | null>;

  /**
   * Moves a reserved row to `ready` and clears the multipart plan with it.
   * `null` when the row is gone, which is what makes a repeated confirmation
   * distinguishable from a first one.
   */
  markFileReady(id: string, values: ReadyValues): Promise<StoredFile | null>;

  /** `null` when the row was already deleted; deleting twice is not an error. */
  softDeleteFile(id: string): Promise<StoredFile | null>;

  /** One page plus the total the page was cut from. */
  listFiles(params: ListFilesParams): Promise<{ items: StoredFile[]; total: number }>;

  /** Immediate child folders of `parent`, derived from the stored directories. */
  listChildDirectories(parent: string): Promise<DirectoryDto[]>;
}

/** Rows as the multipart module handles them: admission, then reservation. */
export interface FileRowsForMultipart {
  /** Slots taken by uploads that have neither completed nor been abandoned. */
  countActiveMultipart(): Promise<number>;

  insertFile(input: InsertFileInput): Promise<StoredFile>;
}

/** Rows as the cleanup pass handles them: find what went stale, then settle it. */
export interface FileRowsForCleanup {
  /** Reserved rows past their TTL, oldest first. */
  listExpiredPending(ttlHours: number): Promise<StoredFile[]>;

  /** The upload turned out to have succeeded; the confirmation was just lost. */
  markFileReady(id: string, values: ReadyValues): Promise<StoredFile | null>;

  markFileFailed(id: string): Promise<void>;

  /**
   * Takes an abandoned multipart upload out of circulation and hands back the
   * upload id that now has to be aborted in storage. Exactly one caller wins:
   * everybody else gets `null` and leaves the row alone, which is what keeps a
   * sweep from cancelling an upload a client is finishing right now.
   */
  claimExpiredMultipart(id: string, ttlHours: number): Promise<string | null>;

  /**
   * Which of these upload ids the metadata table still knows about. The orphan
   * sweep treats anything missing here as an upload no row can reach, so this
   * one question is asked of every row, deleted and settled ones included.
   */
  findKnownUploadIds(ids: string[]): Promise<Set<string>>;
}

/** Everything the three modules together ask of the rows. */
export type FileRows = FileRowsForFiles & FileRowsForMultipart & FileRowsForCleanup;
