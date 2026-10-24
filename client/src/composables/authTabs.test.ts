import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory } from "vue-router";
import type { AuthSession } from "@/api/generated";
import type { AuthChannel, AuthMessage } from "./useAuth";

const USER_X = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "x",
  email: "x@example.com",
};
const USER_Y = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "y",
  email: "y@example.com",
};

function session(user: AuthSession["user"]): AuthSession {
  return { accessToken: `token-${user.name}`, expiresIn: 900, user };
}

interface Delivery {
  status: number;
  body?: unknown;
  setCookie?: string | null;
}

interface PendingRequest {
  url: string;
  cookie: string | null;
  deliver(delivery: Delivery): void;
}

function createBrowser() {
  const jar = { cookie: null as string | null };
  const pending: PendingRequest[] = [];
  const listeners = new Map<
    number,
    (event: MessageEvent<AuthMessage>) => void
  >();
  let tail: Promise<unknown> = Promise.resolve();

  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          const request: PendingRequest = {
            url,
            cookie: jar.cookie,
            deliver({ status, body, setCookie }) {
              pending.splice(pending.indexOf(request), 1);
              if (setCookie !== undefined) jar.cookie = setCookie;
              resolve(
                new Response(status === 204 ? null : JSON.stringify(body), {
                  status,
                  headers: { "Content-Type": "application/json" },
                }),
              );
            },
          };
          pending.push(request);
        }),
    ),
  );

  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request<T>(_name: string, run: () => Promise<T>): Promise<T> {
        const result = tail.then(run);
        tail = result.then(
          () => {},
          () => {},
        );
        return result;
      },
    },
  });

  function channel(tab: number): AuthChannel {
    return {
      postMessage(message) {
        for (const [other, listener] of listeners) {
          if (other !== tab)
            setTimeout(() =>
              listener(new MessageEvent("message", { data: message })),
            );
        }
      },
      addEventListener(_type, listener) {
        listeners.set(tab, listener);
      },
    };
  }

  let tabs = 0;

  async function openTab() {
    const id = (tabs += 1);
    vi.resetModules();
    const { createAuth } = await import("./useAuth");
    const client = await import("@/api/client");
    const shared = await import("@/api/sharedAuth");
    const auth = createAuth(channel(id));
    const signOuts: string[] = [];
    auth.onSignOut((reason) => signOuts.push(reason));
    auth.onSignInElsewhere(() => void auth.renew());

    return { auth, client, shared, signOuts };
  }

  async function openFilesTab() {
    const id = (tabs += 1);
    vi.resetModules();
    const { createAuth } = await import("./useAuth");
    const { useUpload } = await import("./useUpload");
    const { useFileBrowser } = await import("./useFileBrowser");
    const { createAppRouter } = await import("@/router");
    const shared = await import("@/api/sharedAuth");
    const auth = createAuth(channel(id));
    const upload = useUpload();
    const browser = useFileBrowser();
    createAppRouter({
      history: createMemoryHistory(),
      auth,
      upload,
      browser,
      notify: () => {},
    });

    return { auth, upload, browser, shared };
  }

  async function next(url: string): Promise<PendingRequest> {
    await vi.waitFor(() =>
      expect(pending.map((request) => request.url)).toContain(url),
    );
    return pending.find((request) => request.url === url)!;
  }

  return { jar, pending, openTab, openFilesTab, next };
}

type Tab = Awaited<ReturnType<ReturnType<typeof createBrowser>["openTab"]>>;

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "locks");
});

describe("общий вход вкладок одного браузера", () => {
  it.each([
    {
      name: "успешный refresh прежней сессии",
      start: (tab: Tab) => tab.client.renewSession(),
      url: "/api/auth/refresh",
      delivery: { status: 200, body: session(USER_X), setCookie: "refresh=x" },
    },
    {
      name: "refresh с 401 и очисткой cookie",
      start: (tab: Tab) => tab.client.renewSession(),
      url: "/api/auth/refresh",
      delivery: {
        status: 401,
        body: { error: { code: "SESSION_EXPIRED", message: "" } },
        setCookie: null,
      },
    },
    {
      name: "ответ logout",
      start: (tab: Tab) => tab.auth.logout(),
      url: "/api/auth/logout",
      delivery: { status: 204, setCookie: null },
    },
  ])(
    "задержанный $name из другой вкладки не меняет cookie нового пользователя",
    async ({ start, url, delivery }) => {
      const browser = createBrowser();
      browser.jar.cookie = "refresh=x";
      const a = await browser.openTab();
      const b = await browser.openTab();

      const bootA = a.auth.ensureSession();
      (await browser.next("/api/auth/refresh")).deliver({
        status: 200,
        body: session(USER_X),
        setCookie: "refresh=x",
      });
      await bootA;
      const bootB = b.auth.ensureSession();
      (await browser.next("/api/auth/refresh")).deliver({
        status: 200,
        body: session(USER_X),
        setCookie: "refresh=x",
      });
      await bootB;

      const delayed = start(a).catch(() => {});
      const delayedRequest = await browser.next(url);
      const logoutB = b.auth.logout();
      await settle();

      expect(browser.pending.map((request) => request.url)).toEqual([url]);

      delayedRequest.deliver(delivery);
      await delayed;
      await settle();

      const pendingLogout = browser.pending.find(
        (request) => request.url === "/api/auth/logout",
      );
      pendingLogout?.deliver({ status: 204, setCookie: null });
      await logoutB;
      await settle();

      expect(b.auth.user.value).toBeNull();
      expect(a.auth.user.value).toBeNull();

      const generation = b.shared.readSharedAuth().generation;
      const login = b.auth.verifyLogin("attempt-y", "123456", generation);
      (await browser.next("/api/auth/login/verify")).deliver({
        status: 200,
        body: session(USER_Y),
        setCookie: "refresh=y",
      });
      await login;
      await settle();

      expect(browser.jar.cookie).toBe("refresh=y");
      expect(b.auth.user.value).toEqual(USER_Y);

      (await browser.next("/api/auth/refresh")).deliver({
        status: 200,
        body: session(USER_Y),
        setCookie: "refresh=y",
      });
      await settle();

      expect(a.auth.user.value).toEqual(USER_Y);
      expect(browser.jar.cookie).toBe("refresh=y");
    },
  );

  it("первый завершённый вход становится общим, незавершённая попытка другой вкладки не переключает пользователя и не возобновляется после выхода", async () => {
    const browser = createBrowser();
    const a = await browser.openTab();
    const b = await browser.openTab();

    for (const tab of [a, b]) {
      const boot = tab.auth.ensureSession();
      (await browser.next("/api/auth/refresh")).deliver({
        status: 401,
        body: { error: { code: "SESSION_EXPIRED", message: "" } },
        setCookie: null,
      });
      await boot;
    }

    const generation = a.shared.readSharedAuth().generation;
    const loginA = a.auth.verifyLogin("attempt-x", "111111", generation);
    const verifyA = await browser.next("/api/auth/login/verify");
    const loginB = b.auth.verifyLogin("attempt-y", "222222", generation);
    await settle();

    expect(browser.pending).toHaveLength(1);

    verifyA.deliver({
      status: 200,
      body: session(USER_X),
      setCookie: "refresh=x",
    });
    await loginA;
    await expect(loginB).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    await settle();

    expect(browser.pending.map((request) => request.url)).toEqual([
      "/api/auth/refresh",
    ]);
    browser.pending[0].deliver({
      status: 200,
      body: session(USER_X),
      setCookie: "refresh=x",
    });
    await settle();

    expect(browser.jar.cookie).toBe("refresh=x");
    expect(b.auth.user.value).toEqual(USER_X);

    const logout = a.auth.logout();
    (await browser.next("/api/auth/logout")).deliver({
      status: 204,
      setCookie: null,
    });
    await logout;
    await settle();

    expect(b.auth.user.value).toBeNull();
    expect(b.signOuts).toEqual(["elsewhere"]);

    await expect(
      b.auth.verifyLogin("attempt-y", "222222", generation),
    ).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(browser.pending).toEqual([]);
    expect(browser.jar.cookie).toBeNull();
  });

  it("сбой выхода сохраняет сессию во всех вкладках, повтор после серверного отзыва успешен", async () => {
    const browser = createBrowser();
    browser.jar.cookie = "refresh=x";
    const a = await browser.openTab();
    const b = await browser.openTab();

    for (const tab of [a, b]) {
      const boot = tab.auth.ensureSession();
      (await browser.next("/api/auth/refresh")).deliver({
        status: 200,
        body: session(USER_X),
        setCookie: "refresh=x",
      });
      await boot;
    }

    const failed = a.auth.logout();
    (await browser.next("/api/auth/logout")).deliver({
      status: 503,
      body: { error: { code: "DATABASE_UNAVAILABLE", message: "" } },
    });
    await expect(failed).rejects.toMatchObject({ status: 503 });
    await settle();

    expect(a.auth.user.value).toEqual(USER_X);
    expect(b.auth.user.value).toEqual(USER_X);
    expect(browser.jar.cookie).toBe("refresh=x");

    const retry = a.auth.logout();
    (await browser.next("/api/auth/logout")).deliver({
      status: 204,
      setCookie: null,
    });
    await retry;
    await settle();

    expect(a.auth.user.value).toBeNull();
    expect(b.auth.user.value).toBeNull();
    expect(a.signOuts).toEqual(["logout"]);
    expect(b.signOuts).toEqual(["elsewhere"]);
  });
});

describe("личное состояние вкладок при смене пользователя", () => {
  const expired = {
    status: 401,
    body: { error: { code: "SESSION_EXPIRED", message: "" } },
    setCookie: null,
  };
  const picked = () =>
    new File(["x"], "x-report.txt", { type: "text/plain", lastModified: 1 });

  async function signedInAsX() {
    const browser = createBrowser();
    browser.jar.cookie = "refresh=x";
    const a = await browser.openFilesTab();
    const b = await browser.openFilesTab();

    for (const tab of [a, b]) {
      const boot = tab.auth.ensureSession();
      (await browser.next("/api/auth/refresh")).deliver({
        status: 200,
        body: session(USER_X),
        setCookie: "refresh=x",
      });
      await boot;
    }
    await settle();
    for (const tab of [a, b]) {
      tab.upload.addFiles([picked()]);
      tab.browser.searchInput.value = "x-report";
    }

    return { browser, a, b };
  }

  async function expireInBothTabs(
    browser: ReturnType<typeof createBrowser>,
    a: Awaited<ReturnType<ReturnType<typeof createBrowser>["openFilesTab"]>>,
  ) {
    const renewal = a.auth.renew();
    (await browser.next("/api/auth/refresh")).deliver(expired);
    await renewal;
    await settle();
  }

  async function signIn(
    browser: ReturnType<typeof createBrowser>,
    tab: Awaited<ReturnType<ReturnType<typeof createBrowser>["openFilesTab"]>>,
    user: AuthSession["user"],
  ) {
    const generation = tab.shared.readSharedAuth().generation;
    const login = tab.auth.verifyLogin("attempt", "123456", generation);
    (await browser.next("/api/auth/login/verify")).deliver({
      status: 200,
      body: session(user),
      setCookie: `refresh=${user.name}`,
    });
    await login;
    (await browser.next("/api/auth/refresh")).deliver({
      status: 200,
      body: session(user),
      setCookie: `refresh=${user.name}`,
    });
    await settle();
  }

  it("после истечения сессии X и входа Y в одной вкладке вторая вкладка не показывает файлы X", async () => {
    const { browser, a, b } = await signedInAsX();

    await expireInBothTabs(browser, a);

    expect(a.auth.user.value).toBeNull();
    expect(b.auth.user.value).toBeNull();
    expect(b.upload.rows.value).toHaveLength(1);

    await signIn(browser, a, USER_Y);

    expect(a.auth.user.value).toEqual(USER_Y);
    expect(b.auth.user.value).toEqual(USER_Y);
    for (const tab of [a, b]) {
      expect(tab.upload.rows.value).toEqual([]);
      expect(tab.browser.searchInput.value).toBe("");
    }
    expect(localStorage.getItem("file-service.uploads.v1") ?? "").not.toContain(
      "x-report",
    );
  });

  it("повторный вход X после истечения сохраняет выбранные файлы X во всех вкладках", async () => {
    const { browser, a, b } = await signedInAsX();

    await expireInBothTabs(browser, a);
    await signIn(browser, a, USER_X);

    expect(b.auth.user.value).toEqual(USER_X);
    for (const tab of [a, b]) {
      expect(tab.upload.rows.value.map((row) => row.file.name)).toEqual([
        "x-report.txt",
      ]);
      expect(tab.browser.searchInput.value).toBe("x-report");
    }
  });

  it("временная ошибка продления не очищает выбранные файлы и поиск", async () => {
    const { browser, a, b } = await signedInAsX();

    const renewal = a.auth.renew();
    (await browser.next("/api/auth/refresh")).deliver({
      status: 503,
      body: { error: { code: "DATABASE_UNAVAILABLE", message: "" } },
    });
    await renewal;
    await settle();

    for (const tab of [a, b]) {
      expect(tab.auth.user.value).toEqual(USER_X);
      expect(tab.upload.rows.value).toHaveLength(1);
      expect(tab.browser.searchInput.value).toBe("x-report");
    }
  });
});
