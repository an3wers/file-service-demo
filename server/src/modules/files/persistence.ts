import type { FilesPersistence } from "./assembly.js";
import { createSqlFileRows } from "./adapters/persistence/sql-file-rows.js";
import { createSqlDirectories } from "./adapters/persistence/sql-directories.js";
import { createSqlUploadOperations } from "./adapters/persistence/sql-upload-operations.js";

export function createFilesPersistence(
  bucket: string,
  { lockWaitMs = 5_000 }: { lockWaitMs?: number } = {},
): FilesPersistence {
  return {
    fileRows: createSqlFileRows(bucket),
    directories: createSqlDirectories(),
    operations: createSqlUploadOperations({
      lockWaitMs,
      // Все запросы под блокировкой используют её соединение: обращение к общему
      // пулу потребовало бы второго соединения и могло бы заблокировать операцию.
      sessionPorts: (execute) => ({
        fileRows: createSqlFileRows(bucket, execute),
        directories: createSqlDirectories(execute),
      }),
    }),
  };
}
