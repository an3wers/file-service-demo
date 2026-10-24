export interface MailLog {
  info(fields: object, message: string): void;
}

export function logMailAttempt(
  log: MailLog,
  fields: { purpose: string; outcome: string; durationMs: number },
): void {
  log.info(fields, "Auth mail attempt");
}
