import { logger } from "../../../logger.js";
import type { Clock } from "../domain/ports/clock.js";
import type { FileRowsForCleanup } from "../domain/ports/file-rows.js";
import type { ObjectStoreForCleanup } from "../domain/ports/object-storage.js";
import type { UploadOperations } from "../domain/ports/upload-operations.js";
import type {
  ConfirmationModule,
  ReconciliationResult,
} from "./confirmation.js";
import type { UploadPolicy } from "../domain/upload-policy.js";

export interface CleanupModuleDeps {
  objectStore: ObjectStoreForCleanup;
  fileRows: FileRowsForCleanup;
  policy: UploadPolicy;
  /**
   * The wall clock the age filter measures against. It is an argument for the
   * same reason the policy is: the sweep's whole rule is "older than the TTL",
   * and nothing that reads the clock for itself can be shown obeying it. The
   * same port every other scenario takes, so a reservation's expiry and the
   * sweep's age filter age together.
   */
  clock: Clock;
  confirmation: ConfirmationModule;
  operations: UploadOperations;
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
  clock,
  confirmation,
  operations,
}: CleanupModuleDeps): CleanupModule {
  const ttlHours = policy.pendingTtlHours;

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
          const operationId = await operations.findIdByFileId(file.id);
          const outcome: ReconciliationResult | null = operationId
            ? await operations.exclusive(
                operationId,
                async (session) =>
                  await confirmation.reconcile(file.id, session, {
                    expired: true,
                  }),
              )
            : await confirmation.reconcile(file.id, undefined, {
                expired: true,
              });
          if (outcome?.status === "succeeded") counters.recovered += 1;
          else if (outcome?.status === "failed") {
            counters.failed += 1;
            if (outcome.aborted) counters.aborted += 1;
          } else counters.skipped += 1;
        } catch (error) {
          logger.error(
            { err: error, id: file.id },
            "Could not inspect pending upload",
          );
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
      const cutoff = clock.now().getTime() - ttlHours * HOUR_MS;
      // The age filter is what keeps the sweep off uploads that are running right
      // now: those have no row yet only for as long as the insert takes.
      const stale = (await objectStore.listMultipartUploads()).filter(
        (upload) => (upload.initiatedAt?.getTime() ?? 0) < cutoff,
      );
      const known = await fileRows.findKnownUploadIds(
        stale.map((upload) => upload.uploadId),
      );
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
