import { computed, ref, shallowRef } from "vue"
import * as authApi from "@/api/auth"
import { isApiError, renewSession } from "@/api/client"
import {
  clearSession,
  getSessionUser,
  onSessionChange,
  onSessionExpired,
} from "@/api/session"
import type { SessionUser } from "@/api/session"

export type AuthStatus = "booting" | "ready" | "failed"

export type SignOutReason = "logout" | "expired" | "elsewhere"

export type AuthMessage = { type: "login" } | { type: "logout" }

export interface AuthChannel {
  postMessage(message: AuthMessage): void
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<AuthMessage>) => void,
  ): void
}

const AUTH_CHANNEL_NAME = "file-service-auth"

export function createAuth(channel: AuthChannel | null) {
  const status = ref<AuthStatus>("booting")
  const user = shallowRef<SessionUser | null>(getSessionUser())
  const bootError = shallowRef<unknown>(null)
  const signedIn = computed(() => user.value !== null)
  const signOutHandlers = new Set<(reason: SignOutReason) => void>()
  const signInHandlers = new Set<() => void>()
  let booting: Promise<void> | null = null

  function announceSignOut(reason: SignOutReason): void {
    for (const handler of signOutHandlers) {
      handler(reason)
    }
  }

  onSessionChange(() => {
    user.value = getSessionUser()
  })

  onSessionExpired(() => announceSignOut("expired"))

  channel?.addEventListener("message", ({ data }) => {
    if (data.type === "logout") {
      if (!getSessionUser()) {
        return
      }

      clearSession()
      announceSignOut("elsewhere")
      return
    }

    for (const handler of signInHandlers) {
      handler()
    }
  })

  async function boot(): Promise<void> {
    status.value = "booting"
    bootError.value = null

    try {
      await renewSession()
    } catch (error) {
      if (!isApiError(error) || error.status !== 401) {
        bootError.value = error
        status.value = "failed"
        return
      }
    }

    status.value = "ready"
  }

  function ensureSession(): Promise<void> {
    if (status.value === "failed") {
      booting = null
    }

    booting ??= boot()

    return booting
  }

  async function login(login: string, password: string): Promise<void> {
    await authApi.login(login, password)
    status.value = "ready"
    channel?.postMessage({ type: "login" })
  }

  async function logout(): Promise<void> {
    await authApi.logout().catch(() => {})
    channel?.postMessage({ type: "logout" })
    announceSignOut("logout")
  }

  async function renew(): Promise<boolean> {
    try {
      await renewSession()
    } catch {
      return false
    }

    status.value = "ready"

    return true
  }

  function onSignOut(handler: (reason: SignOutReason) => void): () => void {
    signOutHandlers.add(handler)

    return () => signOutHandlers.delete(handler)
  }

  function onSignInElsewhere(handler: () => void): () => void {
    signInHandlers.add(handler)

    return () => signInHandlers.delete(handler)
  }

  return {
    status,
    user,
    bootError,
    signedIn,
    ensureSession,
    login,
    logout,
    renew,
    onSignOut,
    onSignInElsewhere,
  }
}

export type Auth = ReturnType<typeof createAuth>

let instance: Auth | null = null

export function useAuth(): Auth {
  instance ??= createAuth(
    typeof BroadcastChannel === "undefined"
      ? null
      : (new BroadcastChannel(AUTH_CHANNEL_NAME) as AuthChannel),
  )

  return instance
}
