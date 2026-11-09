import type {
  AuthSession,
  LoginAttempt,
  LoginResend,
  RegistrationAttempt,
  RegistrationResend,
  RegistrationResult,
  RegisterData,
  RequestPasswordResetData,
  ConfirmPasswordResetData,
  PasswordResetResult,
} from "@/api/generated";
import { sendAuthRequest, sendRequest } from "./client";
import { clearSession, startSession } from "./session";
import { knownGeneration } from "./sharedAuth";

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
export function resendLoginCode(
  attemptToken: string,
  signal?: AbortSignal,
): Promise<LoginResend> {
  return sendRequest<LoginResend>("/auth/login/resend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attemptToken }),
    signal,
  });
}
export async function verifyLogin(
  attemptToken: string,
  code: string,
  generation: number,
): Promise<void> {
  startSession(
    await sendAuthRequest<AuthSession>(
      "/auth/login/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attemptToken, code }),
      },
      (shared) => !shared.signedIn && shared.generation === generation,
    ),
  );
}

export async function verifyRegistration(
  attemptToken: string,
  code: string,
  generation: number,
): Promise<void> {
  startSession(
    await sendAuthRequest<AuthSession>(
      "/auth/registration/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attemptToken, code }),
      },
      (shared) => !shared.signedIn && shared.generation === generation,
    ),
  );
}

export async function logout(): Promise<void> {
  await sendAuthRequest<void>(
    "/auth/logout",
    { method: "POST" },
    (shared) => shared.generation === knownGeneration(),
  );
  clearSession();
}

export function register(
  input: RegisterData["body"],
  signal: AbortSignal,
): Promise<RegistrationAttempt> {
  return sendRequest<RegistrationAttempt>("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
}

export function resendRegistration(
  attemptToken: string,
  signal: AbortSignal,
): Promise<RegistrationResend> {
  return sendRequest<RegistrationResend>("/auth/registration/resend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attemptToken }),
    signal,
  });
}

export function requestPasswordReset(
  input: RequestPasswordResetData["body"],
  signal: AbortSignal,
): Promise<RegistrationResult> {
  return sendRequest<RegistrationResult>("/auth/password-reset/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
}

export function confirmPasswordReset(
  input: ConfirmPasswordResetData["body"],
  signal: AbortSignal,
): Promise<PasswordResetResult> {
  return sendRequest<PasswordResetResult>("/auth/password-reset/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
}
