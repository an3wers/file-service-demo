import { query } from "../../../../db/pool.js";
import type { DirectoriesForCatalog } from "../../domain/ports/directories.js";

export function createSqlDirectories(): DirectoriesForCatalog {
  return {
    async exists(path) {
      const { rows } = await query<{ exists: boolean }>(
        "select exists(select 1 from directories where path = $1) as exists",
        [path],
      );
      return rows[0]!.exists;
    },
    async create(parent, name) {
      const path = parent ? `${parent}/${name}` : name;
      const { rowCount } = await query(
        "insert into directories (path, parent, name) values ($1, $2, $3) on conflict (path) do nothing",
        [path, parent, name],
      );
      return rowCount === 1;
    },
    async listChildren(parent) {
      const { rows } = await query<{
        path: string;
        name: string;
        file_count: number;
      }>(
        `select d.path, d.name, count(f.id)::int as file_count
           from directories d
           left join files f on f.deleted_at is null and f.status = 'ready'
             and (f.directory = d.path or starts_with(f.directory, d.path || '/'))
          where d.parent = $1
          group by d.path, d.name
          order by d.path collate "C"`,
        [parent],
      );
      return rows.map((row) => ({
        path: row.path,
        name: row.name,
        fileCount: row.file_count,
      }));
    },
  };
}
