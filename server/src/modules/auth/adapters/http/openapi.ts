import { z } from "zod";
import type { ZodOpenApiPathsObject } from "zod-openapi";
import { apiErrors, errorResponse } from "../../../../http-contract.js";
import { REFRESH_COOKIE, REFRESH_COOKIE_PATH } from "./cookie.js";
import {
  loginBodySchema,
  loginVerifySchema,
  loginAttemptSchema,
  loginResendSchema,
  loginResendResponseSchema,
  sessionResponseSchema,
  registrationBodySchema,
  registrationResponseSchema,
  activationRequestSchema,
  activationConfirmSchema,
  activationResponseSchema,
  passwordResetConfirmSchema,
  passwordResetResponseSchema,
} from "./schemas.js";

const json = <T>(schema: T) => ({ "application/json": { schema } });

const setsRefreshCookie = z.object({
  "Set-Cookie": z.string().meta({
    description: `${REFRESH_COOKIE}: токен обновления; HttpOnly, Secure вне localhost, SameSite=Strict, Path=${REFRESH_COOKIE_PATH}`,
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
  "/password-reset/request": {
    post: {
      tags: ["auth"],
      summary: "Письмо восстановления пароля",
      operationId: "requestPasswordReset",
      security: [],
      description:
        "Нейтральный ответ через общий бюджет 15 секунд для активного, неактивного и неизвестного email. Новая ссылка на 30 минут заменяет прежнюю до SMTP. Одно письмо в минуту и пять в час по email и назначению, 20 писем доступа в час с IP. Сам запрос не отзывает доступ.",
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
  "/password-reset/confirm": {
    post: {
      tags: ["auth"],
      summary: "Новый пароль по ссылке восстановления",
      operationId: "confirmPasswordReset",
      security: [],
      description:
        "Атомарно сохраняет пароль, активирует неактивного пользователя, погашает ссылки активации и восстановления, отменяет незавершённые попытки входа и отзывает сессии. Без входа и cookie. Затем одна SMTP-попытка уведомления, её сбой не отменяет изменение. Ошибки полей не расходуют ссылку. Не более 20 запросов за 15 минут с IP, включая ошибочные тела.",
      requestParams: { header: z.object({ Origin: z.string() }) },
      requestBody: {
        required: true,
        content: json(passwordResetConfirmSchema),
      },
      responses: {
        200: {
          description: "Пароль изменён",
          headers: z.object({ "Cache-Control": z.literal("no-store") }),
          content: json(passwordResetResponseSchema),
        },
        ...apiErrors({
          400: "PASSWORD_RESET_LINK_INVALID или BAD_REQUEST",
          403: "ORIGIN_NOT_ALLOWED",
          413: "PAYLOAD_TOO_LARGE",
          415: "UNSUPPORTED_MEDIA_TYPE",
          422: "VALIDATION_ERROR",
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
      summary: "Пароль и отправка кода входа",
      operationId: "login",
      security: [],
      description:
        "Создаёт независимую попытку на 15 минут и код на пять минут без сессии и cookie. Одна SMTP-попытка; accepted не гарантирует доставку, unconfirmed сохраняет возможность ввода. Первый шаг: 10 запросов за 15 минут по email, 50 с IP. Письма: одно в минуту и пять в час по email и назначению, 20 в час с IP совместно с другими письмами доступа.",
      requestParams: { header: z.object({ Origin: z.string() }) },
      requestBody: { required: true, content: json(loginBodySchema) },
      responses: {
        200: {
          description: "Попытка создана; даты UTC ISO 8601",
          headers: z.object({
            "Cache-Control": z.literal("no-store"),
            Date: z.string(),
          }),
          content: json(loginAttemptSchema),
        },
        ...apiErrors({
          400: "BAD_REQUEST",
          401: "INVALID_CREDENTIALS",
          403: "EMAIL_NOT_VERIFIED после правильного пароля или ORIGIN_NOT_ALLOWED",
          413: "PAYLOAD_TOO_LARGE",
          415: "UNSUPPORTED_MEDIA_TYPE",
          503: "SERVICE_UNAVAILABLE",
        }),
        429: {
          ...errorResponse(
            "RATE_LIMITED: details.retryAfterSeconds; без новой попытки и письма",
          ),
          headers: z.object({ "Retry-After": z.string() }),
        },
      },
    },
  },
  "/login/resend": {
    post: {
      tags: ["auth"],
      summary: "Повтор кода входа",
      operationId: "resendLoginCode",
      security: [],
      description:
        "Без пароля заменяет код действующей попытки до SMTP. Новый код живёт пять минут, но не дольше попытки; срок попытки и число неверных проверок не меняются. Одна SMTP-попытка; unconfirmed означает исход SMTP, новый код остаётся действующим. Письма общие с первым кодом: одно в минуту и пять в час по email, 20 в час с IP, включая неизвестные попытки и некорректные тела.",
      requestParams: { header: z.object({ Origin: z.string() }) },
      requestBody: { required: true, content: json(loginResendSchema) },
      responses: {
        200: {
          description: "Код заменён; даты UTC ISO 8601",
          headers: z.object({
            "Cache-Control": z.literal("no-store"),
            Date: z.string(),
          }),
          content: json(loginResendResponseSchema),
        },
        ...apiErrors({
          400: "BAD_REQUEST",
          403: "ORIGIN_NOT_ALLOWED",
          410: "LOGIN_ATTEMPT_INVALID: попытка неизвестна, завершена или истекла",
          413: "PAYLOAD_TOO_LARGE",
          415: "UNSUPPORTED_MEDIA_TYPE",
          503: "SERVICE_UNAVAILABLE",
        }),
        429: {
          ...errorResponse(
            "RATE_LIMITED: details.retryAfterSeconds; прежний код, сроки и оставшиеся проверки сохраняются",
          ),
          headers: z.object({ "Retry-After": z.string() }),
        },
      },
    },
  },
  "/login/verify": {
    post: {
      tags: ["auth"],
      summary: "Проверка кода входа",
      operationId: "verifyLogin",
      security: [],
      description:
        "Атомарно погашает попытку и создаёт одну серверную сессию. Пятая неверная проверка завершает попытку, ошибка формата не расходует пять проверок. Не более 20 проверок за 15 минут по пользователю и 100 с IP, включая неизвестные попытки и некорректные тела. После потерянного ответа cookie позволяет refresh, иначе нужен новый вход.",
      requestParams: { header: z.object({ Origin: z.string() }) },
      requestBody: { required: true, content: json(loginVerifySchema) },
      responses: {
        200: {
          description: "Сессия создана",
          headers: setsRefreshCookie,
          content: json(sessionResponseSchema),
        },
        ...apiErrors({
          400: "LOGIN_CODE_INVALID: details.remainingAttempts; LOGIN_CODE_EXPIRED или BAD_REQUEST",
          403: "ORIGIN_NOT_ALLOWED",
          410: "LOGIN_ATTEMPT_INVALID",
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
  "/refresh": {
    post: {
      tags: ["auth"],
      summary: "Продление",
      operationId: "refreshSession",
      security: [],
      description:
        "Постоянный случайный токен обновления сохраняется. Каждое успешное продление заново отсчитывает семь дней, общего календарного предела нет. Параллельные и повторные запросы разрешены, отозванные и истёкшие сессии не восстанавливаются. 401 очищает cookie, временный 503 её сохраняет.",
      requestParams: {
        cookie: refreshCookie,
        header: z.object({ Origin: z.string() }),
      },
      responses: {
        200: {
          description: "Сессия продлена",
          headers: setsRefreshCookie,
          content: json(sessionResponseSchema),
        },
        ...apiErrors({
          400: "BAD_REQUEST",
          401: "SESSION_EXPIRED",
          403: "ORIGIN_NOT_ALLOWED",
          413: "PAYLOAD_TOO_LARGE",
          415: "UNSUPPORTED_MEDIA_TYPE",
          503: "SERVICE_UNAVAILABLE",
        }),
      },
    },
  },
  "/logout": {
    post: {
      tags: ["auth"],
      summary: "Выход",
      operationId: "logout",
      security: [],
      description:
        "Отзывает текущую серверную сессию и очищает cookie. Повтор без действующей сессии успешен. Другие браузеры сохраняют сессии. Выданный JWT сохраняет доступ до своего истечения, не более 15 минут.",
      requestParams: {
        cookie: refreshCookie,
        header: z.object({ Origin: z.string() }),
      },
      responses: {
        204: {
          description: "Сессия отозвана, cookie очищена",
          headers: setsRefreshCookie,
        },
        ...apiErrors({
          400: "BAD_REQUEST",
          403: "ORIGIN_NOT_ALLOWED",
          413: "PAYLOAD_TOO_LARGE",
          415: "UNSUPPORTED_MEDIA_TYPE",
          503: "SERVICE_UNAVAILABLE",
        }),
      },
    },
  },
};
