import type { DirectoriesForCatalog } from "../domain/ports/directories.js";
import type { FileRowsForFiles } from "../domain/ports/file-rows.js";

export type MemoryDirectoryTree = Map<
  string,
  { parent: string | null; name: string }
>;

export function createMemoryDirectories(
  fileRows: Pick<FileRowsForFiles, "listFiles" | "softDeleteFile">,
  paths: MemoryDirectoryTree = new Map([["", { parent: null, name: "" }]]),
  settled: (fileId: string) => boolean = () => false,
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
    async remove(path) {
      if (!paths.has(path)) return "missing";
      if ([...paths.values()].some((entry) => entry.parent === path))
        return "occupied";
      const { items } = await fileRows.listFiles({
        directory: path,
        recursive: false,
        page: 1,
        limit: Number.MAX_SAFE_INTEGER,
        sort: "created_at",
        order: "asc",
      });
      if (items.some((file) => !settled(file.id))) return "occupied";
      for (const file of items) await fileRows.softDeleteFile(file.id);
      paths.delete(path);
      return "removed";
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
