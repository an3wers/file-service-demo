import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { pool } from "../../../../db/pool.js";
import { migrate } from "../../../../db/migrate.js";
import { createSqlFileRows } from "./sql-file-rows.js";
import {
  describeFileRowsErrors,
  describeFileRowsPagination,
} from "../../testing/file-rows.contract.js";

const schema = `file_rows_test_${randomUUID().replaceAll("-", "")}`;
let created = false;
beforeAll(async () => {
  await pool.query(`create schema ${schema}`);
  created = true;
  await pool.query(`set search_path to ${schema}`);
  pool.options.options = `-c search_path=${schema}`;
  await migrate();
});
beforeEach(async () => {
  await pool.query("truncate files, upload_operations, upload_terminations");
  await pool.query(`insert into directories (path, parent, name)
    values ('docs', '', 'docs'), ('docs/2026', 'docs', '2026'), ('other', '', 'other')
    on conflict (path) do nothing`);
});
afterAll(async () => {
  if (created) await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

describeFileRowsErrors("PostgreSQL", () => createSqlFileRows("test"));

describeFileRowsPagination("PostgreSQL", () => createSqlFileRows("test"));
