import type { RegistrationAttempt } from "@/api/generated";

export const ATTEMPT_KEY = "file-service-registration-attempt";

export interface StoredRegistration {
  attempt: RegistrationAttempt;
  email: string;
  generation: number;
  remainingAttempts: number | null;
  clockOffset: number;
}

const isDate = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function parse(raw: string): StoredRegistration | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value.attempt)) return null;
  const { attempt: a, email, generation, remainingAttempts, clockOffset } =
    value;
  if (
    typeof a.attemptToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(a.attemptToken) ||
    !isDate(a.attemptExpiresAt) ||
    !isDate(a.codeExpiresAt) ||
    !isDate(a.resendAvailableAt) ||
    typeof email !== "string" ||
    email.length === 0 ||
    email.length > 320 ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    typeof clockOffset !== "number" ||
    !Number.isFinite(clockOffset)
  )
    return null;
  if (
    remainingAttempts !== null &&
    (typeof remainingAttempts !== "number" ||
      !Number.isSafeInteger(remainingAttempts) ||
      remainingAttempts < 0)
  )
    return null;
  return {
    attempt: {
      message: typeof a.message === "string" ? a.message : "",
      retryAfterSeconds:
        typeof a.retryAfterSeconds === "number" &&
        Number.isFinite(a.retryAfterSeconds)
          ? a.retryAfterSeconds
          : 0,
      attemptToken: a.attemptToken,
      attemptExpiresAt: a.attemptExpiresAt,
      codeExpiresAt: a.codeExpiresAt,
      resendAvailableAt: a.resendAvailableAt,
    },
    email,
    generation,
    remainingAttempts,
    clockOffset,
  };
}

export function readStoredRegistration(): StoredRegistration | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(ATTEMPT_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const stored = parse(raw);
  if (!stored) clearStoredRegistration();
  return stored;
}

export function writeStoredRegistration(state: StoredRegistration): void {
  try {
    sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(state));
  } catch {
    // Хранилище недоступно: попытка просто не переживёт обновление.
  }
}

export function clearStoredRegistration(): void {
  try {
    sessionStorage.removeItem(ATTEMPT_KEY);
  } catch {
    // Хранилище недоступно: удалять нечего.
  }
}
