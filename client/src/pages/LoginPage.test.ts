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
    vi
      .fn()
      .mockResolvedValue(
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
