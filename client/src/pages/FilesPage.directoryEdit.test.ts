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

function parentOf(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

interface Server {
  paths: Set<string>;
  patches: { path: string; body: { name?: string; parent?: string } }[];
  hold?: Promise<void>;
  refuse?: { status: number; code: string; message: string };
}

function serve(server: Server) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url, "http://localhost");
      if (parsed.pathname === "/api/directories" && init?.method === "PATCH") {
        const path = parsed.searchParams.get("path") ?? "";
        const body = JSON.parse(String(init.body));
        server.patches.push({ path, body });
        await server.hold;
        if (server.refuse)
          return json(
            {
              error: {
                code: server.refuse.code,
                message: server.refuse.message,
              },
            },
            server.refuse.status,
          );
        const parent = body.parent ?? parentOf(path);
        const name = body.name ?? path.split("/").at(-1);
        const target = parent ? `${parent}/${name}` : name;
        for (const existing of [...server.paths])
          if (existing === path || existing.startsWith(`${path}/`)) {
            server.paths.delete(existing);
            server.paths.add(target + existing.slice(path.length));
          }
        return json({ name, path: target, fileCount: 0 });
      }
      if (parsed.pathname === "/api/directories") {
        const parent = parsed.searchParams.get("parent") ?? "";
        return json({
          parent,
          items: [...server.paths]
            .filter((path) => parentOf(path) === parent)
            .sort()
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

async function mountPage(path = "/") {
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

function rowAction(name: string, action: string) {
  return within(screen.getByRole("row", { name: new RegExp(name) })).getByRole(
    "button",
    { name: action },
  );
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

describe("переименование и перемещение каталога на странице файлов", () => {
  it("переименовывает каталог, показывая ожидание, и обновляет навигацию", async () => {
    let release!: () => void;
    const server: Server = {
      paths: new Set(["Документы", "Документы/Отчёты", "Архив"]),
      patches: [],
      hold: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    serve(server);
    await mountPage();

    await fireEvent.click(rowAction("Документы", "Переименовать каталог"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Каталог «Документы»")).toBeTruthy();
    const input = within(dialog).getByLabelText("Новое имя");
    await fireEvent.update(input, "Бумаги");
    await fireEvent.submit(input);
    await flushPromises();
    expect(
      within(dialog).getByRole("button", { name: "Сохранение…" }),
    ).toHaveProperty("disabled", true);
    release();
    await flushPromises();

    expect(server.patches).toEqual([
      { path: "Документы", body: { name: "Бумаги" } },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rowNames()).toEqual(["Архив", "Бумаги"]);
    await fireEvent.click(
      within(screen.getByRole("row", { name: /Бумаги/ })).getByRole("button", {
        name: /Бумаги/,
      }),
    );
    await flushPromises();
    expect(rowNames()).toEqual(["Отчёты"]);
  });

  it("перемещает каталог в другой личный каталог, не предлагая сам каталог назначением", async () => {
    const server: Server = {
      paths: new Set(["Документы", "Документы/Отчёты", "Архив"]),
      patches: [],
    };
    serve(server);
    await mountPage();

    await fireEvent.click(rowAction("Документы", "Переместить каталог"));
    const dialog = screen.getByRole("dialog");
    await flushPromises();
    expect(
      within(dialog).getByRole("button", { name: "Документы" }),
    ).toHaveProperty("disabled", true);
    expect(
      within(dialog).getByRole("button", { name: "Переместить сюда" }),
    ).toHaveProperty("disabled", true);
    await fireEvent.click(
      within(dialog).getByRole("button", { name: "Архив" }),
    );
    await flushPromises();
    await fireEvent.click(
      within(dialog).getByRole("button", { name: "Переместить сюда" }),
    );
    await flushPromises();

    expect(server.patches).toEqual([
      { path: "Документы", body: { parent: "Архив" } },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rowNames()).toEqual(["Архив"]);
    expect([...server.paths].sort()).toEqual([
      "Архив",
      "Архив/Документы",
      "Архив/Документы/Отчёты",
    ]);
  });

  it("показывает отказ сервера и оставляет диалог открытым", async () => {
    const server: Server = {
      paths: new Set(["Документы", "Архив"]),
      patches: [],
      refuse: {
        status: 409,
        code: "DIRECTORY_BUSY",
        message: "busy",
      },
    };
    serve(server);
    await mountPage();

    await fireEvent.click(rowAction("Документы", "Переименовать каталог"));
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByLabelText("Новое имя");
    await fireEvent.update(input, "Архив2");
    await fireEvent.submit(input);
    await flushPromises();

    expect(within(dialog).getByRole("alert").textContent).toContain(
      "незавершённые загрузки",
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    await fireEvent.click(
      within(dialog).getByRole("button", { name: "Отмена" }),
    );
    await flushPromises();
    expect(rowNames()).toEqual(["Архив", "Документы"]);
  });
});
