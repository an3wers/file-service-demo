export type NotificationErrorCode =
  "INVALID_EMAIL_MESSAGE" | "NOTIFICATION_DISABLED" | "EMAIL_SEND_FAILED";

const messages: Record<NotificationErrorCode, string> = {
  INVALID_EMAIL_MESSAGE: "Invalid email message",
  NOTIFICATION_DISABLED: "Notifications are disabled",
  EMAIL_SEND_FAILED: "Email submission failed",
};

export class NotificationError extends Error {
  constructor(readonly code: NotificationErrorCode) {
    super(messages[code]);
    this.name = "NotificationError";
  }
}
