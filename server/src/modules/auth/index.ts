import type { RequestHandler, Router } from "express";
import { createScryptHasher } from "./adapters/crypto/scrypt-hasher.js";
import { createAuthRouter, createRequireAuth } from "./adapters/http/routes.js";
import { createSqlUserRows } from "./adapters/persistence/sql-user-rows.js";
import { createJoseTokens } from "./adapters/tokens/jose-tokens.js";
import { syncEnvironmentUser } from "./application/environment-user.js";
import type { EnvironmentUserSync } from "./application/environment-user.js";
import { createSessionsModule } from "./application/sessions.js";
import { systemClock } from "./domain/ports/clock.js";

export type { EnvironmentUserSync } from "./application/environment-user.js";
export { mapAuthError } from "./adapters/http/error-map.js";
export { authPaths } from "./adapters/http/openapi.js";

export interface AuthSettings {
  login: string;
  password: string;
  accessSecret: string;
  refreshSecret: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  cookieSecure: boolean;
}

export interface AuthHttpAssembly {
  authRouter: Router;
  requireAuth: RequestHandler;
}

export function createAuthHttp(settings: AuthSettings): AuthHttpAssembly {
  const sessions = createSessionsModule({
    users: createSqlUserRows(),
    hasher: createScryptHasher(),
    tokens: createJoseTokens({ ...settings, clock: systemClock }),
    login: settings.login,
  });

  return {
    authRouter: createAuthRouter(sessions, { cookieSecure: settings.cookieSecure }),
    requireAuth: createRequireAuth(sessions),
  };
}

export function syncAuthUser(settings: Pick<AuthSettings, "login" | "password">): Promise<EnvironmentUserSync> {
  return syncEnvironmentUser(
    { users: createSqlUserRows(), hasher: createScryptHasher() },
    { login: settings.login, password: settings.password },
  );
}
