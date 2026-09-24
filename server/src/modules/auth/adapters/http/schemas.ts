import { z } from "zod";

export const loginBodySchema = z.object({
  login: z.string().min(1).max(255),
  password: z.string().min(1).max(1024),
});

export const sessionResponseSchema = z
  .object({
    accessToken: z.string(),
    expiresIn: z.number().int().meta({ description: "Сколько секунд живёт токен доступа" }),
    user: z.object({ login: z.string() }),
  })
  .meta({ id: "AuthSession" });

export type SessionResponse = z.infer<typeof sessionResponseSchema>;
