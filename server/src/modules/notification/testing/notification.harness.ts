import { createNotification } from "../index.js";
import type { MailTransport, NotificationSettings } from "../index.js";
import type { EmailMessage } from "../domain/email.js";

export function createNotificationHarness(
  settings: { enabled: false } | { enabled: true; from: string } = {
    enabled: true,
    from: "sender@example.com",
  },
) {
  const transport = {
    messages: [] as (EmailMessage & { from: string })[],
    failure: undefined as unknown,
    result: undefined as Awaited<ReturnType<MailTransport["send"]>> | undefined,
    async send(message: EmailMessage & { from: string }) {
      this.messages.push(message);
      if (this.failure) throw this.failure;
      return (
        this.result ?? {
          messageId: "test-message",
          accepted: [message.to],
          rejected: [],
        }
      );
    },
  };
  const options: NotificationSettings = settings.enabled
    ? { ...settings, transport }
    : settings;
  return {
    notification: createNotification(options),
    transport,
  };
}
