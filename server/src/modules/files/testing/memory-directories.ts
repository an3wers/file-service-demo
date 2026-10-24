import type { DirectoriesForCatalog } from "../domain/ports/directories.js";
import type { FileRowsForFiles } from "../domain/ports/file-rows.js";

export type MemoryDirectoryTree = Map<
  string,
  { parent: string | null; name: string }
>;

export function createMemoryDirectories(
  fileRows: Pick<FileRowsForFiles, "listFiles">,
  paths: MemoryDirectoryTree = new Map([["", { parent: null, name: "" }]]),
): DirectoriesForCatalog {
  return {
    async exists(path) {
      return paths.has(path);
    },
    async create(parent, name) {
      const path = parent ? `${parent}/${name}` : name;
      if (paths.has(path)) return false;
      paths.set(path, { parent, name });
      return true;
    },
    async listChildren(parent) {
      const children = [...paths.entries()].filter(
        ([, entry]) => entry.parent === parent,
      );
      return await Promise.all(
        children
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(async ([path, entry]) => {
            const { total } = await fileRows.listFiles({
              directory: path,
              recursive: true,
              status: "ready",
              page: 1,
              limit: 1,
              sort: "created_at",
              order: "asc",
            });
            return { path, name: entry.name, fileCount: total };
          }),
      );
    },
  };
}
