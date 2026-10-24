import type { User } from "../user.js";
import type { MailLimit } from "./registration-store.js";

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
  verify(
    tokenHash: string,
    codeHash: string | null,
    session: StoredSession,
    deadline: Date,
  ): Promise<VerificationResult>;
  refresh(
    tokenHash: string,
    ttlSeconds: number,
    deadline: Date,
  ): Promise<User | null>;
  revoke(tokenHash: string, deadline: Date): Promise<void>;
}
