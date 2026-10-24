import type { AuthSession } from "@/api/generated";
import { readPersonalOwner, writePersonalOwner } from "./sharedAuth";

export type SessionUser = AuthSession["user"];

const RENEW_AHEAD_MS = 30_000;

let accessToken: string | null = null;
let expiresAt = 0;
let user: SessionUser | null = null;
let renewal: Promise<void> | null = null;
let epoch = 0;
let controller = new AbortController();
let expiredHandler: (() => void) | null = null;
let changedHandler: (() => void) | null = null;
let switchedHandler: (() => void) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function startSession(session: AuthSession): void {
  accessToken = session.accessToken;
  expiresAt = Date.now() + session.expiresIn * 1000;
  user = session.user;
  const owner = readPersonalOwner();
  if (owner !== user.id) {
    writePersonalOwner(user.id);
    if (owner !== null) switchedHandler?.();
  }
  notify();
}

export function clearSession(): void {
  epoch += 1;
  controller.abort();
  controller = new AbortController();
  renewal = null;
  accessToken = null;
  expiresAt = 0;
  user = null;
  notify();
}

export function sessionSignal(): AbortSignal {
  return controller.signal;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getSessionUser(): SessionUser | null {
  return user;
}

export function isRenewalDue(): boolean {
  return accessToken !== null && renewalDelay() === 0;
}

export function renewalDelay(): number {
  return Math.max(0, expiresAt - Date.now() - RENEW_AHEAD_MS);
}

export function shareRenewal(
  run: () => Promise<AuthSession>,
  onRejected: (error: unknown) => void,
): Promise<void> {
  if (renewal) {
    return renewal;
  }

  const started = epoch;
  const current: Promise<void> = run()
    .then((session) => {
      if (epoch === started) {
        startSession(session);
      }
    })
    .catch((error: unknown) => {
      if (epoch === started) onRejected(error);
      throw error;
    })
    .finally(() => {
      if (renewal === current) {
        renewal = null;
      }
    });

  renewal = current;

  return current;
}

export function onSessionExpired(handler: (() => void) | null): void {
  expiredHandler = handler;
}

export function onUserSwitched(handler: (() => void) | null): void {
  switchedHandler = handler;
}

export function onSharedSessionChanged(handler: (() => void) | null): void {
  changedHandler = handler;
}

export function sharedSessionChanged(): void {
  changedHandler?.();
}

export function expireSession(): void {
  if (accessToken === null && user === null) {
    return;
  }

  clearSession();
  expiredHandler?.();
}

export function onSessionChange(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}
