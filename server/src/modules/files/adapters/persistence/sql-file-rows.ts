import { FileNotFoundError } from "../../domain/errors.js";
import { query, type Execute } from "../../../../db/pool.js";
import type {
  FileRows,
  ReadyValues,
  InsertFileInput,
  ListFilesParams,
} from "../../domain/ports/file-rows.js";
import { toStoredFile } from "./row-mapper.js";
import type { FileRow } from "./row-mapper.js";
import type { StoredFile } from "../../domain/stored-file.js";

const SORT_COLUMNS = {
  created_at: "created_at",
  original_name: "lower(original_name)",
  size_bytes: "size_bytes",
} as const;

/** LIKE считает `%` и `_` шаблонами, хотя оба символа допустимы в именах каталогов. */
function escapeLike(value: string): string {
  return value.replaceAll(/[\\%_]/g, String.raw`\$&`);
}

export async function findFileById(
  id: string,
  execute = query,
): Promise<StoredFile | null> {
  const { rows } = await execute<FileRow>(
    "select * from files where id = $1 and deleted_at is null",
    [id],
  );

  return rows[0] ? toStoredFile(rows[0]) : null;
}

export async function markFileReady(
  id: string,
  values: ReadyValues,
  execute = query,
): Promise<StoredFile | null> {
  const { rows } = await execute<FileRow>(
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
        and not exists (
          select 1 from upload_operations o join upload_terminations t on t.operation_id = o.id
          where o.file_id = files.id
        )
      returning *`,
    [id, values.sizeBytes, values.etag, values.contentType],
  );

  return rows[0] ? toStoredFile(rows[0]) : null;
}

export async function markFileFailed(
  id: string,
  execute = query,
): Promise<void> {
  await execute(
    "update files set status = 'failed', upload_id = null, part_size = null, part_count = null, updated_at = now() where id = $1",
    [id],
  );
}

/** Слоты, занятые составными загрузками, которые ещё не завершены и не отменены. */
export async function countActiveMultipart(execute = query): Promise<number> {
  const { rows } = await execute<{ count: number }>(
    `select count(*)::int as count
       from files
      where status = 'pending' and upload_id is not null and deleted_at is null`,
  );

  return rows[0]?.count ?? 0;
}

export async function softDeleteFile(
  id: string,
  execute = query,
): Promise<StoredFile | null> {
  const { rows } = await execute<FileRow>(
    `update files
        set deleted_at = now(), updated_at = now()
      where id = $1 and deleted_at is null
      returning *`,
    [id],
  );

  return rows[0] ? toStoredFile(rows[0]) : null;
}

export async function hardDeleteFile(
  id: string,
  execute = query,
): Promise<void> {
  await execute("delete from files where id = $1", [id]);
}

export async function listFiles(
  params: ListFilesParams,
  execute = query,
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
      // Пустая строка с recursive означает весь бакет, поэтому условие не требуется.
      const exact = addParam(params.directory);
      const prefix = addParam(`${escapeLike(params.directory)}/%`);
      conditions.push(
        `(directory = ${exact} or directory like ${prefix} escape '\\')`,
      );
    }
  }

  if (params.search) {
    const pattern = addParam(`%${escapeLike(params.search)}%`);
    conditions.push(`original_name ilike ${pattern} escape '\\'`);
  }

  const limit = addParam(params.limit);
  const offset = addParam((params.page - 1) * params.limit);

  // count(*) over() возвращает итог вместе со страницей, экономя отдельный запрос.
  const { rows } = await execute<FileRow & { total_count: number }>(
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
 * Идентификаторы загрузок, которые ещё известны таблице метаданных.
 * Уборка считает сиротами загрузки, на которые не указывает ни одна строка.
 */
export async function findKnownUploadIds(
  ids: string[],
  execute = query,
): Promise<Set<string>> {
  if (ids.length === 0) {
    return new Set();
  }

  const { rows } = await execute<{ upload_id: string }>(
    "select upload_id from files where upload_id = any($1::text[])",
    [ids],
  );

  return new Set(rows.map((row) => row.upload_id));
}

export async function listExpiredPending(
  ttlHours: number,
  execute = query,
): Promise<StoredFile[]> {
  const { rows } = await execute<FileRow>(
    `select * from files
      where status = 'pending'
        and deleted_at is null
        and attempt_started_at < now() - make_interval(hours => $1)
      order by attempt_started_at asc`,
    [ttlHours],
  );

  return rows.map(toStoredFile);
}

/**
 * Те же функции представлены через узкие интерфейсы модулей. Аннотация
 * проверяет при компиляции, что реализация SQL поддерживает все требуемые
 * операции. Вызывающий код получает только нужный ему интерфейс.
 *
 * `bucket` фиксируется при создании репозитория, а не передаётся в каждом
 * вызове: столбец заполняет тот, кто сохраняет строку, а не сценарий загрузки.
 */
export function createSqlFileRows(
  bucket: string,
  execute: Execute = query,
): FileRows {
  async function insertFile(
    input: InsertFileInput,
    replace = false,
  ): Promise<StoredFile> {
    const { rows } = await execute<FileRow>(
      `insert into files (
         id, bucket, object_key, directory, original_name, extension,
         content_type, size_bytes, etag, status, upload_source,
         upload_id, part_size, part_count
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ${
         replace
           ? `on conflict (id) do update set
         status = excluded.status, upload_source = excluded.upload_source,
         size_bytes = excluded.size_bytes, etag = excluded.etag,
         upload_id = excluded.upload_id, part_size = excluded.part_size,
         part_count = excluded.part_count, updated_at = now(),
         attempt_started_at = now(), attempt_generation = gen_random_uuid()
         where files.deleted_at is null and files.status <> 'ready'`
           : ""
       }
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

    if (!rows[0])
      throw new FileNotFoundError(`File ${input.id} was deleted or completed`);
    return toStoredFile(rows[0]);
  }

  return {
    async isFileDeleted(id) {
      const { rows } = await execute<{ deleted: boolean }>(
        "select deleted_at is not null as deleted from files where id = $1",
        [id],
      );
      return rows[0]?.deleted ?? false;
    },
    insertFile,
    reserveFile: (input) => insertFile(input, true),
    findFileById: (id) => findFileById(id, execute),
    markFileReady: (id, values) => markFileReady(id, values, execute),
    markFileFailed: (id) => markFileFailed(id, execute),
    async failFileIfUnchanged(expected) {
      const { rows } = await execute<{ id: string }>(
        `update files set status = 'failed', upload_id = null, part_size = null,
            part_count = null, updated_at = now()
          where id = $1 and status = 'pending' and deleted_at is null
            and date_trunc('milliseconds', updated_at) = $2
            and upload_id is not distinct from $3
            and attempt_generation = $4
            and not exists (
              select 1 from upload_operations o join upload_terminations t on t.operation_id = o.id
              where o.file_id = files.id
            ) returning id`,
        [
          expected.id,
          expected.updatedAt,
          expected.kind === "multipart" ? expected.uploadId : null,
          expected.attemptGeneration,
        ],
      );
      return rows.length > 0;
    },
    countActiveMultipart: () => countActiveMultipart(execute),
    softDeleteFile: (id) => softDeleteFile(id, execute),
    listFiles: (params) => listFiles(params, execute),
    findKnownUploadIds: (ids) => findKnownUploadIds(ids, execute),
    listExpiredPending: (ttlHours) => listExpiredPending(ttlHours, execute),
  };
}
