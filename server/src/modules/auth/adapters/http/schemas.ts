import { z } from "zod";

export const sessionResponseSchema = z
  .object({
    accessToken: z.string(),
    expiresIn: z
      .number()
      .int()
      .positive()
      .meta({ description: "Сколько секунд живёт токен доступа" }),
    user: z.object({ id: z.uuid(), name: z.string(), email: z.email() }),
  })
  .meta({ id: "AuthSession" });

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

const codePoints = (minimum: number, maximum: number) =>
  z
    .string()
    .refine(
      (value) => [...value].length >= minimum && [...value].length <= maximum,
      `Длина должна быть от ${minimum} до ${maximum} символов`,
    );

export const registrationEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));
export const registrationBodySchema = z.object({
  name: z.string().trim().pipe(codePoints(1, 100)),
  email: registrationEmailSchema,
  password: codePoints(12, 128),
});
export const activationRequestSchema = z.object({
  email: registrationEmailSchema,
});
export const activationConfirmSchema = z.object({ token: z.string() });
export const activationResponseSchema = z
  .object({ message: z.literal("Email подтверждён. Теперь можно войти") })
  .meta({ id: "ActivationResult" });
export type ActivationResponse = z.infer<typeof activationResponseSchema>;
export const registrationResponseSchema = z
  .object({
    message: z.string(),
    retryAfterSeconds: z.number().int().nonnegative(),
  })
  .meta({ id: "RegistrationResult" });

export const loginBodySchema = z.object({
  email: registrationEmailSchema,
  password: z.string().min(1).max(1024),
});
export const loginVerifySchema = z.object({
  attemptToken: z.string().min(1).max(256),
  code: z.string().regex(/^[0-9]{6}$/, "Введите шесть цифр"),
});
export const loginAttemptSchema = z
  .object({
    attemptToken: z.string(),
    attemptExpiresAt: z.iso.datetime(),
    codeExpiresAt: z.iso.datetime(),
    resendAvailableAt: z.iso.datetime(),
    deliveryStatus: z.enum(["accepted", "unconfirmed"]),
  })
  .meta({ id: "LoginAttempt" });
