import { pool, query, type Execute } from "../../../../db/pool.js";
import { databaseError, violatedForeignKey } from "../../../../db/errors.js";
import { DirectoryNotFoundError } from "../../domain/errors.js";
import type { DirectoriesForCatalog } from "../../domain/ports/directories.js";
import { MAX_DIRECTORY_BYTES } from "../../domain/keys.js";

const SETTLED_FILE = `exists (
  select 1 from upload_operations o
    join upload_terminations t on t.operation_id = o.id
   where o.file_id = f.id and o.owner_id is not distinct from f.owner_id
)`;

export function createSqlDirectories(
  execute: Execute = query,
  owner: string | null = null,
): DirectoriesForCatalog {
  return {
    async exists(path) {
      const { rows } = await execute<{ exists: boolean }>(
        "select exists(select 1 from directories where owner_id is not distinct from $2 and path = $1) as exists",
        [path, owner],
      );
      return rows[0]!.exists;
    },
    async create(parent, name) {
      const path = parent ? `${parent}/${name}` : name;
      const { rowCount } = await execute(
        "insert into directories (owner_id, path, parent, name) values ($4, $1, $2, $3) on conflict (owner_id, path) do nothing",
        [path, parent, name, owner],
      ).catch((error: unknown) => {
        if (violatedForeignKey(error) === "directories_parent_fk")
          throw new DirectoryNotFoundError("Директория не найдена", {
            path: parent,
          });
        throw error;
      });
      return rowCount === 1;
    },
    async remove(path) {
      const client = await pool.connect().catch((error: unknown) => {
        throw databaseError(error);
      });
      try {
        await client.query("begin");
        const { rowCount: found } = await client.query(
          "select 1 from directories where owner_id is not distinct from $1 and path = $2 for update",
          [owner, path],
        );
        if (!found) {
          await client.query("rollback");
          return "missing";
        }
        const { rows } = await client.query<{ occupied: boolean }>(
          `select exists (
             select 1 from directories where owner_id is not distinct from $1 and parent = $2
           ) or exists (
             select 1 from files f
              where f.live_owner_id = $1 and f.live_directory = $2
                and not ${SETTLED_FILE}
           ) as occupied`,
          [owner, path],
        );
        if (rows[0]!.occupied) {
          await client.query("rollback");
          return "occupied";
        }
        await client.query(
          `update files f set deleted_at = now(), updated_at = now()
            where f.live_owner_id = $1 and f.live_directory = $2
              and ${SETTLED_FILE}`,
          [owner, path],
        );
        await client.query(
          "delete from directories where owner_id is not distinct from $1 and path = $2",
          [owner, path],
        );
        await client.query("commit");
        return "removed";
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        if (violatedForeignKey(error)) return "occupied";
        throw databaseError(error);
      } finally {
        client.release();
      }
    },
    async move(path, parent, name) {
      const target = parent ? `${parent}/${name}` : name;
      const client = await pool.connect().catch((error: unknown) => {
        throw databaseError(error);
      });
      try {
        await client.query("begin");
        const { rows: subtree } = await client.query<{ path: string }>(
          `select path from directories
            where owner_id is not distinct from $1
              and (path = $2 or starts_with(path, $2 || '/'))
            order by path for update`,
          [owner, path],
        );
        const outcome = await (async () => {
          if (!subtree.some((row) => row.path === path)) return "missing";
          const { rowCount: parentFound } = await client.query(
            "select 1 from directories where owner_id is not distinct from $1 and path = $2 for key share",
            [owner, parent],
          );
          if (!parentFound) return "target-missing";
          const { rowCount: taken } = await client.query(
            "select 1 from directories where owner_id is not distinct from $1 and path = $2",
            [owner, target],
          );
          if (taken) return "exists";
          if (
            subtree.some(
              (row) =>
                Buffer.byteLength(target + row.path.slice(path.length)) >
                MAX_DIRECTORY_BYTES,
            )
          )
            return "too-long";
          const { rows } = await client.query<{ busy: boolean }>(
            `select exists (
               select 1 from files f
                where f.live_owner_id = $1
                  and (f.live_directory = $2 or starts_with(f.live_directory, $2 || '/'))
                  and f.status <> 'ready' and not ${SETTLED_FILE}
             ) as busy`,
            [owner, path],
          );
          if (rows[0]!.busy) return "busy";
          return null;
        })();
        if (outcome) {
          await client.query("rollback");
          return outcome;
        }
        const remap = (column: string) =>
          `$3 || substr(${column}, char_length($2) + 1)`;
        const subtreeOf = (column: string) =>
          `(${column} = $2 or starts_with(${column}, $2 || '/'))`;
        await client.query(
          `insert into directories (owner_id, path, parent, name)
           select owner_id, ${remap("path")},
                  case when path = $2 then $4 else ${remap("parent")} end,
                  case when path = $2 then $5 else name end
             from directories
            where owner_id is not distinct from $1 and ${subtreeOf("path")}`,
          [owner, path, target, parent, name],
        );
        await client.query(
          `update files set directory = ${remap("directory")}, updated_at = now()
            where owner_id is not distinct from $1 and ${subtreeOf("directory")}`,
          [owner, path, target],
        );
        await client.query(
          `update upload_operations set directory = ${remap("directory")}
            where owner_id is not distinct from $1 and ${subtreeOf("directory")}`,
          [owner, path, target],
        );
        await client.query(
          `delete from directories
            where owner_id is not distinct from $1 and ${subtreeOf("path")}`,
          [owner, path],
        );
        await client.query("commit");
        return "moved";
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        const code = (error as { code?: unknown } | null)?.code;
        if (code === "23505") return "exists";
        if (code === "23503" || code === "40P01") return "busy";
        throw databaseError(error);
      } finally {
        client.release();
      }
    },
    async listChildren(parent) {
      const { rows } = await execute<{
        path: string;
        name: string;
        file_count: number;
      }>(
        `select d.path, d.name, count(f.id)::int as file_count
           from directories d
           left join files f on f.deleted_at is null and f.status = 'ready'
             and f.owner_id is not distinct from d.owner_id
             and (f.directory = d.path or starts_with(f.directory, d.path || '/'))
          where d.owner_id is not distinct from $2 and d.parent = $1
          group by d.path, d.name
          order by d.path collate "C"`,
        [parent, owner],
      );
      return rows.map((row) => ({
        path: row.path,
        name: row.name,
        fileCount: row.file_count,
      }));
    },
  };
}
