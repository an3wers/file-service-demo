import express, { Router } from "express";
import type { ErrorRequestHandler, RequestHandler, Response } from "express";
import { z } from "zod";
import { AppError, ERROR_CODES, unauthorized } from "../../../../errors.js";
import type { Registration } from "../../application/registration.js";
import {
  MailRateLimitedError,
  RegistrationUnavailableError,
  ActivationLinkInvalidError,
  PasswordResetLinkInvalidError,
} from "../../domain/registration-errors.js";
import type { Session, SessionsModule } from "../../application/sessions.js";
import { SessionExpiredError } from "../../domain/errors.js";
import { mapAuthError } from "./error-map.js";
import { REFRESH_COOKIE, readCookie, refreshCookieOptions } from "./cookie.js";
import {
  loginBodySchema,
  loginVerifySchema,
  loginResendSchema,
  registrationBodySchema,
  registrationEmailSchema,
  activationRequestSchema,
  activationConfirmSchema,
  passwordResetConfirmSchema,
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
    res.set("Date", sessions.now().toUTCString());
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
    if (!res.locals.registrationDeadline && !res.locals.authDeadline)
      return parseJson(req, res, next);
    const withinDeadline = res.locals.registrationDeadline
      ? registration!.withinDeadline
      : sessions.withinDeadline;
    await withinDeadline(
      res.locals.registrationDeadline ?? res.locals.authDeadline,
      () =>
        new Promise<void>((resolve, reject) => {
          parseJson(req, res, (error) => (error ? reject(error) : resolve()));
        }),
    );
    next();
  };

  const requestMail =
    (kind: "register" | "activation" | "password-reset"): RequestHandler =>
    async (req, res) => {
      if (!registration) throw new RegistrationUnavailableError();
      const email = registrationEmailSchema.safeParse(req.body?.email);
      const emailAdmission = email.success
        ? await registration.consumeEmail(
            email.data,
            res.locals.registrationDeadline,
            kind === "password-reset" ? kind : "activation",
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
      const result =
        kind === "register"
          ? await registration.register(
              registrationBodySchema.parse(req.body),
              deadline,
              emailAdmission!.requestedAt,
              requestId,
            )
          : await registration[
              kind === "activation"
                ? "requestActivation"
                : "requestPasswordReset"
            ](
              activationRequestSchema.parse(req.body).email,
              deadline,
              emailAdmission!.requestedAt,
              requestId,
            );
      res.status(202).json(result);
    };
  router.post(
    "/register",
    prepareRegistration,
    parseBody,
    requestMail("register"),
  );
  router.post(
    "/activation/request",
    prepareRegistration,
    parseBody,
    requestMail("activation"),
  );
  router.post(
    "/password-reset/request",
    prepareRegistration,
    parseBody,
    requestMail("password-reset"),
  );
  const prepareConfirmation =
    (purpose: "activation" | "password-reset"): RequestHandler =>
    async (req, res, next) => {
      if (!registration) throw new RegistrationUnavailableError();
      res.locals.registrationDeadline = registration.deadline();
      res.locals.ipRetry = await registration.consumeConfirmationIp(
        req.ip ?? req.socket.remoteAddress ?? "unknown",
        res.locals.registrationDeadline,
        purpose,
      );
      if (res.locals.ipRetry > 0)
        throw new MailRateLimitedError(res.locals.ipRetry);
      next();
    };
  router.post(
    "/password-reset/confirm",
    prepareConfirmation("password-reset"),
    parseBody,
    async (req, res) => {
      if (!registration) throw new RegistrationUnavailableError();
      const { token, password } = passwordResetConfirmSchema.parse(req.body);
      res.json(
        await registration.confirmPasswordReset(
          token,
          password,
          res.locals.registrationDeadline,
          typeof req.id === "string" || typeof req.id === "number"
            ? req.id
            : undefined,
        ),
      );
    },
  );
  router.post(
    "/activation/confirm",
    prepareConfirmation("activation"),
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
  const prepareSession =
    (consumeIp: (ip: string, until: Date) => Promise<void>): RequestHandler =>
    async (req, res, next) => {
      const until = sessions.deadline();
      res.locals.authDeadline = until;
      await consumeIp(req.ip ?? req.socket.remoteAddress ?? "unknown", until);
      next();
    };

  function respond(res: Response, session: Session): void {
    res.set("Date", sessions.now().toUTCString());
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

  router.post(
    "/login",
    prepareSession(sessions.consumeLoginIp),
    parseBody,
    async (req, res) => {
      const { email, password } = loginBodySchema.parse(req.body);
      const attempt = await sessions.login(
        email,
        password,
        req.ip ?? req.socket.remoteAddress ?? "unknown",
        res.locals.authDeadline,
      );
      res.set("Date", sessions.now().toUTCString());
      res.json(attempt);
    },
  );
  router.post(
    "/login/resend",
    async (req, res, next) => {
      res.locals.authDeadline = sessions.deadline();
      res.locals.ipRetry = await sessions.consumeMailIp(
        req.ip ?? req.socket.remoteAddress ?? "unknown",
        res.locals.authDeadline,
      );
      next();
    },
    parseBody,
    async (req, res) => {
      const { attemptToken } = loginResendSchema.parse(req.body);
      const result = await sessions.resend(
        attemptToken,
        res.locals.ipRetry,
        res.locals.authDeadline,
      );
      res.set("Date", sessions.now().toUTCString());
      res.json(result);
    },
  );
  router.post(
    "/login/verify",
    prepareSession(sessions.consumeVerifyIp),
    parseBody,
    async (req, res) => {
      const parsed = loginVerifySchema.safeParse(req.body);
      if (!parsed.success) {
        const token = loginVerifySchema
          .pick({ attemptToken: true })
          .safeParse(req.body);
        if (token.success)
          await sessions.verify(
            token.data.attemptToken,
            null,
            res.locals.authDeadline,
          );
        throw parsed.error;
      }
      const { attemptToken, code } = parsed.data;
      respond(
        res,
        await sessions.verify(attemptToken, code, res.locals.authDeadline),
      );
    },
  );

  router.post("/refresh", parseBody, async (req, res) => {
    try {
      respond(
        res,
        await sessions.refresh(
          readCookie(req.get("cookie"), REFRESH_COOKIE),
          sessions.deadline(),
        ),
      );
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        res.clearCookie(REFRESH_COOKIE, cookieOptions);
      }

      throw error;
    }
  });

  router.post("/logout", parseBody, async (req, res) => {
    await sessions.logout(
      readCookie(req.get("cookie"), REFRESH_COOKIE),
      sessions.deadline(),
    );
    res.clearCookie(REFRESH_COOKIE, cookieOptions);
    res.status(204).end();
  });

  const sanitizeError: ErrorRequestHandler = (error, req, res, next) => {
    res.set("Date", sessions.now().toUTCString());
    if (error instanceof ActivationLinkInvalidError)
      return next(
        new AppError(400, ERROR_CODES.ACTIVATION_LINK_INVALID, error.message),
      );
    if (error instanceof PasswordResetLinkInvalidError)
      return next(
        new AppError(
          400,
          ERROR_CODES.PASSWORD_RESET_LINK_INVALID,
          error.message,
        ),
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
  return async (req, res, next) => {
    const token = BEARER.exec(req.get("authorization") ?? "")?.[1];
    const claims = token ? await sessions.authenticate(token) : null;

    if (claims) res.locals.userId = claims.userId;
    next(claims ? undefined : unauthorized());
  };
}
