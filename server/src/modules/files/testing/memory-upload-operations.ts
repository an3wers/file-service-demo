import type {
  UploadOperationFileRows,
  UploadOperations,
  UploadOperationRecord,
} from "../domain/ports/upload-operations.js";

export function createMemoryUploadOperations(
  fileRows: UploadOperationFileRows,
): UploadOperations {
  const records = new Map<string, UploadOperationRecord>();
  const active = new Set<string>();
  return {
    async exclusive(id, run) {
      if (active.has(id)) return null;
      active.add(id);
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
      }
    },
  };
}
