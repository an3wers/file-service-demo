import { randomUUID } from "node:crypto";
import { pool } from "../../../db/pool.js";

export async function createPostgresOwner(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into users (id, login, password_hash) values ($1, $2, 'x')",
    [id, id],
  );
  return id;
}
