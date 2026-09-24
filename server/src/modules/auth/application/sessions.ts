import { InvalidCredentialsError, SessionExpiredError } from "../domain/errors.js";
import type { PasswordHasher } from "../domain/ports/password-hasher.js";
import type { AccessClaims, Tokens } from "../domain/ports/tokens.js";
import type { UserRowsForSessions } from "../domain/ports/user-rows.js";
import type { User } from "../domain/user.js";

export interface SessionsDeps {
  users: UserRowsForSessions;
  hasher: PasswordHasher;
  tokens: Tokens;
  login: string;
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
  user: { login: string };
}

export interface SessionsModule {
  login(login: string, password: string): Promise<Session>;
  refresh(refreshToken: string | undefined): Promise<Session>;
  authenticate(accessToken: string): Promise<AccessClaims | null>;
}

export function createSessionsModule({ users, hasher, tokens, login: allowedLogin }: SessionsDeps): SessionsModule {
  async function issueSession(user: User): Promise<Session> {
    const [access, refresh] = await Promise.all([
      tokens.issueAccess(user.id),
      tokens.issueRefresh(user.id, user.tokenVersion),
    ]);

    return {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken: refresh.token,
      refreshExpiresIn: refresh.expiresIn,
      user: { login: user.login },
    };
  }

  return {
    async login(login, password) {
      const user = login === allowedLogin ? await users.findByLogin(login) : null;

      if (!user) {
        await hasher.hash(password);
        throw new InvalidCredentialsError();
      }

      if (!(await hasher.verify(password, user.passwordHash))) {
        throw new InvalidCredentialsError();
      }

      return issueSession(user);
    },

    async refresh(refreshToken) {
      const claims = refreshToken ? await tokens.verifyRefresh(refreshToken) : null;
      const user = claims ? await users.findById(claims.userId) : null;

      if (!claims || !user || user.login !== allowedLogin || user.tokenVersion !== claims.version) {
        throw new SessionExpiredError();
      }

      return issueSession(user);
    },

    authenticate: (accessToken) => tokens.verifyAccess(accessToken),
  };
}
