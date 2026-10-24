import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { fireEvent, screen } from "@testing-library/vue";
import FilesPage from "./FilesPage.vue";
import { useFileBrowser } from "@/composables/useFileBrowser";
import { useUpload } from "@/composables/useUpload";
import { startSession } from "@/api/session";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function mountPage(url = "/") {
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
  useUpload().reset();
  useUpload().mode.value = "server";
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

describe("создание каталога на странице файлов", () => {
  it("создаёт каталог, остаётся у родителя, открывает его и загружает в выбранное место", async () => {
    let created = false;
    let uploaded = false;
    const file = {
      id: "c3346aa8-ad3d-4e74-8c13-8c7a04078a72",
      name: "report.txt",
      directory: "Документы",
      extension: "txt",
      contentType: "text/plain",
      size: 1,
      etag: null,
      status: "ready",
      uploadSource: "server",
      bucket: "test",
      key: "Документы/file.txt",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const requests: { path: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const parsed = new URL(url, "http://localhost");
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          requests.push({ path: parsed.pathname, body });
          created = true;
          return json(
            { name: "Документы", path: "Документы", fileCount: 0 },
            201,
          );
        }
        if (parsed.pathname === "/api/directories") {
          const parent = parsed.searchParams.get("parent") ?? "";
          return json({
            parent,
            items:
              created && !parent
                ? [
                    {
                      name: "Документы",
                      path: "Документы",
                      fileCount: uploaded ? 1 : 0,
                    },
                  ]
                : [],
          });
        }
        return json({
          items: uploaded ? [file] : [],
          pagination: {
            page: 1,
            limit: 20,
            total: uploaded ? 1 : 0,
            totalPages: uploaded ? 1 : 0,
          },
        });
      }),
    );
    const sent: FormData[] = [];
    class UploadRequest extends EventTarget {
      status = 201;
      responseText = JSON.stringify(file);
      upload = new EventTarget();
      open() {}
      setRequestHeader() {}
      send(body: FormData) {
        sent.push(body);
        uploaded = true;
        queueMicrotask(() => this.dispatchEvent(new Event("load")));
      }
      abort() {}
    }
    vi.stubGlobal("XMLHttpRequest", UploadRequest);
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (
      this: HTMLInputElement,
    ) {
      Object.defineProperty(this, "files", {
        configurable: true,
        value: [new File(["a"], "report.txt", { type: "text/plain" })],
      });
      this.dispatchEvent(new Event("change"));
    });
    const { wrapper } = await mountPage();
    await fireEvent.click(
      screen.getByRole("button", { name: "Создать каталог" }),
    );
    await fireEvent.update(screen.getByLabelText("Имя каталога"), "Документы");
    await flushPromises();
    await fireEvent.submit(
      screen.getByLabelText("Имя каталога").closest("form")!,
    );
    await flushPromises();
    expect(requests).toEqual([
      { path: "/api/directories", body: { parent: "", name: "Документы" } },
    ]);
    expect(screen.getByText("Документы")).toBeTruthy();
    expect(screen.getByText("Все файлы")).toBeTruthy();
    await fireEvent.click(screen.getByText("Документы"));
    await flushPromises();
    expect(wrapper.text()).toContain("Здесь пока пусто");
    await fireEvent.click(
      screen.getByRole("button", { name: "Загрузить файл" }),
    );
    await flushPromises();
    expect(screen.getByText("Каталог загрузки")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Директория" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Выбрать файл" }));
    await flushPromises();
    await fireEvent.click(screen.getByRole("button", { name: /^Загрузить$/ }));
    await flushPromises();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.get("directory")).toBe("Документы");
    expect(wrapper.text()).toContain("report.txt");
    await fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await flushPromises();
    await fireEvent.click(screen.getByText("Все файлы"));
    await flushPromises();
    expect(wrapper.text()).toContain("Документы");
  });
  it("создаёт вложенный каталог и показывает сообщение о дубликате", async () => {
    let created = false;
    const posted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const parsed = new URL(url, "http://localhost");
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          posted.push(body);
          if (body.name === "existing")
            return json(
              {
                error: {
                  code: "DIRECTORY_ALREADY_EXISTS",
                  message: "duplicate",
                },
              },
              409,
            );
          created = true;
          return json(
            { name: "reports", path: "docs/reports", fileCount: 0 },
            201,
          );
        }
        if (parsed.pathname === "/api/directories") {
          const parent = parsed.searchParams.get("parent") ?? "";
          return json({
            parent,
            items: parent
              ? created
                ? [{ name: "reports", path: "docs/reports", fileCount: 0 }]
                : []
              : [{ name: "docs", path: "docs", fileCount: 0 }],
          });
        }
        return json({
          items: [],
          pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
        });
      }),
    );
    const { wrapper, router } = await mountPage();
    await fireEvent.click(screen.getByText("docs"));
    await flushPromises();
    await fireEvent.click(
      screen.getByRole("button", { name: "Создать каталог" }),
    );
    await fireEvent.update(screen.getByLabelText("Имя каталога"), "existing");
    await flushPromises();
    await fireEvent.submit(
      screen.getByLabelText("Имя каталога").closest("form")!,
    );
    await flushPromises();
    expect(screen.getByRole("alert").textContent).toContain(
      "Директория уже существует",
    );
    await fireEvent.update(screen.getByLabelText("Имя каталога"), "reports");
    await flushPromises();
    await fireEvent.submit(
      screen.getByLabelText("Имя каталога").closest("form")!,
    );
    await flushPromises();
    expect(posted).toEqual([
      { parent: "docs", name: "existing" },
      { parent: "docs", name: "reports" },
    ]);
    expect(wrapper.text()).toContain("reports");
    expect(screen.getByText("docs")).toBeTruthy();
    const address = router.currentRoute.value.fullPath;
    wrapper.unmount();
    const reopened = await mountPage(address);
    expect(reopened.wrapper.text()).toContain("reports");
  });
});
