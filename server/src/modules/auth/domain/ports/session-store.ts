import type { User } from "../user.js";
import type { MailLimit } from "./registration-store.js";

export const LOGIN_MAIL_LIMITS: readonly MailLimit[] = [
  { windowMs: 60000, maximum: 1 },
  { windowMs: 3600000, maximum: 5 },
];

export interface LoginAttempt {
  tokenHash: string;
  userId: string;
  passwordHash: string;
  codeHash: string;
  expiresAt: Date;
  codeExpiresAt: Date;
  resendAvailableAt: Date;
}

export interface StoredSession {
  tokenHash: string;
  ttlSeconds: number;
}

export type VerificationResult =
  | { status: "verified"; user: User }
  | { status: "invalid"; remainingAttempts: number }
  | { status: "expired" | "unavailable" | "format" }
  | { status: "limited"; retryAfterSeconds: number };

export interface ReplacementCode {
  codeHash: string;
  codeExpiresAt: Date;
  resendAvailableAt: Date;
}

export type ResendResult =
  | { status: "unavailable" }
  | { status: "limited"; retryAfterSeconds: number }
  | {
      status: "replaced";
      email: string;
      expiresAt: Date;
      codeExpiresAt: Date;
      resendAvailableAt: Date;
    };

export interface SessionStore {
  findByEmail(email: string, deadline: Date): Promise<User | null>;
  consume(
    key: string,
    limits: readonly MailLimit[],
    deadline: Date,
  ): Promise<number>;
  saveAttempt(
    attempt: LoginAttempt,
    mailKeys: { email: string; ip: string },
    deadline: Date,
  ): Promise<number>;
  resend(
    tokenHash: string,
    code: ReplacementCode,
    mailKey: (email: string) => string,
    ipRetrySeconds: number,
    deadline: Date,
  ): Promise<ResendResult>;
  verify(
    tokenHash: string,
    codeHash: string | null,
    session: StoredSession,
    deadline: Date,
  ): Promise<VerificationResult>;
  refresh(tokenHash: string, deadline: Date): Promise<User | null>;
  revoke(tokenHash: string, deadline: Date): Promise<void>;
}
