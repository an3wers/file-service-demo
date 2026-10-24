import type {
  AuthSession,
  LoginAttempt,
  RegistrationResult,
  RegisterData,
  RequestActivationData,
  ActivationResult,
} from "@/api/generated";
import { sendAuthRequest, sendRequest } from "./client";
import { clearSession, startSession } from "./session";

export function login(
  email: string,
  password: string,
  signal?: AbortSignal,
): Promise<LoginAttempt> {
  return sendRequest<LoginAttempt>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal,
  });
}
export async function verifyLogin(
  attemptToken: string,
  code: string,
  signal?: AbortSignal,
): Promise<void> {
  startSession(
    await sendAuthRequest<AuthSession>("/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attemptToken, code }),
      signal,
    }),
  );
}

export async function logout(): Promise<void> {
  clearSession();
  await sendAuthRequest<void>("/auth/logout", { method: "POST" });
}

export function register(
  input: RegisterData["body"],
  signal: AbortSignal,
): Promise<RegistrationResult> {
  return sendRequest<RegistrationResult>("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
}

export function requestActivation(
  input: RequestActivationData["body"],
  signal: AbortSignal,
): Promise<RegistrationResult> {
  return sendRequest<RegistrationResult>("/auth/activation/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
}

export function confirmActivation(
  token: string,
  signal: AbortSignal,
): Promise<ActivationResult> {
  return sendRequest<ActivationResult>("/auth/activation/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    signal,
  });
}
