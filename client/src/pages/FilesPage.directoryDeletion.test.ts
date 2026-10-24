import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { fireEvent, screen, within } from "@testing-library/vue";
import FilesPage from "./FilesPage.vue";
import { useFileBrowser } from "@/composables/useFileBrowser";
import { startSession } from "@/api/session";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function conflict() {
  return json(
    {
      error: {
        code: "DIRECTORY_NOT_EMPTY",
        message: "Каталог не пуст",
      },
    },
    409,
  );
}

function serve(
  paths: Set<string>,
  occupied: Set<string>,
  deletions: string[],
  hold?: Promise<void>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url, "http://localhost");
      if (parsed.pathname === "/api/directories" && init?.method === "DELETE") {
        const path = parsed.searchParams.get("path") ?? "";
        deletions.push(path);
        await hold;
        if (occupied.has(path)) return conflict();
        paths.delete(path);
        return new Response(null, { status: 204 });
      }
      if (parsed.pathname === "/api/directories") {
        const parent = parsed.searchParams.get("parent") ?? "";
        if (parent && !paths.has(parent))
          return json(
            {
              error: {
                code: "DIRECTORY_NOT_FOUND",
                message: "Директория не найдена",
              },
            },
            404,
          );
        return json({
          parent,
          items: [...paths]
            .filter(
              (path) =>
                path.slice(0, Math.max(0, path.lastIndexOf("/"))) === parent,
            )
            .map((path) => ({
              name: path.split("/").at(-1),
              path,
              fileCount: 0,
            })),
        });
      }
      return json({
        items: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
    }),
  );
}

async function mountPage(path: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: FilesPage }],
  });
  await router.push(path);
  await router.isReady();
  mount(FilesPage, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises();
  return router;
}

function rowNames(): string[] {
  return within(screen.getByRole("table", { name: "Каталоги и файлы" }))
    .queryAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent?.trim())
    .filter((name): name is string => !!name);
}

beforeEach(() => {
  document.body.innerHTML = "";
  useFileBrowser().reset();
  startSession({
    accessToken: "token",
    expiresIn: 3600,
    user: {
      id: "00000000-0000-4000-8000-000000000001",
      name: "operator",
      email: "operator@example.com",
    },
  });
});

describe("удаление пустого каталога на странице файлов", () => {
  it("удаляет открытый пустой каталог после подтверждения и переходит к родителю", async () => {
    const paths = new Set(["Документы", "Документы/Пустой", "Архив"]);
    const deletions: string[] = [];
    let release!: () => void;
    serve(
      paths,
      new Set(),
      deletions,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const router = await mountPage("/?directory=Документы/Пустой");

    await fireEvent.click(
      screen.getByRole("button", { name: "Удалить этот каталог" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Удалить каталог «Пустой»?")).toBeTruthy();
    await fireEvent.click(
      within(dialog).getByRole("button", { name: "Удалить" }),
    );
    await flushPromises();
    expect(
      (
        within(dialog).getByRole("button", {
          name: /Удаление…/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    release();
    await flushPromises();

    expect(deletions).toEqual(["Документы/Пустой"]);
    expect(router.currentRoute.value.query.directory).toBe("Документы");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(rowNames()).toEqual([]);
  });

  it("сообщает о непустом каталоге и оставляет его в навигации", async () => {
    const paths = new Set(["Документы", "Документы/Отчёты"]);
    const deletions: string[] = [];
    serve(paths, new Set(["Документы"]), deletions);
    await mountPage("/");

    await fireEvent.click(
      within(screen.getByRole("row", { name: /Документы/ })).getByRole(
        "button",
        { name: "Удалить каталог" },
      ),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Удалить каталог «Документы»?"),
    ).toBeTruthy();
    await fireEvent.click(
      within(dialog).getByRole("button", { name: "Удалить" }),
    );
    await flushPromises();

    expect(deletions).toEqual(["Документы"]);
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "Каталог не пуст",
    );
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await fireEvent.click(
      within(dialog).getByRole("button", { name: "Отмена" }),
    );
    await flushPromises();
    expect(rowNames()).toEqual(["Документы"]);
  });
});
