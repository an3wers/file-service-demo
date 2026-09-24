import { createTestClock } from "../../../testing/clock.js";
import type { TestClock } from "../../../testing/clock.js";
import { createScryptHasher } from "../adapters/crypto/scrypt-hasher.js";
import { createJoseTokens } from "../adapters/tokens/jose-tokens.js";
import { createSessionsModule } from "../application/sessions.js";
import type { SessionsModule } from "../application/sessions.js";
import { syncEnvironmentUser } from "../application/environment-user.js";
import type { EnvironmentUserSync } from "../application/environment-user.js";
import type { PasswordHasher } from "../domain/ports/password-hasher.js";
import type { Tokens } from "../domain/ports/tokens.js";
import { createMemoryUserRows } from "./memory-user-rows.js";
import type { MemoryUserRows } from "./memory-user-rows.js";

export const LOGIN = "operator";
export const PASSWORD = "correct horse battery";
export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface AuthHarness {
  users: MemoryUserRows;
  hasher: PasswordHasher;
  tokens: Tokens;
  clock: TestClock;
  sessions: SessionsModule;
  sync(credentials?: { login?: string; password?: string }): Promise<EnvironmentUserSync>;
  withLogin(login: string): SessionsModule;
}

export function createAuthHarness(): AuthHarness {
  const users = createMemoryUserRows();
  const hasher = createScryptHasher({ N: 1024, r: 8, p: 1 });
  const clock = createTestClock(new Date("2026-01-01T00:00:00Z"));
  const tokens = createJoseTokens({
    accessSecret: "access-secret-0123456789abcdef0123456789",
    refreshSecret: "refresh-secret-0123456789abcdef012345678",
    accessTtlSeconds: ACCESS_TTL_SECONDS,
    refreshTtlSeconds: REFRESH_TTL_SECONDS,
    clock,
  });
  const withLogin = (login: string) => createSessionsModule({ users, hasher, tokens, login });

  return {
    users,
    hasher,
    tokens,
    clock,
    sessions: withLogin(LOGIN),
    sync: (credentials = {}) =>
      syncEnvironmentUser(
        { users, hasher },
        { login: credentials.login ?? LOGIN, password: credentials.password ?? PASSWORD },
      ),
    withLogin,
  };
}
