import { violatedForeignKey } from "../../../../db/errors.js";
import { DirectoryNotFoundError } from "../../domain/errors.js";

export function settledFile(alias: string): string {
  return `exists (
  select 1 from upload_operations o
    join upload_terminations t on t.operation_id = o.id
   where o.file_id = ${alias}.id and o.owner_id is not distinct from ${alias}.owner_id
)`;
}

export function directoryMissingOn(constraint: string, path: string) {
  return (error: unknown): never => {
    if (violatedForeignKey(error) === constraint)
      throw new DirectoryNotFoundError("Каталог не найден", { path });
    throw error;
  };
}
