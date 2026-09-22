import { config } from "../config.js";
import { createObjectStore } from "../composition.js";
import { pool } from "../db/pool.js";
import { logger } from "../logger.js";
import type { FileRowsForCleanup } from "../modules/files/file-rows.js";
import { sqlFileRows } from "../modules/files/files.repo.js";
import type { FileRow } from "../modules/files/files.types.js";
import type { ObjectStore } from "../storage/object-store.js";

interface CleanupDeps {
  objectStore: ObjectStore;
  fileRows: FileRowsForCleanup;
  pendingTtlHours: number;
}

interface Counters {
  examined: number;
  recovered: number;
  failed: number;
  aborted: number;
  skipped: number;
}

/**
 * The cleanup pass, assembled separately from the API: it needs storage and the
 * rows, and nothing else the service wires up.
 */
function createCleanup({ objectStore, fileRows, pendingTtlHours }: CleanupDeps) {
  /** Did the upload succeed after all, with only the confirmation lost? */
  async function recoverFromObject(file: FileRow): Promise<boolean> {
    const stored = await objectStore.head(file.object_key);

    if (!stored) {
      return false;
    }

    await fileRows.markFileReady(file.id, {
      sizeBytes: stored.size,
      etag: stored.etag,
      contentType: stored.contentType ?? file.content_type,
    });

    return true;
  }

  /**
   * An abandoned multipart upload. The row is claimed first, in one statement: a
   * client can still be finishing this upload right now, and whoever updates the
   * row wins. Losing the claim means somebody else settled it, so it is left
   * alone.
   *
   * The claim marks the row failed before the abort runs. If the abort then
   * fails, the upload becomes an orphan — which is exactly what the second pass
   * is for. The other order is worse: it leaves a window where a live client
   * still sees `pending` and keeps pushing parts into an upload already
   * condemned.
   */
  async function settleMultipart(file: FileRow, counters: Counters): Promise<void> {
    const uploadId = await fileRows.claimExpiredMultipart(file.id, pendingTtlHours);

    if (!uploadId) {
      counters.skipped += 1;
      logger.debug({ id: file.id }, "Pending upload was settled by someone else; skipping");
      return;
    }

    const parts = await objectStore.listParts(file.object_key, uploadId);

    if (!parts) {
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

    await objectStore.abortMultipart(file.object_key, uploadId);
    counters.aborted += 1;
    counters.failed += 1;
    logger.info(
      { id: file.id, key: file.object_key, uploadId },
      "Aborted abandoned multipart upload",
    );
  }

  /** A single presigned PUT: only storage can say whether the object turned up. */
  async function settleSingle(file: FileRow, counters: Counters): Promise<void> {
    if (await recoverFromObject(file)) {
      counters.recovered += 1;
      logger.info({ id: file.id, key: file.object_key }, "Recovered pending upload");
      return;
    }

    await fileRows.markFileFailed(file.id);
    counters.failed += 1;
    logger.info({ id: file.id, key: file.object_key }, "Marked pending upload failed");
  }

  /**
   * Rows stay `pending` when a client asked for an upload and never confirmed
   * it. Ask storage what actually happened rather than guessing from the row.
   */
  async function settleExpiredRows(): Promise<Counters> {
    const expired = await fileRows.listExpiredPending(pendingTtlHours);
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
   * Uploads storage holds that no row points at — what a crash between opening
   * the upload and the metadata insert leaves behind. Nothing else ever looks at
   * those, and storage charges for their parts until somebody aborts them.
   */
  async function sweepOrphanUploads(): Promise<{ examined: number; aborted: number }> {
    const cutoff = Date.now() - pendingTtlHours * 60 * 60 * 1000;
    // The age filter is what keeps the sweep off uploads that are running right
    // now: those have no row yet only for as long as the insert takes.
    const stale = (await objectStore.listMultipartUploads()).filter(
      (upload) => (upload.initiatedAt?.getTime() ?? 0) < cutoff,
    );
    const known = await fileRows.findKnownUploadIds(stale.map((upload) => upload.uploadId));
    const result = { examined: stale.length, aborted: 0 };

    for (const upload of stale) {
      if (known.has(upload.uploadId)) {
        continue;
      }

      await objectStore.abortMultipart(upload.key, upload.uploadId);

      result.aborted += 1;
      logger.info(
        { key: upload.key, uploadId: upload.uploadId },
        "Aborted multipart upload with no metadata row",
      );
    }

    return result;
  }

  return { settleExpiredRows, sweepOrphanUploads };
}

async function main(): Promise<void> {
  const cleanup = createCleanup({
    objectStore: createObjectStore(),
    fileRows: sqlFileRows,
    pendingTtlHours: config.uploads.pendingTtlHours,
  });

  const counters = await cleanup.settleExpiredRows();

  if (counters.examined === 0) {
    logger.info("No expired pending uploads");
  } else {
    logger.info(counters, "Cleanup finished");
  }

  const orphans = await cleanup.sweepOrphanUploads();

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
