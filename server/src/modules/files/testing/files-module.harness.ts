import { assembleFiles, type FilesModuleDependencies } from "../assembly.js";
import type { UploadOperations } from "../domain/ports/upload-operations.js";
import type { ConfirmationModule } from "../application/confirmation.js";
import { createMemoryUploadOperations } from "./memory-upload-operations.js";
import { createMemoryDirectories } from "./memory-directories.js";
import { createTestClock } from "../../../testing/clock.js";
import { createMemoryObjectStore } from "../../../storage/memory-object-store.js";
import type { MemoryObjectStore } from "../../../storage/memory-object-store.js";
import { createMemoryFileRows } from "./memory-file-rows.js";
import type { MemoryFileRows } from "./memory-file-rows.js";
import type { UploadsModule } from "../application/uploads.js";
import type { CatalogModule } from "../application/catalog.js";
import type { MultipartModule } from "../application/multipart.js";
import type { CleanupModule } from "../application/cleanup.js";
import type { UploadPolicy } from "../domain/upload-policy.js";
import type { StoredFile } from "../domain/stored-file.js";

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
    planLimits: {
      partSize: 5 * MIB,
      minPartSize: 5 * MIB,
      maxPartSize: 5 * 1024 * MIB,
      maxParts: 10_000,
      maxObjectSize: 200 * GIB,
    },
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
  dependencies: FilesModuleDependencies;
  /** The uploads and catalog scenarios merged behind one facade, as routes see it. */
  files: UploadsModule & CatalogModule;
  /** The same multipart module the uploads module drives. */
  multipart: MultipartModule;
  confirmation: ConfirmationModule;
  operations: UploadOperations;
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

export function buildHarness(
  policyOverrides: Partial<UploadPolicy> = {},
): Harness {
  const clock = createTestClock();
  const objectStore = createMemoryObjectStore({ clock });
  const fileRows = createMemoryFileRows({ clock, bucket: BUCKET });
  const policy = testPolicy(policyOverrides);
  const directories = createMemoryDirectories(fileRows);
  const operations = createMemoryUploadOperations(fileRows);
  const dependencies = {
    objectStore,
    fileRows,
    directories,
    operations,
    policy,
    clock,
  };
  const { multipart, confirmation, uploads, catalog, cleanup } =
    assembleFiles(dependencies);

  return {
    dependencies,
    confirmation,
    operations,
    multipart,
    files: { ...uploads, ...catalog },
    cleanup,
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

export async function buildHarnessWithDirectories(
  policyOverrides: Partial<UploadPolicy> = {},
): Promise<Harness> {
  const harness = buildHarness(policyOverrides);
  await harness.files.createDirectory({ name: "docs" });
  return harness;
}
