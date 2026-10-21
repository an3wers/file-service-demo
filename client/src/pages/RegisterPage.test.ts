import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import RegisterPage from "./RegisterPage.vue";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fill(wrapper: ReturnType<typeof mount>) {
  await wrapper.get("input[name=name]").setValue(" Имя 😀 ");
  await wrapper.get("input[name=email]").setValue("User+tag@example.com");
  await wrapper.get("input[name=password]").setValue(" 1234567890😀 ");
}

it("показывает ожидание, нейтральный результат и возвращает форму без пароля", async () => {
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
  finish(
    new Response(
      JSON.stringify({
        message: "Если требуется письмо, инструкции придут на email",
        retryAfterSeconds: 45,
      }),
      { status: 202 },
    ),
  );
  await flushPromises();
  expect(wrapper.text()).toContain(
    "Если требуется письмо, инструкции придут на email",
  );
  expect(wrapper.find("input[name=password]").exists()).toBe(false);
  expect(wrapper.find("a[href='/login']").exists()).toBe(true);
  await wrapper.get("button[data-change-email]").trigger("click");
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

it("показывает ошибки у полей, переводит фокус и сохраняет ввод для ручного повтора", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
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
    vi
      .fn()
      .mockResolvedValue(
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
