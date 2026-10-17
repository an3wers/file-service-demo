import type { QueryResultRow } from "pg";
import { createSqlFileRows } from "./sql-file-rows.js";
import { databaseError } from "../../../../db/errors.js";
import { pool, query } from "../../../../db/pool.js";
import type {
  UploadTerminationReason,
  UploadOperations,
} from "../../domain/ports/upload-operations.js";

async function terminate(
  id: string,
  reason: UploadTerminationReason,
  uploadId?: string,
  execute = query,
): Promise<void> {
  await execute(
    `insert into upload_terminations (operation_id, reason, upload_id) values ($1, $2, $3)
     on conflict (operation_id) do update set
       reason = case when excluded.reason = 'failed' then upload_terminations.reason else excluded.reason end,
       upload_id = coalesce(excluded.upload_id, upload_terminations.upload_id), checked_at = null`,
    [id, reason, uploadId ?? null],
  );
}

export function createSqlUploadOperations(bucket: string): UploadOperations {
  return {
    async read(id) {
      const { rows } = await query<{
        file_id: string | null;
        object_key: string;
        directory: string;
        original_name: string;
        extension: string;
        content_type: string;
        size_bytes: number | null;
        reason: UploadTerminationReason | null;
        upload_id: string | null;
      }>(
        `select o.*, t.reason, t.upload_id from upload_operations o
          full join upload_terminations t on t.operation_id = o.id
          where coalesce(o.id, t.operation_id) = $1`,
        [id],
      );
      const row = rows[0];
      return {
        record: row?.file_id
          ? {
              reservation: {
                id: row.file_id,
                key: row.object_key,
                directory: row.directory,
                originalName: row.original_name,
                extension: row.extension,
                contentType: row.content_type,
              },
              size: row.size_bytes,
            }
          : null,
        termination: row?.reason
          ? { reason: row.reason, uploadId: row.upload_id }
          : null,
      };
    },
    terminate,
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
    async exclusive(id, run, wait = false) {
      const client = await pool.connect().catch((error: unknown) => {
        throw databaseError(error);
      });
      let locked = false;
      let releaseError: Error | undefined;
      try {
        const result = await client.query<{ locked: boolean }>(
          wait
            ? "select pg_advisory_lock(hashtextextended($1, 39)), true as locked"
            : "select pg_try_advisory_lock(hashtextextended($1, 39)) as locked",
          [id],
        );
        locked = result.rows[0]!.locked;
        if (!locked) return null;
        async function execute<T extends QueryResultRow>(
          text: string,
          values: unknown[] = [],
        ) {
          return await client.query<T>(text, values);
        }
        return await run({
          fileRows: createSqlFileRows(bucket, execute),
          async termination() {
            const { rows } = await execute<{
              reason: UploadTerminationReason;
              upload_id: string | null;
            }>(
              "select reason, upload_id from upload_terminations where operation_id = $1",
              [id],
            );
            return rows[0]
              ? { reason: rows[0].reason, uploadId: rows[0].upload_id }
              : null;
          },
          terminate: (reason, uploadId) =>
            terminate(id, reason, uploadId, execute),
          async checked() {
            await execute(
              "update upload_terminations set checked_at = now() where operation_id = $1",
              [id],
            );
          },
          async read() {
            const { rows } = await client.query<{
              file_id: string;
              object_key: string;
              directory: string;
              original_name: string;
              extension: string;
              content_type: string;
              size_bytes: number | null;
            }>("select * from upload_operations where id = $1", [id]);
            const row = rows[0];
            return row
              ? {
                  reservation: {
                    id: row.file_id,
                    key: row.object_key,
                    directory: row.directory,
                    originalName: row.original_name,
                    extension: row.extension,
                    contentType: row.content_type,
                  },
                  size: row.size_bytes,
                }
              : null;
          },
          async save(record) {
            await client.query(
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
        });
      } catch (error) {
        throw databaseError(error);
      } finally {
        if (locked) {
          try {
            await client.query(
              "select pg_advisory_unlock(hashtextextended($1, 39))",
              [id],
            );
          } catch (error) {
            releaseError =
              error instanceof Error ? error : new Error(String(error));
          }
        }
        client.release(releaseError);
      }
    },
  };
}
