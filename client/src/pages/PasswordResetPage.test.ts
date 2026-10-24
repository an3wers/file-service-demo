import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import PasswordResetPage from "./PasswordResetPage.vue";
import html from "../../index.html?raw";
import App from "@/App.vue";
import { createAppRouter } from "@/router";
import { useAuth } from "@/composables/useAuth";
import { clearSession, getAccessToken, startSession } from "@/api/session";

const TOKEN_KEY = "file-service-password-reset-token";
const FORM_KEY = "file-service-password-reset-form";
const PASSWORD = "new password 12345";
const SUCCESS = "Пароль изменён. Теперь можно войти";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

function mountPage(options: { attachTo?: HTMLElement } = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: PasswordResetPage },
      {
        path: "/password-reset",
        name: "password-reset",
        component: PasswordResetPage,
      },
    ],
  });
  return mount(PasswordResetPage, {
    ...options,
    global: { plugins: [router] },
  });
}

async function fillPasswords(
  wrapper: ReturnType<typeof mountPage>,
  password = PASSWORD,
  confirmation = password,
) {
  await wrapper.get("input[name=password]").setValue(password);
  await wrapper.get("input[name=passwordConfirmation]").setValue(confirmation);
  await wrapper.get("form[data-confirm]").trigger("submit");
  await flushPromises();
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  clearSession();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("сохраняет пароль явной отправкой, передаёт секрет в JSON и не хранит пароли", async () => {
  sessionStorage.setItem(TOKEN_KEY, "private-token");
  const fetch = vi.fn().mockResolvedValue(json(200, { message: SUCCESS }));
  vi.stubGlobal("fetch", fetch);
  const wrapper = mountPage({ attachTo: document.body });
  expect(fetch).not.toHaveBeenCalled();
  expect(wrapper.get("label[for=reset-password]").text()).toBe("Новый пароль");
  expect(wrapper.get("label[for=reset-password-confirmation]").text()).toBe(
    "Повторите пароль",
  );
  await fillPasswords(wrapper);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toBe("/api/auth/password-reset/confirm");
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
    token: "private-token",
    password: PASSWORD,
    passwordConfirmation: PASSWORD,
  });
  expect(wrapper.text()).toContain(SUCCESS);
  expect(wrapper.find("form[data-confirm]").exists()).toBe(false);
  expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain(
    PASSWORD,
  );
  expect(document.activeElement?.getAttribute("role")).toBe("status");
  expect(wrapper.find("a[href='/login']").exists()).toBe(true);
  wrapper.unmount();
});

it("ошибка подтверждения пароля связана с полем, получает фокус и не удаляет ссылку", async () => {
  sessionStorage.setItem(TOKEN_KEY, "private-token");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      json(422, {
        error: {
          code: "VALIDATION_ERROR",
          message: "Проверьте поля формы",
          details: {
            formErrors: [],
            fieldErrors: { passwordConfirmation: ["Пароли не совпадают"] },
          },
        },
      }),
    ),
  );
  const wrapper = mountPage({ attachTo: document.body });
  await fillPasswords(wrapper, PASSWORD, "other password 1");
  const input = wrapper.get<HTMLInputElement>(
    "input[name=passwordConfirmation]",
  );
  expect(input.attributes("aria-invalid")).toBe("true");
  expect(input.attributes("aria-describedby")).toBe(
    "reset-password-confirmation-error",
  );
  expect(wrapper.get("#reset-password-confirmation-error").text()).toBe(
    "Пароли не совпадают",
  );
  expect(document.activeElement).toBe(input.element);
  expect(sessionStorage.getItem(TOKEN_KEY)).toBe("private-token");
  wrapper.unmount();
});

it("недействительная ссылка удаляется, форма запроса письма остаётся", async () => {
  sessionStorage.setItem(TOKEN_KEY, "used-token");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      json(400, {
        error: {
          code: "PASSWORD_RESET_LINK_INVALID",
          message: "Ссылка недействительна",
        },
      }),
    ),
  );
  const wrapper = mountPage();
  await fillPasswords(wrapper);
  expect(wrapper.text()).toContain(
    "Ссылка недействительна. Запросите новое письмо восстановления",
  );
  expect(wrapper.find("form[data-confirm]").exists()).toBe(false);
  expect(wrapper.find("form[data-request]").exists()).toBe(true);
  expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  wrapper.unmount();
});

it("временный сбой сохраняет ссылку для ручного повтора", async () => {
  sessionStorage.setItem(TOKEN_KEY, "private-token");
  const fetch = vi.fn().mockResolvedValueOnce(
    json(503, {
      error: { code: "SERVICE_UNAVAILABLE", message: "Попробуйте позже" },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const wrapper = mountPage();
  await fillPasswords(wrapper);
  expect(wrapper.find("[role=alert]").exists()).toBe(true);
  expect(sessionStorage.getItem(TOKEN_KEY)).toBe("private-token");
  fetch.mockResolvedValueOnce(json(200, { message: SUCCESS }));
  await wrapper.get("form[data-confirm]").trigger("submit");
  await flushPromises();
  expect(wrapper.text()).toContain(SUCCESS);
  wrapper.unmount();
});

it("запрос письма сохраняет email и ожидание после обновления без паролей и повторной отправки", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValue(
    json(202, {
      message: "Если требуется письмо, инструкции придут на email",
      retryAfterSeconds: 45,
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const wrapper = mountPage();
  await wrapper.get("input[name=email]").setValue("user@example.com");
  await wrapper.get("form[data-request]").trigger("submit");
  await flushPromises();
  expect(fetch.mock.calls[0]![0]).toBe("/api/auth/password-reset/request");
  expect(wrapper.text()).toContain("Повторить можно через 45 с");
  const saved = sessionStorage.getItem(FORM_KEY)!;
  wrapper.unmount();
  sessionStorage.setItem(FORM_KEY, saved);
  const reloaded = mountPage();
  expect(
    reloaded.get<HTMLInputElement>("input[name=email]").element.value,
  ).toBe("user@example.com");
  expect(reloaded.text()).toContain("Повторить можно через 45 с");
  expect(fetch).toHaveBeenCalledTimes(1);
  reloaded.unmount();
});

it("уход отменяет запрос, удаляет секрет и игнорирует поздний успех", async () => {
  sessionStorage.setItem(TOKEN_KEY, "private-token");
  let finish!: (response: Response) => void;
  const fetch = vi.fn().mockReturnValue(
    new Promise<Response>((resolve) => {
      finish = resolve;
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const wrapper = mountPage();
  await wrapper.get("input[name=password]").setValue(PASSWORD);
  await wrapper.get("input[name=passwordConfirmation]").setValue(PASSWORD);
  await wrapper.get("form[data-confirm]").trigger("submit");
  const signal = fetch.mock.calls[0]![1].signal as AbortSignal;
  wrapper.unmount();
  expect(signal.aborted).toBe(true);
  expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  expect(sessionStorage.getItem(FORM_KEY)).toBeNull();
  finish(json(200, { message: SUCCESS }));
  await flushPromises();
});

it.each([
  ["того же пользователя завершает его сессию", 401, null],
  ["другого пользователя сохраняет его сессию", 200, "renewed-token"],
] as const)(
  "восстановление при входе %s",
  async (_name, refreshStatus, expectedToken) => {
    const user = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Имя",
      email: "current@example.com",
    };
    const fetch = vi.fn(async (url: string) => {
      if (url === "/api/auth/password-reset/confirm")
        return json(200, { message: SUCCESS });
      return refreshStatus === 200
        ? json(200, { accessToken: "renewed-token", expiresIn: 900, user })
        : json(401, {
            error: { code: "SESSION_EXPIRED", message: "expired" },
          });
    });
    vi.stubGlobal("fetch", fetch);
    const auth = useAuth();
    auth.status.value = "ready";
    startSession({ accessToken: "existing-token", expiresIn: 900, user });
    const upload = { stop: vi.fn(), reset: vi.fn() };
    const router = createAppRouter({
      history: createMemoryHistory(),
      auth,
      upload,
      browser: { reset: vi.fn() },
      notify: vi.fn(),
    });
    await router.push("/password-reset#token=private-token");
    expect(router.currentRoute.value.hash).toBe("");
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe("private-token");
    const wrapper = mount(App, {
      global: { plugins: [router], stubs: { Toaster: true } },
    });
    await flushPromises();
    expect(fetch).not.toHaveBeenCalled();
    await wrapper.get("input[name=password]").setValue(PASSWORD);
    await wrapper.get("input[name=passwordConfirmation]").setValue(PASSWORD);
    await wrapper.get("form[data-confirm]").trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain(SUCCESS);
    expect(getAccessToken()).toBe(expectedToken);
    expect(router.currentRoute.value.name).toBe("password-reset");
    if (expectedToken === null) expect(upload.stop).toHaveBeenCalled();
    wrapper.unmount();
  },
);

it("ссылка восстановления удаляется из адреса до запуска приложения и живёт только во вкладке", () => {
  sessionStorage.setItem("file-service-activation-token", "activation-token");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const location = {
    pathname: "/password-reset",
    search: "",
    hash: "#token=private-token",
  };
  const history = { state: null, replaceState: vi.fn() };
  new Function("location", "history", "sessionStorage", "performance", script)(
    location,
    history,
    sessionStorage,
    { getEntriesByType: () => [{ type: "navigate" }] },
  );
  expect(history.replaceState).toHaveBeenCalledWith(
    null,
    "",
    "/password-reset",
  );
  expect(sessionStorage.getItem(TOKEN_KEY)).toBe("private-token");
  expect(sessionStorage.getItem("file-service-activation-token")).toBeNull();
  expect(localStorage.length).toBe(0);
});
