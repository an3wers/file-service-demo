import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { fireEvent, screen, within } from "@testing-library/vue";
import { createMemoryHistory, createRouter } from "vue-router";
import FilesPage from "./FilesPage.vue";
import UploadPanel from "@/components/UploadPanel.vue";
import { useUpload } from "@/composables/useUpload";
import { useFileBrowser } from "@/composables/useFileBrowser";
import { startSession } from "@/api/session";
import type { FileDto, UploadSource } from "@/types/api";

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

async function setup(
  source: UploadSource,
  count = 1,
  options: {
    delayedAbort?: boolean;
    delayedDelete?: boolean;
    delayedPreparation?: boolean;
    url?: string;
  } = {},
) {
  const ready: FileDto[] = [];
  const confirmations = new Map<string, () => void>();
  const deletions = new Map<string, () => void>();
  const preparations: (() => void)[] = [];
  const filenames = Array.from({ length: count }, (_, index) =>
    count === 1 ? "report.txt" : `report-${index + 1}.txt`,
  );
  function result(index: number, directory = ""): FileDto {
    return {
      id: `file-${index + 1}`,
      name: filenames[index]!,
      directory,
      extension: "txt",
      contentType: "text/plain",
      size: 8,
      etag: "etag",
      status: "ready",
      uploadSource: source,
      bucket: "files",
      key: `file-${index + 1}.txt`,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
  }
  const results = new Map<string, FileDto>();
  const fetchMock = vi.fn(
    async (url: string, init?: RequestInit): Promise<Response> => {
      if (url === "/api/files/presign-upload") {
        const body = JSON.parse(String(init?.body));
        const file = result(filenames.indexOf(body.filename), body.directory);
        results.set(file.id, file);
        const response = json(
          source === "presigned"
            ? {
                strategy: "single",
                id: file.id,
                key: file.key,
                directory: file.directory,
                uploadUrl: `https://storage.test/${file.id}`,
                requiredHeaders: { "Content-Type": "text/plain" },
                expiresAt: "2026-01-01T01:00:00Z",
              }
            : {
                strategy: "multipart",
                id: file.id,
                key: file.key,
                directory: file.directory,
                uploadId: `upload-${file.id}`,
                size: 8,
                partSize: 4,
                partCount: 2,
                maxConcurrency: 2,
                expiresAt: "2026-01-01T01:00:00Z",
                parts: [1, 2].map((partNumber) => ({
                  partNumber,
                  offset: (partNumber - 1) * 4,
                  size: 4,
                  url: `https://storage.test/${file.id}/part-${partNumber}`,
                })),
              },
        );
        if (options.delayedPreparation)
          return new Promise((resolve, reject) => {
            preparations.push(() => resolve(response));
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Отменено", "AbortError")),
            );
          });
        return response;
      }
      const id = url.split("/")[3]!;
      if (url.endsWith("/complete")) {
        return new Promise<Response>((resolve) => {
          confirmations.set(id, () => {
            const file = results.get(id)!;
            ready.push(file);
            resolve(json(file));
          });
        });
      }
      if (init?.method === "DELETE") {
        if (options.delayedDelete)
          return new Promise((resolve) => {
            deletions.set(id, () =>
              resolve(new Response(null, { status: 204 })),
            );
          });
        return new Response(null, { status: 204 });
      }
      if (url.startsWith("/api/directories"))
        return json({ parent: "", items: [] });
      const query = new URL(url, "http://localhost").searchParams;
      return json({
        items: [...ready],
        pagination: {
          page: Number(query.get("page") ?? 1),
          limit: 20,
          total: ready.length,
          totalPages: ready.length ? 1 : 0,
        },
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const requests: UploadRequest[] = [];
  class UploadRequest extends EventTarget {
    status = source === "server" ? 201 : 200;
    responseText = "";
    upload = new EventTarget();
    body: XMLHttpRequestBodyInit | null = null;
    url = "";
    file: FileDto | null = null;
    open(_method: string, url: string) {
      this.url = url;
    }
    setRequestHeader() {}
    send(body: XMLHttpRequestBodyInit) {
      this.body = body;
      if (body instanceof FormData) {
        this.file = result(
          filenames.indexOf((body.get("file") as File).name),
          String(body.get("directory")),
        );
        this.responseText = JSON.stringify(this.file);
      }
      requests.push(this);
    }
    progress(loaded: number, total: number) {
      this.upload.dispatchEvent(
        new ProgressEvent("progress", {
          loaded,
          total,
          lengthComputable: true,
        }),
      );
    }
    finish() {
      if (this.file && this.status === 201) ready.push(this.file);
      this.dispatchEvent(new Event("load"));
    }
    fail() {
      this.status = 502;
      this.responseText = JSON.stringify({
        error: { code: "STORAGE_ERROR", message: "Хранилище недоступно" },
      });
      this.finish();
    }
    finishAbort() {
      this.dispatchEvent(new Event("abort"));
    }
    abort() {
      if (!options.delayedAbort) this.finishAbort();
    }
  }
  vi.stubGlobal("XMLHttpRequest", UploadRequest);
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (
    this: HTMLInputElement,
  ) {
    expect(this.multiple).toBe(true);
    Object.defineProperty(this, "files", {
      configurable: true,
      value: filenames.map(
        (name) => new File(["contents"], name, { type: "text/plain" }),
      ),
    });
    this.dispatchEvent(new Event("change"));
  });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: FilesPage }],
  });
  await router.push(options.url ?? "/");
  await router.isReady();
  const wrapper = mount(FilesPage, {
    attachTo: document.body,
    global: { plugins: [router] },
  });
  await flushPromises();
  await fireEvent.click(screen.getByRole("button", { name: "Загрузить файл" }));
  await flushPromises();
  if (source !== "server")
    await fireEvent.click(
      screen.getByRole("button", { name: "Напрямую в S3" }),
    );
  await fireEvent.click(screen.getByRole("button", { name: "Выбрать файл" }));
  await flushPromises();
  return {
    wrapper,
    router,
    requests,
    fetchMock,
    confirm: (index = 0) => confirmations.get(`file-${index + 1}`)!(),
    finishDelete: (index = 0) => deletions.get(`file-${index + 1}`)!(),
    preparations,
    ready,
    file: result(0),
  };
}

beforeEach(() => {
  useFileBrowser().reset();
  useUpload().reset();
  useUpload().mode.value = "server";
  startSession({
    accessToken: "token",
    expiresIn: 3600,
    user: { login: "operator" },
  });
});

describe("загрузка одного файла через страницу", () => {
  it.each([
    { source: "server", name: "через сервер" },
    { source: "presigned", name: "одной прямой передачей" },
    { source: "multipart", name: "составной загрузкой" },
  ] as const)(
    "явно запускает файл $name и показывает его после ответа сервера",
    async ({ source }) => {
      const { wrapper, requests, fetchMock, confirm, file } =
        await setup(source);
      expect(requests).toHaveLength(0);
      expect(
        fetchMock.mock.calls.some(([url]) => url.includes("presign-upload")),
      ).toBe(false);

      await fireEvent.click(
        screen.getByRole("button", { name: /^Загрузить$/ }),
      );
      await flushPromises();
      expect(requests).toHaveLength(source === "multipart" ? 2 : 1);
      expect(screen.getByText("Отправляем…")).toBeTruthy();
      expect(
        (screen.getByRole("button", { name: "Отменить" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
      const operation = useUpload().rows.value[0]!.operation.value!;

      if (source === "multipart") {
        expect(requests.map((request) => (request.body as Blob).size)).toEqual([
          4, 4,
        ]);
        requests[0]!.progress(2, 4);
        requests[1]!.progress(2, 4);
        await flushPromises();
        expect(screen.getByText("50%")).toBeTruthy();
      }
      for (const request of requests) {
        request.progress(
          source === "server" ? 100 : (request.body as Blob).size,
          source === "server" ? 100 : (request.body as Blob).size,
        );
        request.upload.dispatchEvent(new Event("load"));
      }
      await flushPromises();
      expect(screen.getByText("100%")).toBeTruthy();
      expect(operation.outcome.value).toBeNull();

      if (source !== "multipart") {
        expect(screen.getByText("Обрабатываем…")).toBeTruthy();
        expect(
          (
            screen.getByRole("button", {
              name: "Отменить",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(true);
      }
      if (source !== "server") {
        requests.forEach((request) => request.finish());
        await flushPromises();
        expect(screen.getByText("Подтверждаем…")).toBeTruthy();
        expect(
          (
            screen.getByRole("button", {
              name: "Отменить",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(true);
        expect(operation.outcome.value).toBeNull();
      }

      wrapper.getComponent(UploadPanel).vm.$emit("update:open", false);
      await flushPromises();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(operation.uploading.value).toBe(true);
      await fireEvent.click(
        screen.getByRole("button", { name: "Загрузить файл" }),
      );
      await flushPromises();
      expect(useUpload().rows.value[0]!.operation.value).toBe(operation);
      expect(
        screen.getByText(
          source === "server" ? "Обрабатываем…" : "Подтверждаем…",
        ),
      ).toBeTruthy();

      if (source === "server") requests[0]!.finish();
      else confirm();
      await flushPromises();

      expect(wrapper.text()).toContain("report.txt");
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(operation.outcome.value).toEqual({ status: "succeeded", file });
      expect(operation.uploading.value).toBe(false);
    },
  );

  it("отменяет передачу через сервер и сохраняет отмену после закрытия диалога", async () => {
    const { requests } = await setup("server");
    await fireEvent.click(screen.getByRole("button", { name: /^Загрузить$/ }));
    await flushPromises();
    const operation = useUpload().rows.value[0]!.operation.value!;
    const abort = vi.spyOn(requests[0]!, "abort");

    await fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    await flushPromises();
    expect(abort).toHaveBeenCalledOnce();
    expect(operation.outcome.value).toEqual({ status: "cancelled" });
    expect(operation.uploading.value).toBe(false);
    await fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await flushPromises();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useUpload().rows.value[0]!.operation.value?.outcome.value).toEqual({
      status: "cancelled",
    });
  });
});

describe("очередь загрузки файлов", () => {
  it("запускает пять файлов по порядку с пределом трёх и удерживает место при обработке", async () => {
    const { requests } = await setup("server", 5);
    expect(requests).toHaveLength(0);
    await fireEvent.click(screen.getByRole("button", { name: /^Загрузить$/ }));
    await flushPromises();
    expect(requests).toHaveLength(3);
    expect(screen.getAllByText("Ожидает")).toHaveLength(2);
    requests[0]!.upload.dispatchEvent(new Event("load"));
    await flushPromises();
    expect(requests).toHaveLength(3);
    requests[1]!.finish();
    await flushPromises();
    expect(requests).toHaveLength(4);
    expect((requests[3]!.body as FormData).get("file")).toHaveProperty(
      "name",
      "report-4.txt",
    );
    requests[0]!.finish();
    await flushPromises();
    expect(requests).toHaveLength(5);
    expect((requests[4]!.body as FormData).get("file")).toHaveProperty(
      "name",
      "report-5.txt",
    );
    requests.slice(2).forEach((request) => request.finish());
    await flushPromises();
    expect(screen.getAllByText("Готово")).toHaveLength(5);
    expect(
      screen
        .getAllByTestId("upload-row")
        .map((row) => row.querySelector("[data-file-name]")?.textContent),
    ).toEqual(
      Array.from({ length: 5 }, (_, index) => `report-${index + 1}.txt`),
    );
  });
});

function row(index: number) {
  return within(screen.getAllByTestId("upload-row")[index]!);
}
async function launch() {
  await fireEvent.click(screen.getByRole("button", { name: /^Загрузить$/ }));
  await flushPromises();
}

describe("независимость операций очереди", () => {
  it("удаляет файл из выбора без отправки остальных", async () => {
    const { requests } = await setup("server", 5);
    await fireEvent.click(row(1).getByRole("button", { name: "Убрать" }));
    expect(screen.getAllByTestId("upload-row")).toHaveLength(4);
    expect(requests).toHaveLength(0);
    await launch();
    expect(
      requests.map((request) => (request.body as FormData).get("file")),
    ).toEqual([
      expect.objectContaining({ name: "report-1.txt" }),
      expect.objectContaining({ name: "report-3.txt" }),
      expect.objectContaining({ name: "report-4.txt" }),
    ]);
    requests.forEach((request) => request.finish());
    await flushPromises();
    requests[3]!.finish();
    await flushPromises();
  });

  it("сохраняет место во время отмены и продолжает очередь после независимой ошибки", async () => {
    const { requests, wrapper } = await setup("server", 5, {
      delayedAbort: true,
    });
    await launch();
    requests[2]!.progress(2, 8);
    await fireEvent.click(row(3).getByRole("button", { name: "Отменить" }));
    await fireEvent.click(row(0).getByRole("button", { name: "Отменить" }));
    expect(row(0).getByText("Отменяем…")).toBeTruthy();
    expect(row(3).getByText("Отменено")).toBeTruthy();
    expect(requests).toHaveLength(3);
    expect(row(2).getByText("25%")).toBeTruthy();
    requests[1]!.fail();
    await flushPromises();
    expect(row(1).getByRole("alert").textContent).toContain("Ошибка хранилища");
    expect(requests).toHaveLength(4);
    expect((requests[3]!.body as FormData).get("file")).toHaveProperty(
      "name",
      "report-5.txt",
    );
    requests[0]!.finishAbort();
    await flushPromises();
    expect(row(0).getByText("Отменено")).toBeTruthy();
    expect(requests).toHaveLength(4);
    requests.slice(2).forEach((request) => request.finish());
    await flushPromises();
    wrapper.getComponent(UploadPanel).vm.$emit("update:open", false);
    await flushPromises();
    await fireEvent.click(
      screen.getByRole("button", { name: "Загрузить файл" }),
    );
    await flushPromises();
    expect(row(1).getByRole("alert").textContent).toContain("Ошибка хранилища");
    expect(row(2).getByText("Готово")).toBeTruthy();
    expect(row(4).getByText("Готово")).toBeTruthy();
  });

  it.each([
    { source: "presigned", name: "прямой передачи", parts: 1 },
    { source: "multipart", name: "составной загрузки", parts: 2 },
  ] as const)(
    "удерживает три места на подтверждении $name",
    async ({ source, parts }) => {
      const { requests, confirm, fetchMock } = await setup(source, 5);
      expect(
        fetchMock.mock.calls.some(([url]) => url.includes("presign-upload")),
      ).toBe(false);
      await launch();
      expect(requests).toHaveLength(3 * parts);
      for (const request of requests) {
        request.progress(8 / parts, 8 / parts);
        request.finish();
      }
      await flushPromises();
      expect(screen.getAllByText("Подтверждаем…")).toHaveLength(3);
      expect(screen.queryByText("Готово")).toBeNull();
      expect(requests).toHaveLength(3 * parts);
      expect(
        (row(0).getByRole("button", { name: "Отменить" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      confirm(1);
      await flushPromises();
      expect(requests).toHaveLength(4 * parts);
      expect(requests[3 * parts]!.url).toContain("file-4");
      confirm(0);
      await flushPromises();
      expect(requests).toHaveLength(5 * parts);
      expect(requests[4 * parts]!.url).toContain("file-5");
      requests.slice(3 * parts).forEach((request) => request.finish());
      await flushPromises();
      confirm(2);
      confirm(3);
      confirm(4);
      await flushPromises();
      expect(screen.getAllByText("Готово")).toHaveLength(5);
    },
  );

  it("удерживает место составной загрузки до ответа об отмене и не отменяет соседние части", async () => {
    const { requests, finishDelete, confirm } = await setup("multipart", 5, {
      delayedDelete: true,
    });
    await launch();
    expect(requests).toHaveLength(6);
    await fireEvent.click(row(0).getByRole("button", { name: "Отменить" }));
    await flushPromises();
    expect(row(0).getByText("Отменяем…")).toBeTruthy();
    expect(requests).toHaveLength(6);
    requests[2]!.progress(2, 4);
    requests[3]!.progress(2, 4);
    await flushPromises();
    expect(row(1).getByText("50%")).toBeTruthy();
    finishDelete();
    await flushPromises();
    expect(row(0).getByText("Отменено")).toBeTruthy();
    expect(requests).toHaveLength(8);
    expect(requests[6]!.url).toContain("file-4");
    requests.slice(2).forEach((request) => request.finish());
    await flushPromises();
    confirm(1);
    await flushPromises();
    expect(requests).toHaveLength(10);
    requests.slice(8).forEach((request) => request.finish());
    await flushPromises();
    confirm(2);
    confirm(3);
    confirm(4);
    await flushPromises();
    expect(screen.getAllByText("Готово")).toHaveLength(4);
  });

  it("учитывает подготовку в пределе трёх и отменяет только выбранную подготовку", async () => {
    const { requests, fetchMock, preparations, confirm } = await setup(
      "presigned",
      5,
      { delayedPreparation: true },
    );
    await launch();
    expect(preparations).toHaveLength(3);
    expect(requests).toHaveLength(0);
    await fireEvent.click(row(0).getByRole("button", { name: "Отменить" }));
    await flushPromises();
    expect(preparations).toHaveLength(4);
    expect(row(0).getByText("Отменено")).toBeTruthy();
    expect(
      fetchMock.mock.calls
        .filter(([url]) => url.includes("presign-upload"))
        .map(([, init]) => JSON.parse(String(init?.body)).filename),
    ).toEqual(["report-1.txt", "report-2.txt", "report-3.txt", "report-4.txt"]);
    preparations.slice(1).forEach((finish) => finish());
    await flushPromises();
    requests.forEach((request) => request.finish());
    await flushPromises();
    confirm(1);
    await flushPromises();
    preparations[4]!();
    await flushPromises();
    requests[3]!.finish();
    await flushPromises();
    confirm(2);
    confirm(3);
    confirm(4);
    await flushPromises();
  });

  it("сохраняет назначение ожидающих файлов при навигации и обновляет текущее представление после близких успехов", async () => {
    const { requests, router, wrapper, fetchMock, ready } = await setup(
      "server",
      5,
      { url: "/?directory=docs" },
    );
    await launch();
    wrapper.getComponent(UploadPanel).vm.$emit("update:open", false);
    await flushPromises();
    await router.push("/?directory=other&search=report&page=2");
    await flushPromises();
    const browser = useFileBrowser();
    browser.sort.value = "original_name";
    browser.order.value = "asc";
    const listingRequests: {
      resolve: (response: Response) => void;
      items: FileDto[];
      signal?: AbortSignal | null;
    }[] = [];
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) => {
      if (url.startsWith("/api/files?"))
        return new Promise((resolve) =>
          listingRequests.push({
            resolve,
            items: [...ready],
            signal: init?.signal,
          }),
        );
      return originalFetch(url, init);
    });
    requests[1]!.finish();
    await flushPromises();
    requests[0]!.finish();
    await flushPromises();
    expect(requests).toHaveLength(5);
    expect(
      requests.every(
        (request) => (request.body as FormData).get("directory") === "docs",
      ),
    ).toBe(true);
    expect(listingRequests).toHaveLength(2);
    expect(listingRequests[0]!.signal?.aborted).toBe(true);
    const latest = listingRequests[1]!;
    latest.resolve(
      json({
        items: latest.items,
        pagination: { page: 2, limit: 20, total: 2, totalPages: 2 },
      }),
    );
    await flushPromises();
    const stale = listingRequests[0]!;
    stale.resolve(
      json({
        items: stale.items,
        pagination: { page: 2, limit: 20, total: 1, totalPages: 2 },
      }),
    );
    await flushPromises();
    expect(browser.files.value.map((file) => file.name)).toEqual([
      "report-2.txt",
      "report-1.txt",
    ]);
    expect(router.currentRoute.value.fullPath).toBe(
      "/?directory=other&search=report&page=2",
    );
    expect(browser.directory.value).toBe("other");
    expect(browser.search.value).toBe("report");
    expect(browser.page.value).toBe(2);
    expect(browser.sort.value).toBe("original_name");
    expect(browser.order.value).toBe("asc");
    fetchMock.mockImplementation(originalFetch);
    requests.slice(2).forEach((request) => request.finish());
    await flushPromises();
    expect(browser.files.value).toHaveLength(5);
  });
});
