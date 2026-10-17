import type {
  UploadTermination,
  UploadTerminationReason,
  UploadOperationFileRows,
  UploadOperations,
  UploadOperationRecord,
} from "../domain/ports/upload-operations.js";

export function createMemoryUploadOperations(
  fileRows: UploadOperationFileRows & {
    setTerminationGuard?: (guard: (id: string) => boolean) => void;
  },
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
      } finally {
        active.delete(id);
        release();
      }
    },
  };
}
