import type { PoolClient } from "pg";
import { databaseError } from "../../../../db/errors.js";
import { pool, query, type Execute } from "../../../../db/pool.js";
import type {
  UploadOperationRecord,
  UploadOperationSession,
  UploadOperationSessionPorts,
  UploadTermination,
  UploadTerminationReason,
  UploadOperations,
} from "../../domain/ports/upload-operations.js";

const LOCK_NOT_AVAILABLE = "55P03";

interface OperationRow {
  file_id: string;
  object_key: string;
  directory: string;
  original_name: string;
  extension: string;
  content_type: string;
  size_bytes: number | null;
  stopped_multipart_upload_id: string | null;
}

interface TerminationRow {
  reason: UploadTerminationReason;
  upload_id: string | null;
}

function toRecord(row: OperationRow): UploadOperationRecord {
  return {
    reservation: {
      id: row.file_id,
      key: row.object_key,
      directory: row.directory,
      originalName: row.original_name,
      extension: row.extension,
      contentType: row.content_type,
    },
    size: row.size_bytes,
    stoppedMultipartUploadId: row.stopped_multipart_upload_id,
  };
}

function toTermination(row: TerminationRow): UploadTermination {
  return { reason: row.reason, uploadId: row.upload_id };
}

async function terminate(
  id: string,
  reason: UploadTerminationReason,
  uploadId: string | undefined,
  execute: Execute,
): Promise<void> {
  await execute(
    `insert into upload_terminations (operation_id, reason, upload_id) values ($1, $2, $3)
     on conflict (operation_id) do update set
       reason = case when excluded.reason = 'failed' then upload_terminations.reason else excluded.reason end,
       upload_id = coalesce(excluded.upload_id, upload_terminations.upload_id), checked_at = null`,
    [id, reason, uploadId ?? null],
  );
}

function openSession(
  id: string,
  execute: Execute,
  ports: UploadOperationSessionPorts,
): UploadOperationSession {
  return {
    ...ports,
    async termination() {
      const { rows } = await execute<TerminationRow>(
        "select reason, upload_id from upload_terminations where operation_id = $1",
        [id],
      );
      return rows[0] ? toTermination(rows[0]) : null;
    },
    terminate: (reason, uploadId) => terminate(id, reason, uploadId, execute),
    async markMultipartStopped(uploadId) {
      await execute(
        "update upload_operations set stopped_multipart_upload_id = $2 where id = $1",
        [id, uploadId],
      );
    },
    async checked() {
      await execute(
        "update upload_terminations set checked_at = now() where operation_id = $1",
        [id],
      );
    },
    async read() {
      const { rows } = await execute<OperationRow>(
        "select * from upload_operations where id = $1",
        [id],
      );
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async save(record) {
      await execute(
        `insert into upload_operations (id, file_id, object_key, directory, original_name, extension, content_type, size_bytes)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          record.reservation.id,
          record.reservation.key,
          record.reservation.directory,
          record.reservation.originalName,
          record.reservation.extension,
          record.reservation.contentType,
          record.size,
        ],
      );
    },
  };
}

async function acquire(
  client: PoolClient,
  execute: Execute,
  id: string,
  waitMs: number | false,
): Promise<boolean> {
  if (waitMs === false) {
    const { rows } = await execute<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 39)) as locked",
      [id],
    );
    return rows[0]!.locked;
  }
  await execute("select set_config('lock_timeout', $1, false)", [
    `${waitMs}ms`,
  ]);
  let locked = false;
  try {
    await client.query("select pg_advisory_lock(hashtextextended($1, 39))", [
      id,
    ]);
    locked = true;
  } catch (error) {
    if ((error as { code?: unknown }).code !== LOCK_NOT_AVAILABLE)
      throw databaseError(error);
  }
  await execute("reset lock_timeout");
  return locked;
}

export interface SqlUploadOperationsOptions {
  sessionPorts: (execute: Execute) => UploadOperationSessionPorts;
  lockWaitMs: number;
}

export function createSqlUploadOperations({
  sessionPorts,
  lockWaitMs,
}: SqlUploadOperationsOptions): UploadOperations {
  return {
    async read(id) {
      const { rows } = await query<
        Partial<OperationRow> & {
          reason: UploadTerminationReason | null;
          upload_id: string | null;
        }
      >(
        `select o.*, t.reason, t.upload_id from upload_operations o
          full join upload_terminations t on t.operation_id = o.id
          where coalesce(o.id, t.operation_id) = $1`,
        [id],
      );
      const row = rows[0];
      return {
        record: row?.file_id ? toRecord(row as OperationRow) : null,
        termination: row?.reason
          ? toTermination({ reason: row.reason, upload_id: row.upload_id })
          : null,
      };
    },
    terminate: (id, reason, uploadId) => terminate(id, reason, uploadId, query),
    async listTerminated() {
      const { rows } = await query<{ operation_id: string }>(
        "select operation_id from upload_terminations order by checked_at nulls first limit 100",
      );
      return rows.map((row) => row.operation_id);
    },
    async findIdByFileId(fileId) {
      const { rows } = await query<{ id: string }>(
        "select id from upload_operations where file_id = $1",
        [fileId],
      );
      return rows[0]?.id ?? null;
    },
    async exclusive(id, run, { wait = false } = {}) {
      const client = await pool.connect().catch((error: unknown) => {
        throw databaseError(error);
      });
      const execute: Execute = async (text, values = []) => {
        try {
          return await client.query(text, values);
        } catch (error) {
          throw databaseError(error);
        }
      };
      let locked = false;
      let broken: Error | undefined;
      try {
        try {
          locked = await acquire(
            client,
            execute,
            id,
            wait && lockWaitMs > 0 ? lockWaitMs : false,
          );
        } catch (error) {
          broken = error instanceof Error ? error : new Error(String(error));
          throw error;
        }
        if (!locked) return { busy: true };
        return {
          busy: false,
          value: await run(openSession(id, execute, sessionPorts(execute))),
        };
      } finally {
        if (locked) {
          try {
            await client.query(
              "select pg_advisory_unlock(hashtextextended($1, 39))",
              [id],
            );
          } catch (error) {
            broken = error instanceof Error ? error : new Error(String(error));
          }
        }
        client.release(broken);
      }
    },
  };
}
