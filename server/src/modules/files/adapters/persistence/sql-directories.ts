import {
  query,
  transaction as poolTransaction,
  type Execute,
  type Transaction,
} from "../../../../db/pool.js";
import { hasSqlState, violatedForeignKey } from "../../../../db/errors.js";
import type { DirectoriesForCatalog } from "../../domain/ports/directories.js";
import { MAX_DIRECTORY_BYTES } from "../../domain/keys.js";
import { directoryMissingOn, settledFile } from "./shared-sql.js";

const SETTLED_FILE = settledFile("f");

export function createSqlDirectories(
  execute: Execute = query,
  owner: string | null = null,
  transaction: Transaction = poolTransaction,
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
      ).catch(directoryMissingOn("directories_parent_fk", parent));
      return rowCount === 1;
    },
    async remove(path) {
      return transaction(async (run) => {
        const { rowCount: found } = await run(
          "select 1 from directories where owner_id is not distinct from $1 and path = $2 for update",
          [owner, path],
        );
        if (!found) return "missing" as const;
        const { rows } = await run<{ occupied: boolean }>(
          `select exists (
             select 1 from directories where owner_id is not distinct from $1 and parent = $2
           ) or exists (
             select 1 from files f
              where f.live_owner_id = $1 and f.live_directory = $2
                and not ${SETTLED_FILE}
           ) as occupied`,
          [owner, path],
        );
        if (rows[0]!.occupied) return "occupied" as const;
        await run(
          `update files f set deleted_at = now(), updated_at = now()
            where f.live_owner_id = $1 and f.live_directory = $2
              and ${SETTLED_FILE}`,
          [owner, path],
        );
        await run(
          "delete from directories where owner_id is not distinct from $1 and path = $2",
          [owner, path],
        );
        return "removed" as const;
      }).catch((error: unknown) => {
        if (violatedForeignKey(error)) return "occupied" as const;
        throw error;
      });
    },
    async move(path, parent, name) {
      const target = parent ? `${parent}/${name}` : name;
      return transaction(async (run) => {
        const { rows: subtree } = await run<{ path: string }>(
          `select path from directories
            where owner_id is not distinct from $1
              and (path = $2 or starts_with(path, $2 || '/'))
            order by path for update`,
          [owner, path],
        );
        if (!subtree.some((row) => row.path === path))
          return "missing" as const;
        const { rowCount: parentFound } = await run(
          "select 1 from directories where owner_id is not distinct from $1 and path = $2 for key share",
          [owner, parent],
        );
        if (!parentFound) return "target-missing" as const;
        const { rowCount: taken } = await run(
          "select 1 from directories where owner_id is not distinct from $1 and path = $2",
          [owner, target],
        );
        if (taken) return "exists" as const;
        if (
          subtree.some(
            (row) =>
              Buffer.byteLength(target + row.path.slice(path.length)) >
              MAX_DIRECTORY_BYTES,
          )
        )
          return "too-long" as const;
        const { rows } = await run<{ busy: boolean }>(
          `select exists (
             select 1 from files f
              where f.live_owner_id = $1
                and (f.live_directory = $2 or starts_with(f.live_directory, $2 || '/'))
                and f.status <> 'ready' and not ${SETTLED_FILE}
           ) as busy`,
          [owner, path],
        );
        if (rows[0]!.busy) return "busy" as const;
        const remap = (column: string) =>
          `$3 || substr(${column}, char_length($2) + 1)`;
        const subtreeOf = (column: string) =>
          `(${column} = $2 or starts_with(${column}, $2 || '/'))`;
        await run(
          `insert into directories (owner_id, path, parent, name)
           select owner_id, ${remap("path")},
                  case when path = $2 then $4 else ${remap("parent")} end,
                  case when path = $2 then $5 else name end
             from directories
            where owner_id is not distinct from $1 and ${subtreeOf("path")}`,
          [owner, path, target, parent, name],
        );
        await run(
          `update files set directory = ${remap("directory")}, updated_at = now()
            where owner_id is not distinct from $1 and ${subtreeOf("directory")}`,
          [owner, path, target],
        );
        await run(
          `update upload_operations set directory = ${remap("directory")}
            where owner_id is not distinct from $1 and ${subtreeOf("directory")}`,
          [owner, path, target],
        );
        await run(
          `delete from directories
            where owner_id is not distinct from $1 and ${subtreeOf("path")}`,
          [owner, path],
        );
        return "moved" as const;
      }).catch((error: unknown) => {
        if (hasSqlState(error, "23505")) return "exists" as const;
        if (violatedForeignKey(error) || hasSqlState(error, "40P01"))
          return "busy" as const;
        throw error;
      });
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
