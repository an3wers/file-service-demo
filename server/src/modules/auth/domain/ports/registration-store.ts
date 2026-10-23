export interface RegistrationRecord {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  tokenHash: string;
  expiresAt: Date;
}

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
  save(record: RegistrationRecord, deadline: Date): Promise<boolean>;
}

export interface MailEventCleanup {
  removeExpiredEvents(now: Date): Promise<number>;
}
