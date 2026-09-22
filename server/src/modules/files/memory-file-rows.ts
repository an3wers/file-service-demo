import { ERROR_CODES, conflict } from "../../errors.js";
import type {
  FileRows,
  FileRowsForCleanup,
  FileRowsForFiles,
  FileRowsForMultipart,
  ReadyValues,
} from "./file-rows.js";
import type { DirectoryDto, FileRow, InsertFileInput, ListFilesParams } from "./files.types.js";

/**
 * The second implementation of the row interfaces: the metadata table as a Map.
 *
 * It keeps real state rather than scripted answers, so a test can assert that a
 * row ended up confirmed instead of asserting that confirmation was called
 * once. That is the whole reason it exists — idempotence, claiming and TTL are
 * transitions, and a spy cannot show a transition.
 *
 * The rules reproduced here are the ones the SQL side guarantees and the code
 * leans on:
 *
 * - a soft-deleted row is invisible to reads, confirmation and deletion;
 * - confirmation clears the multipart plan along with the upload id;
 * - claiming an expired upload succeeds exactly once and hands back the id that
 *   was cleared, not the null left behind;
 * - `(bucket, object_key)` is unique, and so is the id;
 * - listing sorts by the requested column, then by id, and pages the result.
 *
 * Time is a knob here. TTL is the one rule that cannot be exercised without
 * moving the clock, so the store owns one and `advance` turns it.
 */

/** A clock the test drives, standing in for the database's `now()`. */
interface MemoryClock {
  now(): Date;
  advance(hours: number): void;
}

export interface MemoryFileRows extends FileRows {
  /** Moves the clock forward, which is how a reserved row becomes expired. */
  advance(hours: number): void;
}

const HOUR_MS = 60 * 60 * 1000;

function createClock(start: Date): MemoryClock {
  let current = start.getTime();

  return {
    now: () => new Date(current),
    advance: (hours) => {
      current += hours * HOUR_MS;
    },
  };
}

/**
 * `size_bytes` is the one sortable column that can be null, and where a null
 * sits is a rule of its own: Postgres puts nulls last ascending and first
 * descending, while the direction applies to the values.
 */
function compareSizes(a: number | null, b: number | null, order: "asc" | "desc"): number {
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

export function createMemoryFileRows(options: { now?: Date } = {}): MemoryFileRows {
  const rows = new Map<string, FileRow>();
  const clock = createClock(options.now ?? new Date());

  /** Rows leave by value: a caller mutating one must not rewrite the table. */
  const copy = (row: FileRow): FileRow => ({ ...row });

  const live = (row: FileRow): boolean => row.deleted_at === null;

  const expired = (row: FileRow, ttlHours: number): boolean =>
    row.created_at.getTime() < clock.now().getTime() - ttlHours * HOUR_MS;

  const files: FileRowsForFiles & FileRowsForMultipart & FileRowsForCleanup = {
    async insertFile(input: InsertFileInput): Promise<FileRow> {
      if (rows.has(input.id)) {
        throw conflict(ERROR_CODES.DUPLICATE_RESOURCE, `File ${input.id} already exists`);
      }

      const takenKey = [...rows.values()].some(
        (row) => row.bucket === input.bucket && row.object_key === input.objectKey,
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
        bucket: input.bucket,
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
        updated_at: now,
        deleted_at: null,
      };

      rows.set(row.id, row);

      return copy(row);
    },

    async findFileById(id: string): Promise<FileRow | null> {
      const row = rows.get(id);

      return row && live(row) ? copy(row) : null;
    },

    async markFileReady(id: string, values: ReadyValues): Promise<FileRow | null> {
      const row = rows.get(id);

      if (!row || !live(row)) {
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

      return copy(row);
    },

    /** Unlike the rest, the SQL statement carries no `deleted_at` check. */
    async markFileFailed(id: string): Promise<void> {
      const row = rows.get(id);

      if (!row) {
        return;
      }

      row.status = "failed";
      row.updated_at = clock.now();
    },

    async countActiveMultipart(): Promise<number> {
      return [...rows.values()].filter(
        (row) => row.status === "pending" && row.upload_id !== null && live(row),
      ).length;
    },

    async claimExpiredMultipart(id: string, ttlHours: number): Promise<string | null> {
      const row = rows.get(id);

      if (
        !row ||
        !live(row) ||
        row.status !== "pending" ||
        row.upload_id === null ||
        !expired(row, ttlHours)
      ) {
        return null;
      }

      // Read before write: the answer is the id being taken out of circulation.
      const claimed = row.upload_id;

      row.status = "failed";
      row.upload_id = null;
      row.updated_at = clock.now();

      return claimed;
    },

    async softDeleteFile(id: string): Promise<FileRow | null> {
      const row = rows.get(id);

      if (!row || !live(row)) {
        return null;
      }

      row.deleted_at = clock.now();
      row.updated_at = row.deleted_at;

      return copy(row);
    },

    async listFiles(params: ListFilesParams): Promise<{ items: FileRow[]; total: number }> {
      const matched = [...rows.values()].filter((row) => {
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
            // "" with recursive means the whole bucket, so nothing is excluded.
            directory !== "" &&
            row.directory !== directory &&
            !row.directory.startsWith(`${directory}/`)
          ) {
            return false;
          }
        }

        if (
          params.search &&
          !row.original_name.toLowerCase().includes(params.search.toLowerCase())
        ) {
          return false;
        }

        return true;
      });

      const direction = params.order === "asc" ? 1 : -1;

      matched.sort((a, b) => {
        let ordered = 0;

        if (params.sort === "created_at") {
          const ages = a.created_at.getTime() - b.created_at.getTime();

          ordered = direction * (ages === 0 ? 0 : ages < 0 ? -1 : 1);
        } else if (params.sort === "original_name") {
          ordered =
            direction * compareText(a.original_name.toLowerCase(), b.original_name.toLowerCase());
        } else {
          ordered = compareSizes(a.size_bytes, b.size_bytes, params.order);
        }

        return ordered === 0 ? compareText(a.id, b.id) : ordered;
      });

      const offset = (params.page - 1) * params.limit;
      const items = matched.slice(offset, offset + params.limit).map(copy);

      // The total rides along with the page in SQL, so a page past the end
      // reports no total at all. Callers see the same number here.
      return { items, total: items.length > 0 ? matched.length : 0 };
    },

    async findKnownUploadIds(ids: string[]): Promise<Set<string>> {
      if (ids.length === 0) {
        return new Set();
      }

      const wanted = new Set(ids);

      // No `deleted_at` or status check: the sweep asks the whole table.
      return new Set(
        [...rows.values()]
          .map((row) => row.upload_id)
          .filter((uploadId): uploadId is string => uploadId !== null && wanted.has(uploadId)),
      );
    },

    async listExpiredPending(ttlHours: number): Promise<FileRow[]> {
      return [...rows.values()]
        .filter((row) => row.status === "pending" && live(row) && expired(row, ttlHours))
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
        .map(copy);
    },

    async listChildDirectories(parent: string): Promise<DirectoryDto[]> {
      const counts = new Map<string, number>();

      for (const row of rows.values()) {
        if (!live(row) || row.status !== "ready") {
          continue;
        }

        const inSubtree =
          parent === "" || row.directory === parent || row.directory.startsWith(`${parent}/`);

        if (!inSubtree || row.directory === parent || row.directory === "") {
          continue;
        }

        const rest = parent === "" ? row.directory : row.directory.slice(parent.length + 1);
        const head = rest.split("/")[0] ?? "";

        if (head === "") {
          continue;
        }

        const path = parent === "" ? head : `${parent}/${head}`;

        counts.set(path, (counts.get(path) ?? 0) + 1);
      }

      return [...counts.entries()]
        .sort(([a], [b]) => compareText(a, b))
        .map(([path, fileCount]) => ({
          path,
          name: path.split("/").pop() ?? path,
          fileCount,
        }));
    },
  };

  return {
    ...files,

    advance(hours: number): void {
      clock.advance(hours);
    },
  };
}
