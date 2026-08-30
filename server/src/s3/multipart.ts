import { config } from "../config.js";
import { ERROR_CODES, badRequest, payloadTooLarge } from "../errors.js";

const MIB = 1024 * 1024;

/** Hard limits of the S3 protocol itself. Not configurable. */
export const S3_LIMITS = {
  /** Every part except the last one. The last may be any size at all. */
  minPartSize: 5 * MIB,
  maxPartSize: 5 * 1024 * MIB,
  maxParts: 10_000,
  maxObjectSize: 5 * 1024 * 1024 * MIB,
} as const;

export interface PlanLimits {
  /** Desired part size; grows if the file would not fit in `maxParts`. */
  partSize: number;
  maxParts: number;
  maxObjectSize: number;
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

function configuredLimits(): PlanLimits {
  return {
    partSize: config.uploads.multipartPartSizeBytes,
    maxParts: Math.min(config.uploads.multipartMaxParts, S3_LIMITS.maxParts),
    maxObjectSize: Math.min(config.uploads.maxObjectSizeBytes, S3_LIMITS.maxObjectSize),
  };
}

/** Whether a file of this size goes through multipart rather than a single PUT. */
export function needsMultipart(size: number | undefined, threshold: number): boolean {
  return size !== undefined && size >= threshold;
}

/**
 * Decides how a file is cut into parts. This is the whole of the split policy:
 * the client sends a size and gets back a plan it only has to follow.
 *
 * `limits` is injectable so the edge cases can be driven from a test without
 * standing up a different environment.
 */
export function planMultipart(size: number, limits: PlanLimits = configuredLimits()): UploadPlan {
  if (!Number.isFinite(size) || size <= 0) {
    throw badRequest(
      ERROR_CODES.INVALID_UPLOAD_SIZE,
      "File size must be a positive number of bytes",
    );
  }

  if (size > limits.maxObjectSize) {
    throw payloadTooLarge(
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

  partSize = Math.min(Math.max(partSize, S3_LIMITS.minPartSize), S3_LIMITS.maxPartSize);

  const partCount = Math.ceil(size / partSize);

  if (partCount > limits.maxParts) {
    // Unreachable while `maxObjectSize` stays at or below 5 TiB (10 000 parts of
    // 5 GiB is 50 TiB); kept in case that ceiling is ever raised.
    throw payloadTooLarge("File cannot be split into parts within the S3 limits", {
      maxParts: limits.maxParts,
    });
  }

  return {
    size,
    partSize,
    partCount,
    // Almost always smaller than `minPartSize`, and that is legal: S3 applies
    // the 5 MiB floor to every part except the last.
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
