import express, { Router } from "express";
import type { ErrorRequestHandler, RequestHandler, Response } from "express";
import { z } from "zod";
import { AppError, ERROR_CODES, unauthorized } from "../../../../errors.js";
import type { Registration } from "../../application/registration.js";
import {
  MailRateLimitedError,
  RegistrationUnavailableError,
  ActivationLinkInvalidError,
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
  activationRequestSchema,
  activationConfirmSchema,
} from "./schemas.js";
import type { ActivationResponse, SessionResponse } from "./schemas.js";

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
    next();
  });
  const prepareRegistration: RequestHandler = async (req, res, next) => {
    if (registration) {
      res.locals.registrationDeadline = registration.deadline();
      res.locals.ipRetry = await registration.consumeIp(
        req.ip ?? req.socket.remoteAddress ?? "unknown",
        res.locals.registrationDeadline,
      );
    }
    next();
  };
  const parseJson = express.json({ limit: "16kb", strict: false });
  const parseBody: RequestHandler = async (req, res, next) => {
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
    if (!registration || !res.locals.registrationDeadline)
      return parseJson(req, res, next);
    await registration.withinDeadline(
      res.locals.registrationDeadline,
      () =>
        new Promise<void>((resolve, reject) => {
          parseJson(req, res, (error) => (error ? reject(error) : resolve()));
        }),
    );
    next();
  };

  const requestMail =
    (activation: boolean): RequestHandler =>
    async (req, res) => {
      if (!registration) throw new RegistrationUnavailableError();
      const email = registrationEmailSchema.safeParse(req.body?.email);
      const emailAdmission = email.success
        ? await registration.consumeEmail(
            email.data,
            res.locals.registrationDeadline,
          )
        : undefined;
      const retry = Math.max(
        res.locals.ipRetry ?? 0,
        emailAdmission?.retryAfterSeconds ?? 0,
      );
      if (retry > 0) throw new MailRateLimitedError(retry);
      const deadline = res.locals.registrationDeadline;
      const requestId =
        typeof req.id === "string" || typeof req.id === "number"
          ? req.id
          : undefined;
      const result = activation
        ? await registration.requestActivation(
            activationRequestSchema.parse(req.body).email,
            deadline,
            emailAdmission!.requestedAt,
            requestId,
          )
        : await registration.register(
            registrationBodySchema.parse(req.body),
            deadline,
            emailAdmission!.requestedAt,
            requestId,
          );
      res.status(202).json(result);
    };
  router.post("/register", prepareRegistration, parseBody, requestMail(false));
  router.post(
    "/activation/request",
    prepareRegistration,
    parseBody,
    requestMail(true),
  );
  router.post(
    "/activation/confirm",
    async (req, res, next) => {
      if (!registration) throw new RegistrationUnavailableError();
      res.locals.registrationDeadline = registration.deadline();
      res.locals.ipRetry = await registration.consumeConfirmationIp(
        req.ip ?? req.socket.remoteAddress ?? "unknown",
        res.locals.registrationDeadline,
      );
      if (res.locals.ipRetry > 0)
        throw new MailRateLimitedError(res.locals.ipRetry);
      next();
    },
    parseBody,
    async (req, res) => {
      if (!registration) throw new RegistrationUnavailableError();
      const { token } = activationConfirmSchema.parse(req.body);
      const response: ActivationResponse = await registration.confirmActivation(
        token,
        res.locals.registrationDeadline,
      );
      res.json(response);
    },
  );
  router.use(parseBody);

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

  const sanitizeError: ErrorRequestHandler = (error, req, res, next) => {
    if (error instanceof ActivationLinkInvalidError)
      return next(
        new AppError(400, ERROR_CODES.ACTIVATION_LINK_INVALID, error.message),
      );
    if (error instanceof RegistrationUnavailableError) {
      if (!req.complete) res.set("Connection", "close");
      return next(
        new AppError(503, ERROR_CODES.SERVICE_UNAVAILABLE, error.message),
      );
    }
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
