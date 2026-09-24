import type { NewUser, UserRows } from "../domain/ports/user-rows.js";
import type { User } from "../domain/user.js";

export interface MemoryUserRows extends UserRows {
  all(): User[];
}

export function createMemoryUserRows(): MemoryUserRows {
  const byId = new Map<string, User>();

  const findByLogin = (login: string) =>
    [...byId.values()].find((user) => user.login === login) ?? null;

  return {
    async insertIfAbsent(user: NewUser) {
      if (findByLogin(user.login) || byId.has(user.id)) {
        return;
      }

      byId.set(user.id, { ...user, tokenVersion: 0 });
    },

    async findByLogin(login) {
      const user = findByLogin(login);

      return user ? { ...user } : null;
    },

    async findById(id) {
      const user = byId.get(id);

      return user ? { ...user } : null;
    },

    async replacePasswordHash(id, expectedHash, newHash) {
      const user = byId.get(id);

      if (!user || user.passwordHash !== expectedHash) {
        return false;
      }

      byId.set(id, { ...user, passwordHash: newHash, tokenVersion: user.tokenVersion + 1 });

      return true;
    },

    all: () => [...byId.values()].map((user) => ({ ...user })),
  };
}
