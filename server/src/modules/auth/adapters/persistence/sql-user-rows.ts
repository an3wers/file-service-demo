import { query } from "../../../../db/pool.js";
import type { UserRows } from "../../domain/ports/user-rows.js";
import type { User } from "../../domain/user.js";

interface UserRow {
  id: string;
  login: string;
  password_hash: string;
  token_version: number;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    login: row.login,
    passwordHash: row.password_hash,
    tokenVersion: row.token_version,
  };
}

export function createSqlUserRows(): UserRows {
  return {
    async insertIfAbsent(user) {
      await query(
        `insert into users (id, login, password_hash)
         values ($1, $2, $3)
         on conflict (login) do nothing`,
        [user.id, user.login, user.passwordHash],
      );
    },

    async findByLogin(login) {
      const { rows } = await query<UserRow>("select * from users where login = $1", [login]);

      return rows[0] ? toUser(rows[0]) : null;
    },

    async findById(id) {
      const { rows } = await query<UserRow>("select * from users where id = $1", [id]);

      return rows[0] ? toUser(rows[0]) : null;
    },

    async replacePasswordHash(id, expectedHash, newHash) {
      const { rowCount } = await query(
        `update users
            set password_hash = $3,
                token_version = token_version + 1,
                updated_at = now()
          where id = $1 and password_hash = $2`,
        [id, expectedHash, newHash],
      );

      return rowCount === 1;
    },
  };
}
