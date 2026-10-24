import type { RequestHandler, Router } from "express";
import { setTimeout as wait } from "node:timers/promises";
import { createScryptHasher } from "./adapters/crypto/scrypt-hasher.js";
import { createAuthRouter, createRequireAuth } from "./adapters/http/routes.js";
import { createJoseTokens } from "./adapters/tokens/jose-tokens.js";
import { createSessionsModule } from "./application/sessions.js";
import type { Notification } from "../notification/index.js";
import { createRegistration } from "./application/registration.js";
import { createSqlRegistrationStore } from "./adapters/persistence/sql-registration-store.js";
import { createSqlSessionStore } from "./adapters/persistence/sql-session-store.js";
import { systemClock } from "./domain/ports/clock.js";

export { mapAuthError } from "./adapters/http/error-map.js";
export { authPaths } from "./adapters/http/openapi.js";
export interface AuthSettings {
  accessSecret: string;
  codeSecret: string;
  accessTtlSeconds: number;
  cookieSecure: boolean;
}
export interface AuthHttpAssembly {
  authRouter: Router;
  requireAuth: RequestHandler;
}
export interface RegistrationSettings {
  publicUrl: string;
  deadlineMs: number;
  allowedOrigins: string[];
  notification: Notification;
}
export function createAuthHttp(
  settings: AuthSettings,
  registrationSettings?: RegistrationSettings,
): AuthHttpAssembly {
  const notification = registrationSettings?.notification ?? {
    sendEmail: async () => {
      throw new Error("Mail unavailable");
    },
  };
  const hasher = createScryptHasher();
  const sessions = createSessionsModule({
    store: createSqlSessionStore(),
    hasher,
    tokens: createJoseTokens({ ...settings, clock: systemClock }),
    clock: systemClock,
    notification,
    codeSecret: settings.codeSecret,
  });
  return {
    authRouter: createAuthRouter(sessions, {
      cookieSecure: settings.cookieSecure,
      ...(registrationSettings
        ? {
            allowedOrigins: registrationSettings.allowedOrigins,
            registration: createRegistration({
              ...registrationSettings,
              store: createSqlRegistrationStore(),
              hasher,
              clock: systemClock,
              wait: async (ms) => {
                await wait(ms);
              },
            }),
          }
        : {}),
    }),
    requireAuth: createRequireAuth(sessions),
  };
}
export function createMailQuotaMaintenance(): () => Promise<number> {
  const store = createSqlRegistrationStore();
  return () => store.removeExpiredEvents(systemClock.now());
}
