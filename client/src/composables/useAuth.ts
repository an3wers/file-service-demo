import { computed, ref, shallowRef } from "vue";
import * as authApi from "@/api/auth";
import { isApiError, renewSession } from "@/api/client";
import {
  clearSession,
  getSessionUser,
  onSessionChange,
  onSessionExpired,
  onSharedSessionChanged,
  onUserSwitched,
} from "@/api/session";
import type { SessionUser } from "@/api/session";
import {
  acceptGeneration,
  knownGeneration,
  readSharedAuth,
  writeSharedAuth,
} from "@/api/sharedAuth";

export type AuthStatus = "booting" | "ready" | "failed";

export type SignOutReason = "logout" | "expired" | "elsewhere";

export type AuthMessage =
  { type: "login" } | { type: "logout" } | { type: "expired" };

export interface AuthChannel {
  postMessage(message: AuthMessage): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<AuthMessage>) => void,
  ): void;
}

const AUTH_CHANNEL_NAME = "file-service-auth";

export function createAuth(channel: AuthChannel | null) {
  const status = ref<AuthStatus>("booting");
  const user = shallowRef<SessionUser | null>(getSessionUser());
  const bootError = shallowRef<unknown>(null);
  const signedIn = computed(() => user.value !== null);
  const signOutHandlers = new Set<(reason: SignOutReason) => void>();
  const signInHandlers = new Set<() => void>();
  const switchHandlers = new Set<() => void>();
  let booting: Promise<void> | null = null;

  function announceSignOut(reason: SignOutReason): void {
    for (const handler of signOutHandlers) {
      handler(reason);
    }
  }

  onSessionChange(() => {
    user.value = getSessionUser();
  });

  onUserSwitched(() => {
    for (const handler of switchHandlers) {
      handler();
    }
  });

  function sync(reason: SignOutReason): void {
    const shared = readSharedAuth();

    if (shared.generation === knownGeneration()) {
      return;
    }

    acceptGeneration(shared.generation);

    if (getSessionUser()) {
      clearSession();
      announceSignOut(reason);
    }

    if (shared.signedIn) {
      for (const handler of signInHandlers) {
        handler();
      }
    }
  }

  function isSessionChanged(error: unknown): boolean {
    return isApiError(error) && error.code === "SESSION_CHANGED";
  }

  onSessionExpired(() => {
    const shared = readSharedAuth();
    if (shared.signedIn && shared.generation === knownGeneration()) {
      writeSharedAuth({ generation: shared.generation + 1, signedIn: false });
    }
    announceSignOut("expired");
    channel?.postMessage({ type: "expired" });
  });

  onSharedSessionChanged(() => sync("elsewhere"));

  channel?.addEventListener("message", ({ data }) =>
    sync(data.type === "expired" ? "expired" : "elsewhere"),
  );

  async function boot(): Promise<void> {
    status.value = "booting";
    bootError.value = null;

    try {
      await renewSession();
    } catch (error) {
      if (!isApiError(error) || error.status !== 401) {
        bootError.value = error;
        status.value = "failed";
        return;
      }
      channel?.postMessage({ type: "expired" });
    }

    status.value = "ready";
  }

  function ensureSession(): Promise<void> {
    if (status.value === "failed") {
      booting = null;
    }

    booting ??= boot();

    return booting;
  }

  async function verifyLogin(
    attemptToken: string,
    code: string,
    generation: number,
  ): Promise<void> {
    try {
      await authApi.verifyLogin(attemptToken, code, generation);
    } catch (error) {
      if (isSessionChanged(error)) sync("elsewhere");
      throw error;
    }
    status.value = "ready";
    channel?.postMessage({ type: "login" });
  }

  async function logout(): Promise<void> {
    try {
      await authApi.logout();
    } catch (error) {
      if (!isSessionChanged(error)) throw error;
      sync("elsewhere");
      return;
    }
    announceSignOut("logout");
    channel?.postMessage({ type: "logout" });
  }

  async function renew(): Promise<boolean> {
    try {
      await renewSession();
    } catch {
      return false;
    }

    status.value = "ready";

    return true;
  }

  function onSignOut(handler: (reason: SignOutReason) => void): () => void {
    signOutHandlers.add(handler);

    return () => signOutHandlers.delete(handler);
  }

  function onUserSwitch(handler: () => void): () => void {
    switchHandlers.add(handler);

    return () => switchHandlers.delete(handler);
  }

  function onSignInElsewhere(handler: () => void): () => void {
    signInHandlers.add(handler);

    return () => signInHandlers.delete(handler);
  }

  return {
    status,
    user,
    bootError,
    signedIn,
    ensureSession,
    verifyLogin,
    logout,
    renew,
    onSignOut,
    onSignInElsewhere,
    onUserSwitch,
  };
}

export type Auth = ReturnType<typeof createAuth>;

let instance: Auth | null = null;

export function useAuth(): Auth {
  instance ??= createAuth(
    typeof BroadcastChannel === "undefined"
      ? null
      : (new BroadcastChannel(AUTH_CHANNEL_NAME) as AuthChannel),
  );

  return instance;
}
