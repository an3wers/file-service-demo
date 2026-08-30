import { HeadObjectCommand, ListMultipartUploadsCommand } from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { logger } from "../logger.js";
import { bucket, s3 } from "../s3/client.js";
import { isS3NoSuchUpload, isS3NotFound } from "../s3/errors.js";
import * as repo from "../modules/files/files.repo.js";
import {
  abortMultipartUpload,
  listAllParts,
} from "../modules/files/multipart.service.js";
import type { FileRow } from "../modules/files/files.types.js";

interface Counters {
  examined: number;
  recovered: number;
  failed: number;
  aborted: number;
  skipped: number;
}

/** Did the upload succeed after all, with only the confirmation lost? */
async function recoverFromObject(file: FileRow): Promise<boolean> {
  try {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: file.bucket, Key: file.object_key }),
    );

    await repo.markFileReady(file.id, {
      sizeBytes: head.ContentLength ?? null,
      etag: head.ETag ?? null,
      contentType: head.ContentType ?? file.content_type,
    });

    return true;
  } catch (error) {
    if (isS3NotFound(error)) {
      return false;
    }

    throw error;
  }
}

/**
 * An abandoned multipart upload. The row is claimed first, in one statement: a
 * client can still be finishing this upload right now, and whoever updates the
 * row wins. Losing the claim means somebody else settled it, so it is left alone.
 *
 * The claim marks the row failed before the abort runs. If the abort then fails,
 * the upload becomes an orphan — which is exactly what the second pass is for.
 * The other order is worse: it leaves a window where a live client still sees
 * `pending` and keeps pushing parts into an upload already condemned.
 */
async function settleMultipart(file: FileRow, counters: Counters): Promise<void> {
  const uploadId = await repo.claimExpiredMultipart(file.id, config.uploads.pendingTtlHours);

  if (!uploadId) {
    counters.skipped += 1;
    logger.debug({ id: file.id }, "Pending upload was settled by someone else; skipping");
    return;
  }

  try {
    await listAllParts(file, uploadId);
  } catch (error) {
    if (!isS3NoSuchUpload(error)) {
      throw error;
    }

    // The upload is gone: either it completed and only the confirmation was
    // lost, or it never landed at all.
    if (await recoverFromObject(file)) {
      counters.recovered += 1;
      logger.info({ id: file.id, key: file.object_key }, "Recovered pending upload");
    } else {
      counters.failed += 1;
      logger.info({ id: file.id, key: file.object_key }, "Marked pending upload failed");
    }

    return;
  }

  await abortMultipartUpload(file, uploadId);
  counters.aborted += 1;
  counters.failed += 1;
  logger.info(
    { id: file.id, key: file.object_key, uploadId },
    "Aborted abandoned multipart upload",
  );
}

/** A single presigned PUT: S3 alone can say whether the object turned up. */
async function settleSingle(file: FileRow, counters: Counters): Promise<void> {
  if (await recoverFromObject(file)) {
    counters.recovered += 1;
    logger.info({ id: file.id, key: file.object_key }, "Recovered pending upload");
    return;
  }

  await repo.markFileFailed(file.id);
  counters.failed += 1;
  logger.info({ id: file.id, key: file.object_key }, "Marked pending upload failed");
}

/**
 * Rows stay `pending` when a client asked for an upload and never confirmed it.
 * Ask S3 what actually happened rather than guessing from the row alone.
 */
async function settleExpiredRows(): Promise<Counters> {
  const expired = await repo.listExpiredPending(config.uploads.pendingTtlHours);
  const counters: Counters = {
    examined: expired.length,
    recovered: 0,
    failed: 0,
    aborted: 0,
    skipped: 0,
  };

  for (const file of expired) {
    try {
      if (file.upload_id) {
        await settleMultipart(file, counters);
      } else {
        await settleSingle(file, counters);
      }
    } catch (error) {
      logger.error({ err: error, id: file.id }, "Could not inspect pending upload");
    }
  }

  return counters;
}

/**
 * Uploads S3 holds that no row points at — what a crash between
 * CreateMultipartUpload and the metadata insert leaves behind. Nothing else ever
 * looks at those, and S3 charges for their parts until somebody aborts them.
 */
async function sweepOrphanUploads(): Promise<{ examined: number; aborted: number }> {
  const cutoff = Date.now() - config.uploads.pendingTtlHours * 60 * 60 * 1000;
  const result = { examined: 0, aborted: 0 };
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;

  do {
    const page = await s3.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
      }),
    );

    // The age filter is what keeps the sweep off uploads that are running right
    // now: those have no row yet only for as long as the insert takes.
    const stale = (page.Uploads ?? []).filter(
      (upload) =>
        upload.UploadId !== undefined &&
        upload.Key !== undefined &&
        (upload.Initiated?.getTime() ?? 0) < cutoff,
    );

    result.examined += stale.length;

    const known = await repo.findKnownUploadIds(stale.map((upload) => upload.UploadId!));

    for (const upload of stale) {
      if (known.has(upload.UploadId!)) {
        continue;
      }

      await abortMultipartUpload(
        { id: "(orphan)", bucket, object_key: upload.Key! },
        upload.UploadId!,
      );

      result.aborted += 1;
      logger.info(
        { key: upload.Key, uploadId: upload.UploadId },
        "Aborted multipart upload with no metadata row",
      );
    }

    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (keyMarker !== undefined || uploadIdMarker !== undefined);

  return result;
}

async function main(): Promise<void> {
  const counters = await settleExpiredRows();

  if (counters.examined === 0) {
    logger.info("No expired pending uploads");
  } else {
    logger.info(counters, "Cleanup finished");
  }

  const orphans = await sweepOrphanUploads();

  logger.info(orphans, "Orphan multipart sweep finished");
}

try {
  await main();
  await pool.end();
} catch (error) {
  logger.error({ err: error }, "Cleanup failed");
  await pool.end();
  process.exit(1);
}
