/**
 * The seam between this service and whatever actually holds the bytes.
 *
 * Everything vendor-specific lives behind it: SDK commands, request signing,
 * pagination, and the several shapes a "not found" answer arrives in. Callers
 * work in object keys and never see a bucket — the adapter owns that.
 *
 * Failures cross this seam as `AppError`. The two conditions that are not
 * failures — no object at a key, no upload behind an id — cross it as values,
 * because callers react to them differently: one confirmation path turns a
 * missing object into a 409, another treats a vanished upload as "somebody else
 * already assembled it".
 */

/** What storage knows about an object that exists. */
export interface StoredObject {
  size: number | null;
  etag: string | null;
  contentType: string | null;
}

/** One part storage currently holds for an upload in flight. */
export interface UploadedPart {
  partNumber: number;
  size: number;
  etag: string;
}

/** A multipart upload storage has open, as the orphan sweep sees it. */
export interface MultipartUpload {
  key: string;
  uploadId: string;
  initiatedAt: Date | null;
}

export interface PutOptions {
  contentType: string;
  contentLength: number;
}

export interface SignUploadOptions {
  contentType: string;
  expiresIn: number;
}

export interface SignDownloadOptions {
  /** The name the browser should save the file under. */
  name: string;
  contentType: string;
  disposition: "attachment" | "inline";
  expiresIn: number;
}

/**
 * Whether an upload was assembled here or had already settled elsewhere. A
 * `"gone"` answer is not an error: a lost response or a concurrent confirmation
 * both look like this, and the caller decides by reading the object.
 */
export type CompleteOutcome = "assembled" | "gone";

export interface ObjectStore {
  /** Readiness: storage is reachable and the bucket is there. */
  checkAvailable(): Promise<void>;

  put(key: string, body: Buffer, options: PutOptions): Promise<{ etag: string | null }>;

  /** `null` when no object exists at the key. */
  head(key: string): Promise<StoredObject | null>;

  /** Succeeds whether or not an object was there. */
  remove(key: string): Promise<void>;

  signUpload(key: string, options: SignUploadOptions): Promise<string>;

  signDownload(key: string, options: SignDownloadOptions): Promise<string>;

  /** Opens an upload and returns the id every later call needs. */
  beginMultipart(key: string, options: { contentType: string }): Promise<string>;

  signPart(
    key: string,
    uploadId: string,
    partNumber: number,
    options: { expiresIn: number },
  ): Promise<string>;

  /**
   * Every part held for this upload, ascending by part number. `null` when no
   * upload answers to the id.
   */
  listParts(key: string, uploadId: string): Promise<UploadedPart[] | null>;

  /** Assembles the object out of the parts given, in the order given. */
  completeMultipart(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<CompleteOutcome>;

  /** Cancels an upload in flight. Succeeds when there was nothing to cancel. */
  abortMultipart(key: string, uploadId: string): Promise<void>;

  /**
   * Every upload currently open in the bucket. Only the orphan sweep needs this,
   * and the count it walks is bounded by the active-upload limit plus whatever
   * crashed, so the whole list comes back at once rather than page by page.
   */
  listMultipartUploads(): Promise<MultipartUpload[]>;
}
