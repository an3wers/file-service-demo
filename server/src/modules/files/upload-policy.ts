import type { PlanLimits } from "./upload-plan.js";

/**
 * What this deployment has decided about uploads: from what size an upload
 * becomes multipart, how it is cut up, how many URLs are signed at a time, how
 * many uploads may run at once and how long links live.
 *
 * It arrives as an argument rather than being read from the environment inside
 * the modules. These are numbers a deployment chooses, so a module that reached
 * for them itself could only be exercised by rewriting the environment around
 * it.
 */
export interface UploadPolicy {
  /** At or above this size an upload goes multipart instead of a single PUT. */
  multipartThresholdBytes: number;

  /** What the plan builder is allowed to produce. */
  planLimits: PlanLimits;

  /** How many part URLs are signed in one answer — the first batch and later ones. */
  partUrlBatch: number;

  /** How many parts the client may keep in flight; the server owns this number. */
  maxConcurrency: number;

  /** How many multipart uploads may be in progress across the service at once. */
  maxActiveUploads: number;

  presignUploadTtlSeconds: number;
  presignDownloadTtlSeconds: number;
  presignPartTtlSeconds: number;
}
