import { logger } from "../../logger.js";
import type { ObjectStore } from "../../storage/object-store.js";
import type { FileRowsForCleanup } from "./file-rows.js";
import type { StoredFile } from "./stored-file.js";
import type { UploadPolicy } from "./upload-policy.js";

export interface CleanupModuleDeps {
  objectStore: ObjectStore;
  fileRows: FileRowsForCleanup;
  policy: UploadPolicy;
  /**
   * The wall clock the age filter measures against. It is an argument for the
   * same reason the policy is: the sweep's whole rule is "older than the TTL",
   * and nothing that reads the clock for itself can be shown obeying it.
   */
  now?: () => Date;
}

/** What one pass over the expired rows settled. */
export interface SettleCounters {
  examined: number;
  recovered: number;
  failed: number;
  aborted: number;
  skipped: number;
}

/** What one pass over storage's open uploads cancelled. */
export interface SweepResult {
  examined: number;
  aborted: number;
}

export interface CleanupModule {
  /**
   * Rows that stayed `pending` past the TTL, each settled by what storage says
   * actually happened rather than by what the row claims.
   */
  settleExpiredRows(): Promise<SettleCounters>;

  /** Uploads storage still holds open that no metadata row points at. */
  sweepOrphanUploads(): Promise<SweepResult>;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * The cleanup pass: the rules for what to do with an upload nobody ever
 * confirmed.
 *
 * It is a module like the others and takes the same seams — storage, its own
 * narrow row interface, this deployment's policy — so the script that runs it
 * on a schedule only has to assemble those three and call it. Storage is
 * reached through the seam here too: the sweep asks for the open uploads, and
 * no vendor client is named in this file.
 *
 * Both passes are safe to lose halfway through. What the first one leaves
 * behind — a row failed but its upload not yet aborted — is exactly what the
 * second one is for, and running either one twice settles nothing twice.
 */
export function createCleanupModule({
  objectStore,
  fileRows,
  policy,
  now = () => new Date(),
}: CleanupModuleDeps): CleanupModule {
  const ttlHours = policy.pendingTtlHours;

  /** Did the upload succeed after all, with only the confirmation lost? */
  async function recoverFromObject(file: StoredFile): Promise<boolean> {
    const stored = await objectStore.head(file.key);

    if (!stored) {
      return false;
    }

    await fileRows.markFileReady(file.id, {
      sizeBytes: stored.size,
      etag: stored.etag,
      contentType: stored.contentType ?? file.contentType,
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
  async function settleMultipart(file: StoredFile, counters: SettleCounters): Promise<void> {
    const uploadId = await fileRows.claimExpiredMultipart(file.id, ttlHours);

    if (!uploadId) {
      counters.skipped += 1;
      logger.debug({ id: file.id }, "Pending upload was settled by someone else; skipping");
      return;
    }

    const parts = await objectStore.listParts(file.key, uploadId);

    if (!parts) {
      // The upload is gone: either it completed and only the confirmation was
      // lost, or it never landed at all.
      if (await recoverFromObject(file)) {
        counters.recovered += 1;
        logger.info({ id: file.id, key: file.key }, "Recovered pending upload");
      } else {
        counters.failed += 1;
        logger.info({ id: file.id, key: file.key }, "Marked pending upload failed");
      }

      return;
    }

    await objectStore.abortMultipart(file.key, uploadId);
    counters.aborted += 1;
    counters.failed += 1;
    logger.info(
      { id: file.id, key: file.key, uploadId },
      "Aborted abandoned multipart upload",
    );
  }

  /** A single presigned PUT: only storage can say whether the object turned up. */
  async function settleSingle(file: StoredFile, counters: SettleCounters): Promise<void> {
    if (await recoverFromObject(file)) {
      counters.recovered += 1;
      logger.info({ id: file.id, key: file.key }, "Recovered pending upload");
      return;
    }

    await fileRows.markFileFailed(file.id);
    counters.failed += 1;
    logger.info({ id: file.id, key: file.key }, "Marked pending upload failed");
  }

  return {
    /**
     * Rows stay `pending` when a client asked for an upload and never confirmed
     * it. Ask storage what actually happened rather than guessing from the row.
     */
    async settleExpiredRows(): Promise<SettleCounters> {
      const expired = await fileRows.listExpiredPending(ttlHours);
      const counters: SettleCounters = {
        examined: expired.length,
        recovered: 0,
        failed: 0,
        aborted: 0,
        skipped: 0,
      };

      for (const file of expired) {
        try {
          if (file.kind === "multipart") {
            await settleMultipart(file, counters);
          } else {
            await settleSingle(file, counters);
          }
        } catch (error) {
          logger.error({ err: error, id: file.id }, "Could not inspect pending upload");
        }
      }

      return counters;
    },

    /**
     * Uploads storage holds that no row points at — what a crash between opening
     * the upload and the metadata insert leaves behind. Nothing else ever looks
     * at those, and storage charges for their parts until somebody aborts them.
     *
     * The seam hands back every open upload at once, so the rows are asked about
     * all of them in one question instead of one question per page.
     */
    async sweepOrphanUploads(): Promise<SweepResult> {
      const cutoff = now().getTime() - ttlHours * HOUR_MS;
      // The age filter is what keeps the sweep off uploads that are running right
      // now: those have no row yet only for as long as the insert takes.
      const stale = (await objectStore.listMultipartUploads()).filter(
        (upload) => (upload.initiatedAt?.getTime() ?? 0) < cutoff,
      );
      const known = await fileRows.findKnownUploadIds(stale.map((upload) => upload.uploadId));
      const result: SweepResult = { examined: stale.length, aborted: 0 };

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
    },
  };
}
