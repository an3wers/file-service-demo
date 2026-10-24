import { z } from "zod";
import type { ZodOpenApiPathsObject } from "zod-openapi";
import { apiErrors, errorResponse } from "../../../../http-contract.js";
import { REFRESH_COOKIE, REFRESH_COOKIE_PATH } from "./cookie.js";
import {
  loginBodySchema,
  sessionResponseSchema,
  registrationBodySchema,
  registrationResponseSchema,
  activationRequestSchema,
  activationConfirmSchema,
  activationResponseSchema,
} from "./schemas.js";

const json = <T>(schema: T) => ({ "application/json": { schema } });

const setsRefreshCookie = z.object({
  "Set-Cookie": z.string().meta({
    description: `${REFRESH_COOKIE}: токен обновления; HttpOnly, SameSite=Strict, Path=${REFRESH_COOKIE_PATH}`,
  }),
});

const refreshCookie = z.object({
  [REFRESH_COOKIE]: z
    .string()
    .optional()
    .meta({ description: "Токен обновления из входа или продления" }),
});

export const authPaths: ZodOpenApiPathsObject = {
  "/activation/request": {
    post: {
      tags: ["auth"],
      summary: "Повтор письма активации",
      operationId: "requestActivation",
      security: [],
      description:
        "Нейтральный ответ через общий бюджет 15 секунд. Новая ссылка на 24 часа заменяет прежнюю до SMTP только у неактивного пользователя. Квоты общие с регистрацией.",
      requestParams: { header: z.object({ Origin: z.string() }) },
      requestBody: { required: true, content: json(activationRequestSchema) },
      responses: {
        202: {
          description: "Запрос обработан",
          headers: z.object({ "Cache-Control": z.literal("no-store") }),
          content: json(registrationResponseSchema),
        },
        ...apiErrors({
          400: "BAD_REQUEST",
          403: "ORIGIN_NOT_ALLOWED",
          413: "PAYLOAD_TOO_LARGE",
          415: "UNSUPPORTED_MEDIA_TYPE",
          503: "SERVICE_UNAVAILABLE",
        }),
        429: {
          ...errorResponse("RATE_LIMITED: details.retryAfterSeconds"),
          headers: z.object({ "Retry-After": z.string() }),
        },
      },
    },
  },
  "/activation/confirm": {
    post: {
      tags: ["auth"],
      summary: "Подтверждение email",
      operationId: "confirmActivation",
      security: [],
      description:
        "Одноразовое подтверждение кнопкой. Атомарно погашает действующую ссылку и активирует пользователя без создания или переключения сессии. Не более 20 запросов за 15 минут с IP, включая ошибочные тела.",
      requestParams: { header: z.object({ Origin: z.string() }) },
      requestBody: { required: true, content: json(activationConfirmSchema) },
      responses: {
        200: {
          description: "Email подтверждён",
          headers: z.object({ "Cache-Control": z.literal("no-store") }),
          content: json(activationResponseSchema),
        },
        ...apiErrors({
          400: "ACTIVATION_LINK_INVALID или BAD_REQUEST",
          403: "ORIGIN_NOT_ALLOWED",
          413: "PAYLOAD_TOO_LARGE",
          415: "UNSUPPORTED_MEDIA_TYPE",
          503: "SERVICE_UNAVAILABLE",
        }),
        429: {
          ...errorResponse("RATE_LIMITED: details.retryAfterSeconds"),
          headers: z.object({ "Retry-After": z.string() }),
        },
      },
    },
  },
  "/register": {
    post: {
      tags: ["auth"],
      summary: "Регистрация",
      operationId: "register",
      security: [],
      description:
        "Нейтральный результат через 15 секунд; принятие SMTP не означает доставку. Повтор не меняет имя и пароль.",
      requestParams: { header: z.object({ Origin: z.string() }) },
      requestBody: { required: true, content: json(registrationBodySchema) },
      responses: {
        202: {
          description: "Запрос обработан",
          headers: z.object({ "Cache-Control": z.literal("no-store") }),
          content: json(registrationResponseSchema),
        },
        ...apiErrors({
          400: "BAD_REQUEST",
          403: "ORIGIN_NOT_ALLOWED",
          413: "PAYLOAD_TOO_LARGE",
          415: "UNSUPPORTED_MEDIA_TYPE",
          503: "SERVICE_UNAVAILABLE",
        }),
        429: {
          ...errorResponse("RATE_LIMITED: details.retryAfterSeconds"),
          headers: z.object({ "Retry-After": z.string() }),
        },
      },
    },
  },
  "/login": {
    post: {
      tags: ["auth"],
      summary: "Вход",
      description:
        "Меняет логин и пароль пользователя из окружения на токен доступа (в теле ответа) " +
        "и токен обновления (в httpOnly-cookie).",
      operationId: "login",
      security: [],
      requestBody: { required: true, content: json(loginBodySchema) },
      responses: {
        200: {
          description: "Вход выполнен",
          headers: setsRefreshCookie,
          content: json(sessionResponseSchema),
        },
        ...apiErrors({ 401: "INVALID_CREDENTIALS: неверный логин или пароль" }),
      },
    },
  },
  "/refresh": {
    post: {
      tags: ["auth"],
      summary: "Продление",
      description:
        "Меняет токен обновления из cookie на новую пару токенов; новый токен обновления " +
        "приходит в cookie.",
      operationId: "refreshSession",
      security: [],
      requestParams: { cookie: refreshCookie },
      responses: {
        200: {
          description: "Сессия продлена",
          headers: setsRefreshCookie,
          content: json(sessionResponseSchema),
        },
        ...apiErrors({
          401: "SESSION_EXPIRED: cookie нет, токен недействителен или истёк, сессии отозваны",
        }),
      },
    },
  },
  "/logout": {
    post: {
      tags: ["auth"],
      summary: "Выход",
      description:
        "Очищает cookie токена обновления в этом браузере. Ничего не отзывает; повторный вызов " +
        "не ошибка.",
      operationId: "logout",
      security: [],
      responses: {
        204: { description: "Cookie очищена" },
      },
    },
  },
};
