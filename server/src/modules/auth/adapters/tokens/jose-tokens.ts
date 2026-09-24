import { SignJWT, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import type { Clock } from "../../domain/ports/clock.js";
import type { IssuedToken, Tokens } from "../../domain/ports/tokens.js";

export interface JoseTokensSettings {
  accessSecret: string;
  refreshSecret: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  clock: Clock;
}

type TokenType = "access" | "refresh";

const ALGORITHM = "HS256";

export function createJoseTokens(settings: JoseTokensSettings): Tokens {
  const encoder = new TextEncoder();
  const keys: Record<TokenType, Uint8Array> = {
    access: encoder.encode(settings.accessSecret),
    refresh: encoder.encode(settings.refreshSecret),
  };
  const ttls: Record<TokenType, number> = {
    access: settings.accessTtlSeconds,
    refresh: settings.refreshTtlSeconds,
  };

  async function issue(type: TokenType, userId: string, claims: JWTPayload = {}): Promise<IssuedToken> {
    const now = Math.floor(settings.clock.now().getTime() / 1000);
    const token = await new SignJWT({ ...claims, typ: type })
      .setProtectedHeader({ alg: ALGORITHM })
      .setSubject(userId)
      .setIssuedAt(now)
      .setExpirationTime(now + ttls[type])
      .sign(keys[type]);

    return { token, expiresIn: ttls[type] };
  }

  async function verify(type: TokenType, token: string): Promise<JWTPayload | null> {
    try {
      const { payload } = await jwtVerify(token, keys[type], {
        algorithms: [ALGORITHM],
        currentDate: settings.clock.now(),
        requiredClaims: ["sub", "exp"],
      });

      return payload.typ === type && typeof payload.sub === "string" ? payload : null;
    } catch {
      return null;
    }
  }

  return {
    issueAccess: (userId) => issue("access", userId),

    issueRefresh: (userId, version) => issue("refresh", userId, { ver: version }),

    async verifyAccess(token) {
      const payload = await verify("access", token);

      return payload?.sub ? { userId: payload.sub } : null;
    },

    async verifyRefresh(token) {
      const payload = await verify("refresh", token);

      return payload?.sub && Number.isSafeInteger(payload.ver)
        ? { userId: payload.sub, version: payload.ver as number }
        : null;
    },
  };
}
