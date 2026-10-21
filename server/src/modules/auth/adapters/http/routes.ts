import express, { Router } from "express";
import type { ErrorRequestHandler, RequestHandler, Response } from "express";
import { z } from "zod";
import { AppError, ERROR_CODES, unauthorized } from "../../../../errors.js";
import type { Registration } from "../../application/registration.js";
import {
  MailRateLimitedError,
  RegistrationUnavailableError,
} from "../../domain/registration-errors.js";
import { validateBody } from "../../../../middleware/validate.js";
import type { Session, SessionsModule } from "../../application/sessions.js";
import { SessionExpiredError } from "../../domain/errors.js";
import { mapAuthError } from "./error-map.js";
import { REFRESH_COOKIE, readCookie, refreshCookieOptions } from "./cookie.js";
import {
  loginBodySchema,
  registrationBodySchema,
  registrationEmailSchema,
} from "./schemas.js";
import type { SessionResponse } from "./schemas.js";

export interface AuthRouterSettings {
  cookieSecure: boolean;
  registration?: Registration;
  allowedOrigins?: string[];
}

export function createAuthRouter(
  sessions: SessionsModule,
  { cookieSecure, registration, allowedOrigins }: AuthRouterSettings,
): Router {
  const router = Router();
  const cookieOptions = refreshCookieOptions(cookieSecure);

  router.use(async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    if (
      allowedOrigins &&
      (!req.get("origin") ||
        req.get("origin") === "null" ||
        !allowedOrigins.includes(req.get("origin")!))
    ) {
      throw new AppError(
        403,
        ERROR_CODES.ORIGIN_NOT_ALLOWED,
        "Источник запроса не разрешён",
      );
    }
    if (registration && req.path === "/register" && req.method === "POST") {
      res.locals.registrationStarted = registration.now();
      res.locals.ipRetry = await registration.consumeIp(
        req.ip ?? req.socket.remoteAddress ?? "unknown",
      );
    }
    next();
  });
  router.use((req, _res, next) => {
    if (
      (Number(req.headers["content-length"]) > 0 ||
        req.headers["transfer-encoding"] !== undefined) &&
      !req.is("application/json")
    ) {
      throw new AppError(
        415,
        ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
        "Ожидается application/json",
      );
    }
    next();
  });
  router.use(express.json({ limit: "16kb", strict: false }));

  router.post("/register", async (req, res) => {
    if (!registration) throw new RegistrationUnavailableError();
    const email = registrationEmailSchema.safeParse(req.body?.email);
    const emailAdmission = email.success
      ? await registration.consumeEmail(email.data)
      : undefined;
    const retry = Math.max(
      res.locals.ipRetry ?? 0,
      emailAdmission?.retryAfterSeconds ?? 0,
    );
    if (retry > 0) throw new MailRateLimitedError(retry);
    const input = registrationBodySchema.parse(req.body);
    res
      .status(202)
      .json(
        await registration.register(
          input,
          res.locals.registrationStarted,
          emailAdmission!.requestedAt,
          typeof req.id === "string" || typeof req.id === "number"
            ? req.id
            : undefined,
        ),
      );
  });

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
      respond(
        res,
        await sessions.refresh(readCookie(req.get("cookie"), REFRESH_COOKIE)),
      );
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

  const sanitizeError: ErrorRequestHandler = (error, _req, res, next) => {
    const retry = Math.max(
      res.locals.ipRetry ?? 0,
      error instanceof MailRateLimitedError ? error.retryAfterSeconds : 0,
    );
    if (retry > 0) {
      res.set("Retry-After", String(retry));
      return next(
        new AppError(
          429,
          ERROR_CODES.RATE_LIMITED,
          "Слишком много запросов. Попробуйте позже",
          { retryAfterSeconds: retry },
        ),
      );
    }
    if (error instanceof z.ZodError)
      return next(
        new AppError(
          422,
          ERROR_CODES.VALIDATION_ERROR,
          "Проверьте поля формы",
          z.flattenError(error),
        ),
      );
    if (error?.type === "entity.parse.failed")
      return next(
        new AppError(400, ERROR_CODES.BAD_REQUEST, "Некорректный JSON"),
      );
    if (error?.type === "entity.too.large")
      return next(
        new AppError(
          413,
          ERROR_CODES.PAYLOAD_TOO_LARGE,
          "Слишком большое тело запроса",
        ),
      );
    if (error?.status === 415)
      return next(
        new AppError(
          415,
          ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
          "Неподдерживаемый формат запроса",
        ),
      );
    if (error instanceof RegistrationUnavailableError)
      return next(
        new AppError(503, ERROR_CODES.SERVICE_UNAVAILABLE, error.message),
      );
    if (error instanceof AppError && error.statusCode < 500)
      return next(
        new AppError(
          error.statusCode,
          error.code,
          error.message,
          error.details,
        ),
      );
    const mapped = mapAuthError(error);
    if (mapped)
      return next(
        new AppError(
          mapped.statusCode,
          mapped.code,
          mapped.message,
          mapped.details,
        ),
      );
    next(
      new AppError(
        500,
        ERROR_CODES.INTERNAL_SERVER_ERROR,
        "Произошла ошибка сервера",
      ),
    );
  };
  router.use(sanitizeError);

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
