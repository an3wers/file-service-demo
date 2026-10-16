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
  const deleteResponses: Response[] = [];
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
          source !== "multipart"
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
      if (url.endsWith("/cancel")) {
        if (options.delayedDelete)
          return new Promise((resolve) => {
            deletions.set("file-1", () => resolve(json({ status: "failed" })));
          });
        return json({ status: "failed" });
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
        const response =
          deleteResponses.shift() ?? new Response(null, { status: 204 });
        const finish = () => {
          if (response.ok || response.status === 404) {
            const index = ready.findIndex((file) => file.id === id);
            if (index !== -1) ready.splice(index, 1);
          }
          return response;
        };
        if (options.delayedDelete)
          return new Promise((resolve) => {
            deletions.set(id, () => resolve(finish()));
          });
        return finish();
      }
      if (url.startsWith("/api/directories"))
        return json({ parent: "", items: [] });
      const query = new URL(url, "http://localhost").searchParams;
      return json({
        items: ready.filter((file) => {
          const directory = query.get("directory") ?? "";
          const search = query.get("search") ?? "";
          return (
            (file.directory === directory ||
              (!!search && file.directory.startsWith(`${directory}/`))) &&
            file.name.includes(search)
          );
        }),
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
  let chosenFiles = filenames.map(
    (name) => new File(["contents"], name, { type: "text/plain" }),
  );
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (
    this: HTMLInputElement,
  ) {
    expect(this.multiple).toBe(true);
    Object.defineProperty(this, "files", {
      configurable: true,
      value: chosenFiles,
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
    async choose(files: File[]) {
      chosenFiles = files;
      for (const file of files)
        if (!filenames.includes(file.name)) filenames.push(file.name);
      await fireEvent.click(
        screen.getByRole("button", { name: "Выбрать файл" }),
      );
      await flushPromises();
    },
    wrapper,
    router,
    requests,
    fetchMock,
    confirm: (index = 0) => confirmations.get(`file-${index + 1}`)!(),
    finishDelete: (index = 0) => deletions.get(`file-${index + 1}`)!(),
    preparations,
    ready,
    deleteResponses,
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
    expect(screen.getByRole("dialog")).toBeTruthy();
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
    expect(row(1).getByRole("alert").textContent).toContain(
      "Не удалось выяснить результат",
    );
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
    expect(row(1).getByRole("alert").textContent).toContain(
      "Не удалось выяснить результат",
    );
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
    const { requests, router, fetchMock, ready } = await setup("server", 5, {
      url: "/?directory=docs",
    });
    await launch();
    await fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
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
            items: ready.filter((file) => file.directory === "other"),
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
    expect(browser.files.value).toEqual([]);
    expect(screen.queryByRole("button", { name: "report-1.txt" })).toBeNull();
    const query = new URL(
      fetchMock.mock.calls
        .filter(([url]) => url.startsWith("/api/files?"))
        .at(-1)![0],
      "http://localhost",
    ).searchParams;
    expect(Object.fromEntries(query)).toMatchObject({
      directory: "other",
      search: "report",
      page: "2",
      sort: "original_name",
      order: "asc",
    });
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
    expect(browser.files.value).toHaveLength(0);
    await fireEvent.click(screen.getByRole("button", { name: /^Загрузки:/ }));
    await flushPromises();
    expect(screen.getAllByText("docs · Через сервер")).toHaveLength(5);
    expect(screen.getAllByText("Готово")).toHaveLength(5);
  });
});

describe("ручной повтор строки загрузки", () => {
  it("показывает потерянный результат без повторной передачи и выбора файла", async () => {
    const { requests, fetchMock, file } = await setup("server");
    await launch();
    const operationId = (requests[0]!.body as FormData).get("operationId");
    requests[0]!.dispatchEvent(new Event("error"));
    await flushPromises();
    expect(row(0).getByRole("alert").textContent).toContain(
      "Не удалось выяснить результат",
    );
    fetchMock.mockResolvedValueOnce(json({ status: "succeeded", file }));
    await fireEvent.click(
      row(0).getByRole("button", { name: "Выяснить результат" }),
    );
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/files/upload-operations/${operationId}`,
      expect.anything(),
    );
    expect(requests).toHaveLength(1);
    expect(row(0).getByText("Готово")).toBeTruthy();
    expect(row(0).queryByRole("button", { name: "Повторить" })).toBeNull();
  });

  it("передаёт тот же выбранный файл после подтверждённой неудачи", async () => {
    const { requests, fetchMock } = await setup("server");
    await launch();
    const first = requests[0]!.body as FormData;
    requests[0]!.fail();
    await flushPromises();
    fetchMock.mockResolvedValueOnce(json({ status: "failed" }));
    await fireEvent.click(
      row(0).getByRole("button", { name: "Выяснить результат" }),
    );
    await flushPromises();
    fetchMock.mockResolvedValueOnce(json({ status: "failed" }));
    await fireEvent.click(row(0).getByRole("button", { name: "Повторить" }));
    await flushPromises();
    expect(requests).toHaveLength(2);
    const second = requests[1]!.body as FormData;
    expect(second.get("operationId")).toBe(first.get("operationId"));
    expect(second.get("file")).toEqual(first.get("file"));
    requests[1]!.finish();
    await flushPromises();
    expect(row(0).getByText("Готово")).toBeTruthy();
  });
});

describe.each(["presigned", "multipart"] as const)(
  "ручной повтор прямой строки %s",
  (source) => {
    it("повторяет только подтверждение уже отправленного файла", async () => {
      const { requests, fetchMock, confirm } = await setup(source);
      const original = fetchMock.getMockImplementation()!;
      let failed = false;
      fetchMock.mockImplementation(async (url, init) => {
        if (url.endsWith("/complete") && !failed) {
          failed = true;
          throw new Error("Ответ потерян");
        }
        if (url.includes("/upload-operations/"))
          return json({ status: "failed" });
        return original(url, init);
      });
      await launch();
      requests.forEach((request) => request.finish());
      await flushPromises();
      const count = requests.length;
      expect(
        row(0).getByRole("button", { name: "Выяснить результат" }),
      ).toBeTruthy();
      expect(
        row(0)
          .getByRole("button", { name: "Через сервер" })
          .hasAttribute("disabled"),
      ).toBe(true);
      await fireEvent.click(
        row(0).getByRole("button", { name: "Выяснить результат" }),
      );
      await flushPromises();
      await fireEvent.click(row(0).getByRole("button", { name: "Повторить" }));
      await flushPromises();
      expect(requests).toHaveLength(count);
      expect(
        fetchMock.mock.calls.filter(
          ([url]) => url === "/api/files/presign-upload",
        ),
      ).toHaveLength(1);
      confirm();
      await flushPromises();
      expect(row(0).getByText("Готово")).toBeTruthy();
    });

    it("выясняет потерянное резервирование и показывает готовый файл в прежней строке", async () => {
      const { requests, fetchMock, file } = await setup(source);
      fetchMock.mockRejectedValueOnce(new Error("Ответ потерян"));
      await launch();
      const first = JSON.parse(
        String(
          fetchMock.mock.calls.find(
            ([url]) => url === "/api/files/presign-upload",
          )![1]?.body,
        ),
      );
      expect(first.operationId).toEqual(expect.any(String));
      fetchMock.mockResolvedValueOnce(json({ status: "succeeded", file }));
      await fireEvent.click(
        row(0).getByRole("button", { name: "Выяснить результат" }),
      );
      await flushPromises();
      expect(requests).toHaveLength(0);
      expect(screen.getAllByTestId("upload-row")).toHaveLength(1);
      expect(row(0).getByText("Готово")).toBeTruthy();
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/files/upload-operations/${first.operationId}`,
        expect.anything(),
      );
    });
  },
);

describe("фоновая загрузка", () => {
  it.each(["server", "presigned", "multipart"] as const)(
    "продолжает несколько загрузок %s на всех стадиях и сохраняет общий успех",
    async (source) => {
      const { requests, preparations, confirm } = await setup(source, 2, {
        delayedPreparation: source !== "server",
      });
      async function hideAndReopen(stage: string) {
        expect(row(0).getByText(stage)).toBeTruthy();
        await fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
        await flushPromises();
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(
          screen.getByRole("button", { name: /^Загрузки:/ }).textContent,
        ).toContain("Загружаются: 2");
        await fireEvent.click(
          screen.getByRole("button", { name: /^Загрузки:/ }),
        );
        await flushPromises();
        expect(screen.getAllByTestId("upload-row")).toHaveLength(2);
        expect(row(0).getByText(stage)).toBeTruthy();
      }
      await launch();
      if (source !== "server") {
        await hideAndReopen("Готовим ссылку…");
        preparations.forEach((finish) => finish());
        await flushPromises();
      }
      await hideAndReopen("Отправляем…");
      requests.forEach((request) => {
        request.progress(8, 8);
        request.upload.dispatchEvent(new Event("load"));
      });
      await flushPromises();
      if (source !== "multipart") await hideAndReopen("Обрабатываем…");
      if (source !== "server") {
        requests.forEach((request) => request.finish());
        await flushPromises();
        await hideAndReopen("Подтверждаем…");
      }
      await fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
      await flushPromises();
      if (source === "server") requests.forEach((request) => request.finish());
      else {
        confirm(0);
        confirm(1);
      }
      await flushPromises();
      expect(screen.queryByRole("dialog")).toBeNull();
      const indicator = screen.getByRole("button", { name: /^Загрузки:/ });
      expect(indicator.textContent).toContain("Загружаются: 0");
      expect(indicator.textContent).toContain("Готовы: 2");
      expect(screen.getByRole("button", { name: "report-1.txt" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "report-2.txt" })).toBeTruthy();
      await fireEvent.click(indicator);
      await flushPromises();
      expect(screen.getAllByText("Готово")).toHaveLength(2);
      expect(screen.getByRole("dialog")).toBeTruthy();
    },
  );

  it("показывает сводку и сохраняет ошибки, отмены и результаты после закрытия", async () => {
    const { requests } = await setup("server", 5);
    expect(screen.getByLabelText("Сводка загрузок").textContent).toContain(
      "Ожидают: 5",
    );
    await launch();
    expect(screen.getByLabelText("Сводка загрузок").textContent).toContain(
      "Загружаются: 3",
    );
    await fireEvent.click(row(4).getByRole("button", { name: "Отменить" }));
    await fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await flushPromises();
    expect(screen.queryByRole("dialog")).toBeNull();
    const indicator = screen.getByRole("button", { name: /^Загрузки:/ });
    expect(indicator.textContent).toContain("Ожидают: 1");
    expect(indicator.textContent).toContain("Отменены: 1");
    requests[0]!.progress(2, 8);
    requests[1]!.fail();
    requests[2]!.finish();
    await flushPromises();
    expect(requests).toHaveLength(4);
    expect(indicator.textContent).toContain("Загружаются: 2");
    expect(indicator.textContent).toContain("Готовы: 1");
    expect(indicator.textContent).toContain("Ошибки: 1");
    await fireEvent.click(indicator);
    await flushPromises();
    expect(row(0).getByText("25%")).toBeTruthy();
    expect(row(1).getByRole("alert").textContent).toContain(
      "Не удалось выяснить результат",
    );
    expect(row(2).getByText("Готово")).toBeTruthy();
    expect(row(4).getByText("Отменено")).toBeTruthy();
    requests[0]!.finish();
    requests[3]!.finish();
    await flushPromises();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText("Сводка загрузок").textContent).toContain(
      "Готовы: 3",
    );
    await fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await flushPromises();
    await fireEvent.click(screen.getByRole("button", { name: /^Загрузки:/ }));
    await flushPromises();
    expect(screen.getAllByTestId("upload-row")).toHaveLength(5);
    expect(row(1).getByRole("alert")).toBeTruthy();
    expect(screen.getAllByText("Готово")).toHaveLength(3);
  });
});

describe("итерации выбора файлов", () => {
  it("проверяет полное имя и размер без времени изменения и помнит удалённую строку до конца итерации", async () => {
    const { choose, requests } = await setup("server", 2);
    await fireEvent.click(row(0).getByRole("button", { name: "Убрать" }));
    await choose([
      new File(["contents"], "report-1.txt", { lastModified: 1 }),
      new File(["contents"], "report-2.txt", { lastModified: 2 }),
      new File(["contents"], "report-2.csv"),
      new File(["larger contents"], "report-2.txt"),
    ]);
    expect(screen.getAllByTestId("upload-row")).toHaveLength(3);
    expect(screen.queryByText("report-1.txt")).toBeNull();
    expect(requests).toHaveLength(0);
    await launch();
    requests.forEach((request) => request.finish());
    await flushPromises();
    await choose([new File(["contents"], "report-1.txt")]);
    expect(screen.getAllByTestId("upload-row")).toHaveLength(4);
    expect(screen.getAllByText("Готово")).toHaveLength(3);
    expect(row(3).getByText("Выбран")).toBeTruthy();
  });
});

describe("добавление в работающую очередь", () => {
  it("ждёт отдельного запуска добавлений и сохраняет каталог и режим после закрытия и навигации", async () => {
    const { choose, requests, router } = await setup("server", 1, {
      url: "/?directory=docs",
    });
    await launch();
    await fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await flushPromises();
    await router.push("/?directory=other");
    await flushPromises();
    await fireEvent.click(screen.getByRole("button", { name: /^Загрузки:/ }));
    await flushPromises();
    expect(
      (
        screen.getByRole("button", {
          name: "Напрямую в S3",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await choose([new File(["contents"], "added.txt")]);
    expect(requests).toHaveLength(1);
    expect(row(1).getByText("Выбран")).toBeTruthy();
    requests[0]!.finish();
    await flushPromises();
    await fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await flushPromises();
    await fireEvent.click(screen.getByRole("button", { name: /^Загрузки:/ }));
    await flushPromises();
    await choose([new File(["contents"], "report.txt", { lastModified: 1 })]);
    expect(screen.getAllByTestId("upload-row")).toHaveLength(2);
    await launch();
    expect(requests).toHaveLength(2);
    expect((requests[1]!.body as FormData).get("directory")).toBe("docs");
    requests[1]!.finish();
    await flushPromises();
  });
});

describe("порядок повторных попыток", () => {
  it("ставит повтор ошибочной строки после ожидающих файлов и сохраняет строки", async () => {
    const { requests, fetchMock } = await setup("server", 5);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) =>
      url.includes("/upload-operations/")
        ? Promise.resolve(json({ status: "failed" }))
        : original(url, init),
    );
    await launch();
    requests[0]!.fail();
    await flushPromises();
    await fireEvent.click(
      row(0).getByRole("button", { name: "Выяснить результат" }),
    );
    await flushPromises();
    await fireEvent.click(row(0).getByRole("button", { name: "Повторить" }));
    requests[1]!.finish();
    await flushPromises();
    expect((requests[4]!.body as FormData).get("file")).toMatchObject({
      name: "report-5.txt",
    });
    requests[2]!.finish();
    await flushPromises();
    expect((requests[5]!.body as FormData).get("file")).toMatchObject({
      name: "report-1.txt",
    });
    expect((requests[5]!.body as FormData).get("operationId")).toBe(
      (requests[0]!.body as FormData).get("operationId"),
    );
    expect(
      screen
        .getAllByTestId("upload-row")
        .map((element) => within(element).getByText(/report-/).textContent),
    ).toEqual([
      "report-1.txt",
      "report-2.txt",
      "report-3.txt",
      "report-4.txt",
      "report-5.txt",
    ]);
    requests.slice(3).forEach((request) => request.finish());
    await flushPromises();
  });

  it("ставит отменённую строку в конец очереди без нового выбора", async () => {
    const { requests } = await setup("server", 5);
    await launch();
    await fireEvent.click(row(3).getByRole("button", { name: "Отменить" }));
    await fireEvent.click(
      row(3).getByRole("button", { name: "Загрузить снова" }),
    );
    requests[0]!.finish();
    await flushPromises();
    expect((requests[3]!.body as FormData).get("file")).toMatchObject({
      name: "report-5.txt",
    });
    requests[1]!.finish();
    await flushPromises();
    expect((requests[4]!.body as FormData).get("file")).toMatchObject({
      name: "report-4.txt",
    });
    requests.slice(2).forEach((request) => request.finish());
    await flushPromises();
    expect(screen.getAllByText("Готово")).toHaveLength(5);
  });
});

describe("исправление режима и размера", () => {
  it("показывает ошибку размера в строке, загружает остальные и повторяет большой файл напрямую с прежней операцией", async () => {
    const { requests, choose, fetchMock, confirm } = await setup("server");
    const large = new File(["contents"], "large.txt");
    Object.defineProperty(large, "size", { value: 50 * 1024 * 1024 + 1 });
    await choose([large]);
    expect(row(1).getByRole("alert").textContent).toContain("50 МБ");
    await launch();
    expect(requests).toHaveLength(1);
    expect(row(1).getByText("Ошибка")).toBeTruthy();
    const operationId = useUpload().rows.value[1]!.operationId;
    expect(
      (
        screen.getAllByRole("button", {
          name: "Напрямую в S3",
        })[0] as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    requests[0]!.finish();
    await flushPromises();
    await fireEvent.click(
      screen.getAllByRole("button", { name: "Напрямую в S3" })[0]!,
    );
    expect(row(0).getByText("Корень · Через сервер")).toBeTruthy();
    await fireEvent.click(row(1).getByRole("button", { name: "Повторить" }));
    await flushPromises();
    const body = JSON.parse(
      String(
        fetchMock.mock.calls.find(([url]) => url.endsWith("presign-upload"))![1]
          ?.body,
      ),
    );
    expect(body.operationId).toBe(operationId);
    expect(body.filename).toBe("large.txt");
    expect(requests).toHaveLength(2);
    requests[1]!.finish();
    await flushPromises();
    confirm(1);
    await flushPromises();
    expect(screen.getAllByText("Готово")).toHaveLength(2);
  });

  it("сохраняет режим неизвестного результата и меняет его только после подтверждения неудачи", async () => {
    const { requests, fetchMock, confirm } = await setup("server");
    await launch();
    const first = requests[0]!.body as FormData;
    requests[0]!.fail();
    await flushPromises();
    await fireEvent.click(
      screen.getAllByRole("button", { name: "Напрямую в S3" })[0]!,
    );
    expect(row(0).getByText("Корень · Через сервер")).toBeTruthy();
    expect(
      (
        row(0).getByRole("button", {
          name: "Напрямую в S3",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fetchMock.mockResolvedValueOnce(json({ status: "failed" }));
    await fireEvent.click(
      row(0).getByRole("button", { name: "Выяснить результат" }),
    );
    await flushPromises();
    fetchMock.mockResolvedValueOnce(json({ status: "failed" }));
    await fireEvent.click(row(0).getByRole("button", { name: "Повторить" }));
    await flushPromises();
    const body = JSON.parse(
      String(
        fetchMock.mock.calls.find(([url]) => url.endsWith("presign-upload"))![1]
          ?.body,
      ),
    );
    expect(body.operationId).toBe(first.get("operationId"));
    expect(row(0).getByText("Корень · Напрямую в S3")).toBeTruthy();
    requests[1]!.finish();
    await flushPromises();
    confirm();
    await flushPromises();
    expect(row(0).getByText("Готово")).toBeTruthy();
  });
});

describe("границы итерации и последующие добавления", () => {
  it("запускает добавленный файл во время работы только после кнопки и начинает новую операцию того же файла после завершения", async () => {
    const { requests, choose } = await setup("server");
    await launch();
    await choose([new File(["contents"], "extra.txt")]);
    expect(requests).toHaveLength(1);
    await launch();
    expect(requests).toHaveLength(2);
    const firstId = (requests[0]!.body as FormData).get("operationId");
    requests.forEach((request) => request.finish());
    await flushPromises();
    await choose([new File(["contents"], "report.txt", { lastModified: 0 })]);
    expect(screen.getAllByText("Готово")).toHaveLength(2);
    expect(row(2).getByText("Выбран")).toBeTruthy();
    expect(requests).toHaveLength(2);
    await launch();
    expect((requests[2]!.body as FormData).get("operationId")).not.toBe(
      firstId,
    );
    requests[2]!.finish();
    await flushPromises();
    expect(screen.getAllByText("Готово")).toHaveLength(3);
  });

  it("разрешает новый выбор после удаления всех неотправленных строк", async () => {
    const { choose } = await setup("server");
    await fireEvent.click(row(0).getByRole("button", { name: "Убрать" }));
    await choose([new File(["contents"], "report.txt")]);
    expect(screen.getAllByTestId("upload-row")).toHaveLength(1);
    expect(row(0).getByText("Выбран")).toBeTruthy();
  });

  it("оставляет серверную ошибку размера в строке и разрешает безопасный повтор другим режимом", async () => {
    const { requests, fetchMock, confirm } = await setup("server");
    await launch();
    const operationId = (requests[0]!.body as FormData).get("operationId");
    requests[0]!.status = 413;
    requests[0]!.responseText = JSON.stringify({
      error: { code: "PAYLOAD_TOO_LARGE", message: "Превышен лимит" },
    });
    requests[0]!.finish();
    await flushPromises();
    expect(row(0).getByRole("alert").textContent).toContain(
      "Файл слишком большой",
    );
    await fireEvent.click(
      screen.getAllByRole("button", { name: "Напрямую в S3" })[0]!,
    );
    fetchMock.mockResolvedValueOnce(json({ status: "failed" }));
    await fireEvent.click(row(0).getByRole("button", { name: "Повторить" }));
    await flushPromises();
    const body = JSON.parse(
      String(
        fetchMock.mock.calls.find(([url]) => url.endsWith("presign-upload"))![1]
          ?.body,
      ),
    );
    expect(body.operationId).toBe(operationId);
    requests[1]!.finish();
    await flushPromises();
    confirm();
    await flushPromises();
    expect(row(0).getByText("Готово")).toBeTruthy();
  });
});

describe("завершённая итерация", () => {
  it("не открывает завершённую итерацию повтором старой строки и разрешает независимый выбор того же файла", async () => {
    const { requests, choose, fetchMock } = await setup("server");
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) =>
      url.includes("/upload-operations/")
        ? Promise.resolve(json({ status: "failed" }))
        : original(url, init),
    );
    await launch();
    requests[0]!.fail();
    await flushPromises();
    await fireEvent.click(
      row(0).getByRole("button", { name: "Выяснить результат" }),
    );
    await flushPromises();
    await fireEvent.click(row(0).getByRole("button", { name: "Повторить" }));
    await flushPromises();
    await choose([new File(["contents"], "report.txt")]);
    expect(screen.getAllByTestId("upload-row")).toHaveLength(2);
    expect(row(1).getByText("Выбран")).toBeTruthy();
    requests[1]!.finish();
    await flushPromises();
  });
});

describe("удаление готового файла из загрузок", () => {
  it("подтверждает удаление из хранилища и синхронизирует модалку со списком", async () => {
    const { wrapper, requests, fetchMock } = await setup("server");
    await fireEvent.click(screen.getByRole("button", { name: /^Загрузить$/ }));
    await flushPromises();
    requests[0]!.finish();
    await flushPromises();
    await fireEvent.click(
      screen.getByRole("button", { name: "Удалить из хранилища" }),
    );
    const confirmation = screen.getByRole("alertdialog");
    expect(
      within(confirmation).getByText("Удалить файл из хранилища?"),
    ).toBeTruthy();
    expect(confirmation.textContent).toContain("report.txt");
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(0);
    await fireEvent.click(
      within(confirmation).getByRole("button", { name: "Отмена" }),
    );
    await flushPromises();
    expect(screen.getByText("Готово")).toBeTruthy();
    await fireEvent.click(
      screen.getByRole("button", { name: "Удалить из хранилища" }),
    );
    await fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Удалить",
      }),
    );
    await flushPromises();
    expect(screen.queryByText("Готово")).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(1);
    expect(useFileBrowser().files.value).toHaveLength(0);
    wrapper.unmount();
  });
});

it.each(["модалка", "список"])(
  "сохраняет строку при ошибке, разрешает повтор и блокирует повторное подтверждение: %s",
  async (origin) => {
    const { requests, fetchMock, finishDelete, deleteResponses } = await setup(
      "server",
      1,
      { delayedDelete: true },
    );
    deleteResponses.push(
      new Response(
        JSON.stringify({
          error: { code: "INTERNAL_ERROR", message: "Ошибка сервера" },
        }),
        { status: 500 },
      ),
    );
    await fireEvent.click(screen.getByRole("button", { name: /^Загрузить$/ }));
    await flushPromises();
    requests[0]!.finish();
    await flushPromises();
    if (origin === "список") {
      await fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
      await flushPromises();
    }
    await fireEvent.click(
      screen.getByRole("button", {
        name: origin === "список" ? "Удалить файл" : "Удалить из хранилища",
      }),
    );
    const confirm = within(screen.getByRole("alertdialog")).getByRole(
      "button",
      { name: "Удалить" },
    );
    await fireEvent.click(confirm);
    await flushPromises();
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    (confirm as HTMLButtonElement).click();
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(1);
    finishDelete();
    await flushPromises();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(useFileBrowser().files.value).toHaveLength(1);
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await fireEvent.click(confirm);
    await flushPromises();
    finishDelete();
    await flushPromises();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByText("Готово")).toBeNull();
    expect(useFileBrowser().files.value).toHaveLength(0);
  },
);

it.each(["модалка", "список"])(
  "синхронизирует уже удалённый файл по FILE_NOT_FOUND: %s",
  async (origin) => {
    const { requests, deleteResponses } = await setup("server");
    deleteResponses.push(
      new Response(
        JSON.stringify({
          error: { code: "FILE_NOT_FOUND", message: "Файл не найден" },
        }),
        { status: 404 },
      ),
    );
    await fireEvent.click(screen.getByRole("button", { name: /^Загрузить$/ }));
    await flushPromises();
    requests[0]!.finish();
    await flushPromises();
    if (origin === "список") {
      await fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
      await flushPromises();
    }
    await fireEvent.click(
      screen.getByRole("button", {
        name: origin === "список" ? "Удалить файл" : "Удалить из хранилища",
      }),
    );
    await fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Удалить",
      }),
    );
    await flushPromises();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByText("Готово")).toBeNull();
    expect(useFileBrowser().files.value).toHaveLength(0);
  },
);

it("удаляет из списка сохранённый результат прошлой итерации по идентификатору, сохраняя одноимённый файл", async () => {
  const { requests, file, choose } = await setup("server");
  await fireEvent.click(screen.getByRole("button", { name: /^Загрузить$/ }));
  await flushPromises();
  requests[0]!.finish();
  await flushPromises();
  await choose([new File(["contents"], file.name, { type: "text/plain" })]);
  await fireEvent.click(screen.getByRole("button", { name: /^Загрузить$/ }));
  await flushPromises();
  requests[1]!.file = { ...file, id: "file-2", key: "file-2.txt" };
  requests[1]!.responseText = JSON.stringify(requests[1]!.file);
  requests[1]!.finish();
  await flushPromises();
  await fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  await flushPromises();
  await fireEvent.click(
    screen.getAllByRole("button", { name: "Удалить файл" })[0]!,
  );
  await fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Удалить",
    }),
  );
  await flushPromises();
  expect(useFileBrowser().files.value.map((item) => item.id)).toEqual([
    "file-2",
  ]);
  await fireEvent.click(screen.getByRole("button", { name: /^Загрузки:/ }));
  await flushPromises();
  expect(screen.getAllByText("Готово")).toHaveLength(1);
  expect(
    within(screen.getByRole("dialog")).getAllByText("report.txt"),
  ).toHaveLength(1);
});

it("не разрешает повторно выбрать удалённый готовый файл до конца текущей итерации", async () => {
  const { requests, choose, file } = await setup("server");
  await fireEvent.click(screen.getByRole("button", { name: /^Загрузить$/ }));
  await flushPromises();
  const other = new File(["other"], "other.txt");
  await choose([other]);
  requests[0]!.finish();
  await flushPromises();
  await fireEvent.click(
    screen.getByRole("button", { name: "Удалить из хранилища" }),
  );
  await fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Удалить",
    }),
  );
  await flushPromises();
  await choose([new File(["contents"], file.name)]);
  expect(within(screen.getByRole("dialog")).queryByText(file.name)).toBeNull();
  await fireEvent.click(screen.getByRole("button", { name: "Убрать" }));
  await choose([new File(["contents"], file.name)]);
  expect(within(screen.getByRole("dialog")).getByText(file.name)).toBeTruthy();
});

it.each(["ошибка", "отмена"])(
  "убирает строку с исходом %s без удаления одноимённого готового файла и сохраняет учёт выбора",
  async (outcome) => {
    const { requests, choose, file, fetchMock } = await setup("server");
    await fireEvent.click(screen.getByRole("button", { name: /^Загрузить$/ }));
    await flushPromises();
    requests[0]!.finish();
    await flushPromises();
    await choose([
      new File(["contents"], file.name),
      new File(["other"], "other.txt"),
    ]);
    await fireEvent.click(screen.getByRole("button", { name: /^Загрузить$/ }));
    await flushPromises();
    expect(screen.queryByRole("button", { name: "Убрать строку" })).toBeNull();
    if (outcome === "ошибка") requests[1]!.fail();
    else
      await fireEvent.click(
        screen.getAllByRole("button", { name: "Отменить" })[0]!,
      );
    await flushPromises();
    await fireEvent.click(
      screen.getByRole("button", { name: "Убрать строку" }),
    );
    await choose([new File(["contents"], file.name)]);
    expect(
      within(screen.getByRole("dialog")).getAllByText(file.name),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(0);
    expect(useFileBrowser().files.value.map((item) => item.id)).toEqual([
      file.id,
    ]);
    requests[2]!.finish();
    await flushPromises();
    await choose([new File(["contents"], file.name)]);
    expect(
      within(screen.getByRole("dialog")).getAllByText(file.name),
    ).toHaveLength(2);
  },
);
