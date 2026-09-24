import { Router } from "express";
import type { RequestHandler, Response } from "express";
import { unauthorized } from "../../../../errors.js";
import { validateBody } from "../../../../middleware/validate.js";
import type { Session, SessionsModule } from "../../application/sessions.js";
import { SessionExpiredError } from "../../domain/errors.js";
import { REFRESH_COOKIE, readCookie, refreshCookieOptions } from "./cookie.js";
import { loginBodySchema } from "./schemas.js";
import type { SessionResponse } from "./schemas.js";

export interface AuthRouterSettings {
  cookieSecure: boolean;
}

export function createAuthRouter(sessions: SessionsModule, { cookieSecure }: AuthRouterSettings): Router {
  const router = Router();
  const cookieOptions = refreshCookieOptions(cookieSecure);

  function respond(res: Response, session: Session): void {
    res.cookie(REFRESH_COOKIE, session.refreshToken, {
      ...cookieOptions,
      maxAge: session.refreshExpiresIn * 1000,
    });

    const body: SessionResponse = {
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      user: session.user,
    };

    res.json(body);
  }

  router.post("/login", validateBody(loginBodySchema), async (req, res) => {
    respond(res, await sessions.login(req.body.login, req.body.password));
  });

  router.post("/refresh", async (req, res) => {
    try {
      respond(res, await sessions.refresh(readCookie(req.get("cookie"), REFRESH_COOKIE)));
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        res.clearCookie(REFRESH_COOKIE, cookieOptions);
      }

      throw error;
    }
  });

  router.post("/logout", (_req, res) => {
    res.clearCookie(REFRESH_COOKIE, cookieOptions);
    res.status(204).end();
  });

  return router;
}

const BEARER = /^Bearer ([^\s]+)$/i;

export function createRequireAuth(sessions: SessionsModule): RequestHandler {
  return async (req, _res, next) => {
    const token = BEARER.exec(req.get("authorization") ?? "")?.[1];
    const claims = token ? await sessions.authenticate(token) : null;

    next(claims ? undefined : unauthorized());
  };
}
