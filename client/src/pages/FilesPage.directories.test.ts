import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { fireEvent, screen, within } from "@testing-library/vue";
import FilesPage from "./FilesPage.vue";
import { useFileBrowser } from "@/composables/useFileBrowser";
import { startSession } from "@/api/session";
import type { FileDto } from "@/types/api";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function file(name: string, directory = ""): FileDto {
  return {
    id: "c3346aa8-ad3d-4e74-8c13-8c7a04078a72",
    name,
    directory,
    extension: "txt",
    contentType: "text/plain",
    size: 1,
    etag: null,
    status: "ready",
    uploadSource: "server",
    bucket: "test",
    key: `${directory}/file.txt`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

async function mountPage() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: FilesPage }],
  });
  await router.push("/");
  await router.isReady();
  mount(FilesPage, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises();
  return router;
}

beforeEach(() => {
  useFileBrowser().reset();
  startSession({
    accessToken: "token",
    expiresIn: 3600,
    user: { login: "operator" },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("доступность каталогов на странице файлов", () => {
  it("показывает непосредственные каталоги над файлами и позволяет открыть пустой каталог со второй страницы", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url, "http://localhost");
        if (parsed.pathname === "/api/directories") {
          const parent = parsed.searchParams.get("parent") ?? "";
          return json({
            parent,
            items: parent
              ? []
              : [
                  {
                    name: "Пустой каталог",
                    path: "Пустой каталог",
                    fileCount: 0,
                  },
                  { name: "Документы", path: "Документы", fileCount: 21 },
                ],
          });
        }
        const directory = parsed.searchParams.get("directory") ?? "";
        const page = Number(parsed.searchParams.get("page") ?? "1");
        return json({
          items: directory
            ? []
            : [file(page === 1 ? "первый.txt" : "второй.txt")],
          pagination: {
            page,
            limit: 20,
            total: directory ? 0 : 21,
            totalPages: directory ? 0 : 2,
          },
        });
      }),
    );
    await mountPage();
    const catalogs = screen.getByRole("table", { name: "Каталоги и файлы" });
    expect(
      within(catalogs)
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[0]?.textContent?.trim()),
    ).toEqual(["Пустой каталог", "Документы", "первый.txt"]);
    expect(
      within(catalogs)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent?.trim()),
    ).toEqual(["Название", "Размер", "Дата загрузки", "Действия"]);
    await fireEvent.click(screen.getByRole("button", { name: /next/i }));
    await flushPromises();
    expect(screen.getByText("второй.txt")).toBeTruthy();
    expect(screen.queryByText("первый.txt")).toBeNull();
    await fireEvent.click(
      within(screen.getByRole("table", { name: "Каталоги и файлы" })).getByRole(
        "button",
        { name: /Пустой каталог/ },
      ),
    );
    await flushPromises();
    expect(screen.getByText("Здесь пока пусто")).toBeTruthy();
    expect(screen.getByText("Пустой каталог")).toBeTruthy();
    expect(screen.queryByText("второй.txt")).toBeNull();
  });

  it("сохраняет дочерние каталоги при поиске по поддереву и позволяет открыть их без найденных файлов", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url, "http://localhost");
        if (parsed.pathname === "/api/directories") {
          const parent = parsed.searchParams.get("parent") ?? "";
          const items =
            parent === ""
              ? [{ name: "Документы", path: "Документы", fileCount: 2 }]
              : parent === "Документы"
                ? [
                    {
                      name: "Черновики",
                      path: "Документы/Черновики",
                      fileCount: 1,
                    },
                    {
                      name: "Пустой каталог",
                      path: "Документы/Пустой каталог",
                      fileCount: 0,
                    },
                  ]
                : [];
          return json({ parent, items });
        }
        const directory = parsed.searchParams.get("directory") ?? "";
        const term = parsed.searchParams.get("search");
        const recursive = parsed.searchParams.get("recursive") === "true";
        const items =
          directory === "Документы" && term === "отчёт"
            ? [
                file("отчёт.txt", "Документы"),
                ...(recursive
                  ? [
                      {
                        ...file("вложенный отчёт.txt", "Документы/Черновики"),
                        id: "702388ee-1b0b-4b99-872c-d4b407a08c85",
                      },
                    ]
                  : []),
              ]
            : directory === "" && term === "отчёт"
              ? [file("чужой отчёт.txt", "Чужой каталог")]
              : [];
        return json({
          items,
          pagination: {
            page: 1,
            limit: 20,
            total: items.length,
            totalPages: items.length ? 1 : 0,
          },
        });
      }),
    );
    await mountPage();
    await fireEvent.click(
      within(screen.getByRole("table", { name: "Каталоги и файлы" })).getByRole(
        "button",
        { name: /Документы/ },
      ),
    );
    await flushPromises();
    const catalogs = screen.getByRole("table", { name: "Каталоги и файлы" });
    expect(within(catalogs).getAllByRole("row")).toHaveLength(3);
    expect(screen.queryByText("Здесь пока пусто")).toBeNull();
    vi.useFakeTimers();
    await fireEvent.update(
      screen.getByRole("textbox", { name: "Поиск по имени файла" }),
      "отчёт",
    );
    await vi.advanceTimersByTimeAsync(350);
    await flushPromises();
    expect(screen.getByText("отчёт.txt")).toBeTruthy();
    expect(screen.getByText("вложенный отчёт.txt")).toBeTruthy();
    expect(screen.queryByText("чужой отчёт.txt")).toBeNull();
    expect(
      within(screen.getByRole("table", { name: "Каталоги и файлы" })).getByRole(
        "button",
        { name: "Пустой каталог" },
      ),
    ).toBeTruthy();
    await fireEvent.update(
      screen.getByRole("textbox", { name: "Поиск по имени файла" }),
      "несуществующий файл",
    );
    await vi.advanceTimersByTimeAsync(350);
    await flushPromises();
    expect(screen.queryByText("Ничего не найдено")).toBeNull();
    expect(
      within(
        screen.getByRole("table", { name: "Каталоги и файлы" }),
      ).getAllByRole("row"),
    ).toHaveLength(3);
    await fireEvent.click(
      within(screen.getByRole("table", { name: "Каталоги и файлы" })).getByRole(
        "button",
        { name: /Пустой каталог/ },
      ),
    );
    await flushPromises();
    expect(screen.getByText("Здесь пока пусто")).toBeTruthy();
    expect(screen.getByText("Пустой каталог")).toBeTruthy();
    expect(
      (
        screen.getByRole("textbox", {
          name: "Поиск по имени файла",
        }) as HTMLInputElement
      ).value,
    ).toBe("");
  });
  it("скрывает каталоги предыдущего родителя во время перехода и не возвращает их из запоздалого ответа", async () => {
    const initial = new Set<string>();
    const pending: {
      path: string;
      directory: string;
      resolve: (response: Response) => void;
    }[] = [];
    const rootItems = [
      { name: "docs", path: "docs", fileCount: 0 },
      { name: "archive", path: "archive", fileCount: 0 },
    ];
    const childItems = [
      { name: "reports", path: "docs/reports", fileCount: 0 },
    ];
    const response = (path: string, directory: string, items = rootItems) =>
      path === "/api/directories"
        ? json({ parent: directory, items })
        : json({
            items: [],
            pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
          });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url, "http://localhost");
        const directory =
          parsed.searchParams.get("parent") ??
          parsed.searchParams.get("directory") ??
          "";
        if (!directory && !initial.has(parsed.pathname)) {
          initial.add(parsed.pathname);
          return response(parsed.pathname, directory);
        }
        return await new Promise<Response>((resolve) =>
          pending.push({ path: parsed.pathname, directory, resolve }),
        );
      }),
    );
    const router = await mountPage();
    await router.push("/?search=anything&page=2");
    await flushPromises();
    expect(screen.queryByRole("button", { name: "docs" })).toBeNull();
    await router.push("/?directory=docs");
    await flushPromises();
    expect(router.currentRoute.value.query.directory).toBe("docs");
    expect(screen.queryByRole("button", { name: "archive" })).toBeNull();
    for (const request of pending.filter((request) => !request.directory))
      request.resolve(response(request.path, ""));
    await flushPromises();
    expect(screen.queryByRole("button", { name: "archive" })).toBeNull();
    for (const request of pending.filter(
      (request) => request.directory === "docs",
    ))
      request.resolve(response(request.path, "docs", childItems));
    await flushPromises();
    expect(
      within(screen.getByRole("table", { name: "Каталоги и файлы" })).getByRole(
        "button",
        { name: /reports/ },
      ),
    ).toBeTruthy();
    pending.length = 0;
    await router.push("/?directory=docs&search=delayed");
    await flushPromises();
    expect(screen.queryByRole("button", { name: "reports" })).toBeNull();
    await router.push("/?directory=missing");
    await flushPromises();
    expect(screen.queryByRole("button", { name: "archive" })).toBeNull();
    for (const request of pending.filter(
      (request) => request.directory === "missing",
    )) {
      request.resolve(
        json(
          {
            error: {
              code: "DIRECTORY_NOT_FOUND",
              message: "Директория не найдена",
            },
          },
          404,
        ),
      );
    }
    await flushPromises();
    expect(screen.getAllByText("Директория не найдена").length).toBeGreaterThan(
      0,
    );
    for (const request of pending.filter(
      (request) => request.directory === "docs",
    ))
      request.resolve(response(request.path, "docs", childItems));
    await flushPromises();
    expect(screen.queryByRole("button", { name: "archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: /reports/ })).toBeNull();
  });
});
