import type {
  UploadTermination,
  UploadTerminationReason,
  UploadOperationFileRows,
  UploadOperations,
  UploadOperationRecord,
} from "../domain/ports/upload-operations.js";

export function createMemoryUploadOperations(
  fileRows: UploadOperationFileRows,
): UploadOperations {
  const records = new Map<string, UploadOperationRecord>();
  const active = new Map<string, Promise<void>>();
  const terminations = new Map<string, UploadTermination>();
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
  return {
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
    async exclusive(id, run, wait = false) {
      while (active.has(id)) {
        if (!wait) return null;
        await active.get(id);
      }
      let release!: () => void;
      active.set(
        id,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      try {
        return await run({
          fileRows,
          async termination() {
            return terminations.get(id) ?? null;
          },
          terminate: (reason, uploadId) => terminate(id, reason, uploadId),
          async checked() {},
          async read() {
            return records.get(id) ?? null;
          },
          async save(record) {
            records.set(id, record);
          },
        });
      } finally {
        active.delete(id);
        release();
      }
    },
  };
}
