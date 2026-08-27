import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";
import { logger } from "../logger.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query(`
      create table if not exists schema_migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const { rows } = await client.query<{ name: string }>(
      "select name from schema_migrations",
    );
    const applied = new Set(rows.map((row) => row.name));

    const files = (await readdir(migrationsDir))
      .filter((name) => name.endsWith(".sql"))
      .sort();

    for (const name of files) {
      if (applied.has(name)) {
        logger.debug({ migration: name }, "Migration already applied; skipping");
        continue;
      }

      const sql = await readFile(join(migrationsDir, name), "utf8");

      await client.query("begin");

      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [name]);
        await client.query("commit");
        logger.info({ migration: name }, "Migration applied");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

// Run standalone via `npm run db:migrate`.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await migrate();
    logger.info("Migrations up to date");
    await pool.end();
  } catch (error) {
    logger.error({ err: error }, "Migration failed");
    await pool.end();
    process.exit(1);
  }
}
