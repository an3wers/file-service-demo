import { DirectoryNotFoundError } from "./errors.js";
import type { DirectoriesForUpload } from "./ports/directories.js";

export async function requireDirectory(
  directories: DirectoriesForUpload,
  path: string,
): Promise<void> {
  if (!(await directories.exists(path))) {
    throw new DirectoryNotFoundError("Каталог не найден", { path });
  }
}
