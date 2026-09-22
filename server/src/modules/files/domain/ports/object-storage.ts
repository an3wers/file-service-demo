import type {
  CompleteOutcome,
  MultipartUpload,
  PutOptions,
  SignDownloadOptions,
  SignUploadOptions,
  StoredObject,
  UploadedPart,
} from "../../../../storage/object-store.js";

/**
 * The seam between the modules that reason about files and object storage,
 * narrowed the same way the row interfaces in `file-rows.ts` are: each module
 * declares only the operations it actually calls, so its dependency reads as a
 * list of what it does to storage. The files module never opens a multipart
 * upload, cleanup never signs a URL, and a test double only has to answer for
 * the slice it stands in for.
 *
 * There is still one adapter behind all three — `storage/`'s `ObjectStore` is
 * structurally wide enough to satisfy every interface here, so the assembly
 * hands the same instance to all three modules without adapting anything.
 */

/** Storage as the files module handles it: put, confirm, sign, remove. */
export interface ObjectStoreForFiles {
  put(key: string, body: Buffer, options: PutOptions): Promise<{ etag: string | null }>;

  /** `null` when no object exists at the key. */
  head(key: string): Promise<StoredObject | null>;

  /** Succeeds whether or not an object was there. */
  remove(key: string): Promise<void>;

  signUpload(key: string, options: SignUploadOptions): Promise<string>;

  signDownload(key: string, options: SignDownloadOptions): Promise<string>;

  /** Cancels an upload in flight, for a delete that catches a live multipart file. */
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

/** Storage as the multipart module handles it: open, sign, assemble, cancel. */
export interface ObjectStoreForMultipart {
  beginMultipart(key: string, options: { contentType: string }): Promise<string>;

  signPart(
    key: string,
    uploadId: string,
    partNumber: number,
    options: { expiresIn: number },
  ): Promise<string>;

  /** `null` when no upload answers to the id. */
  listParts(key: string, uploadId: string): Promise<UploadedPart[] | null>;

  completeMultipart(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<CompleteOutcome>;

  abortMultipart(key: string, uploadId: string): Promise<void>;
}

/** Storage as the cleanup pass handles it: check, inspect, cancel, list. */
export interface ObjectStoreForCleanup {
  head(key: string): Promise<StoredObject | null>;

  listParts(key: string, uploadId: string): Promise<UploadedPart[] | null>;

  abortMultipart(key: string, uploadId: string): Promise<void>;

  /** Every upload storage still holds open, for the orphan sweep. */
  listMultipartUploads(): Promise<MultipartUpload[]>;
}
