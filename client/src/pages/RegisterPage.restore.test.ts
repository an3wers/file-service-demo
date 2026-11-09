import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { clearSession } from "@/api/session";
import { writeSharedAuth } from "@/api/sharedAuth";
import RegisterPage from "./RegisterPage.vue";

const push = vi.fn();
const query: Record<string, unknown> = {};
vi.mock("vue-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-router")>()),
  useRouter: () => ({ push }),
  useRoute: () => ({ query }),
}));

function mountPage(options: { attachTo?: HTMLElement } = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: ["/", "/login", "/password-reset"].map((path) => ({
      path,
      component: { template: "<div />" },
    })),
  });
  return mount(RegisterPage, { ...options, global: { plugins: [router] } });
}

const ATTEMPT_KEY = "file-service-registration-attempt";
const SECRET = "s".repeat(43);
const json = (body: unknown, status = 200, date = new Date()) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      Date: date.toUTCString(),
    },
  });
const apiError = (code: string, status: number, details?: unknown) =>
  json({ error: { code, message: "Сообщение сервера", details } }, status);
const attempt = (now = Date.now()) => ({
  message: "Если требуется письмо, инструкции придут на email",
  retryAfterSeconds: 45,
  attemptToken: SECRET,
  attemptExpiresAt: new Date(now + 900000).toISOString(),
  codeExpiresAt: new Date(now + 300000).toISOString(),
  resendAvailableAt: new Date(now + 60000).toISOString(),
});
const session = {
  accessToken: "access",
  expiresIn: 900,
  user: { id: "00000000-0000-4000-8000-000000000001", name: "Имя", email: "u@example.com" },
};

function seed(overrides: Record<string, unknown> = {}, now = Date.now()) {
  sessionStorage.setItem(
    ATTEMPT_KEY,
    JSON.stringify({
      attempt: attempt(now),
      email: "User+tag@example.com",
      generation: 0,
      remainingAttempts: 3,
      clockOffset: 0,
      ...overrides,
    }),
  );
}

beforeEach(() => {
  clearSession();
  sessionStorage.clear();
  localStorage.clear();
  writeSharedAuth({ generation: 0, signedIn: false });
  push.mockReset();
  Object.keys(query).forEach((key) => delete query[key]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function open() {
  const wrapper = mountPage({ attachTo: document.body });
  await flushPromises();
  return wrapper;
}

it("обновление страницы восстанавливает экран подтверждения без запросов и без смены сроков", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  seed();
  const before = sessionStorage.getItem(ATTEMPT_KEY);
  const wrapper = await open();
  expect(wrapper.text()).toContain("User+tag@example.com");
  expect(wrapper.text()).toContain("Осталось проверок: 3");
  expect(wrapper.find("input[name=code]").exists()).toBe(true);
  expect(wrapper.find("a[href='/login']").exists()).toBe(true);
  expect(wrapper.find("a[href='/password-reset']").exists()).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(ATTEMPT_KEY)).toBe(before);
  wrapper.unmount();
});

it("восстановленная попытка завершается исходным кодом с прежним секретом и поколением", async () => {
  const fetch = vi.fn().mockResolvedValue(json(session));
  vi.stubGlobal("fetch", fetch);
  seed();
  const wrapper = await open();
  await wrapper.get("input[name=code]").setValue("012345");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toBe("/api/auth/registration/verify");
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
    attemptToken: SECRET,
    code: "012345",
  });
  expect(push).toHaveBeenCalled();
  expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
  wrapper.unmount();
});

it("сроки восстановленной попытки считаются по серверному времени, а не по часам устройства", async () => {
  vi.stubGlobal("fetch", vi.fn());
  const serverNowMs = Date.now() + 3600_000;
  seed(
    {
      attempt: {
        ...attempt(serverNowMs),
        attemptExpiresAt: new Date(serverNowMs + 900000).toISOString(),
        codeExpiresAt: new Date(serverNowMs - 1000).toISOString(),
      },
      clockOffset: 3600_000,
    },
    serverNowMs,
  );
  const wrapper = await open();
  await wrapper.get("input[name=code]").setValue("012345");
  expect(
    wrapper.get("button[type=submit]").attributes("disabled"),
  ).toBeUndefined();
  expect(wrapper.text()).not.toContain("Срок действия кода истёк");
  expect(
    wrapper.get("button[data-action=resend]").attributes("disabled"),
  ).toBeDefined();
  wrapper.unmount();
});

it.each([
  ["битый JSON", "{"],
  ["не объект", "42"],
  ["секрет неверной формы", JSON.stringify({ attempt: { ...attempt(), attemptToken: "short" }, email: "a@b.c", generation: 0, remainingAttempts: null, clockOffset: 0 })],
  ["срок не дата", JSON.stringify({ attempt: { ...attempt(), codeExpiresAt: "x" }, email: "a@b.c", generation: 0, remainingAttempts: null, clockOffset: 0 })],
  ["нет адреса", JSON.stringify({ attempt: attempt(), generation: 0, remainingAttempts: null, clockOffset: 0 })],
])("повреждённое локальное состояние (%s) не восстанавливается и очищается", async (_name, raw) => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  sessionStorage.setItem(ATTEMPT_KEY, raw);
  const wrapper = await open();
  expect(wrapper.find("input[name=password]").exists()).toBe(true);
  expect(wrapper.find("input[name=code]").exists()).toBe(false);
  expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  wrapper.unmount();
});

it("секрет и адрес из адресной строки не импортируются в попытку", async () => {
  vi.stubGlobal("fetch", vi.fn());
  query.attemptToken = SECRET;
  query.email = "attacker@example.com";
  const wrapper = await open();
  expect(wrapper.find("input[name=password]").exists()).toBe(true);
  expect(wrapper.text()).not.toContain("attacker@example.com");
  wrapper.unmount();
});

it("истёкшая попытка после обновления очищает секрет и ведёт ко входу и восстановлению", async () => {
  vi.stubGlobal("fetch", vi.fn());
  const past = Date.now() - 1000_000;
  seed({ attempt: attempt(past) });
  const wrapper = await open();
  expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
  expect(wrapper.text()).toContain("Попытка завершена");
  expect(wrapper.get("input[name=code]").attributes("disabled")).toBeDefined();
  expect(wrapper.find("a[href='/login']").exists()).toBe(true);
  expect(wrapper.find("a[href='/password-reset']").exists()).toBe(true);
  wrapper.unmount();
});

it("при смене общего входа секрет не восстанавливается", async () => {
  vi.stubGlobal("fetch", vi.fn());
  seed();
  writeSharedAuth({ generation: 1, signedIn: true });
  const wrapper = await open();
  expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
  expect(wrapper.get("input[name=code]").attributes("disabled")).toBeDefined();
  expect(wrapper.text()).not.toContain("Осталось проверок");
  wrapper.unmount();
});

it("потеря вкладки с секретом даёт форму со ссылками ко входу и восстановлению", async () => {
  vi.stubGlobal("fetch", vi.fn());
  const wrapper = await open();
  expect(wrapper.find("input[name=password]").exists()).toBe(true);
  expect(wrapper.find("a[href='/login']").exists()).toBe(true);
  expect(wrapper.find("a[href='/password-reset']").exists()).toBe(true);
  wrapper.unmount();
});

it("истечение попытки на открытой странице очищает секрет", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn());
  const now = Date.now();
  seed({
    attempt: { ...attempt(now), attemptExpiresAt: new Date(now + 2000).toISOString() },
  });
  const wrapper = await open();
  expect(wrapper.text()).not.toContain("Попытка завершена");
  await vi.advanceTimersByTimeAsync(3000);
  expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
  expect(wrapper.text()).toContain("Попытка завершена");
  wrapper.unmount();
});

it("вход в другой вкладке завершает попытку и очищает локальное состояние", async () => {
  vi.stubGlobal("fetch", vi.fn());
  seed();
  const wrapper = await open();
  await wrapper.get("input[name=code]").setValue("012345");
  localStorage.setItem(
    "file-service-auth-state",
    JSON.stringify({ generation: 1, signedIn: true }),
  );
  const other = new BroadcastChannel("file-service-auth");
  other.postMessage({ type: "login" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  other.close();
  await flushPromises();
  expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
  expect(
    wrapper.get<HTMLInputElement>("input[name=code]").element.value,
  ).toBe("");
  expect(wrapper.text()).toContain("Попытка завершена");
  wrapper.unmount();
});

it("сетевой сбой проверки после обновления сохраняет попытку, а не считается неверным кодом", async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockRejectedValueOnce(new TypeError("offline"));
  vi.stubGlobal("fetch", fetch);
  seed();
  const wrapper = await open();
  await wrapper.get("input[name=code]").setValue("012345");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(sessionStorage.getItem(ATTEMPT_KEY)).not.toBeNull();
  expect(wrapper.text()).not.toContain("Попытка завершена");
  expect(wrapper.text()).toContain("Осталось проверок: 3");
  expect(wrapper.get("input[name=code]").attributes("disabled")).toBeUndefined();
  wrapper.unmount();
});

it("потерянный ответ проверки: refresh-cookie возвращает уже созданную сессию", async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(json(session));
  vi.stubGlobal("fetch", fetch);
  seed();
  const wrapper = await open();
  await wrapper.get("input[name=code]").setValue("012345");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([
    "/api/auth/registration/verify",
    "/api/auth/refresh",
  ]);
  expect(push).toHaveBeenCalled();
  expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
  wrapper.unmount();
});

it("сбой проверки без refresh-cookie сохраняет попытку и поле кода и показывает ошибку со ссылками ко входу и восстановлению", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(apiError("INTERNAL", 503))
    .mockResolvedValueOnce(apiError("SESSION_EXPIRED", 401));
  vi.stubGlobal("fetch", fetch);
  seed();
  const wrapper = await open();
  await wrapper.get("input[name=code]").setValue("012345");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(push).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(ATTEMPT_KEY)).not.toBeNull();
  expect(wrapper.text()).not.toContain("Попытка завершена");
  expect(wrapper.find("[role=alert]").exists()).toBe(true);
  expect(wrapper.get<HTMLInputElement>("input[name=code]").element.value).toBe(
    "012345",
  );
  expect(wrapper.get("input[name=code]").attributes("disabled")).toBeUndefined();
  expect(wrapper.find("a[href='/login']").exists()).toBe(true);
  expect(wrapper.find("a[href='/password-reset']").exists()).toBe(true);
  wrapper.unmount();
});

it("сбой проверки при смене общего входа завершает попытку", async () => {
  const fetch = vi.fn().mockImplementationOnce(async () => {
    writeSharedAuth({ generation: 5, signedIn: false });
    return apiError("INTERNAL", 503);
  });
  vi.stubGlobal("fetch", fetch);
  seed();
  const wrapper = await open();
  await wrapper.get("input[name=code]").setValue("012345");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
  expect(wrapper.text()).toContain("Попытка завершена");
  wrapper.unmount();
});

it("потерянный ответ и недоступный refresh сохраняют попытку для продолжения", async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockRejectedValueOnce(new TypeError("offline"));
  vi.stubGlobal("fetch", fetch);
  seed();
  const wrapper = await open();
  await wrapper.get("input[name=code]").setValue("012345");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(sessionStorage.getItem(ATTEMPT_KEY)).not.toBeNull();
  expect(push).not.toHaveBeenCalled();
  wrapper.unmount();
});

it("ответ о смене общего входа очищает секрет и не создаёт сессию", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  seed();
  const wrapper = await open();
  await wrapper.get("input[name=code]").setValue("012345");
  writeSharedAuth({ generation: 5, signedIn: false });
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(fetch).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
  expect(push).not.toHaveBeenCalled();
  wrapper.unmount();
});
