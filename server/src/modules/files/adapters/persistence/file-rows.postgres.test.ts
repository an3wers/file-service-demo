import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { pool } from "../../../../db/pool.js";
import { migrate } from "../../../../db/migrate.js";
import { createPostgresOwner } from "../../testing/postgres-owner.js";
import { createSqlFileRows } from "./sql-file-rows.js";
import {
  describeFileRowsErrors,
  describeFileRowsOwnership,
  describeFileRowsPagination,
} from "../../testing/file-rows.contract.js";

let owner: string;

const schema = `file_rows_test_${randomUUID().replaceAll("-", "")}`;
let created = false;
beforeAll(async () => {
  await pool.query(`create schema ${schema}`);
  created = true;
  await pool.query(`set search_path to ${schema}`);
  pool.options.options = `-c search_path=${schema}`;
  await migrate();
  owner = await createPostgresOwner();
});
beforeEach(async () => {
  await pool.query("truncate files, upload_operations, upload_terminations");
  await pool.query(
    `insert into directories (owner_id, path, parent, name)
    values ($1, 'docs', '', 'docs'), ($1, 'docs/2026', 'docs', '2026'), ($1, 'other', '', 'other')
    on conflict (owner_id, path) do nothing`,
    [owner],
  );
});
afterAll(async () => {
  if (created) await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

describeFileRowsErrors("PostgreSQL", () =>
  createSqlFileRows("test", undefined, owner),
);

describeFileRowsPagination("PostgreSQL", () =>
  createSqlFileRows("test", undefined, owner),
);

describeFileRowsOwnership("PostgreSQL", async () => ({
  all: createSqlFileRows("test"),
  mine: createSqlFileRows("test", undefined, await createPostgresOwner()),
  theirs: createSqlFileRows("test", undefined, await createPostgresOwner()),
}));
