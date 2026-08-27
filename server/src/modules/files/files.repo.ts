import { query } from "../../db/pool.js";
import type {
  DirectoryDto,
  FileRow,
  InsertFileInput,
  ListFilesParams,
} from "./files.types.js";

const SORT_COLUMNS = {
  created_at: "created_at",
  original_name: "lower(original_name)",
  size_bytes: "size_bytes",
} as const;

/** LIKE treats `%` and `_` as wildcards; folder names legitimately contain both. */
function escapeLike(value: string): string {
  return value.replaceAll(/[\\%_]/g, String.raw`\$&`);
}

export async function insertFile(input: InsertFileInput): Promise<FileRow> {
  const { rows } = await query<FileRow>(
    `insert into files (
       id, bucket, object_key, directory, original_name, extension,
       content_type, size_bytes, etag, status, upload_source
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning *`,
    [
      input.id,
      input.bucket,
      input.objectKey,
      input.directory,
      input.originalName,
      input.extension,
      input.contentType,
      input.sizeBytes,
      input.etag,
      input.status,
      input.uploadSource,
    ],
  );

  return rows[0]!;
}

export async function findFileById(id: string): Promise<FileRow | null> {
  const { rows } = await query<FileRow>(
    "select * from files where id = $1 and deleted_at is null",
    [id],
  );

  return rows[0] ?? null;
}

export async function markFileReady(
  id: string,
  values: { sizeBytes: number | null; etag: string | null; contentType: string },
): Promise<FileRow | null> {
  const { rows } = await query<FileRow>(
    `update files
        set status = 'ready',
            size_bytes = $2,
            etag = $3,
            content_type = $4,
            updated_at = now()
      where id = $1 and deleted_at is null
      returning *`,
    [id, values.sizeBytes, values.etag, values.contentType],
  );

  return rows[0] ?? null;
}

export async function markFileFailed(id: string): Promise<void> {
  await query("update files set status = 'failed', updated_at = now() where id = $1", [
    id,
  ]);
}

export async function softDeleteFile(id: string): Promise<FileRow | null> {
  const { rows } = await query<FileRow>(
    `update files
        set deleted_at = now(), updated_at = now()
      where id = $1 and deleted_at is null
      returning *`,
    [id],
  );

  return rows[0] ?? null;
}

export async function hardDeleteFile(id: string): Promise<void> {
  await query("delete from files where id = $1", [id]);
}

export async function listFiles(
  params: ListFilesParams,
): Promise<{ items: FileRow[]; total: number }> {
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
    items: rows,
    total: rows[0]?.total_count ?? 0,
  };
}

export async function listExpiredPending(ttlHours: number): Promise<FileRow[]> {
  const { rows } = await query<FileRow>(
    `select * from files
      where status = 'pending'
        and deleted_at is null
        and created_at < now() - make_interval(hours => $1)
      order by created_at asc`,
    [ttlHours],
  );

  return rows;
}

/**
 * Immediate child folders of `parent`, derived from the stored directory paths
 * (S3 has no real folders). `fileCount` covers the whole subtree, which is what
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
