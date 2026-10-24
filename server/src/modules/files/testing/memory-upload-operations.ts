import type {
  UploadOperationSessionPorts,
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
): MemoryUploadOperations {
  const records = new Map<string, UploadOperationRecord>();
  const owners = new Map<string, string | null>();
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
  function view(
    owner: string | null,
    ports: UploadOperationSessionPorts,
  ): UploadOperations {
    const visible = (id: string) =>
      owner === null || !owners.has(id) || owners.get(id) === owner;
    const recordOf = (id: string) => (visible(id) && records.get(id)) || null;
    return {
      async read(id) {
        if (!visible(id)) return { record: null, termination: null };
        return {
          record: recordOf(id),
          termination: terminations.get(id) ?? null,
        };
      },
      terminate,
      async listTerminated() {
        return [...terminations.keys()].filter(
          (id) => !owners.has(id) || owners.get(id) !== null,
        );
      },
      async findIdByFileId(fileId) {
        return (
          [...records].find(
            ([id, record]) => record.reservation.id === fileId && visible(id),
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
            ...ports,
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
              return recordOf(id);
            },
            async save(record) {
              records.set(id, record);
              owners.set(id, owner);
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
  return {
    ...view(null, { fileRows, directories }),
    forOwner: view,
  };
}

export interface MemoryUploadOperations extends UploadOperations {
  forOwner(owner: string, ports: UploadOperationSessionPorts): UploadOperations;
}
