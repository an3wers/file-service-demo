import type { EmailMessage } from "../email.js";

export interface MailTransport {
  send(
    message: EmailMessage & { from: string },
    options?: { signal?: AbortSignal },
  ): Promise<{
    messageId: string;
    accepted: string[];
    rejected: string[];
  }>;
}
