import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory } from "vue-router";
import type { AuthSession } from "@/api/generated";
import { clearSession, getAccessToken, onSessionExpired } from "@/api/session";
import { readSharedAuth } from "@/api/sharedAuth";
import { createAuth } from "@/composables/useAuth";
import type { AuthChannel, AuthMessage } from "@/composables/useAuth";
import { createAppRouter } from "./index";

const SESSION: AuthSession = {
  accessToken: "token",
  expiresIn: 900,
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    name: "admin",
    email: "admin@example.com",
  },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function respondWith(...responses: Array<() => Response | Promise<Response>>) {
  const fetchMock = vi.fn();

  for (const respond of responses) {
    fetchMock.mockImplementationOnce(async () => respond());
  }

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

const signedIn = () => json(200, SESSION);
const guest = () =>
  json(401, { error: { code: "SESSION_EXPIRED", message: "" } });
const offline = () => Promise.reject(new TypeError("Failed to fetch"));

class FakeChannel implements AuthChannel {
  posted: AuthMessage[] = [];
  private listener: ((event: MessageEvent<AuthMessage>) => void) | null = null;

  postMessage(message: AuthMessage): void {
    this.posted.push(message);
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<AuthMessage>) => void,
  ): void {
    this.listener = listener;
  }

  deliver(message: AuthMessage): void {
    this.listener?.(new MessageEvent("message", { data: message }));
  }
}

function setup() {
  const channel = new FakeChannel();
  const auth = createAuth(channel);
  const upload = { stop: vi.fn(), reset: vi.fn() };
  const browser = { reset: vi.fn() };
  const notify = vi.fn();
  const router = createAppRouter({
    history: createMemoryHistory(),
    auth,
    upload,
    browser,
    notify,
  });

  return { channel, auth, upload, browser, notify, router };
}

function changeInOtherTab(signedIn: boolean): void {
  const { generation } = readSharedAuth();
  localStorage.setItem(
    "file-service-auth-state",
    JSON.stringify({ generation: generation + 1, signedIn }),
  );
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  clearSession();
});

afterEach(() => {
  onSessionExpired(null);
  sessionStorage.clear();
});

describe("роутер", () => {
  it.each([false, true])(
    "активация доступна при наличии сессии %s без продления или смены пользователя",
    async (signedInBefore) => {
      const fetch = respondWith(signedIn);
      const { router, auth } = setup();
      if (signedInBefore) await auth.ensureSession();
      fetch.mockClear();
      await router.push("/activation#token=private-token");
      expect(router.currentRoute.value.name).toBe("activation");
      expect(router.currentRoute.value.hash).toBe("");
      expect(sessionStorage.getItem("file-service-activation-token")).toBe(
        "private-token",
      );
      expect(auth.signedIn.value).toBe(signedInBefore);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("перебрасывает гостя с / на /login", async () => {
    respondWith(guest);

    const { router } = setup();

    await router.push("/");

    expect(router.currentRoute.value.name).toBe("login");
  });

  it("перебрасывает вошедшего с /login на /", async () => {
    respondWith(signedIn);

    const { router } = setup();

    await router.push("/login");

    expect(router.currentRoute.value.name).toBe("files");
  });

  it("при NETWORK_ERROR на старте никуда не перебрасывает", async () => {
    respondWith(offline);

    const { router, auth } = setup();

    await router.push("/");

    expect(router.currentRoute.value.path).toBe("/");
    expect(auth.status.value).toBe("failed");
    expect(auth.bootError.value).toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("делает одно продление на старте на все навигации", async () => {
    const fetchMock = respondWith(signedIn);

    const { router } = setup();

    await router.push("/");
    await router.push("/unknown");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(router.currentRoute.value.name).toBe("files");
  });

  it("при истечении сессии отменяет загрузку, сохраняет навигацию и показывает тост", async () => {
    respondWith(signedIn, guest);

    const { router, upload, browser, notify } = setup();

    await router.push("/");

    const { apiRequest } = await import("@/api/client");

    await expect(apiRequest("/files")).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    });
    await settle();

    expect(upload.stop).toHaveBeenCalled();
    expect(upload.reset).not.toHaveBeenCalled();
    expect(browser.reset).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Сессия истекла — войдите снова");
    expect(router.currentRoute.value.name).toBe("login");
  });

  it("при подтверждённом выходе сообщает другим вкладкам и очищает загрузки и навигацию", async () => {
    respondWith(signedIn, () => new Response(null, { status: 204 }));

    const { router, auth, channel, upload, browser } = setup();

    await router.push("/");
    await auth.logout();
    await settle();

    expect(channel.posted).toEqual([{ type: "logout" }]);
    expect(getAccessToken()).toBeNull();
    expect(upload.reset).toHaveBeenCalled();
    expect(browser.reset).toHaveBeenCalled();
    expect(router.currentRoute.value.name).toBe("login");
  });

  it("потерянный ответ выхода сохраняет сессию, страницу и состояние", async () => {
    respondWith(signedIn, offline);

    const { router, auth, channel, upload, browser } = setup();

    await router.push("/");
    await expect(auth.logout()).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    await settle();

    expect(getAccessToken()).toBe("token");
    expect(router.currentRoute.value.name).toBe("files");
    expect(channel.posted).toEqual([]);
    expect(upload.reset).not.toHaveBeenCalled();
    expect(browser.reset).not.toHaveBeenCalled();
  });
});

describe("смена пользователя", () => {
  it("вход другого пользователя после истечения очищает загрузки и навигацию прежнего", async () => {
    const other = {
      ...SESSION,
      user: { ...SESSION.user, id: "00000000-0000-4000-8000-000000000002" },
    };
    respondWith(signedIn, guest, () => json(200, other));

    const { router, auth, upload, browser } = setup();

    await router.push("/");
    const { renewSession } = await import("@/api/client");
    await expect(renewSession()).rejects.toMatchObject({ status: 401 });
    await settle();

    expect(upload.reset).not.toHaveBeenCalled();
    expect(browser.reset).not.toHaveBeenCalled();

    await auth.verifyLogin("attempt", "123456", readSharedAuth().generation);

    expect(upload.reset).toHaveBeenCalledTimes(1);
    expect(browser.reset).toHaveBeenCalledTimes(1);
  });

  it("вкладка, пропустившая сообщение о смене входа, при продлении принимает общее состояние", async () => {
    const fetchMock = respondWith(signedIn);

    const { router, upload, browser, notify } = setup();

    await router.push("/");
    changeInOtherTab(false);
    const { renewSession } = await import("@/api/client");
    await expect(renewSession()).rejects.toMatchObject({
      code: "SESSION_CHANGED",
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBeNull();
    expect(upload.reset).toHaveBeenCalled();
    expect(browser.reset).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Вы вышли в другой вкладке");
    expect(router.currentRoute.value.name).toBe("login");
  });
});

describe("канал между вкладками", () => {
  it("«выход» в другой вкладке очищает сессию, загрузки и переводит на /login", async () => {
    const fetchMock = respondWith(signedIn);

    const { router, channel, upload, browser, notify } = setup();

    await router.push("/");
    changeInOtherTab(false);
    channel.deliver({ type: "logout" });
    await settle();

    expect(getAccessToken()).toBeNull();
    expect(upload.reset).toHaveBeenCalled();
    expect(browser.reset).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Вы вышли в другой вкладке");
    expect(router.currentRoute.value.name).toBe("login");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(channel.posted).toEqual([]);
  });

  it("«выход» в другой вкладке не трогает вкладку без сессии", async () => {
    respondWith(guest);

    const { router, channel, upload, browser, notify } = setup();

    await router.push("/login");
    channel.deliver({ type: "logout" });
    await settle();

    expect(upload.reset).not.toHaveBeenCalled();
    expect(upload.stop).not.toHaveBeenCalled();
    expect(browser.reset).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("«вход» в другой вкладке на /login продлевает сессию и переводит на /", async () => {
    const fetchMock = respondWith(guest, signedIn);

    const { router, channel } = setup();

    await router.push("/login");
    changeInOtherTab(true);
    channel.deliver({ type: "login" });
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAccessToken()).toBe("token");
    expect(router.currentRoute.value.name).toBe("files");
  });

  it("сообщение без смены общего входа ничего не делает", async () => {
    const fetchMock = respondWith(signedIn);

    const { router, channel } = setup();

    await router.push("/");
    channel.deliver({ type: "login" });
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
