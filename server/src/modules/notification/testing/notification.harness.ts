import { createEmailNotification } from "../application/send-email.js";
import type { EmailMessage } from "../domain/email.js";

export function createNotificationHarness(
  settings = { enabled: true, from: "sender@example.com" },
) {
  const transport = {
    messages: [] as (EmailMessage & { from: string })[],
    failure: undefined as unknown,
    async send(message: EmailMessage & { from: string }) {
      this.messages.push(message);
      if (this.failure) throw this.failure;
      return { messageId: "test-message" };
    },
  };
  return {
    notification: createEmailNotification(settings, transport),
    transport,
  };
}
