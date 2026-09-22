import { ERROR_CODES, badRequest } from "../../../errors.js";
import { FileTooLargeError, InvalidPlanLimitsError } from "./errors.js";

const MIB = 1024 * 1024;

/**
 * What a deployment's policy hands the plan builder. `minPartSize` and
 * `maxPartSize` are the multipart protocol's own bounds — vendor knowledge the
 * domain does not own, declared next to the adapter that speaks the protocol
 * (`storage/s3-object-store.ts`'s `PROTOCOL_LIMITS`) and clamped into a
 * deployment's config at the assembly. The domain only knows it was handed
 * *some* bounds, and checks that they are sane before building a plan on them.
 */
export interface PlanLimits {
  /** Desired part size; grows if the file would not fit in `maxParts`. */
  partSize: number;
  /** Every part except the last one. The last may be any size at all. */
  minPartSize: number;
  maxPartSize: number;
  maxParts: number;
  maxObjectSize: number;
}

/**
 * The domain no longer owns these numbers, so it cannot trust they arrived
 * sane — a deployment that mis-clamps its config would otherwise build plans
 * storage silently rejects, or worse, plans that lie about what they cover.
 * Exported so the assembly can run it once at startup, on top of the check
 * every call to `planMultipart` repeats anyway.
 */
export function assertValidPlanLimits(limits: PlanLimits): void {
  const sane =
    Number.isFinite(limits.minPartSize) &&
    limits.minPartSize > 0 &&
    Number.isFinite(limits.maxPartSize) &&
    limits.maxPartSize >= limits.minPartSize &&
    Number.isFinite(limits.partSize) &&
    limits.partSize > 0 &&
    Number.isFinite(limits.maxParts) &&
    limits.maxParts > 0 &&
    Number.isFinite(limits.maxObjectSize) &&
    limits.maxObjectSize > 0;

  if (!sane) {
    throw new InvalidPlanLimitsError("Upload plan limits are not sane", { limits });
  }
}

export interface UploadPlan {
  size: number;
  partSize: number;
  partCount: number;
  lastPartSize: number;
}

export interface PartRange {
  offset: number;
  size: number;
}

function ceilTo(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

/** Whether a file of this size goes through multipart rather than a single PUT. */
export function needsMultipart(size: number | undefined, threshold: number): boolean {
  return size !== undefined && size >= threshold;
}

/**
 * Decides how a file is cut into parts. This is the whole of the split policy:
 * the client sends a size and gets back a plan it only has to follow.
 *
 * The limits arrive as an argument and have no default. They are a deployment's
 * policy, and a builder that could reach for the environment on its own would
 * be a builder no test can pin down.
 */
export function planMultipart(size: number, limits: PlanLimits): UploadPlan {
  assertValidPlanLimits(limits);

  if (!Number.isFinite(size) || size <= 0) {
    throw badRequest(
      ERROR_CODES.INVALID_UPLOAD_SIZE,
      "File size must be a positive number of bytes",
    );
  }

  if (size > limits.maxObjectSize) {
    throw new FileTooLargeError(
      `File exceeds the ${Math.floor(limits.maxObjectSize / (1024 * MIB))} GB limit for a single object`,
      { maxObjectSize: limits.maxObjectSize },
    );
  }

  let partSize = limits.partSize;

  if (Math.ceil(size / partSize) > limits.maxParts) {
    // Round the required size up to a whole MiB rather than dividing exactly, so
    // the part count lands inside the limit instead of one over it on rounding.
    partSize = ceilTo(Math.ceil(size / limits.maxParts), MIB);
  }

  partSize = Math.min(Math.max(partSize, limits.minPartSize), limits.maxPartSize);

  const partCount = Math.ceil(size / partSize);

  if (partCount > limits.maxParts) {
    // Unreachable while `maxObjectSize` stays at or below 5 TiB (10 000 parts of
    // 5 GiB is 50 TiB); kept in case that ceiling is ever raised.
    throw new FileTooLargeError("File cannot be split into parts within the protocol limits", {
      maxParts: limits.maxParts,
    });
  }

  return {
    size,
    partSize,
    partCount,
    // Almost always smaller than `minPartSize`, and that is legal: the 5 MiB
    // floor applies to every part except the last.
    lastPartSize: size - (partCount - 1) * partSize,
  };
}

/** The byte range of one part — what the client feeds to `file.slice()`. */
export function partRange(plan: UploadPlan, partNumber: number): PartRange {
  const offset = (partNumber - 1) * plan.partSize;

  return {
    offset,
    size: partNumber === plan.partCount ? plan.lastPartSize : plan.partSize,
  };
}
