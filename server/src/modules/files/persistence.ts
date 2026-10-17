import type { FilesPersistence } from "./assembly.js";
import { createSqlFileRows } from "./adapters/persistence/sql-file-rows.js";
import { createSqlDirectories } from "./adapters/persistence/sql-directories.js";
import { createSqlUploadOperations } from "./adapters/persistence/sql-upload-operations.js";

export function createFilesPersistence(bucket: string): FilesPersistence {
  return {
    fileRows: createSqlFileRows(bucket),
    directories: createSqlDirectories(),
    operations: createSqlUploadOperations(bucket),
  };
}
