import { describe, expect, it } from "vitest";
import { LOGIN, PASSWORD, createAuthHarness } from "../testing/auth.harness.js";

describe("пользователь из окружения при старте", () => {
  it("создаёт строку пользователя с хешем пароля и версией 0", async () => {
    const auth = createAuthHarness();

    const result = await auth.sync();
    const [user] = auth.users.all();

    expect(result).toEqual({ created: true, sessionsRevoked: false });
    expect(auth.users.all()).toHaveLength(1);
    expect(user?.login).toBe(LOGIN);
    expect(user?.tokenVersion).toBe(0);
    expect(user?.passwordHash).not.toContain(PASSWORD);
    expect(await auth.hasher.verify(PASSWORD, user?.passwordHash ?? "")).toBe(true);
  });

  it("повторный старт не создаёт дубль и не трогает версию", async () => {
    const auth = createAuthHarness();

    await auth.sync();
    const before = auth.users.all();
    const result = await auth.sync();

    expect(result).toEqual({ created: false, sessionsRevoked: false });
    expect(auth.users.all()).toEqual(before);
  });

  it("два одновременных старта не создают дубль", async () => {
    const auth = createAuthHarness();

    await Promise.all([auth.sync(), auth.sync()]);

    expect(auth.users.all()).toHaveLength(1);
    expect(auth.users.all()[0]?.tokenVersion).toBe(0);
  });

  it("смена пароля в окружении перехеширует его и отзывает сессии", async () => {
    const auth = createAuthHarness();

    await auth.sync();
    const result = await auth.sync({ password: "a brand new password" });
    const [user] = auth.users.all();

    expect(result).toEqual({ created: false, sessionsRevoked: true });
    expect(user?.tokenVersion).toBe(1);
    expect(await auth.hasher.verify("a brand new password", user?.passwordHash ?? "")).toBe(true);
    expect(await auth.hasher.verify(PASSWORD, user?.passwordHash ?? "")).toBe(false);
  });

  it("два одновременных старта с новым паролем поднимают версию один раз", async () => {
    const auth = createAuthHarness();

    await auth.sync();
    await Promise.all([
      auth.sync({ password: "a brand new password" }),
      auth.sync({ password: "a brand new password" }),
    ]);
    const [user] = auth.users.all();

    expect(user?.tokenVersion).toBe(1);
    expect(await auth.hasher.verify("a brand new password", user?.passwordHash ?? "")).toBe(true);
  });

  it("смена логина заводит новую строку и не трогает старую", async () => {
    const auth = createAuthHarness();

    await auth.sync();
    const [old] = auth.users.all();
    await auth.sync({ login: "someone-else", password: "another password" });

    expect(auth.users.all()).toHaveLength(2);
    expect(auth.users.all().find((user) => user.login === LOGIN)).toEqual(old);
  });
});
