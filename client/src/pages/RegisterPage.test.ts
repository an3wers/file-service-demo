import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearSession, getAccessToken } from "@/api/session";
import RegisterPage from "./RegisterPage.vue";

const push = vi.fn();
const query: Record<string, unknown> = {};
vi.mock("vue-router", () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({ query }),
}));

const ATTEMPT_KEY = "file-service-registration-attempt";
const SECRET = "s".repeat(43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      Date: new Date().toUTCString(),
    },
  });
const attempt = (now = Date.now()) => ({
  message: "Если требуется письмо, инструкции придут на email",
  retryAfterSeconds: 45,
  attemptToken: SECRET,
  attemptExpiresAt: new Date(now + 900000).toISOString(),
  codeExpiresAt: new Date(now + 300000).toISOString(),
  resendAvailableAt: new Date(now + 60000).toISOString(),
});
const apiError = (code: string, status: number, details?: unknown) =>
  json({ error: { code, message: "Сообщение сервера", details } }, status);

beforeEach(() => {
  clearSession();
  sessionStorage.clear();
  localStorage.clear();
  push.mockReset();
  Object.keys(query).forEach((key) => delete query[key]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function fill(wrapper: ReturnType<typeof mount>) {
  await wrapper.get("input[name=name]").setValue(" Имя 😀 ");
  await wrapper.get("input[name=email]").setValue("User+tag@example.com");
  await wrapper.get("input[name=password]").setValue(" 1234567890😀 ");
}

it("показывает ожидание, затем экран «Проверьте почту» с адресом и без пароля", async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn().mockReturnValue(
    new Promise<Response>((resolve) => {
      finish = resolve;
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const wrapper = mount(RegisterPage, { attachTo: document.body });
  await fill(wrapper);
  await wrapper.get("button[aria-label='Показать пароль']").trigger("click");
  expect(wrapper.get("input[name=password]").attributes("type")).toBe("text");
  await wrapper.get("form").trigger("submit");
  expect(
    wrapper.get("button[type=submit]").attributes("disabled"),
  ).toBeDefined();
  expect(wrapper.text()).toContain("Обрабатываем запрос");
  finish(json(attempt(), 202));
  await flushPromises();
  expect(wrapper.text()).toContain("Проверьте почту");
  expect(wrapper.text()).toContain("User+tag@example.com");
  expect(wrapper.text()).toContain(
    "Если в письме есть код подтверждения, введите его ниже.",
  );
  expect(wrapper.text()).toContain("Письмо не пришло? Проверьте папку «Спам»");
  expect(wrapper.find("input[name=password]").exists()).toBe(false);
  expect(wrapper.find("a[href='/login']").exists()).toBe(true);
  expect(wrapper.find("a[href='/password-reset']").exists()).toBe(true);
  const stored = JSON.parse(sessionStorage.getItem(ATTEMPT_KEY)!);
  expect(stored.attempt.attemptToken).toBe(SECRET);
  expect(JSON.stringify(stored)).not.toContain("1234567890");
  expect(localStorage.length).toBe(0);
  await wrapper.get("button[data-change-email]").trigger("click");
  expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
  expect(
    wrapper.get<HTMLInputElement>("input[name=password]").element.value,
  ).toBe("");
  expect(wrapper.get<HTMLInputElement>("input[name=email]").element.value).toBe(
    "User+tag@example.com",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
    name: " Имя 😀 ",
    email: "User+tag@example.com",
    password: " 1234567890😀 ",
  });
  wrapper.unmount();
});

async function toCodeScreen(fetch: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetch);
  const wrapper = mount(RegisterPage, { attachTo: document.body });
  await fill(wrapper);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  return wrapper;
}

it("поле кода принимает вставку с ведущими нулями, отправляет только по Enter или кнопке и входит в хранилище", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(attempt(), 202))
    .mockResolvedValueOnce(
      json({
        accessToken: "access",
        expiresIn: 900,
        user: {
          id: "00000000-0000-4000-8000-000000000001",
          name: "Имя",
          email: "user@example.com",
        },
      }),
    );
  const wrapper = await toCodeScreen(fetch);
  const code = wrapper.get<HTMLInputElement>("input[name=code]");
  expect(code.attributes()).toMatchObject({
    type: "text",
    inputmode: "numeric",
    autocomplete: "one-time-code",
  });
  await code.setValue(" 012 345 ");
  expect(code.element.value).toBe("012345");
  expect(fetch).toHaveBeenCalledTimes(1);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1]![0]).toBe("/api/auth/registration/verify");
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
    attemptToken: SECRET,
    code: "012345",
  });
  expect(getAccessToken()).toBe("access");
  expect(push).toHaveBeenCalledWith("/");
  expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
  wrapper.unmount();
});

it("неполный код не отправляется, а неверный код показывает остаток проверок", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(attempt(), 202))
    .mockResolvedValueOnce(
      apiError("LOGIN_CODE_INVALID", 400, { remainingAttempts: 3 }),
    );
  const wrapper = await toCodeScreen(fetch);
  await wrapper.get("input[name=code]").setValue("01234");
  expect(
    wrapper.get("button[type=submit]").attributes("disabled"),
  ).toBeDefined();
  await wrapper.get("form").trigger("submit");
  expect(fetch).toHaveBeenCalledTimes(1);
  await wrapper.get("input[name=code]").setValue("012345");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(wrapper.text()).toContain("Осталось проверок: 3");
  expect(push).not.toHaveBeenCalled();
  expect(getAccessToken()).toBeNull();
  expect(sessionStorage.getItem(ATTEMPT_KEY)).not.toBeNull();
  wrapper.unmount();
});

it("пятая неверная проверка и завершённая попытка очищают секрет и оставляют переходы ко входу и восстановлению", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(attempt(), 202))
    .mockResolvedValueOnce(
      apiError("LOGIN_CODE_INVALID", 400, { remainingAttempts: 0 }),
    );
  const wrapper = await toCodeScreen(fetch);
  await wrapper.get("input[name=code]").setValue("012345");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
  expect(wrapper.get("input[name=code]").attributes("disabled")).toBeDefined();
  expect(wrapper.find("a[href='/login']").exists()).toBe(true);
  expect(wrapper.find("a[href='/password-reset']").exists()).toBe(true);
  wrapper.unmount();
});

it("вход в другой вкладке делает попытку непригодной: запрос не отправляется и секрет очищается", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json(attempt(), 202));
  const wrapper = await toCodeScreen(fetch);
  localStorage.setItem(
    "file-service-auth-state",
    JSON.stringify({ generation: 5, signedIn: true }),
  );
  await wrapper.get("input[name=code]").setValue("012345");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(getAccessToken()).toBeNull();
  expect(push).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
  wrapper.unmount();
});

it("секрет и код из адреса страницы не импортируются и не отправляются автоматически", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  Object.assign(query, { attemptToken: "foreign", code: "123456" });
  window.history.replaceState(
    null,
    "",
    "/register#attemptToken=foreign&code=123456",
  );
  const wrapper = mount(RegisterPage, { attachTo: document.body });
  await flushPromises();
  expect(wrapper.find("input[name=code]").exists()).toBe(false);
  expect(sessionStorage.getItem(ATTEMPT_KEY)).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  window.history.replaceState(null, "", "/");
  wrapper.unmount();
});

it("для существующего и нового email экран и поля одинаковы", async () => {
  const texts: string[] = [];
  for (const token of ["a".repeat(43), "b".repeat(43)]) {
    const wrapper = await toCodeScreen(
      vi
        .fn()
        .mockResolvedValue(json({ ...attempt(), attemptToken: token }, 202)),
    );
    texts.push(wrapper.html().replace(/\d+ с/g, "N с"));
    wrapper.unmount();
    sessionStorage.clear();
  }
  expect(texts[0]).toBe(texts[1]);
});

it("показывает ошибки у полей, переводит фокус и сохраняет ввод для ручного повтора", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "VALIDATION_ERROR",
            message: "Проверьте поля",
            details: {
              formErrors: [],
              fieldErrors: { password: ["Пароль слишком короткий"] },
            },
          },
        }),
        { status: 422 },
      ),
    ),
  );
  const wrapper = mount(RegisterPage, { attachTo: document.body });
  await fill(wrapper);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  const password = wrapper.get<HTMLInputElement>("input[name=password]");
  expect(password.attributes("aria-invalid")).toBe("true");
  expect(wrapper.get("#password-error").text()).toBe("Пароль слишком короткий");
  expect(password.element.value).toBe(" 1234567890😀 ");
  expect(document.activeElement).toBe(password.element);
  expect(
    wrapper.get("button[type=submit]").attributes("disabled"),
  ).toBeUndefined();
  wrapper.unmount();
});

it("при ограничении показывает секунды и запрещает повтор до конца ожидания", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "RATE_LIMITED",
            message: "Попробуйте позже",
            details: { retryAfterSeconds: 2 },
          },
        }),
        { status: 429 },
      ),
    ),
  );
  const wrapper = mount(RegisterPage);
  try {
    await fill(wrapper);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("Повторить можно через 2 с");
    expect(
      wrapper.get("button[type=submit]").attributes("disabled"),
    ).toBeDefined();
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      wrapper.get("button[type=submit]").attributes("disabled"),
    ).toBeUndefined();
    expect(
      wrapper.get<HTMLInputElement>("input[name=password]").element.value,
    ).toBe(" 1234567890😀 ");
  } finally {
    wrapper.unmount();
    vi.useRealTimers();
  }
});

it("уход отменяет запрос и новое открытие формы не восстанавливает пароль", async () => {
  const fetch = vi.fn().mockReturnValue(new Promise(() => {}));
  vi.stubGlobal("fetch", fetch);
  const wrapper = mount(RegisterPage);
  await fill(wrapper);
  await wrapper.get("form").trigger("submit");
  const signal = fetch.mock.calls[0]![1].signal as AbortSignal;
  wrapper.unmount();
  expect(signal.aborted).toBe(true);
  const reopened = mount(RegisterPage);
  expect(
    reopened.get<HTMLInputElement>("input[name=password]").element.value,
  ).toBe("");
  reopened.unmount();
});
