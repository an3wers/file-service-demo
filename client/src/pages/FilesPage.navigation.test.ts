import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { fireEvent, screen } from "@testing-library/vue";
import FilesPage from "./FilesPage.vue";
import { useFileBrowser } from "@/composables/useFileBrowser";
import { startSession } from "@/api/session";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function mountPage(url: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: FilesPage }],
  });
  await router.push(url);
  await router.isReady();
  const wrapper = mount(FilesPage, {
    attachTo: document.body,
    global: { plugins: [router] },
  });
  await flushPromises();
  return { wrapper, router };
}

beforeEach(() => {
  useFileBrowser().reset();
  startSession({
    accessToken: "token",
    expiresIn: 3600,
    user: { login: "operator" },
  });
});

afterEach(() => vi.useRealTimers());

describe("состояние списка файлов в адресе страницы", () => {
  it("восстанавливает каталог, поиск и страницу по прямой ссылке и при повторном открытии", async () => {
    const requests: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url, "http://localhost");
        requests.push(parsed);
        if (parsed.pathname === "/api/directories")
          return json({ parent: "docs", items: [] });
        return json({
          items: [],
          pagination: { page: 3, limit: 20, total: 60, totalPages: 3 },
        });
      }),
    );
    const first = await mountPage("/?directory=docs&search=report&page=3");
    expect(
      (screen.getByLabelText("Поиск по имени файла") as HTMLInputElement).value,
    ).toBe("report");
    expect(screen.getByText("docs")).toBeTruthy();
    expect(
      requests.some(
        (request) =>
          request.pathname === "/api/files" &&
          request.searchParams.get("directory") === "docs" &&
          request.searchParams.get("search") === "report" &&
          request.searchParams.get("page") === "3" &&
          request.searchParams.get("recursive") === "true",
      ),
    ).toBe(true);
    expect(
      requests.some(
        (request) =>
          request.pathname === "/api/directories" &&
          request.searchParams.get("parent") === "docs",
      ),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Page 3" })
        .getAttribute("aria-current"),
    ).toBe("page");
    const address = first.router.currentRoute.value.fullPath;
    first.wrapper.unmount();
    const reopened = await mountPage(address);
    expect(
      (screen.getByLabelText("Поиск по имени файла") as HTMLInputElement).value,
    ).toBe("report");
    expect(screen.getByText("docs")).toBeTruthy();
    expect(reopened.router.currentRoute.value.query).toEqual({
      directory: "docs",
      search: "report",
      page: "3",
    });
  });

  it("записывает переход к родителю и корню, сбрасывает фильтры и восстанавливает вид по истории", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url, "http://localhost");
        if (parsed.pathname === "/api/directories")
          return json({
            parent: parsed.searchParams.get("parent") ?? "",
            items: [],
          });
        return json({
          items: [],
          pagination: {
            page: Number(parsed.searchParams.get("page")),
            limit: 20,
            total: 60,
            totalPages: 3,
          },
        });
      }),
    );
    const { router } = await mountPage(
      "/?directory=docs/reports&search=report&page=3&display=compact",
    );
    await fireEvent.click(screen.getByRole("button", { name: "docs" }));
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({
      directory: "docs",
      display: "compact",
    });
    expect(
      (screen.getByLabelText("Поиск по имени файла") as HTMLInputElement).value,
    ).toBe("");
    expect(
      screen
        .getByRole("button", { name: "Page 1" })
        .getAttribute("aria-current"),
    ).toBe("page");
    await fireEvent.click(screen.getByRole("button", { name: "Все файлы" }));
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ display: "compact" });
    router.back();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({
      directory: "docs",
      display: "compact",
    });
    router.back();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({
      directory: "docs/reports",
      search: "report",
      page: "3",
      display: "compact",
    });
    expect(
      (screen.getByLabelText("Поиск по имени файла") as HTMLInputElement).value,
    ).toBe("report");
    expect(
      screen
        .getByRole("button", { name: "Page 3" })
        .getAttribute("aria-current"),
    ).toBe("page");
    router.forward();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({
      directory: "docs",
      display: "compact",
    });
    router.forward();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ display: "compact" });
  });

  it("различает неизвестный и пустой каталог и позволяет восстановить действия переходом в корень", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url, "http://localhost");
        if (parsed.pathname === "/api/directories") {
          const parent = parsed.searchParams.get("parent") ?? "";
          if (parent === "missing")
            return json(
              { error: { code: "DIRECTORY_NOT_FOUND", message: "missing" } },
              404,
            );
          return json({ parent, items: [] });
        }
        return json({
          items: [],
          pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
        });
      }),
    );
    const { router } = await mountPage(
      "/?directory=missing&search=report&page=2",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Директория не найдена",
    );
    expect(screen.queryByText("Здесь пока пусто")).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Создать каталог",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Загрузить файл",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await fireEvent.click(
      screen.getByRole("button", { name: "Перейти в корень" }),
    );
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({});
    expect(screen.getByText("Здесь пока пусто")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Создать каталог",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "Загрузить файл",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    await router.push("/?directory=empty");
    await flushPromises();
    expect(screen.getByText("empty")).toBeTruthy();
    expect(screen.getByText("Здесь пока пусто")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Загрузить файл",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("сохраняет поиск и страницу в истории и отменяет отложенный поиск при возврате и повторном открытии", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url, "http://localhost");
        if (parsed.pathname === "/api/directories")
          return json({ parent: "docs", items: [] });
        return json({
          items: [],
          pagination: {
            page: Number(parsed.searchParams.get("page")),
            limit: 20,
            total: 60,
            totalPages: 3,
          },
        });
      }),
    );
    const { router, wrapper } = await mountPage("/?directory=docs&page=3");
    await fireEvent.update(
      screen.getByLabelText("Поиск по имени файла"),
      "report",
    );
    await vi.advanceTimersByTimeAsync(350);
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({
      directory: "docs",
      search: "report",
    });
    expect(
      screen
        .getByRole("button", { name: "Page 1" })
        .getAttribute("aria-current"),
    ).toBe("page");
    await fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({
      directory: "docs",
      search: "report",
      page: "2",
    });
    await fireEvent.update(
      screen.getByLabelText("Поиск по имени файла"),
      "stale",
    );
    router.back();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(350);
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({
      directory: "docs",
      search: "report",
    });
    expect(
      (screen.getByLabelText("Поиск по имени файла") as HTMLInputElement).value,
    ).toBe("report");
    router.back();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({
      directory: "docs",
      page: "3",
    });
    router.forward();
    await flushPromises();
    await fireEvent.update(
      screen.getByLabelText("Поиск по имени файла"),
      "unmounted",
    );
    const address = router.currentRoute.value.fullPath;
    wrapper.unmount();
    const reopened = await mountPage(address);
    await vi.advanceTimersByTimeAsync(350);
    await flushPromises();
    expect(reopened.router.currentRoute.value.query).toEqual({
      directory: "docs",
      search: "report",
    });
    expect(
      (screen.getByLabelText("Поиск по имени файла") as HTMLInputElement).value,
    ).toBe("report");
    await fireEvent.update(screen.getByLabelText("Поиск по имени файла"), "");
    await vi.advanceTimersByTimeAsync(350);
    await flushPromises();
    expect(reopened.router.currentRoute.value.query).toEqual({
      directory: "docs",
    });
    reopened.router.back();
    await flushPromises();
    expect(reopened.router.currentRoute.value.query).toEqual({
      directory: "docs",
      search: "report",
    });
  });

  it("обновляет список после изменения сортировки без изменения адреса", async () => {
    const requests: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url, "http://localhost");
        requests.push(parsed);
        if (parsed.pathname === "/api/directories")
          return json({ parent: "", items: [] });
        return json({
          items: [],
          pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
        });
      }),
    );
    const { router } = await mountPage("/");
    await fireEvent.click(screen.getByRole("button", { name: "Название" }));
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({});
    expect(
      requests.some(
        (request) =>
          request.pathname === "/api/files" &&
          request.searchParams.get("sort") === "original_name",
      ),
    ).toBe(true);
  });

  it("опускает значения по умолчанию в прямой ссылке и сохраняет остальные параметры", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url, "http://localhost");
        if (parsed.pathname === "/api/directories")
          return json({ parent: "", items: [] });
        return json({
          items: [],
          pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
        });
      }),
    );
    const { router } = await mountPage(
      "/?directory=&search=&page=1&display=compact",
    );
    expect(router.currentRoute.value.query).toEqual({ display: "compact" });
    expect(screen.getByText("Здесь пока пусто")).toBeTruthy();
  });
});
