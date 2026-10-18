import type {
  UploadTermination,
  UploadTerminationReason,
  UploadOperationFileRows,
  UploadOperations,
  UploadOperationRecord,
} from "../domain/ports/upload-operations.js";
import type { DirectoriesForUpload } from "../domain/ports/directories.js";

export function createMemoryUploadOperations(
  fileRows: UploadOperationFileRows & {
    setTerminationGuard?: (guard: (id: string) => boolean) => void;
  },
  directories: DirectoriesForUpload,
  { lockWaitMs = 5_000 }: { lockWaitMs?: number } = {},
): UploadOperations {
  const records = new Map<string, UploadOperationRecord>();
  const active = new Map<string, Promise<void>>();
  const terminations = new Map<string, UploadTermination>();
  fileRows.setTerminationGuard?.((fileId) =>
    [...records].some(
      ([id, record]) =>
        record.reservation.id === fileId && terminations.has(id),
    ),
  );
  async function terminate(
    id: string,
    reason: UploadTerminationReason,
    uploadId?: string,
  ) {
    const previous = terminations.get(id);
    terminations.set(id, {
      reason: reason === "failed" ? (previous?.reason ?? reason) : reason,
      uploadId: uploadId ?? previous?.uploadId ?? null,
    });
  }
  async function waitForRelease(id: string, wait: boolean): Promise<boolean> {
    const deadline = Date.now() + lockWaitMs;
    while (active.has(id)) {
      const left = deadline - Date.now();
      if (!wait || left <= 0) return false;
      let timer!: ReturnType<typeof setTimeout>;
      await Promise.race([
        active.get(id),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, left);
        }),
      ]);
      clearTimeout(timer);
    }
    return true;
  }
  return {
    async read(id) {
      return {
        record: records.get(id) ?? null,
        termination: terminations.get(id) ?? null,
      };
    },
    terminate,
    async listTerminated() {
      return [...terminations.keys()];
    },
    async findIdByFileId(fileId) {
      return (
        [...records].find(
          ([, record]) => record.reservation.id === fileId,
        )?.[0] ?? null
      );
    },
    async exclusive(id, run, { wait = false } = {}) {
      if (!(await waitForRelease(id, wait))) return { busy: true };
      let release!: () => void;
      active.set(
        id,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      try {
        const value = await run({
          fileRows,
          directories,
          async termination() {
            return terminations.get(id) ?? null;
          },
          terminate: (reason, uploadId) => terminate(id, reason, uploadId),
          async checked() {},
          async markMultipartStopped(uploadId) {
            const record = records.get(id);
            if (record)
              records.set(id, {
                ...record,
                stoppedMultipartUploadId: uploadId,
              });
          },
          async read() {
            return records.get(id) ?? null;
          },
          async save(record) {
            records.set(id, record);
          },
        });
        return { busy: false, value };
      } finally {
        active.delete(id);
        release();
      }
    },
  };
}
