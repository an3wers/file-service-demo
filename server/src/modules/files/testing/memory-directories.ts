import type { DirectoriesForCatalog } from "../domain/ports/directories.js";
import type { FileRowsForFiles } from "../domain/ports/file-rows.js";
import { MAX_DIRECTORY_BYTES } from "../domain/keys.js";

export type MemoryDirectoryTree = Map<
  string,
  { parent: string | null; name: string }
>;

export function createMemoryDirectories(
  fileRows: Pick<
    FileRowsForFiles,
    "listFiles" | "softDeleteFile" | "relocateFile"
  >,
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
    async move(path, parent, name) {
      if (!paths.has(path)) return "missing";
      if (!paths.has(parent)) return "target-missing";
      const target = parent ? `${parent}/${name}` : name;
      if (paths.has(target)) return "exists";
      const inside = (candidate: string) =>
        candidate === path || candidate.startsWith(`${path}/`);
      const remap = (candidate: string) =>
        target + candidate.slice(path.length);
      const subtree = [...paths.entries()].filter(([key]) => inside(key));
      if (
        subtree.some(
          ([key]) =>
            Buffer.byteLength(remap(key), "utf8") > MAX_DIRECTORY_BYTES,
        )
      )
        return "too-long";
      const { items } = await fileRows.listFiles({
        directory: path,
        recursive: true,
        page: 1,
        limit: Number.MAX_SAFE_INTEGER,
        sort: "created_at",
        order: "asc",
      });
      if (items.some((file) => file.kind !== "ready" && !settled(file.id)))
        return "busy";
      for (const file of items)
        if (file.kind === "ready")
          await fileRows.relocateFile(file.id, {
            directory: remap(file.directory),
          });
      for (const [key] of subtree) paths.delete(key);
      for (const [key, entry] of subtree)
        paths.set(remap(key), {
          parent: key === path ? parent : remap(entry.parent!),
          name: key === path ? name : entry.name,
        });
      return "moved";
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
