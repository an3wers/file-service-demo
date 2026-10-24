import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { clearSession, getAccessToken } from "@/api/session";
import LoginPage from "./LoginPage.vue";

const push = vi.fn();
const query: Record<string, unknown> = {};
vi.mock("vue-router", () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({ query }),
}));
const wrappers: ReturnType<typeof mount>[] = [];
const mountPage = () => {
  const wrapper = mount(LoginPage, { attachTo: document.body });
  wrappers.push(wrapper);
  return wrapper;
};
const json = (body: unknown, status = 200, date = new Date()) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", Date: date.toUTCString() },
  });
function attempt(now = Date.now(), deliveryStatus = "accepted") {
  return {
    attemptToken: "a".repeat(43),
    attemptExpiresAt: new Date(now + 900000).toISOString(),
    codeExpiresAt: new Date(now + 300000).toISOString(),
    resendAvailableAt: new Date(now + 60000).toISOString(),
    deliveryStatus,
  };
}
async function credentials(wrapper: ReturnType<typeof mountPage>) {
  await wrapper.get("input[name=email]").setValue("User@Example.com");
  await wrapper.get("input[name=password]").setValue("secret password");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
}
beforeEach(() => {
  clearSession();
  sessionStorage.clear();
  Object.keys(query).forEach((key) => delete query[key]);
});
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  vi.useRealTimers();
});

it("после пароля показывает одно поле кода, очищает пароль и не создаёт сессию", async () => {
  const fetch = vi.fn().mockResolvedValue(json(attempt()));
  vi.stubGlobal("fetch", fetch);
  const wrapper = mountPage();
  await credentials(wrapper);
  const code = wrapper.get<HTMLInputElement>("input[name=code]");
  expect(code.attributes()).toMatchObject({
    type: "text",
    inputmode: "numeric",
    autocomplete: "one-time-code",
  });
  expect(wrapper.find("input[name=password]").exists()).toBe(false);
  expect(document.activeElement).toBe(code.element);
  expect(getAccessToken()).toBeNull();
  expect(push).not.toHaveBeenCalled();
  expect(JSON.stringify(sessionStorage)).not.toContain("secret password");
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
    email: "User@Example.com",
    password: "secret password",
  });
});

it("вставка сохраняет ведущие нули и шестая цифра не отправляет запрос без Enter или кнопки", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(attempt()))
    .mockResolvedValueOnce(
      json({
        accessToken: "token",
        expiresIn: 900,
        user: { id: "user", name: "Имя", email: "user@example.com" },
      }),
    );
  vi.stubGlobal("fetch", fetch);
  query.returnTo = "/?directory=reports";
  const wrapper = mountPage();
  await credentials(wrapper);
  await wrapper.get("input[name=code]").setValue("001234");
  expect(fetch).toHaveBeenCalledTimes(1);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
    attemptToken: "a".repeat(43),
    code: "001234",
  });
  expect(getAccessToken()).toBe("token");
  expect(push).toHaveBeenCalledWith("/?directory=reports");
  expect(sessionStorage.getItem("file-service-login-attempt")).toBeNull();
});

it.each([
  "https://evil.example",
  "//evil.example",
  "/\\evil.example",
  "/login?returnTo=/",
  "/register",
  "/activation#token=x",
  "/password-reset",
  "/%6Cogin",
  "/nested/../login",
  "/login/",
  ["/?directory=a", "//evil.example"],
])("опасный returnTo %s заменяется корнем", async (returnTo) => {
  query.returnTo = returnTo;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(json(attempt()))
      .mockResolvedValueOnce(
        json({
          accessToken: "t",
          expiresIn: 900,
          user: { id: "user", name: "Имя", email: "user@example.com" },
        }),
      ),
  );
  const wrapper = mountPage();
  await credentials(wrapper);
  await wrapper.get("input[name=code]").setValue("001234");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(push).toHaveBeenCalledWith("/");
});

it("обновление восстанавливает попытку с прежними сроками без письма и учитывает серверный Date при неверных часах клиента", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const clientTime = Date.parse("2026-01-01T00:00:00Z");
  const serverTime = clientTime + 3600000;
  vi.setSystemTime(clientTime);
  const fetch = vi
    .fn()
    .mockResolvedValue(json(attempt(serverTime), 200, new Date(serverTime)));
  vi.stubGlobal("fetch", fetch);
  const first = mountPage();
  await credentials(first);
  expect(first.text()).toContain("Код действует ещё 300 с");
  const saved = sessionStorage.getItem("file-service-login-attempt");
  first.unmount();
  vi.setSystemTime(clientTime + 300000);
  const restored = mountPage();
  expect(restored.find("input[name=code]").exists()).toBe(true);
  expect(restored.text()).toContain("Код истёк");
  expect(
    restored.get("button[type=submit]").attributes("disabled"),
  ).toBeDefined();
  expect(sessionStorage.getItem("file-service-login-attempt")).toBe(saved);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("после входа и выхода в другой вкладке прежняя попытка не возобновляется при обновлении", async () => {
  const fetch = vi.fn().mockResolvedValue(json(attempt()));
  vi.stubGlobal("fetch", fetch);
  const first = mountPage();
  await credentials(first);
  first.unmount();
  localStorage.setItem(
    "file-service-auth-state",
    JSON.stringify({ generation: 2, signedIn: false }),
  );
  const reloaded = mountPage();
  expect(reloaded.find("input[name=email]").exists()).toBe(true);
  expect(reloaded.find("input[name=code]").exists()).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("закрытие вкладки убирает возможность продолжить попытку", async () => {
  const fetch = vi.fn().mockResolvedValue(json(attempt()));
  vi.stubGlobal("fetch", fetch);
  const first = mountPage();
  await credentials(first);
  first.unmount();
  sessionStorage.clear();
  const reopened = mountPage();
  expect(reopened.find("input[name=email]").exists()).toBe(true);
  expect(reopened.find("input[name=code]").exists()).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("неизвестная отправка разрешает ввод, неправильный код показывает остаток, временный сбой сохраняет попытку", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(attempt(Date.now(), "unconfirmed")))
    .mockResolvedValueOnce(
      json(
        {
          error: {
            code: "LOGIN_CODE_INVALID",
            message: "Неверный код",
            details: { remainingAttempts: 4 },
          },
        },
        400,
      ),
    )
    .mockResolvedValueOnce(
      json(
        { error: { code: "SERVICE_UNAVAILABLE", message: "Попробуйте позже" } },
        503,
      ),
    );
  vi.stubGlobal("fetch", fetch);
  const wrapper = mountPage();
  await credentials(wrapper);
  expect(wrapper.text()).toContain("Если код пришёл, введите его");
  await wrapper.get("input[name=code]").setValue("123456");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.text()).toContain("Осталось проверок: 4");
  expect(wrapper.get("[role=alert]").text()).toContain("Неверный код");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.find("input[name=code]").exists()).toBe(true);
  expect(sessionStorage.getItem("file-service-login-attempt")).not.toBeNull();
});

it("пятая ошибка забывает попытку и позволяет начать новый вход", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(json(attempt()))
      .mockResolvedValueOnce(
        json(
          {
            error: {
              code: "LOGIN_CODE_INVALID",
              message: "Неверный код",
              details: { remainingAttempts: 0 },
            },
          },
          400,
        ),
      ),
  );
  const wrapper = mountPage();
  await credentials(wrapper);
  await wrapper.get("input[name=code]").setValue("123456");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.find("input[name=email]").exists()).toBe(true);
  expect(sessionStorage.getItem("file-service-login-attempt")).toBeNull();
});

it("общий отказ входа очищает пароль и возвращает фокус без смены страницы", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      json(
        {
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Неверный email или пароль",
          },
        },
        401,
      ),
    ),
  );
  const wrapper = mountPage();
  await credentials(wrapper);
  const password = wrapper.get<HTMLInputElement>("input[name=password]");
  expect(password.element.value).toBe("");
  expect(document.activeElement).toBe(password.element);
  expect(wrapper.get("[role=alert]").text()).toContain(
    "Неверный email или пароль",
  );
  expect(push).not.toHaveBeenCalled();
});

it("повтор кода без пароля доступен после серверного resendAvailableAt, недоступен во время запроса и обновляет сроки", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const clientTime = Date.parse("2026-01-01T00:00:00Z");
  const serverTime = clientTime + 3600000;
  vi.setSystemTime(clientTime);
  let answer!: (response: Response) => void;
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      json(attempt(serverTime, "unconfirmed"), 200, new Date(serverTime)),
    )
    .mockReturnValueOnce(
      new Promise<Response>((resolve) => (answer = resolve)),
    );
  vi.stubGlobal("fetch", fetch);
  const wrapper = mountPage();
  await credentials(wrapper);
  const resend = () => wrapper.get("button[data-action=resend]");
  expect(resend().attributes("disabled")).toBeDefined();
  expect(wrapper.text()).toContain("Новый код можно запросить через 60 с");
  expect(wrapper.text()).toContain("Попытка действует ещё 900 с");
  vi.advanceTimersByTime(60000);
  await flushPromises();
  expect(resend().attributes("disabled")).toBeUndefined();
  await resend().trigger("click");
  expect(resend().attributes("disabled")).toBeDefined();
  expect(fetch.mock.calls[1]![0]).toContain("/auth/login/resend");
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
    attemptToken: "a".repeat(43),
  });
  answer(
    json(
      {
        attemptExpiresAt: new Date(serverTime + 900000).toISOString(),
        codeExpiresAt: new Date(serverTime + 360000).toISOString(),
        resendAvailableAt: new Date(serverTime + 120000).toISOString(),
        deliveryStatus: "accepted",
      },
      200,
      new Date(serverTime + 60000),
    ),
  );
  await flushPromises();
  expect(wrapper.text()).toContain("Почтовый сервер принял письмо");
  expect(wrapper.text()).toContain("Код действует ещё 300 с");
  expect(wrapper.text()).toContain("Попытка действует ещё 840 с");
  expect(resend().attributes("disabled")).toBeDefined();
  expect(
    JSON.parse(sessionStorage.getItem("file-service-login-attempt")!).attempt,
  ).toMatchObject({
    attemptToken: "a".repeat(43),
    codeExpiresAt: new Date(serverTime + 360000).toISOString(),
  });
  await wrapper.get("input[name=code]").setValue("012345");
  expect(
    wrapper.get("button[type=submit]").attributes("disabled"),
  ).toBeUndefined();
});

it("лимит повтора не мешает вводу кода, оставшиеся проверки переживают обновление, завершённая попытка забывается", async () => {
  const limited = json(
    {
      error: {
        code: "RATE_LIMITED",
        message: "Слишком много запросов. Попробуйте позже",
        details: { retryAfterSeconds: 1800 },
      },
    },
    429,
  );
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      json({
        ...attempt(),
        resendAvailableAt: new Date(Date.now() - 2000).toISOString(),
      }),
    )
    .mockResolvedValueOnce(
      json(
        {
          error: {
            code: "LOGIN_CODE_INVALID",
            message: "Неверный код",
            details: { remainingAttempts: 4 },
          },
        },
        400,
      ),
    )
    .mockResolvedValueOnce(limited)
    .mockResolvedValueOnce(
      json(
        {
          error: {
            code: "LOGIN_ATTEMPT_INVALID",
            message: "Попытка входа завершена. Войдите заново",
          },
        },
        410,
      ),
    );
  vi.stubGlobal("fetch", fetch);
  const first = mountPage();
  await credentials(first);
  await first.get("input[name=code]").setValue("123456");
  await first.get("form").trigger("submit");
  await flushPromises();
  first.unmount();
  const wrapper = mountPage();
  expect(wrapper.text()).toContain("Осталось проверок: 4");
  await wrapper.get("button[data-action=resend]").trigger("click");
  await flushPromises();
  expect(wrapper.text()).toContain("Новый код можно запросить через 1800 с");
  expect(
    wrapper.get("button[data-action=resend]").attributes("disabled"),
  ).toBeDefined();
  await wrapper.get("input[name=code]").setValue("654321");
  expect(
    wrapper.get("button[type=submit]").attributes("disabled"),
  ).toBeUndefined();
  wrapper.unmount();
  sessionStorage.setItem(
    "file-service-login-attempt",
    JSON.stringify({
      ...JSON.parse(sessionStorage.getItem("file-service-login-attempt")!),
      attempt: {
        ...attempt(),
        resendAvailableAt: new Date(Date.now() - 2000).toISOString(),
      },
    }),
  );
  const last = mountPage();
  await last.get("button[data-action=resend]").trigger("click");
  await flushPromises();
  expect(last.find("input[name=email]").exists()).toBe(true);
  expect(sessionStorage.getItem("file-service-login-attempt")).toBeNull();
});

const notVerified = () =>
  json(
    { error: { code: "EMAIL_NOT_VERIFIED", message: "Email не подтверждён" } },
    403,
  );
const invalidCredentials = () =>
  json(
    {
      error: {
        code: "INVALID_CREDENTIALS",
        message: "Неверный email или пароль",
      },
    },
    401,
  );

it("неподтверждённый email показывает объявленный переход к запросу активации без сессии и без отправки письма", async () => {
  const fetch = vi.fn().mockResolvedValue(notVerified());
  vi.stubGlobal("fetch", fetch);
  const wrapper = mountPage();
  await credentials(wrapper);
  const alert = wrapper.get("[role=alert]");
  expect(alert.text()).toContain("Подтвердите email, чтобы войти");
  expect(alert.text()).toContain("письмо активации");
  const link = alert.get("a[href='/activation']");
  expect(link.text()).toBe("Запросить письмо активации");
  expect(link.attributes("tabindex")).toBeUndefined();
  expect(
    wrapper.get<HTMLInputElement>("input[name=password]").element.value,
  ).toBe("");
  expect(JSON.stringify({ ...sessionStorage })).not.toContain(
    "secret password",
  );
  expect(getAccessToken()).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toBe("/api/auth/login");
  expect(push).not.toHaveBeenCalled();
});

it("неверный пароль или неизвестный email не показывает переход к активации", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(invalidCredentials()));
  const wrapper = mountPage();
  await credentials(wrapper);
  expect(wrapper.get("[role=alert]").text()).toContain(
    "Неверный email или пароль",
  );
  expect(wrapper.find("a[href='/activation']").exists()).toBe(false);
  expect(wrapper.text()).not.toContain("письмо активации");
});

it("после отказа неподтверждённому email следующий неверный пароль убирает переход к активации", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(notVerified())
      .mockResolvedValueOnce(invalidCredentials()),
  );
  const wrapper = mountPage();
  await credentials(wrapper);
  expect(wrapper.find("a[href='/activation']").exists()).toBe(true);
  await credentials(wrapper);
  expect(wrapper.find("a[href='/activation']").exists()).toBe(false);
});
