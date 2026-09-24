import { describe, expect, it } from "vitest";
import { InvalidCredentialsError, SessionExpiredError } from "../domain/errors.js";
import {
  ACCESS_TTL_SECONDS,
  LOGIN,
  PASSWORD,
  REFRESH_TTL_SECONDS,
  createAuthHarness,
} from "../testing/auth.harness.js";

async function signedIn() {
  const auth = createAuthHarness();

  await auth.sync();

  return { auth, session: await auth.sessions.login(LOGIN, PASSWORD) };
}

describe("вход", () => {
  it("выдаёт токен доступа и токен обновления пользователю из окружения", async () => {
    const { auth, session } = await signedIn();
    const [user] = auth.users.all();

    expect(session.user).toEqual({ login: LOGIN });
    expect(session.expiresIn).toBe(ACCESS_TTL_SECONDS);
    expect(session.refreshExpiresIn).toBe(REFRESH_TTL_SECONDS);
    expect(await auth.sessions.authenticate(session.accessToken)).toEqual({ userId: user?.id });
  });

  it("отказывает при неверном пароле", async () => {
    const auth = createAuthHarness();

    await auth.sync();

    await expect(auth.sessions.login(LOGIN, "wrong password")).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it("отказывает при неверном логине так же, как при неверном пароле", async () => {
    const auth = createAuthHarness();

    await auth.sync();

    await expect(auth.sessions.login("stranger", PASSWORD)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it("сравнивает логин с учётом регистра и без обрезки пробелов", async () => {
    const auth = createAuthHarness();

    await auth.sync();

    await expect(auth.sessions.login(LOGIN.toUpperCase(), PASSWORD)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    await expect(auth.sessions.login(` ${LOGIN}`, PASSWORD)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it("не пускает прежний логин, оставшийся в базе после смены логина в окружении", async () => {
    const auth = createAuthHarness();

    await auth.sync();
    await auth.sync({ login: "new-operator", password: "another password" });

    await expect(auth.withLogin("new-operator").login(LOGIN, PASSWORD)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });
});

describe("продление", () => {
  it("выдаёт новую пару токенов с новым токеном обновления", async () => {
    const { auth, session } = await signedIn();

    auth.clock.advance(1);
    const renewed = await auth.sessions.refresh(session.refreshToken);

    expect(renewed.refreshToken).not.toBe(session.refreshToken);
    expect(renewed.accessToken).not.toBe(session.accessToken);
    expect(renewed.user).toEqual({ login: LOGIN });
    expect(await auth.sessions.refresh(renewed.refreshToken)).toMatchObject({
      user: { login: LOGIN },
    });
  });

  it("отказывает без токена обновления", async () => {
    const { auth } = await signedIn();

    await expect(auth.sessions.refresh(undefined)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("отказывает с токеном доступа вместо токена обновления", async () => {
    const { auth, session } = await signedIn();

    await expect(auth.sessions.refresh(session.accessToken)).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it("отказывает, когда токен обновления истёк", async () => {
    const { auth, session } = await signedIn();

    auth.clock.advance(REFRESH_TTL_SECONDS / 3600 + 1);

    await expect(auth.sessions.refresh(session.refreshToken)).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it("отказывает по устаревшей версии после смены пароля", async () => {
    const { auth, session } = await signedIn();

    await auth.sync({ password: "a brand new password" });

    await expect(auth.sessions.refresh(session.refreshToken)).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it("отказывает пользователю, чей логин больше не указан в окружении", async () => {
    const { auth, session } = await signedIn();

    await auth.sync({ login: "new-operator", password: "another password" });

    await expect(auth.withLogin("new-operator").refresh(session.refreshToken)).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });
});

describe("проверка токена доступа", () => {
  it("не принимает токен обновления и мусор", async () => {
    const { auth, session } = await signedIn();

    expect(await auth.sessions.authenticate(session.refreshToken)).toBeNull();
    expect(await auth.sessions.authenticate("garbage")).toBeNull();
  });
});
