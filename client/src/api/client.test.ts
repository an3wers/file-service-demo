import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AuthSession } from "@/api/generated"
import { apiRequest, apiUpload } from "./client"
import {
  clearSession,
  getAccessToken,
  onSessionExpired,
  startSession,
} from "./session"

function session(accessToken: string, expiresIn = 900): AuthSession {
  return { accessToken, expiresIn, user: { login: "admin" } }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function failure(status: number, code: string): Response {
  return json(status, { error: { code, message: code } })
}

function bearer(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("Authorization")
}

interface FakeXhr {
  url: string
  headers: Record<string, string>
}

function stubXhr(respond: (request: FakeXhr) => { status: number; body: unknown }) {
  const sent: FakeXhr[] = []

  class FakeXMLHttpRequest extends EventTarget {
    status = 0
    responseText = ""
    upload = new EventTarget()
    private request: FakeXhr = { url: "", headers: {} }

    open(_method: string, url: string): void {
      this.request = { url, headers: {} }
    }

    setRequestHeader(name: string, value: string): void {
      this.request.headers[name] = value
    }

    send(): void {
      sent.push(this.request)

      const { status, body } = respond(this.request)

      queueMicrotask(() => {
        this.status = status
        this.responseText = JSON.stringify(body)
        this.dispatchEvent(new Event("load"))
      })
    }

    abort(): void {}
  }

  vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest)

  return sent
}

const expired = vi.fn()

beforeEach(() => {
  clearSession()
  onSessionExpired(expired)
})

afterEach(() => {
  onSessionExpired(null)
})

describe("запрос к API", () => {
  it("делает одно продление на параллельные 401 и повторяет оба запроса", async () => {
    startSession(session("old"))

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/refresh") {
        return json(200, session("new"))
      }

      return bearer(init) === "Bearer new"
        ? json(200, { ok: url })
        : failure(401, "UNAUTHORIZED")
    })

    vi.stubGlobal("fetch", fetchMock)

    const results = await Promise.all([
      apiRequest("/files"),
      apiRequest("/directories"),
    ])

    expect(results).toEqual([{ ok: "/api/files" }, { ok: "/api/directories" }])
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/auth/refresh"),
    ).toHaveLength(1)
    expect(getAccessToken()).toBe("new")
  })

  it("повторяет запрос с новым токеном после продления", async () => {
    startSession(session("old"))

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failure(401, "UNAUTHORIZED"))
      .mockResolvedValueOnce(json(200, session("new")))
      .mockResolvedValueOnce(json(200, { items: [] }))

    vi.stubGlobal("fetch", fetchMock)

    await expect(apiRequest("/files")).resolves.toEqual({ items: [] })

    const [first, renewal, retry] = fetchMock.mock.calls

    expect(bearer(first[1])).toBe("Bearer old")
    expect(renewal[0]).toBe("/api/auth/refresh")
    expect(retry[0]).toBe("/api/files")
    expect(bearer(retry[1])).toBe("Bearer new")
  })

  it("на SESSION_EXPIRED вызывает onSessionExpired и не повторяет запрос", async () => {
    startSession(session("old"))

    const fetchMock = vi.fn().mockResolvedValue(failure(401, "SESSION_EXPIRED"))

    vi.stubGlobal("fetch", fetchMock)

    await expect(apiRequest("/files")).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(expired).toHaveBeenCalledTimes(1)
    expect(getAccessToken()).toBeNull()
  })

  it("вызывает onSessionExpired, если продление после 401 не удалось", async () => {
    startSession(session("old"))

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failure(401, "UNAUTHORIZED"))
      .mockResolvedValueOnce(failure(401, "SESSION_EXPIRED"))

    vi.stubGlobal("fetch", fetchMock)

    await expect(apiRequest("/files")).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(expired).toHaveBeenCalledTimes(1)
  })

  it("продлевает сессию заранее, если до истечения меньше 30 секунд", async () => {
    startSession(session("old", 20))

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, session("new")))
      .mockResolvedValueOnce(json(200, { items: [] }))

    vi.stubGlobal("fetch", fetchMock)

    await apiRequest("/files")

    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/refresh")
    expect(bearer(fetchMock.mock.calls[1][1])).toBe("Bearer new")
  })

  it("без токена не продлевает сессию на 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(failure(401, "UNAUTHORIZED"))

    vi.stubGlobal("fetch", fetchMock)

    await expect(apiRequest("/files")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("продление, завершившееся после выхода, не возвращает сессию", async () => {
    startSession(session("old", 20))

    let answer: (response: Response) => void = () => {}
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => (answer = resolve)),
      )
      .mockResolvedValue(failure(401, "UNAUTHORIZED"))

    vi.stubGlobal("fetch", fetchMock)

    const request = apiRequest("/files")

    clearSession()
    answer(json(200, session("new")))

    await expect(request).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    expect(getAccessToken()).toBeNull()
  })

  it("не продлевает сессию, пока до истечения больше 30 секунд", async () => {
    startSession(session("old", 60))

    const fetchMock = vi.fn().mockResolvedValue(json(200, { items: [] }))

    vi.stubGlobal("fetch", fetchMock)

    await apiRequest("/files")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(bearer(fetchMock.mock.calls[0][1])).toBe("Bearer old")
  })
})

describe("отправка файла через XHR", () => {
  it("на 401 продлевает сессию и повторяет отправку с новым токеном", async () => {
    startSession(session("old"))
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(200, session("new"))))

    const sent = stubXhr(({ headers }) =>
      headers.Authorization === "Bearer new"
        ? { status: 201, body: { id: "file-1" } }
        : { status: 401, body: { error: { code: "UNAUTHORIZED", message: "" } } },
    )

    await expect(apiUpload("/files", new FormData())).resolves.toEqual({
      id: "file-1",
    })
    expect(sent.map(({ headers }) => headers.Authorization)).toEqual([
      "Bearer old",
      "Bearer new",
    ])
  })

  it("делает одно продление на параллельные 401 при отправке файлов", async () => {
    startSession(session("old"))

    const fetchMock = vi.fn().mockResolvedValue(json(200, session("new")))

    vi.stubGlobal("fetch", fetchMock)
    stubXhr(({ headers }) =>
      headers.Authorization === "Bearer new"
        ? { status: 201, body: { id: "file" } }
        : { status: 401, body: { error: { code: "UNAUTHORIZED", message: "" } } },
    )

    await Promise.all([
      apiUpload("/files", new FormData()),
      apiUpload("/files", new FormData()),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("на SESSION_EXPIRED вызывает onSessionExpired и не повторяет отправку", async () => {
    startSession(session("old"))
    vi.stubGlobal("fetch", vi.fn())

    const sent = stubXhr(() => ({
      status: 401,
      body: { error: { code: "SESSION_EXPIRED", message: "" } },
    }))

    await expect(apiUpload("/files", new FormData())).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    })
    expect(sent).toHaveLength(1)
    expect(expired).toHaveBeenCalledTimes(1)
  })
})
