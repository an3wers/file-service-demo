import { beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { clearSession } from "@/api/session"
import LoginPage from "./LoginPage.vue"

const push = vi.fn()

vi.mock("vue-router", () => ({ useRouter: () => ({ push }) }))

function mountPage() {
  return mount(LoginPage, { attachTo: document.body })
}

function submitButton(wrapper: ReturnType<typeof mountPage>) {
  return wrapper.get("button[type=submit]")
}

beforeEach(() => {
  clearSession()
})

describe("страница входа", () => {
  it("кнопка «Войти» неактивна, пока логин или пароль пусты", async () => {
    const wrapper = mountPage()

    expect(submitButton(wrapper).attributes("disabled")).toBeDefined()

    await wrapper.get("input[name=login]").setValue("admin")
    expect(submitButton(wrapper).attributes("disabled")).toBeDefined()

    await wrapper.get("input[name=password]").setValue("secret")
    expect(submitButton(wrapper).attributes("disabled")).toBeUndefined()
  })

  it("на INVALID_CREDENTIALS показывает общую ошибку, очищает пароль и ставит в него фокус", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "INVALID_CREDENTIALS", message: "Invalid login or password" },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
      ),
    )

    const wrapper = mountPage()
    const password = wrapper.get<HTMLInputElement>("input[name=password]")

    await wrapper.get("input[name=login]").setValue("admin")
    await password.setValue("wrong")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(wrapper.text()).toContain("Неверный логин или пароль")
    expect(password.element.value).toBe("")
    expect(document.activeElement).toBe(password.element)
    expect(push).not.toHaveBeenCalled()
  })

  it("после успешного входа переходит на /", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ accessToken: "t", expiresIn: 900, user: { login: "admin" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    )

    const wrapper = mountPage()

    await wrapper.get("input[name=login]").setValue("admin")
    await wrapper.get("input[name=password]").setValue("secret")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(push).toHaveBeenCalledWith({ name: "files" })
  })
})
