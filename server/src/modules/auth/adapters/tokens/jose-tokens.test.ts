import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { createTestClock } from "../../../../testing/clock.js";
import { createJoseTokens } from "./jose-tokens.js";

const ACCESS_SECRET = "access-secret-0123456789abcdef0123456789";
const REFRESH_SECRET = "refresh-secret-0123456789abcdef012345678";

function setup() {
  const clock = createTestClock(new Date("2026-01-01T00:00:00Z"));
  const tokens = createJoseTokens({
    accessSecret: ACCESS_SECRET,
    refreshSecret: REFRESH_SECRET,
    accessTtlSeconds: 15 * 60,
    refreshTtlSeconds: 7 * 24 * 60 * 60,
    clock,
  });

  return { clock, tokens };
}

describe("токены на jose", () => {
  it("выдаёт токен доступа, который проверяется до истечения срока", async () => {
    const { clock, tokens } = setup();
    const issued = await tokens.issueAccess("user-1");

    expect(issued.expiresIn).toBe(900);
    expect(await tokens.verifyAccess(issued.token)).toEqual({ userId: "user-1" });

    clock.advance(1);

    expect(await tokens.verifyAccess(issued.token)).toBeNull();
  });

  it("выдаёт токен обновления с версией и сроком TTL обновления", async () => {
    const { clock, tokens } = setup();
    const issued = await tokens.issueRefresh("user-1", 3);

    expect(issued.expiresIn).toBe(7 * 24 * 60 * 60);
    expect(await tokens.verifyRefresh(issued.token)).toEqual({ userId: "user-1", version: 3 });

    clock.advance(7 * 24 + 1);

    expect(await tokens.verifyRefresh(issued.token)).toBeNull();
  });

  it("не принимает токен обновления вместо токена доступа и наоборот", async () => {
    const { tokens } = setup();
    const access = await tokens.issueAccess("user-1");
    const refresh = await tokens.issueRefresh("user-1", 0);

    expect(await tokens.verifyAccess(refresh.token)).toBeNull();
    expect(await tokens.verifyRefresh(access.token)).toBeNull();
  });

  it("не принимает токен с чужой подписью или неверным typ", async () => {
    const { clock, tokens } = setup();
    const now = Math.floor(clock.now().getTime() / 1000);
    const wrongType = await new SignJWT({ typ: "refresh" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(new TextEncoder().encode(ACCESS_SECRET));

    expect(await tokens.verifyAccess(wrongType)).toBeNull();
    expect(await tokens.verifyAccess("not.a.token")).toBeNull();
  });
});
