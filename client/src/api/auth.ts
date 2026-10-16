import type { AuthSession } from "@/api/generated";
import { sendAuthRequest } from "./client";
import { clearSession, startSession } from "./session";

export async function login(login: string, password: string): Promise<void> {
  startSession(
    await sendAuthRequest<AuthSession>("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, password }),
    }),
  );
}

export async function logout(): Promise<void> {
  clearSession();
  await sendAuthRequest<void>("/auth/logout", { method: "POST" });
}
