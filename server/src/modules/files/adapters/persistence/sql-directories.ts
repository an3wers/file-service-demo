import { query, type Execute } from "../../../../db/pool.js";
import type { DirectoriesForCatalog } from "../../domain/ports/directories.js";

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
      );
      return rowCount === 1;
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
