import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMemoryHistory } from "vue-router"
import type { AuthSession } from "@/api/generated"
import { clearSession, getAccessToken, onSessionExpired } from "@/api/session"
import { createAuth } from "@/composables/useAuth"
import type { AuthChannel, AuthMessage } from "@/composables/useAuth"
import { createAppRouter } from "./index"

const SESSION: AuthSession = {
  accessToken: "token",
  expiresIn: 900,
  user: { login: "admin" },
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function respondWith(...responses: Array<() => Response | Promise<Response>>) {
  const fetchMock = vi.fn()

  for (const respond of responses) {
    fetchMock.mockImplementationOnce(async () => respond())
  }

  vi.stubGlobal("fetch", fetchMock)

  return fetchMock
}

const signedIn = () => json(200, SESSION)
const guest = () =>
  json(401, { error: { code: "SESSION_EXPIRED", message: "" } })
const offline = () => Promise.reject(new TypeError("Failed to fetch"))

class FakeChannel implements AuthChannel {
  posted: AuthMessage[] = []
  private listener: ((event: MessageEvent<AuthMessage>) => void) | null = null

  postMessage(message: AuthMessage): void {
    this.posted.push(message)
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<AuthMessage>) => void,
  ): void {
    this.listener = listener
  }

  deliver(message: AuthMessage): void {
    this.listener?.(new MessageEvent("message", { data: message }))
  }
}

function setup() {
  const channel = new FakeChannel()
  const auth = createAuth(channel)
  const upload = { cancel: vi.fn() }
  const browser = { reset: vi.fn() }
  const notify = vi.fn()
  const router = createAppRouter({
    history: createMemoryHistory(),
    auth,
    upload,
    browser,
    notify,
  })

  return { channel, auth, upload, browser, notify, router }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  clearSession()
})

afterEach(() => {
  onSessionExpired(null)
})

describe("роутер", () => {
  it("перебрасывает гостя с / на /login", async () => {
    respondWith(guest)

    const { router } = setup()

    await router.push("/")

    expect(router.currentRoute.value.name).toBe("login")
  })

  it("перебрасывает вошедшего с /login на /", async () => {
    respondWith(signedIn)

    const { router } = setup()

    await router.push("/login")

    expect(router.currentRoute.value.name).toBe("files")
  })

  it("при NETWORK_ERROR на старте никуда не перебрасывает", async () => {
    respondWith(offline)

    const { router, auth } = setup()

    await router.push("/")

    expect(router.currentRoute.value.path).toBe("/")
    expect(auth.status.value).toBe("failed")
    expect(auth.bootError.value).toMatchObject({ code: "NETWORK_ERROR" })
  })

  it("делает одно продление на старте на все навигации", async () => {
    const fetchMock = respondWith(signedIn)

    const { router } = setup()

    await router.push("/")
    await router.push("/unknown")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.name).toBe("files")
  })

  it("при истечении сессии отменяет загрузку, сохраняет навигацию и показывает тост", async () => {
    respondWith(signedIn, guest)

    const { router, upload, browser, notify } = setup()

    await router.push("/")

    const { apiRequest } = await import("@/api/client")

    await expect(apiRequest("/files")).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    })
    await settle()

    expect(upload.cancel).toHaveBeenCalled()
    expect(browser.reset).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith("Сессия истекла — войдите снова")
    expect(router.currentRoute.value.name).toBe("login")
  })

  it("при выходе сообщает другим вкладкам, отменяет загрузку и сбрасывает навигацию", async () => {
    respondWith(signedIn, () => new Response(null, { status: 204 }))

    const { router, auth, channel, upload, browser } = setup()

    await router.push("/")
    await auth.logout()
    await settle()

    expect(channel.posted).toEqual([{ type: "logout" }])
    expect(getAccessToken()).toBeNull()
    expect(upload.cancel).toHaveBeenCalled()
    expect(browser.reset).toHaveBeenCalled()
    expect(router.currentRoute.value.name).toBe("login")
  })

  it("выходит локально, даже если POST /logout упал", async () => {
    respondWith(signedIn, offline)

    const { router, auth } = setup()

    await router.push("/")
    await auth.logout()
    await settle()

    expect(getAccessToken()).toBeNull()
    expect(router.currentRoute.value.name).toBe("login")
  })
})

describe("канал между вкладками", () => {
  it("«выход» в другой вкладке очищает сессию, отменяет загрузку и переводит на /login", async () => {
    const fetchMock = respondWith(signedIn)

    const { router, channel, upload, browser, notify } = setup()

    await router.push("/")
    channel.deliver({ type: "logout" })
    await settle()

    expect(getAccessToken()).toBeNull()
    expect(upload.cancel).toHaveBeenCalled()
    expect(browser.reset).toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith("Вы вышли в другой вкладке")
    expect(router.currentRoute.value.name).toBe("login")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(channel.posted).toEqual([])
  })

  it("«выход» в другой вкладке не трогает вкладку без сессии", async () => {
    respondWith(guest)

    const { router, channel, upload, browser, notify } = setup()

    await router.push("/login")
    channel.deliver({ type: "logout" })
    await settle()

    expect(upload.cancel).not.toHaveBeenCalled()
    expect(browser.reset).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it("«вход» в другой вкладке на /login продлевает сессию и переводит на /", async () => {
    const fetchMock = respondWith(guest, signedIn)

    const { router, channel } = setup()

    await router.push("/login")
    channel.deliver({ type: "login" })
    await settle()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getAccessToken()).toBe("token")
    expect(router.currentRoute.value.name).toBe("files")
  })

  it("«вход» в другой вкладке вне /login ничего не делает", async () => {
    const fetchMock = respondWith(signedIn)

    const { router, channel } = setup()

    await router.push("/")
    channel.deliver({ type: "login" })
    await settle()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
