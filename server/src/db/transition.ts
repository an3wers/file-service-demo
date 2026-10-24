import type pg from "pg";
import { migrationFiles } from "./migrate.js";
import { pool } from "./pool.js";

async function applicationTables(client: pg.PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `select tablename as name from pg_tables
      where schemaname = current_schema() and tablename <> 'schema_migrations'
      order by tablename`,
  );
  return rows.map((row) => row.name);
}

export async function cleanOldState(): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const tables = await applicationTables(client);
    const list = tables.map((name) => client.escapeIdentifier(name)).join(", ");
    if (tables.length) await client.query(`lock table ${list}`);
    const { rows } = await client.query<{ hasEmail: boolean }>(
      `select exists (
         select 1 from information_schema.columns
          where table_schema = current_schema() and table_name = 'users' and column_name = 'email'
       ) as "hasEmail"`,
    );
    if (
      rows[0]!.hasEmail &&
      (
        await client.query(
          "select 1 from users where email is not null limit 1",
        )
      ).rowCount
    )
      throw new Error(
        "Найдены зарегистрированные пользователи: очистка старого состояния запрещена",
      );
    if (tables.length) await client.query(`truncate ${list} restart identity`);
    await client.query("commit");
    return tables;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function checkCleanState(): Promise<{
  nonEmptyTables: string[];
  pendingMigrations: string[];
}> {
  const client = await pool.connect();
  try {
    const nonEmptyTables: string[] = [];
    for (const name of await applicationTables(client)) {
      const { rowCount } = await client.query(
        `select 1 from ${client.escapeIdentifier(name)} limit 1`,
      );
      if (rowCount) nonEmptyTables.push(name);
    }
    const { rows: history } = await client.query<{ exists: boolean }>(
      "select to_regclass('schema_migrations') is not null as exists",
    );
    const { rows } = history[0]!.exists
      ? await client.query<{ name: string }>(
          "select name from schema_migrations",
        )
      : { rows: [] };
    const applied = new Set(rows.map((row) => row.name));
    const pendingMigrations = (await migrationFiles()).filter(
      (name) => !applied.has(name),
    );
    return { nonEmptyTables, pendingMigrations };
  } finally {
    client.release();
  }
}
