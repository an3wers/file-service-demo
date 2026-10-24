import { pool, query, type Execute } from "../../../../db/pool.js";
import { databaseError, violatedForeignKey } from "../../../../db/errors.js";
import { DirectoryNotFoundError } from "../../domain/errors.js";
import type { DirectoriesForCatalog } from "../../domain/ports/directories.js";

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
