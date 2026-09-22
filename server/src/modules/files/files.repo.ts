import { query } from "../../db/pool.js";
import type { FileRows, ReadyValues } from "./file-rows.js";
import type {
  DirectoryDto,
  FileRow,
  InsertFileInput,
  ListFilesParams,
} from "./files.types.js";
import { toStoredFile } from "./stored-file.js";
import type { StoredFile } from "./stored-file.js";

const SORT_COLUMNS = {
  created_at: "created_at",
  original_name: "lower(original_name)",
  size_bytes: "size_bytes",
} as const;

/** LIKE treats `%` and `_` as wildcards; folder names legitimately contain both. */
function escapeLike(value: string): string {
  return value.replaceAll(/[\\%_]/g, String.raw`\$&`);
}

export async function findFileById(id: string): Promise<StoredFile | null> {
  const { rows } = await query<FileRow>(
    "select * from files where id = $1 and deleted_at is null",
    [id],
  );

  return rows[0] ? toStoredFile(rows[0]) : null;
}

export async function markFileReady(
  id: string,
  values: ReadyValues,
): Promise<StoredFile | null> {
  const { rows } = await query<FileRow>(
    `update files
        set status = 'ready',
            size_bytes = $2,
            etag = $3,
            content_type = $4,
            upload_id = null,
            part_size = null,
            part_count = null,
            updated_at = now()
      where id = $1 and deleted_at is null
      returning *`,
    [id, values.sizeBytes, values.etag, values.contentType],
  );

  return rows[0] ? toStoredFile(rows[0]) : null;
}

export async function markFileFailed(id: string): Promise<void> {
  await query("update files set status = 'failed', updated_at = now() where id = $1", [
    id,
  ]);
}

/** Slots taken by multipart uploads that have neither completed nor been abandoned. */
export async function countActiveMultipart(): Promise<number> {
  const { rows } = await query<{ count: number }>(
    `select count(*)::int as count
       from files
      where status = 'pending' and upload_id is not null and deleted_at is null`,
  );

  return rows[0]?.count ?? 0;
}

/**
 * Takes an abandoned multipart upload out of circulation and hands back the
 * `upload_id` that has to be aborted in storage, in one statement. Claiming first is
 * what keeps the cleanup pass from cancelling an upload a client is finishing
 * right now: whoever updates the row wins, and the loser gets no rows back.
 *
 * `returning` yields the *new* values, so the old `upload_id` has to come out of
 * the subquery in `from` — reading it off `f` would return the null just written.
 */
export async function claimExpiredMultipart(
  id: string,
  ttlHours: number,
): Promise<string | null> {
  const { rows } = await query<{ upload_id: string | null }>(
    `update files f
        set status = 'failed', upload_id = null, updated_at = now()
       from (select id, upload_id from files where id = $1 for update) old
      where f.id = old.id
        and f.status = 'pending'
        and f.upload_id is not null
        and f.deleted_at is null
        and f.created_at < now() - make_interval(hours => $2)
      returning old.upload_id`,
    [id, ttlHours],
  );

  return rows[0]?.upload_id ?? null;
}

export async function softDeleteFile(id: string): Promise<StoredFile | null> {
  const { rows } = await query<FileRow>(
    `update files
        set deleted_at = now(), updated_at = now()
      where id = $1 and deleted_at is null
      returning *`,
    [id],
  );

  return rows[0] ? toStoredFile(rows[0]) : null;
}

export async function hardDeleteFile(id: string): Promise<void> {
  await query("delete from files where id = $1", [id]);
}

export async function listFiles(
  params: ListFilesParams,
): Promise<{ items: StoredFile[]; total: number }> {
  const conditions = ["deleted_at is null"];
  const values: unknown[] = [];

  const addParam = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  if (params.status) {
    conditions.push(`status = ${addParam(params.status)}`);
  }

  if (params.directory !== undefined) {
    if (!params.recursive) {
      conditions.push(`directory = ${addParam(params.directory)}`);
    } else if (params.directory !== "") {
      // "" with recursive means the whole bucket, so no condition is needed.
      const exact = addParam(params.directory);
      const prefix = addParam(`${escapeLike(params.directory)}/%`);
      conditions.push(`(directory = ${exact} or directory like ${prefix} escape '\\')`);
    }
  }

  if (params.search) {
    const pattern = addParam(`%${escapeLike(params.search)}%`);
    conditions.push(`original_name ilike ${pattern} escape '\\'`);
  }

  const limit = addParam(params.limit);
  const offset = addParam((params.page - 1) * params.limit);

  // count(*) over() rides along with the page, saving a second round trip.
  const { rows } = await query<FileRow & { total_count: number }>(
    `select *, count(*) over() as total_count
       from files
      where ${conditions.join(" and ")}
      order by ${SORT_COLUMNS[params.sort]} ${params.order === "asc" ? "asc" : "desc"}, id asc
      limit ${limit} offset ${offset}`,
    values,
  );

  return {
    items: rows.map(toStoredFile),
    total: rows[0]?.total_count ?? 0,
  };
}

/**
 * Which of these upload ids the metadata table still knows about. Used by the
 * orphan sweep, where anything missing here is an upload no row can reach.
 */
export async function findKnownUploadIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) {
    return new Set();
  }

  const { rows } = await query<{ upload_id: string }>(
    "select upload_id from files where upload_id = any($1::text[])",
    [ids],
  );

  return new Set(rows.map((row) => row.upload_id));
}

export async function listExpiredPending(ttlHours: number): Promise<StoredFile[]> {
  const { rows } = await query<FileRow>(
    `select * from files
      where status = 'pending'
        and deleted_at is null
        and created_at < now() - make_interval(hours => $1)
      order by created_at asc`,
    [ttlHours],
  );

  return rows.map(toStoredFile);
}

/**
 * Immediate child folders of `parent`, derived from the stored directory paths
 * (object storage has no real folders). `fileCount` covers the whole subtree, which is what
 * a folder listing wants to show.
 */
export async function listChildDirectories(parent: string): Promise<DirectoryDto[]> {
  const { rows } = await query<{ path: string; file_count: number }>(
    `with children as (
       select case
                when $1 = '' then split_part(directory, '/', 1)
                else $1 || '/' || split_part(right(directory, -(length($1) + 1)), '/', 1)
              end as path
         from files
        where deleted_at is null
          and status = 'ready'
          and ($1 = '' or directory = $1 or directory like $2 escape '\\')
          and directory <> $1
          and directory <> ''
     )
     select path, count(*)::int as file_count
       from children
      where path <> ''
      group by path
      order by path`,
    [parent, `${escapeLike(parent)}/%`],
  );

  return rows.map((row) => ({
    path: row.path,
    name: row.path.split("/").pop() ?? row.path,
    fileCount: row.file_count,
  }));
}

/**
 * The same functions seen through the narrow interfaces the modules declare.
 * The annotation is the whole point of it: it is what makes the SQL side prove,
 * at compile time, that it still answers for every operation those modules ask
 * for. Callers take the one interface they need, never this bundle.
 *
 * `bucket` is fixed here rather than threaded through every call: this is the
 * row writer the domain talks about when it says the column is filled by
 * "whoever writes the row", not by the scenario that asked for the insert.
 */
export function createSqlFileRows(bucket: string): FileRows {
  async function insertFile(input: InsertFileInput): Promise<StoredFile> {
    const { rows } = await query<FileRow>(
      `insert into files (
         id, bucket, object_key, directory, original_name, extension,
         content_type, size_bytes, etag, status, upload_source,
         upload_id, part_size, part_count
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       returning *`,
      [
        input.id,
        bucket,
        input.objectKey,
        input.directory,
        input.originalName,
        input.extension,
        input.contentType,
        input.sizeBytes,
        input.etag,
        input.status,
        input.uploadSource,
        input.uploadId ?? null,
        input.partSize ?? null,
        input.partCount ?? null,
      ],
    );

    return toStoredFile(rows[0]!);
  }

  return {
    insertFile,
    findFileById,
    markFileReady,
    markFileFailed,
    countActiveMultipart,
    claimExpiredMultipart,
    softDeleteFile,
    listFiles,
    findKnownUploadIds,
    listExpiredPending,
    listChildDirectories,
  };
}
