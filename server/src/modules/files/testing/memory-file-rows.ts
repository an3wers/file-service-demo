import { randomUUID } from "node:crypto";
import { ERROR_CODES, conflict } from "../../../errors.js";
import { createTestClock } from "../../../testing/clock.js";
import type { TestClock } from "../../../testing/clock.js";
import { createFailureSwitch } from "../../../testing/failure-switch.js";
import type {
  FileRows,
  FileRowsForCleanup,
  FileRowsForFiles,
  FileRowsForMultipart,
  InsertFileInput,
  ListFilesParams,
  ReadyValues,
} from "../domain/ports/file-rows.js";
import { toStoredFile } from "../adapters/persistence/row-mapper.js";
import type { FileRow } from "../adapters/persistence/row-mapper.js";
import type { StoredFile } from "../domain/stored-file.js";
import { FileNotFoundError } from "../domain/errors.js";

/**
 * Реализация интерфейсов строк метаданных на Map.
 *
 * Хранит состояние, чтобы тест мог проверить результат перехода:
 * идемпотентность, захват и истечение TTL нельзя подтвердить одним
 * подсчётом вызовов.
 *
 * Воспроизводит гарантии SQL, на которые опирается код:
 *
 * - удалённая строка недоступна для чтения, подтверждения и удаления;
 * - подтверждение очищает план составной загрузки и её идентификатор;
 * - захват просроченной загрузки срабатывает один раз и возвращает прежний
 *   идентификатор, а не `null`, записанный при очистке;
 * - идентификатор и пара `(bucket, object_key)` уникальны;
 * - список сортируется по выбранному столбцу, затем по идентификатору
 *   и разбивается на страницы.
 *
 * Для проверки TTL используются управляемые часы. Они могут быть общими
 * с хранилищем; `advance` передвигает их.
 *
 * `failNext` отклоняет один вызов, позволяя проверять откат состояния
 * хранилища при отказе таблицы сохранить строку.
 */

export interface MemoryFileRows extends FileRows {
  forOwner(owner: string): FileRows;
  setTerminationGuard(guard: (id: string) => boolean): void;
  isTerminated(id: string): boolean;
  /** Передвигает часы, чтобы резервирование могло стать просроченным. */
  advance(hours: number): void;
  /** Отклоняет следующий вызов этого метода для проверки обработки ошибок. */
  failNext(method: keyof FileRows, error: unknown): void;
  /**
   * Позволяет изменить строку непосредственно перед следующим захватом:
   * например, подтвердить загрузку, которую уборка собирается отменить.
   * Так воспроизводится гонка, которую должен разрешать захват.
   */
  beforeNextClaim(run: () => Promise<void>): void;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * `size_bytes` — единственный сортируемый столбец с допустимым `null`.
 * Postgres размещает `null` в конце при сортировке по возрастанию
 * и в начале при сортировке по убыванию.
 */
function compareSizes(
  a: number | null,
  b: number | null,
  order: "asc" | "desc",
): number {
  const direction = order === "asc" ? 1 : -1;

  if (a === b) {
    return 0;
  }

  if (a === null || b === null) {
    return (a === null ? 1 : -1) * direction;
  }

  return (a < b ? -1 : 1) * direction;
}

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}

export function createMemoryFileRows(
  options: { clock?: TestClock; bucket?: string } = {},
): MemoryFileRows {
  const rows = new Map<string, FileRow>();
  const owners = new Map<string, string | null>();
  const clock = options.clock ?? createTestClock();
  const bucket = options.bucket ?? "test-bucket";
  const failures = createFailureSwitch<keyof FileRows>();
  let terminated = (_id: string) => false;
  let interleaved: (() => Promise<void>) | null = null;

  /** Строки возвращаются копиями: изменения у вызывающего кода не меняют таблицу. */
  const copy = (row: FileRow): FileRow => ({ ...row });

  const live = (row: FileRow): boolean => row.deleted_at === null;

  const expired = (row: FileRow, ttlHours: number): boolean =>
    row.attempt_started_at.getTime() <
    clock.now().getTime() - ttlHours * HOUR_MS;

  function view(owner: string | null): FileRows {
    const visible = (row: FileRow) =>
      owner === null || owners.get(row.id) === owner;
    const get = (id: string) => {
      const row = rows.get(id);
      return row && visible(row) ? row : undefined;
    };
    const all = () => [...rows.values()].filter(visible);
    const files: FileRowsForFiles & FileRowsForMultipart & FileRowsForCleanup =
      {
        async reserveFile(input) {
          failures.check("reserveFile");
          const row = get(input.id);
          if (!row) return await files.insertFile(input);
          if (!live(row) || row.status === "ready")
            throw new FileNotFoundError(
              `File ${input.id} was deleted or completed`,
            );
          row.attempt_started_at = clock.now();
          row.attempt_generation = randomUUID();
          row.status = input.status;
          row.upload_source = input.uploadSource;
          row.size_bytes = input.sizeBytes;
          row.etag = input.etag;
          row.upload_id = input.uploadId ?? null;
          row.part_size = input.partSize ?? null;
          row.part_count = input.partCount ?? null;
          row.updated_at = clock.now();
          return toStoredFile(copy(row));
        },
        async insertFile(input: InsertFileInput): Promise<StoredFile> {
          failures.check("insertFile");

          if (rows.has(input.id)) {
            throw conflict(
              ERROR_CODES.DUPLICATE_RESOURCE,
              `File ${input.id} already exists`,
            );
          }

          const takenKey = [...rows.values()].some(
            (row) =>
              row.bucket === bucket && row.object_key === input.objectKey,
          );

          if (takenKey) {
            throw conflict(
              ERROR_CODES.DUPLICATE_RESOURCE,
              `Object key ${input.objectKey} is already reserved`,
            );
          }

          const now = clock.now();
          const row: FileRow = {
            id: input.id,
            bucket,
            object_key: input.objectKey,
            directory: input.directory,
            original_name: input.originalName,
            extension: input.extension,
            content_type: input.contentType,
            size_bytes: input.sizeBytes,
            etag: input.etag,
            status: input.status,
            upload_source: input.uploadSource,
            upload_id: input.uploadId ?? null,
            part_size: input.partSize ?? null,
            part_count: input.partCount ?? null,
            created_at: now,
            attempt_started_at: now,
            attempt_generation: randomUUID(),
            updated_at: now,
            deleted_at: null,
          };

          rows.set(row.id, row);
          owners.set(row.id, owner);

          return toStoredFile(copy(row));
        },

        async isFileDeleted(id) {
          return get(id)?.deleted_at != null;
        },

        async findFileById(id: string): Promise<StoredFile | null> {
          failures.check("findFileById");

          const row = get(id);

          return row && live(row) ? toStoredFile(copy(row)) : null;
        },

        async markFileReady(
          id: string,
          values: ReadyValues,
        ): Promise<StoredFile | null> {
          failures.check("markFileReady");

          const row = get(id);

          if (!row || !live(row) || terminated(id)) {
            return null;
          }

          row.status = "ready";
          row.size_bytes = values.sizeBytes;
          row.etag = values.etag;
          row.content_type = values.contentType;
          row.upload_id = null;
          row.part_size = null;
          row.part_count = null;
          row.updated_at = clock.now();

          return toStoredFile(copy(row));
        },

        async failFileIfUnchanged(expected) {
          failures.check("failFileIfUnchanged");
          if (interleaved) {
            const run = interleaved;
            interleaved = null;
            await run();
          }
          const row = get(expected.id);
          if (
            !row ||
            !live(row) ||
            terminated(expected.id) ||
            row.status !== "pending" ||
            row.attempt_generation !== expected.attemptGeneration ||
            row.updated_at.getTime() !== expected.updatedAt.getTime() ||
            row.upload_id !==
              (expected.kind === "multipart" ? expected.uploadId : null)
          )
            return false;
          row.status = "failed";
          row.upload_id = null;
          row.part_size = null;
          row.part_count = null;
          row.updated_at = clock.now();
          return true;
        },

        /** В этом SQL-запросе, в отличие от остальных, нет проверки `deleted_at`. */
        async markFileFailed(id: string): Promise<void> {
          failures.check("markFileFailed");

          const row = get(id);

          if (!row) {
            return;
          }

          row.status = "failed";
          row.upload_id = null;
          row.part_size = null;
          row.part_count = null;
          row.updated_at = clock.now();
        },

        async countActiveMultipart(): Promise<number> {
          failures.check("countActiveMultipart");

          return all().filter(
            (row) =>
              row.status === "pending" && row.upload_id !== null && live(row),
          ).length;
        },

        async relocateFile(id, change) {
          failures.check("relocateFile");
          const row = get(id);
          if (!row || !live(row) || row.status !== "ready" || terminated(id))
            return null;
          if (change.name) {
            row.original_name = change.name.originalName;
            row.extension = change.name.extension;
          }
          if (change.directory !== undefined) row.directory = change.directory;
          row.updated_at = clock.now();
          return toStoredFile(copy(row));
        },

        async softDeleteFile(id: string): Promise<StoredFile | null> {
          failures.check("softDeleteFile");

          const row = get(id);

          if (!row || !live(row)) {
            return null;
          }

          row.deleted_at = clock.now();
          row.updated_at = row.deleted_at;

          return toStoredFile(copy(row));
        },

        async listFiles(
          params: ListFilesParams,
        ): Promise<{ items: StoredFile[]; total: number }> {
          failures.check("listFiles");

          const matched = all().filter((row) => {
            if (!live(row)) {
              return false;
            }

            if (params.status && row.status !== params.status) {
              return false;
            }

            if (params.directory !== undefined) {
              const directory = params.directory;

              if (!params.recursive) {
                if (row.directory !== directory) {
                  return false;
                }
              } else if (
                // Пустая строка с recursive означает весь бакет, поэтому ничего не исключаем.
                directory !== "" &&
                row.directory !== directory &&
                !row.directory.startsWith(`${directory}/`)
              ) {
                return false;
              }
            }

            if (
              params.search &&
              !row.original_name
                .toLowerCase()
                .includes(params.search.toLowerCase())
            ) {
              return false;
            }

            return true;
          });

          const direction = params.order === "asc" ? 1 : -1;

          matched.sort((a, b) => {
            let ordered: number;

            if (params.sort === "created_at") {
              const ages = a.created_at.getTime() - b.created_at.getTime();

              ordered = direction * (ages === 0 ? 0 : ages < 0 ? -1 : 1);
            } else if (params.sort === "original_name") {
              ordered =
                direction *
                compareText(
                  a.original_name.toLowerCase(),
                  b.original_name.toLowerCase(),
                );
            } else {
              ordered = compareSizes(a.size_bytes, b.size_bytes, params.order);
            }

            return ordered === 0 ? compareText(a.id, b.id) : ordered;
          });

          const offset = (params.page - 1) * params.limit;
          const items = matched.slice(offset, offset + params.limit).map(copy);

          return {
            items: items.map(toStoredFile),
            total: matched.length,
          };
        },

        async findKnownUploadIds(ids: string[]): Promise<Set<string>> {
          failures.check("findKnownUploadIds");

          if (ids.length === 0) {
            return new Set();
          }

          const wanted = new Set(ids);

          // Без проверки `deleted_at` и статуса: уборка обращается ко всей таблице.
          return new Set(
            [...rows.values()]
              .map((row) => row.upload_id)
              .filter(
                (uploadId): uploadId is string =>
                  uploadId !== null && wanted.has(uploadId),
              ),
          );
        },

        async listExpiredPending(ttlHours: number): Promise<StoredFile[]> {
          failures.check("listExpiredPending");

          return all()
            .filter(
              (row) =>
                row.status === "pending" &&
                live(row) &&
                owners.get(row.id) != null &&
                expired(row, ttlHours),
            )
            .sort(
              (a, b) =>
                a.attempt_started_at.getTime() - b.attempt_started_at.getTime(),
            )
            .map(copy)
            .map(toStoredFile);
        },
      };
    return files;
  }
  const files = view(null);

  return {
    ...files,
    forOwner: view,
    setTerminationGuard(guard) {
      terminated = guard;
    },
    isTerminated: (id) => terminated(id),

    advance(hours: number): void {
      clock.advance(hours);
    },

    failNext(method, error): void {
      failures.failNext(method, error);
    },

    beforeNextClaim(run): void {
      interleaved = run;
    },
  };
}
