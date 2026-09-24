import type { AuthSession } from "@/api/generated"
import { sendRequest } from "./client"
import { clearSession, startSession } from "./session"

export async function login(login: string, password: string): Promise<void> {
  startSession(
    await sendRequest<AuthSession>("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, password }),
    }),
  )
}

export async function logout(): Promise<void> {
  try {
    await sendRequest<void>("/auth/logout", { method: "POST" })
  } finally {
    clearSession()
  }
}
