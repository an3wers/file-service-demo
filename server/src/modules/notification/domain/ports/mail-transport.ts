import type { EmailMessage, EmailResult } from "../email.js";

export interface MailTransport {
  send(message: EmailMessage & { from: string }): Promise<EmailResult>;
}
