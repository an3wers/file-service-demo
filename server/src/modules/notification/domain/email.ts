export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailResult {
  messageId: string;
}

export interface Notification {
  sendEmail(
    message: EmailMessage,
    options?: { signal?: AbortSignal },
  ): Promise<EmailResult>;
}
