import type {
  UploadOperationFileRows,
  UploadOperations,
  UploadOperationRecord,
} from "../domain/ports/upload-operations.js";

export function createMemoryUploadOperations(
  fileRows: UploadOperationFileRows,
): UploadOperations {
  const records = new Map<string, UploadOperationRecord>();
  const active = new Map<string, Promise<void>>();
  return {
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
