import { randomUUID } from "node:crypto";
import type { PasswordHasher } from "../domain/ports/password-hasher.js";
import type { UserRowsForEnvironment } from "../domain/ports/user-rows.js";

export interface EnvironmentUserDeps {
  users: UserRowsForEnvironment;
  hasher: PasswordHasher;
}

export interface EnvironmentCredentials {
  login: string;
  password: string;
}

export interface EnvironmentUserSync {
  created: boolean;
  sessionsRevoked: boolean;
}

export async function syncEnvironmentUser(
  { users, hasher }: EnvironmentUserDeps,
  { login, password }: EnvironmentCredentials,
): Promise<EnvironmentUserSync> {
  const id = randomUUID();

  await users.insertIfAbsent({ id, login, passwordHash: await hasher.hash(password) });

  const user = await users.findByLogin(login);

  if (!user) {
    throw new Error(`The row for user "${login}" vanished right after it was ensured`);
  }

  const created = user.id === id;

  if (await hasher.verify(password, user.passwordHash)) {
    return { created, sessionsRevoked: false };
  }

  const sessionsRevoked = await users.replacePasswordHash(
    user.id,
    user.passwordHash,
    await hasher.hash(password),
  );

  return { created, sessionsRevoked };
}
