import { z } from "zod";
import type { ZodOpenApiPathsObject } from "zod-openapi";
import { apiErrors } from "../../../../http-contract.js";
import { REFRESH_COOKIE, REFRESH_COOKIE_PATH } from "./cookie.js";
import { loginBodySchema, sessionResponseSchema } from "./schemas.js";

const json = <T>(schema: T) => ({ "application/json": { schema } });

const setsRefreshCookie = z.object({
  "Set-Cookie": z.string().meta({
    description: `${REFRESH_COOKIE}: токен обновления; HttpOnly, SameSite=Strict, Path=${REFRESH_COOKIE_PATH}`,
  }),
});

const refreshCookie = z.object({
  [REFRESH_COOKIE]: z.string().optional().meta({ description: "Токен обновления из входа или продления" }),
});

export const authPaths: ZodOpenApiPathsObject = {
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
