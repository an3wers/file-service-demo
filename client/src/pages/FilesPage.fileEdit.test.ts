import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { fireEvent, screen, within } from "@testing-library/vue";
import FilesPage from "./FilesPage.vue";
import { useFileBrowser } from "@/composables/useFileBrowser";
import { useUpload } from "@/composables/useUpload";
import { startSession } from "@/api/session";
import { uploadViaServer } from "@/api/files";
import type { DirectoryDto, FileDto } from "@/types/api";

vi.mock("@/api/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/files")>()),
  uploadViaServer: vi.fn(),
}));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ID = "c3346aa8-ad3d-4e74-8c13-8c7a04078a72";

interface Server {
  file: FileDto;
  directories: Record<string, DirectoryDto[]>;
  patches: unknown[];
  answer?: () => Promise<Response>;
}

function serve(server: Server) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url, "http://localhost");
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as {
          name?: string;
          directory?: string;
        };
        server.patches.push(body);
        if (server.answer) return await server.answer();
        server.file = {
          ...server.file,
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.directory === undefined
            ? {}
            : { directory: body.directory }),
        };
        return json(server.file);
      }
      if (parsed.pathname === "/api/directories") {
        const parent = parsed.searchParams.get("parent") ?? "";
        return json({ parent, items: server.directories[parent] ?? [] });
      }
      if (parsed.pathname === `/api/files/${ID}`) return json(server.file);
      const directory = parsed.searchParams.get("directory") ?? "";
      const items = server.file.directory === directory ? [server.file] : [];
      return json({
        items,
        pagination: {
          page: 1,
          limit: 20,
          total: items.length,
          totalPages: items.length,
        },
      });
    }),
  );
}

function ready(): FileDto {
  return {
    id: ID,
    name: "report.txt",
    directory: "",
    extension: "txt",
    contentType: "text/plain",
    size: 1,
    etag: null,
    status: "ready",
    uploadSource: "server",
    bucket: "test",
    key: `${ID}.txt`,
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
}

function table() {
  return screen.getByRole("table", { name: "Каталоги и файлы" });
}

beforeEach(() => {
  document.body.innerHTML = "";
  useFileBrowser().reset();
  useUpload().reset();
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

describe("переименование и перемещение файла на странице файлов", () => {
  it("переименовывает файл, блокируя повторную отправку, и показывает новое имя в списке", async () => {
    const server: Server = { file: ready(), directories: {}, patches: [] };
    let release: () => void = () => undefined;
    server.answer = () =>
      new Promise((resolve) => {
        release = () => {
          server.file = { ...server.file, name: "Итоги.txt" };
          resolve(json(server.file));
        };
      });
    serve(server);
    await mountPage();

    await fireEvent.click(
      within(table()).getByRole("button", { name: "Переименовать файл" }),
    );
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByLabelText("Новое имя");
    expect((input as HTMLInputElement).value).toBe("report.txt");
    await fireEvent.update(input, "Итоги.txt");
    const submit = within(dialog).getByRole("button", {
      name: "Переименовать",
    });
    await fireEvent.click(submit);
    await flushPromises();
    expect(
      within(dialog).getByRole("button", { name: "Сохранение…" }),
    ).toHaveProperty("disabled", true);
    await fireEvent.submit(within(dialog).getByLabelText("Новое имя"));
    expect(server.patches).toEqual([{ name: "Итоги.txt" }]);

    release();
    await flushPromises();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(table()).getByText("Итоги.txt")).toBeTruthy();
    expect(within(table()).queryByText("report.txt")).toBeNull();
  });

  it("история загрузок показывает новое имя и каталог файла после изменения", async () => {
    const server: Server = {
      file: ready(),
      directories: { "": [{ name: "docs", path: "docs", fileCount: 0 }] },
      patches: [],
    };
    serve(server);
    vi.mocked(uploadViaServer).mockResolvedValue(ready());
    await mountPage();
    useUpload().addFiles([
      new File(["x"], "report.txt", { type: "text/plain" }),
    ]);
    void useUpload().submit("");
    await flushPromises();

    await fireEvent.click(
      within(table()).getByRole("button", { name: "Переименовать файл" }),
    );
    let dialog = screen.getByRole("dialog");
    await fireEvent.update(
      within(dialog).getByLabelText("Новое имя"),
      "Итоги.txt",
    );
    await fireEvent.submit(within(dialog).getByLabelText("Новое имя"));
    await flushPromises();
    await fireEvent.click(
      within(table()).getByRole("button", { name: "Переместить файл" }),
    );
    dialog = screen.getByRole("dialog");
    await flushPromises();
    await fireEvent.click(within(dialog).getByRole("button", { name: "docs" }));
    await flushPromises();
    await fireEvent.click(
      within(dialog).getByRole("button", { name: "Переместить сюда" }),
    );
    await flushPromises();

    await fireEvent.click(screen.getByRole("button", { name: /^Загрузки:/ }));
    await flushPromises();
    const row = within(screen.getByTestId("upload-row"));
    expect(row.getByText("Итоги.txt")).toBeTruthy();
    expect(row.queryByText("report.txt")).toBeNull();
    expect(row.getByText(/docs/)).toBeTruthy();
  });

  it("показывает понятную ошибку и оставляет диалог открытым", async () => {
    const server: Server = { file: ready(), directories: {}, patches: [] };
    server.answer = async () =>
      json(
        {
          error: {
            code: "FILE_NOT_READY",
            message: "not ready",
            requestId: "r",
          },
        },
        409,
      );
    serve(server);
    await mountPage();

    await fireEvent.click(
      within(table()).getByRole("button", { name: "Переименовать файл" }),
    );
    const dialog = screen.getByRole("dialog");
    await fireEvent.update(within(dialog).getByLabelText("Новое имя"), "x.txt");
    await fireEvent.click(
      within(dialog).getByRole("button", { name: "Переименовать" }),
    );
    await flushPromises();

    expect(within(dialog).getByRole("alert").textContent).toContain(
      "Файл ещё не готов",
    );
    expect(
      within(dialog).getByRole("button", { name: "Переименовать" }),
    ).toHaveProperty("disabled", false);
  });

  it("перемещает файл в выбранный каталог и обратно в личный корень, обновляя счётчики", async () => {
    const server: Server = {
      file: ready(),
      directories: {
        "": [{ name: "docs", path: "docs", fileCount: 0 }],
        docs: [{ name: "2026", path: "docs/2026", fileCount: 0 }],
      },
      patches: [],
    };
    serve(server);
    await mountPage();

    await fireEvent.click(
      within(table()).getByRole("button", { name: "Переместить файл" }),
    );
    let dialog = screen.getByRole("dialog");
    await flushPromises();
    expect(within(dialog).getByText("Текущий выбор: Корень")).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Переместить сюда" }),
    ).toHaveProperty("disabled", true);
    await fireEvent.click(within(dialog).getByRole("button", { name: "docs" }));
    await flushPromises();
    expect(within(dialog).getByText("Текущий выбор: docs")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "2026" })).toBeTruthy();

    server.directories[""] = [{ name: "docs", path: "docs", fileCount: 1 }];
    await fireEvent.click(
      within(dialog).getByRole("button", { name: "Переместить сюда" }),
    );
    await flushPromises();
    expect(server.patches).toEqual([{ directory: "docs" }]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(table()).queryByText("report.txt")).toBeNull();
    expect(within(table()).getByText("docs")).toBeTruthy();

    await fireEvent.click(
      within(table()).getByRole("button", { name: /docs/ }),
    );
    await flushPromises();
    await fireEvent.click(
      within(table()).getByRole("button", { name: "Переместить файл" }),
    );
    dialog = screen.getByRole("dialog");
    await flushPromises();
    await fireEvent.click(
      within(dialog).getByRole("button", { name: "Корень" }),
    );
    await flushPromises();
    await fireEvent.click(
      within(dialog).getByRole("button", { name: "Переместить сюда" }),
    );
    await flushPromises();
    expect(server.patches).toEqual([{ directory: "docs" }, { directory: "" }]);
    expect(within(table()).queryByText("report.txt")).toBeNull();
  });
});
