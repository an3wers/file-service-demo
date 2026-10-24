import { z } from "zod";

export const loginBodySchema = z.object({
  login: z.string().min(1).max(255),
  password: z.string().min(1).max(1024),
});

export const sessionResponseSchema = z
  .object({
    accessToken: z.string(),
    expiresIn: z
      .number()
      .int()
      .meta({ description: "Сколько секунд живёт токен доступа" }),
    user: z.object({ login: z.string() }),
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
