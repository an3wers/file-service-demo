import { vi } from "vitest";
import type { TestClock } from "../../../testing/clock.js";
import { createTestClock } from "../../../testing/clock.js";
import { createScryptHasher } from "../adapters/crypto/scrypt-hasher.js";
import { createJoseTokens } from "../adapters/tokens/jose-tokens.js";
import { createSessionsModule } from "../application/sessions.js";
import type { SessionStore } from "../domain/ports/session-store.js";
import { createMemorySessionStore } from "./memory-session-store.js";

export const EMAIL = "user@example.com";
export const PASSWORD = "correct horse battery";
export function createAuthHarness(
  clock: TestClock = createTestClock(new Date("2026-01-01T00:00:00Z")),
) {
  const memory = createMemorySessionStore(clock);
  const hasher = createScryptHasher({ N: 1024, r: 8, p: 1 });
  const tokens = createJoseTokens({
    accessSecret: "access-secret-0123456789abcdef0123456789",
    accessTtlSeconds: 900,
    clock,
  });
  const sendEmail = vi.fn().mockResolvedValue({ messageId: "accepted" });
  const deps = {
    store: memory.store,
    hasher,
    tokens,
    clock,
    notification: { sendEmail },
    codeSecret: "code-secret-0123456789abcdef0123456789",
  };
  return {
    ...memory,
    hasher,
    clock,
    tokens,
    sendEmail,
    sessions: createSessionsModule(deps),
    withStore: (store: SessionStore, deadlineMs?: number) =>
      createSessionsModule({
        ...deps,
        store,
        ...(deadlineMs ? { deadlineMs } : {}),
      }),
    async seed(state: "active" | "inactive" = "active") {
      memory.users.set("00000000-0000-4000-8000-000000000001", {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Имя",
        email: EMAIL,
        passwordHash: await hasher.hash(PASSWORD),
        tokenVersion: 0,
        state,
      });
    },
    code: () =>
      sendEmail.mock.calls.at(-1)![0].text.match(/[0-9]{6}/)![0] as string,
  };
}
export type AuthHarness = ReturnType<typeof createAuthHarness>;
