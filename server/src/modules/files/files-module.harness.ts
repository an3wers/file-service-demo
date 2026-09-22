import { createTestClock } from "../../testing/clock.js";
import { createMemoryObjectStore } from "../../storage/memory-object-store.js";
import type { MemoryObjectStore } from "../../storage/memory-object-store.js";
import { createMemoryFileRows } from "./memory-file-rows.js";
import type { MemoryFileRows } from "./memory-file-rows.js";
import { createFilesModule } from "./files.service.js";
import type { FilesModule } from "./files.service.js";
import { createMultipartModule } from "./multipart.service.js";
import type { MultipartModule } from "./multipart.service.js";
import { createCleanupModule } from "./cleanup.service.js";
import type { CleanupModule } from "./cleanup.service.js";
import type { UploadPolicy } from "./upload-policy.js";
import type { StoredFile } from "./stored-file.js";

/**
 * The files module as a test drives it: the real modules, assembled the way
 * `composition.ts` assembles them, on the two second implementations.
 *
 * The multipart module is the real one and the files module drives it through
 * the same interface; only the storage seam and the rows seam are substituted.
 * That is what lets a test assert an observable result — what came back to the
 * caller, and what state the metadata row and storage ended in — rather than a
 * list of calls.
 *
 * The cleanup module is assembled here too, on the same two second
 * implementations and the same clock, because what it settles is what the other
 * two modules left behind: a reservation nobody confirmed, an upload nobody
 * finished. `advance` is the only way past a TTL, and it moves the one clock
 * the rows, storage and the cleanup's age filter all read.
 */

export const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const BUCKET = "test-bucket";

/** A 12 MiB file: three parts by the plan — 5 MiB, 5 MiB and 2 MiB. */
export const THREE_PART_SIZE = 12 * MIB;

/** How long a reservation stays untouched here; `advance` past it to expire one. */
export const PENDING_TTL_HOURS = 24;

/**
 * The policy is stated here rather than read from the environment: a test picks
 * limits small enough to be seen in three parts and two uploads. Part size hits
 * the protocol floor of 5 MiB, so the plan is built on that rather than on
 * something smaller.
 */
function testPolicy(overrides: Partial<UploadPolicy> = {}): UploadPolicy {
  return {
    multipartThresholdBytes: 5 * MIB,
    planLimits: { partSize: 5 * MIB, maxParts: 10_000, maxObjectSize: 200 * GIB },
    partUrlBatch: 2,
    maxConcurrency: 3,
    maxActiveUploads: 2,
    presignUploadTtlSeconds: 900,
    presignDownloadTtlSeconds: 900,
    presignPartTtlSeconds: 900,
    pendingTtlHours: PENDING_TTL_HOURS,
    ...overrides,
  };
}

export interface Harness {
  /** The real files module: confirmation, links and deletion live in it. */
  files: FilesModule;
  /** The same multipart module the files module drives. */
  multipart: MultipartModule;
  /** The real cleanup module, on the same storage and rows. */
  cleanup: CleanupModule;
  objectStore: MemoryObjectStore;
  fileRows: MemoryFileRows;
  policy: UploadPolicy;
  /**
   * Moves the shared clock forward: how a fresh reservation becomes expired.
   * It is the same clock `fileRows.advance` turns — one of the two doors, not
   * two clocks.
   */
  advance(hours: number): void;
  /** The metadata row as a router would see it: by id. */
  rowOf(id: string): Promise<StoredFile>;
  /** How many rows were written at all, deleted and failed ones included. */
  rowCount(): Promise<number>;
}

export function buildHarness(policyOverrides: Partial<UploadPolicy> = {}): Harness {
  const clock = createTestClock();
  const objectStore = createMemoryObjectStore({ clock });
  const fileRows = createMemoryFileRows({ clock });
  const policy = testPolicy(policyOverrides);
  const multipart = createMultipartModule({ objectStore, fileRows, policy, bucket: BUCKET });

  return {
    multipart,
    files: createFilesModule({ objectStore, fileRows, policy, multipart, bucket: BUCKET }),
    cleanup: createCleanupModule({ objectStore, fileRows, policy, now: clock.now }),
    objectStore,
    fileRows,
    policy,
    advance(hours) {
      clock.advance(hours);
    },
    async rowCount() {
      // A row with no live upload is invisible to the active-upload count, so
      // "no row was written" is checked by listing rather than by that count.
      const { items } = await fileRows.listFiles({
        recursive: true,
        directory: "",
        page: 1,
        limit: 100,
        sort: "created_at",
        order: "desc",
      });

      return items.length;
    },
    async rowOf(id) {
      const row = await fileRows.findFileById(id);

      if (!row) {
        throw new Error(`Expected a metadata row for ${id}`);
      }

      return row;
    },
  };
}

/** Hands back the thrown error, so a test can check its code and not just the throw. */
export async function thrownBy(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }

  throw new Error("Expected the call to reject, but it resolved");
}
