export interface RegistrationRecord {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  attempt: RegistrationAttemptRecord;
}

export interface RegistrationAttemptRecord {
  tokenHash: string;
  codeHash: string;
  expiresAt: Date;
  codeExpiresAt: Date;
  resendAvailableAt: Date;
}

export type SaveOutcome = "created" | "active" | "inactive";

export interface MailLimit {
  windowMs: number;
  maximum: number;
}

export interface RegistrationStore {
  consume(
    key: string,
    limits: readonly MailLimit[],
    now: Date,
    deadline: Date,
  ): Promise<number>;
  save(record: RegistrationRecord, deadline: Date): Promise<SaveOutcome>;
  requestActivation(
    email: string,
    tokenHash: string,
    expiresAt: Date,
    deadline: Date,
  ): Promise<boolean>;
  confirmActivation(tokenHash: string, deadline: Date): Promise<boolean>;
  requestPasswordReset(
    email: string,
    tokenHash: string,
    expiresAt: Date,
    deadline: Date,
  ): Promise<boolean>;
  confirmPasswordReset(
    tokenHash: string,
    passwordHash: string,
    deadline: Date,
  ): Promise<string | null>;
}

export interface MailEventCleanup {
  removeExpiredEvents(now: Date): Promise<number>;
}
