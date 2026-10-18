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
   * Часы для проверки возраста передаются извне, чтобы правило «старше TTL»
   * можно было проверить в тесте. Эти же часы используют остальные сценарии,
   * поэтому резервирование и порог уборки отсчитывают время согласованно.
   */
  clock: Clock;
  confirmation: ConfirmationModule;
  operations: UploadOperations;
}

/** Результат одного прохода по просроченным строкам метаданных. */
export interface SettleCounters {
  examined: number;
  recovered: number;
  failed: number;
  aborted: number;
  skipped: number;
}

/** Результат одного прохода отмены открытых загрузок в хранилище. */
export interface SweepResult {
  examined: number;
  aborted: number;
}

export interface CleanupModule {
  /**
   * Строки в состоянии `pending` с истёкшим TTL сверяются с фактическим
   * состоянием объектного хранилища.
   */
  settleExpiredRows(): Promise<SettleCounters>;

  /** Открытые загрузки в хранилище, на которые не указывает ни одна строка метаданных. */
  sweepOrphanUploads(): Promise<SweepResult>;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Уборка определяет судьбу загрузок, которые никто не подтвердил.
 *
 * Модуль получает объектное хранилище, узкий интерфейс строк метаданных
 * и политику развёртывания. Скрипту по расписанию достаточно собрать
 * зависимости и запустить проход; работа с SDK остаётся за адаптером.
 *
 * Оба прохода можно безопасно прервать и повторить. Второй проход убирает
 * то, что осталось после первого, например неотменённую составную загрузку
 * уже неудавшегося файла.
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
     * Строка остаётся `pending`, если клиент запросил загрузку, но не подтвердил её.
     * Фактический результат выясняем у хранилища.
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
          const locked = operationId
            ? await operations.exclusive(
                operationId,
                async (session) =>
                  await confirmation.reconcile(file.id, session),
              )
            : null;
          const outcome: ReconciliationResult | null = !locked
            ? await confirmation.reconcile(file.id)
            : locked.busy
              ? null
              : locked.value;
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
     * Сбой между открытием загрузки и вставкой строки оставляет в хранилище
     * сироту. Другие сценарии к ней не обращаются, а части тарифицируются
     * до отмены загрузки.
     *
     * Интерфейс возвращает все открытые загрузки сразу, поэтому проверяем их
     * наличие в таблице одним запросом.
     */
    async sweepOrphanUploads(): Promise<SweepResult> {
      const cutoff = clock.now().getTime() - ttlHours * HOUR_MS;
      // Порог возраста защищает текущие загрузки: строки метаданных может ещё
      // не быть, пока выполняется её вставка.
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
