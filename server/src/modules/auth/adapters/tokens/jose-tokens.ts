import { SignJWT, jwtVerify } from "jose";
import type { Clock } from "../../domain/ports/clock.js";
import type { Tokens } from "../../domain/ports/tokens.js";

export interface JoseTokensSettings {
  accessSecret: string;
  accessTtlSeconds: number;
  clock: Clock;
}
export function createJoseTokens(settings: JoseTokensSettings): Tokens {
  const key = new TextEncoder().encode(settings.accessSecret);
  return {
    async issueAccess(userId) {
      const now = Math.floor(settings.clock.now().getTime() / 1000);
      const token = await new SignJWT({ typ: "access" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(userId)
        .setIssuedAt(now)
        .setExpirationTime(now + settings.accessTtlSeconds)
        .sign(key);
      return { token, expiresIn: settings.accessTtlSeconds };
    },
    async verifyAccess(token) {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: ["HS256"],
          currentDate: settings.clock.now(),
          requiredClaims: ["sub", "exp"],
        });
        return payload.typ === "access" && typeof payload.sub === "string"
          ? { userId: payload.sub }
          : null;
      } catch {
        return null;
      }
    },
  };
}
