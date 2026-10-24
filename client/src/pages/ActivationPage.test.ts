import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import ActivationPage from "./ActivationPage.vue";
import html from "../../index.html?raw";
import {
  createMemoryHistory,
  createRouter,
  createWebHistory,
} from "vue-router";
import App from "@/App.vue";
import { createAppRouter } from "@/router";
import { useAuth } from "@/composables/useAuth";
import { clearSession, getAccessToken, startSession } from "@/api/session";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

function mountPage(options: { attachTo?: HTMLElement } = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: ActivationPage },
      { path: "/activation", name: "activation", component: ActivationPage },
    ],
  });
  return mount(ActivationPage, { ...options, global: { plugins: [router] } });
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  clearSession();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(["booting", "failed", "ready"] as const)(
  "приложение показывает активацию при состоянии сессии %s и сохраняет текущего пользователя",
  async (status) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json(200, { message: "Email подтверждён. Теперь можно войти" }),
      );
    vi.stubGlobal("fetch", fetch);
    const auth = useAuth();
    auth.status.value = status;
    if (status === "ready")
      startSession({
        accessToken: "existing-user-token",
        expiresIn: 900,
        user: {
          id: "00000000-0000-4000-8000-000000000001",
          name: "other-user",
          email: "other-user@example.com",
        },
      });
    sessionStorage.setItem("file-service-activation-token", "private-token");
    const router = createAppRouter({
      history: createMemoryHistory(),
      auth,
      upload: { stop: vi.fn(), reset: vi.fn() },
      browser: { reset: vi.fn() },
      notify: vi.fn(),
    });
    await router.push("/activation");
    const wrapper = mount(App, {
      global: { plugins: [router], stubs: { Toaster: true } },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("Подтвердить email");
    expect(fetch).not.toHaveBeenCalled();
    await wrapper.get("button[data-confirm]").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Email подтверждён. Теперь можно войти");
    expect(getAccessToken()).toBe(
      status === "ready" ? "existing-user-token" : null,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  },
);

it("новая ссылка в уже открытой вкладке заменяет использованную форму и не отправляет старый секрет", async () => {
  const fetch = vi
    .fn()
    .mockImplementation(async () =>
      json(200, { message: "Email подтверждён. Теперь можно войти" }),
    );
  vi.stubGlobal("fetch", fetch);
  const router = createAppRouter({
    history: createMemoryHistory(),
    auth: useAuth(),
    upload: { stop: vi.fn(), reset: vi.fn() },
    browser: { reset: vi.fn() },
    notify: vi.fn(),
  });
  await router.push("/activation#token=first-token");
  const wrapper = mount(App, {
    global: { plugins: [router], stubs: { Toaster: true } },
  });
  await flushPromises();
  await wrapper.get("button[data-confirm]").trigger("click");
  await flushPromises();
  expect(wrapper.find("button[data-confirm]").exists()).toBe(false);
  await router.push("/activation#token=second-token");
  await flushPromises();
  expect(router.currentRoute.value.hash).toBe("");
  await wrapper.get("button[data-confirm]").trigger("click");
  await flushPromises();
  expect(JSON.parse(fetch.mock.calls.at(-1)![1].body)).toEqual({
    token: "second-token",
  });
  wrapper.unmount();
});

it("повторное открытие fragment в текущем документе сразу очищает настоящий адрес браузера", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(async () =>
        json(200, { message: "Email подтверждён. Теперь можно войти" }),
      ),
  );
  window.history.replaceState({}, "", "/activation#token=first-token");
  const history = createWebHistory();
  const router = createAppRouter({
    history,
    auth: useAuth(),
    upload: { stop: vi.fn(), reset: vi.fn() },
    browser: { reset: vi.fn() },
    notify: vi.fn(),
  });
  await router.push("/activation#token=first-token");
  const wrapper = mount(App, {
    global: { plugins: [router], stubs: { Toaster: true } },
  });
  try {
    await flushPromises();
    window.history.replaceState(
      window.history.state,
      "",
      "/activation#token=second-token",
    );
    await router.push("/activation#token=second-token");
    await flushPromises();
    expect(window.location.hash).toBe("");
    expect(router.options.history.location).toBe("/activation");
    expect(sessionStorage.getItem("file-service-activation-token")).toBe(
      "second-token",
    );
  } finally {
    wrapper.unmount();
    history.destroy();
    window.history.replaceState({}, "", "/");
  }
});

it("открытие новой ссылки отменяет прежний запрос, поздний ответ не удаляет новый секрет", async () => {
  let finish!: (response: Response) => void;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockImplementation(async () =>
      json(200, { message: "Email подтверждён. Теперь можно войти" }),
    );
  vi.stubGlobal("fetch", fetch);
  const router = createAppRouter({
    history: createMemoryHistory(),
    auth: useAuth(),
    upload: { stop: vi.fn(), reset: vi.fn() },
    browser: { reset: vi.fn() },
    notify: vi.fn(),
  });
  await router.push("/activation#token=first-token");
  const wrapper = mount(App, {
    global: { plugins: [router], stubs: { Toaster: true } },
  });
  await flushPromises();
  await wrapper.get("button[data-confirm]").trigger("click");
  const oldSignal = fetch.mock.calls[0]![1].signal as AbortSignal;
  await router.push("/activation#token=second-token");
  await flushPromises();
  expect(oldSignal.aborted).toBe(true);
  finish(json(200, { message: "Email подтверждён. Теперь можно войти" }));
  await flushPromises();
  expect(sessionStorage.getItem("file-service-activation-token")).toBe(
    "second-token",
  );
  expect(
    wrapper.get("button[data-confirm]").attributes("disabled"),
  ).toBeUndefined();
  await wrapper.get("button[data-confirm]").trigger("click");
  await flushPromises();
  expect(JSON.parse(fetch.mock.calls.at(-1)![1].body)).toEqual({
    token: "second-token",
  });
  wrapper.unmount();
});

it("повтор сохраняет email и ожидание после обновления без повторной отправки", async () => {
  vi.useFakeTimers();
  sessionStorage.setItem("file-service-activation-token", "private-token");
  const fetch = vi.fn().mockResolvedValue(
    json(202, {
      message: "Если требуется письмо, инструкции придут на email",
      retryAfterSeconds: 45,
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const wrapper = mountPage();
  await wrapper.get("input[name=email]").setValue("user@example.com");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.text()).toContain("Повторить можно через 45 с");
  const saved = sessionStorage.getItem("file-service-activation-form")!;
  wrapper.unmount();
  sessionStorage.setItem("file-service-activation-token", "private-token");
  sessionStorage.setItem("file-service-activation-form", saved);
  const reloaded = mountPage();
  expect(
    reloaded.get<HTMLInputElement>("input[name=email]").element.value,
  ).toBe("user@example.com");
  expect(reloaded.text()).toContain("Повторить можно через 45 с");
  expect(reloaded.find("button[data-confirm]").exists()).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(45000);
  expect(
    reloaded.get("button[type=submit]").attributes("disabled"),
  ).toBeUndefined();
  expect(localStorage.getItem("file-service-activation-token")).toBeNull();
  reloaded.unmount();
});

it.each(["NETWORK_ERROR", "SERVICE_UNAVAILABLE", "RATE_LIMITED"])(
  "временная ошибка %s сохраняет ссылку для ручного повтора",
  async (code) => {
    vi.useFakeTimers();
    sessionStorage.setItem("file-service-activation-token", "private-token");
    const fetch = vi.fn().mockResolvedValue(
      json(code === "RATE_LIMITED" ? 429 : 503, {
        error: {
          code,
          message: "Попробуйте позже",
          details: { retryAfterSeconds: 2 },
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const wrapper = mountPage({ attachTo: document.body });
    await wrapper.get("button[data-confirm]").trigger("click");
    await flushPromises();
    expect(sessionStorage.getItem("file-service-activation-token")).toBe(
      "private-token",
    );
    expect(wrapper.find("[role=alert]").exists()).toBe(true);
    if (code === "RATE_LIMITED") {
      expect(
        wrapper.get("button[data-confirm]").attributes("disabled"),
      ).toBeDefined();
      expect(wrapper.text()).toContain("Подтвердить можно через 2 с");
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(
      wrapper.get("button[data-confirm]").attributes("disabled"),
    ).toBeUndefined();
    fetch.mockResolvedValueOnce(
      json(200, { message: "Email подтверждён. Теперь можно войти" }),
    );
    await wrapper.get("button[data-confirm]").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Email подтверждён. Теперь можно войти");
    expect(sessionStorage.getItem("file-service-activation-token")).toBeNull();
    wrapper.unmount();
  },
);

it("недействительная ссылка удаляется, форма повтора остаётся доступной", async () => {
  sessionStorage.setItem("file-service-activation-token", "used-token");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      json(400, {
        error: {
          code: "ACTIVATION_LINK_INVALID",
          message: "Ссылка недействительна. Запросите новое письмо активации",
        },
      }),
    ),
  );
  const wrapper = mountPage();
  await wrapper.get("button[data-confirm]").trigger("click");
  await flushPromises();
  expect(wrapper.text()).toContain("Ссылка недействительна");
  expect(wrapper.find("button[data-confirm]").exists()).toBe(false);
  expect(wrapper.find("form").exists()).toBe(true);
  expect(sessionStorage.getItem("file-service-activation-token")).toBeNull();
  wrapper.unmount();
});

it("переход со страницы входа ничего не отправляет сам, письмо запрашивается вручную и даёт нейтральный ответ с ожиданием", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValue(
    json(202, {
      message: "Если требуется письмо, инструкции придут на email",
      retryAfterSeconds: 60,
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const wrapper = mountPage({ attachTo: document.body });
  await flushPromises();
  expect(fetch).not.toHaveBeenCalled();
  expect(wrapper.find("button[data-confirm]").exists()).toBe(false);
  await wrapper.get("input[name=email]").setValue("user@example.com");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toBe("/api/auth/activation/request");
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
    email: "user@example.com",
  });
  expect(wrapper.text()).toContain(
    "Если требуется письмо, инструкции придут на email",
  );
  expect(wrapper.text()).toContain("Повторить можно через 60 с");
  expect(
    wrapper.get("button[type=submit]").attributes("disabled"),
  ).toBeDefined();
  wrapper.unmount();
});

it("ошибка email имеет подпись, объявление и фокус на поле", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      json(422, {
        error: {
          code: "VALIDATION_ERROR",
          message: "Проверьте поля",
          details: {
            formErrors: [],
            fieldErrors: { email: ["Проверьте email"] },
          },
        },
      }),
    ),
  );
  const wrapper = mountPage({ attachTo: document.body });
  await wrapper.get("input[name=email]").setValue("bad");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  const input = wrapper.get<HTMLInputElement>("input[name=email]");
  expect(input.attributes("aria-invalid")).toBe("true");
  expect(wrapper.get("#activation-email-error").text()).toBe("Проверьте email");
  expect(document.activeElement).toBe(input.element);
  wrapper.unmount();
});

it("уход отменяет запрос, удаляет секрет и игнорирует поздний успех", async () => {
  sessionStorage.setItem("file-service-activation-token", "private-token");
  let finish!: (response: Response) => void;
  const fetch = vi.fn().mockReturnValue(
    new Promise<Response>((resolve) => {
      finish = resolve;
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const wrapper = mountPage();
  await wrapper.get("button[data-confirm]").trigger("click");
  const signal = fetch.mock.calls[0]![1].signal as AbortSignal;
  wrapper.unmount();
  expect(signal.aborted).toBe(true);
  expect(sessionStorage.getItem("file-service-activation-token")).toBeNull();
  expect(sessionStorage.getItem("file-service-activation-form")).toBeNull();
  finish(json(200, { message: "Email подтверждён. Теперь можно войти" }));
  await flushPromises();
  const reopened = mountPage();
  expect(reopened.find("button[data-confirm]").exists()).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  reopened.unmount();
});

it("возврат из кеша браузера после ухода не восстанавливает ссылку", async () => {
  sessionStorage.setItem("file-service-activation-token", "private-token");
  const wrapper = mountPage();
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: true });
  window.dispatchEvent(event);
  await flushPromises();
  expect(sessionStorage.getItem("file-service-activation-token")).toBeNull();
  expect(wrapper.find("button[data-confirm]").exists()).toBe(false);
  wrapper.unmount();
});

it("сразу удаляет fragment до запуска приложения и хранит секрет только в текущей вкладке", () => {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const location = {
    pathname: "/activation",
    search: "",
    hash: "#token=private-token",
  };
  const history = {
    state: null,
    replaceState: vi.fn(() => {
      location.hash = "";
    }),
  };
  new Function("location", "history", "sessionStorage", "performance", script)(
    location,
    history,
    sessionStorage,
    { getEntriesByType: () => [{ type: "navigate" }] },
  );
  expect(history.replaceState).toHaveBeenCalledWith(null, "", "/activation");
  expect(location.hash).toBe("");
  expect(sessionStorage.getItem("file-service-activation-token")).toBe(
    "private-token",
  );
  expect(localStorage.length).toBe(0);
  expect(html).toContain('name="referrer" content="no-referrer"');
});

it.each(["reload", "navigate", "back_forward"])(
  "загрузка без fragment типа %s сохраняет секрет только при обновлении",
  (type) => {
    sessionStorage.setItem("file-service-activation-token", "private-token");
    sessionStorage.setItem("file-service-activation-form", "saved-form");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    new Function(
      "location",
      "history",
      "sessionStorage",
      "performance",
      script,
    )({ pathname: "/activation", hash: "", search: "" }, {}, sessionStorage, {
      getEntriesByType: () => [{ type }],
    });
    expect(sessionStorage.getItem("file-service-activation-token")).toBe(
      type === "reload" ? "private-token" : null,
    );
    expect(sessionStorage.getItem("file-service-activation-form")).toBe(
      type === "reload" ? "saved-form" : null,
    );
  },
);

it("при запрете sessionStorage всё равно удаляет секрет из адресной строки", () => {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const history = { state: null, replaceState: vi.fn() };
  new Function("location", "history", "sessionStorage", "performance", script)(
    { pathname: "/activation", hash: "#token=private-token", search: "" },
    history,
    {
      removeItem: () => {
        throw new Error("denied");
      },
    },
    { getEntriesByType: () => [] },
  );
  expect(history.replaceState).toHaveBeenCalledWith(null, "", "/activation");
});

it("сохраняет форму после обновления и подтверждает только кнопкой, передавая секрет в JSON", async () => {
  sessionStorage.setItem("file-service-activation-token", "private-token");
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ message: "Email подтверждён. Теперь можно войти" }),
        { status: 200 },
      ),
    );
  vi.stubGlobal("fetch", fetch);
  const wrapper = mountPage({ attachTo: document.body });
  expect(fetch).not.toHaveBeenCalled();
  expect(wrapper.text()).toContain("Подтвердить email");
  await wrapper.get("button[data-confirm]").trigger("click");
  await flushPromises();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toBe("/api/auth/activation/confirm");
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
    token: "private-token",
  });
  expect(wrapper.text()).toContain("Email подтверждён. Теперь можно войти");
  expect(wrapper.find("a[href='/login']").exists()).toBe(true);
  expect(sessionStorage.getItem("file-service-activation-token")).toBeNull();
  expect(document.activeElement?.getAttribute("role")).toBe("status");
  wrapper.unmount();
});
