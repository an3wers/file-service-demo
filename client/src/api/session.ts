import type { AuthSession } from "@/api/generated"

export type SessionUser = AuthSession["user"]

const RENEW_AHEAD_MS = 30_000

let accessToken: string | null = null
let expiresAt = 0
let user: SessionUser | null = null
let renewal: Promise<void> | null = null
let epoch = 0
let expiredHandler: (() => void) | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function startSession(session: AuthSession): void {
  accessToken = session.accessToken
  expiresAt = Date.now() + session.expiresIn * 1000
  user = session.user
  notify()
}

export function clearSession(): void {
  epoch += 1
  renewal = null
  accessToken = null
  expiresAt = 0
  user = null
  notify()
}

export function getAccessToken(): string | null {
  return accessToken
}

export function getSessionUser(): SessionUser | null {
  return user
}

export function isRenewalDue(): boolean {
  return accessToken !== null && expiresAt - Date.now() < RENEW_AHEAD_MS
}

export function shareRenewal(
  run: () => Promise<AuthSession>,
): Promise<void> {
  if (renewal) {
    return renewal
  }

  const started = epoch
  const current: Promise<void> = run()
    .then((session) => {
      if (epoch === started) {
        startSession(session)
      }
    })
    .finally(() => {
      if (renewal === current) {
        renewal = null
      }
    })

  renewal = current

  return current
}

export function onSessionExpired(handler: (() => void) | null): void {
  expiredHandler = handler
}

export function expireSession(): void {
  if (accessToken === null && user === null) {
    return
  }

  clearSession()
  expiredHandler?.()
}

export function onSessionChange(listener: () => void): () => void {
  listeners.add(listener)

  return () => listeners.delete(listener)
}
