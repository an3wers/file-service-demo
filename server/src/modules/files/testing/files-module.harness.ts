import {
  assembleFiles,
  type FilesModuleDependencies,
  type FilesPorts,
} from "../assembly.js";
import type { UploadOperations } from "../domain/ports/upload-operations.js";
import type { ConfirmationModule } from "../application/confirmation.js";
import { createMemoryUploadOperations } from "./memory-upload-operations.js";
import {
  createMemoryDirectories,
  type MemoryDirectoryTree,
} from "./memory-directories.js";
import { createTestClock } from "../../../testing/clock.js";
import { createMemoryObjectStore } from "../../../storage/memory-object-store.js";
import type { MemoryObjectStore } from "../../../storage/memory-object-store.js";
import { createMemoryFileRows } from "./memory-file-rows.js";
import type { MemoryFileRows } from "./memory-file-rows.js";
import type {
  CreatePresignedUploadInput,
  PresignMultipartResult,
  UploadsModule,
} from "../application/uploads.js";
import type { CatalogModule } from "../application/catalog.js";
import type { CleanupModule } from "../application/cleanup.js";
import type { UploadPolicy } from "../domain/upload-policy.js";
import type { StoredFile } from "../domain/stored-file.js";

export const MIB = 1024 * 1024;
export const HARNESS_OWNER = "00000000-0000-4000-8000-0000000000bb";
const GIB = 1024 * MIB;
const BUCKET = "test-bucket";

/** Файл размером 12 МиБ: три части по плану — 5 МиБ, 5 МиБ и 2 МиБ. */
export const THREE_PART_SIZE = 12 * MIB;

/** Срок резервирования; `advance` за его пределы делает резервирование просроченным. */
export const PENDING_TTL_HOURS = 24;

/**
 * Политика задана явно, чтобы тест мог проверить пределы на трёх частях
 * и двух загрузках без изменения окружения. Размер части соответствует
 * нижней границе протокола 5 МиБ; план строится с учётом этого ограничения.
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
  /** Сценарии загрузки и каталога объединены в фасад, доступный маршрутам. */
  files: UploadsModule & CatalogModule;
  startMultipart(
    input: CreatePresignedUploadInput & { size: number },
  ): Promise<PresignMultipartResult>;
  confirmation: ConfirmationModule;
  operations: UploadOperations;
  /** Настоящий модуль уборки с теми же хранилищем и строками метаданных. */
  cleanup: CleanupModule;
  objectStore: MemoryObjectStore;
  fileRows: MemoryFileRows;
  policy: UploadPolicy;
  /**
   * Передвигает общие часы, превращая свежее резервирование в просроченное.
   * `fileRows.advance` меняет эти же часы: это два способа управлять
   * одним временем.
   */
  advance(hours: number): void;
  /** Строка метаданных по идентификатору, как её видит маршрутизатор. */
  rowOf(id: string): Promise<StoredFile>;
  /** Число всех записанных строк, включая удалённые и неудавшиеся загрузки. */
  rowCount(): Promise<number>;
}

export function buildHarness(
  policyOverrides: Partial<UploadPolicy> = {},
  { lockWaitMs }: { lockWaitMs?: number } = {},
): Harness {
  const clock = createTestClock();
  const objectStore = createMemoryObjectStore({ clock });
  const fileRows = createMemoryFileRows({ clock, bucket: BUCKET });
  const policy = testPolicy(policyOverrides);
  const directories = createMemoryDirectories(fileRows);
  const operations = createMemoryUploadOperations(
    fileRows,
    directories,
    lockWaitMs === undefined ? {} : { lockWaitMs },
  );
  const trees = new Map<string, MemoryDirectoryTree>();
  const forOwner = (owner: string): FilesPorts => {
    const ownRows = fileRows.forOwner(owner);
    if (!trees.has(owner))
      trees.set(owner, new Map([["", { parent: null, name: "" }]]));
    const ownDirectories = createMemoryDirectories(
      ownRows,
      trees.get(owner),
      fileRows.isTerminated,
    );
    return {
      fileRows: ownRows,
      directories: ownDirectories,
      operations: operations.forOwner(owner, {
        fileRows: ownRows,
        directories: ownDirectories,
      }),
    };
  };
  const dependencies = {
    objectStore,
    fileRows,
    directories,
    operations,
    policy,
    clock,
    forOwner,
  };
  const { cleanup } = assembleFiles(dependencies);
  const { confirmation, uploads, catalog } = assembleFiles({
    ...dependencies,
    ...forOwner(HARNESS_OWNER),
  });

  return {
    dependencies,
    confirmation,
    operations,
    async startMultipart(input) {
      const started = await uploads.createPresignedUpload(input);
      if (started.strategy !== "multipart")
        throw new Error(`Expected a multipart upload, got ${started.strategy}`);
      return started;
    },
    files: { ...uploads, ...catalog },
    cleanup,
    objectStore,
    fileRows,
    policy,
    advance(hours) {
      clock.advance(hours);
    },
    async rowCount() {
      // Строка без живой загрузки не входит в число активных загрузок, поэтому
      // отсутствие вставленной строки проверяется через список строк.
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

/** Возвращает выброшенную ошибку, чтобы тест проверял её код, а не только факт сбоя. */
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
