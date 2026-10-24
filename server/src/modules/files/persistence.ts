import { transactionOn } from "../../db/pool.js";
import type { FilesPersistence, FilesPorts } from "./assembly.js";
import { createSqlFileRows } from "./adapters/persistence/sql-file-rows.js";
import { createSqlDirectories } from "./adapters/persistence/sql-directories.js";
import { createSqlUploadOperations } from "./adapters/persistence/sql-upload-operations.js";

export function createFilesPersistence(
  bucket: string,
  { lockWaitMs = 5_000 }: { lockWaitMs?: number } = {},
): FilesPersistence {
  const ports = (owner: string | null): FilesPorts => ({
    fileRows: createSqlFileRows(bucket, undefined, owner),
    directories: createSqlDirectories(undefined, owner),
    operations: createSqlUploadOperations({
      lockWaitMs,
      owner,
      // Все запросы под блокировкой используют её соединение: обращение к общему
      // пулу потребовало бы второго соединения и могло бы заблокировать операцию.
      sessionPorts: (execute) => ({
        fileRows: createSqlFileRows(bucket, execute, owner),
        directories: createSqlDirectories(
          execute,
          owner,
          transactionOn(execute),
        ),
      }),
    }),
  });
  return { ...ports(null), forOwner: ports };
}
