import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { fireEvent, screen, within } from "@testing-library/vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { createAppRouter } from "@/router";
import { useAuth } from "@/composables/useAuth";
import FilesPage from "./FilesPage.vue";
import { useUpload } from "@/composables/useUpload";
import { useFileBrowser } from "@/composables/useFileBrowser";
import { expireSession, startSession } from "@/api/session";
import type { FileDto, UploadSource } from "@/types/api";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
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
    ignorePreparationAbort?: boolean;
    preparationResponse?: Response;
    lifecycle?: boolean;
    delayedLogout?: boolean;
    url?: string;
  } = {},
) {
  const ready: FileDto[] = [];
  const deleteResponses: Response[] = [];
  const confirmations = new Map<string, () => void>();
  const deletions = new Map<string, () => void>();
  const preparations: (() => void)[] = [];
  let finishLogout = () => {};
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
  const operations = new Map<string, string>();
  const fetchMock = vi.fn(
    async (url: string, init?: RequestInit): Promise<Response> => {
      if (url === "/api/auth/logout") {
        if (options.delayedLogout)
          return new Promise((resolve) => {
            finishLogout = () => resolve(new Response(null, { status: 204 }));
          });
        return new Response(null, { status: 204 });
      }
      if (url === "/api/auth/refresh" || url === "/api/auth/login")
        return json({
          accessToken: "token",
          expiresIn: 3600,
          user: { login: "operator" },
        });
      if (url === "/api/files/presign-upload") {
        const body = JSON.parse(String(init?.body));
        const fileId =
          operations.get(body.operationId) ?? `file-${operations.size + 1}`;
        const file = {
          ...result(filenames.indexOf(body.filename), body.directory),
          id: fileId,
          key: `${fileId}.txt`,
        };
        results.set(file.id, file);
        operations.set(body.operationId, file.id);
        const response =
          options.preparationResponse ??
          json(
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
            if (!options.ignorePreparationAbort)
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("Отменено", "AbortError")),
              );
          });
        return response;
      }
      if (url.endsWith("/fail")) return json({ status: "discarded" });
      if (url.includes("/upload-operations/") && !url.endsWith("/cancel"))
        return json({ status: "failed" });
      if (url.endsWith("/cancel")) {
        const cancel = () => {
          const fileId = operations.get(url.split("/")[4]!);
          const index = ready.findIndex((file) => file.id === fileId);
          if (index !== -1) ready.splice(index, 1);
          return json({ status: "cancelled" });
        };
        if (options.delayedDelete)
          return new Promise((resolve) => {
            deletions.set("file-1", () =>
              resolve(json({ status: "cancelled" })),
            );
          });
        return cancel();
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
    aborted = false;
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
        const fileId =
          operations.get(String(body.get("operationId"))) ??
          `file-${operations.size + 1}`;
        this.file = { ...this.file, id: fileId, key: `${fileId}.txt` };
        operations.set(String(body.get("operationId")), this.file.id);
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
      this.aborted = true;
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
  const router = options.lifecycle
    ? createAppRouter({
        history: createMemoryHistory(),
        auth: useAuth(),
        upload: useUpload(),
        browser: useFileBrowser(),
        notify: () => {},
      })
    : createRouter({
        history: createMemoryHistory(),
        routes: [{ path: "/", component: FilesPage }],
      });
  await router.push(options.url ?? "/");
  await router.isReady();
  const wrapper = mount(options.lifecycle ? RouterView : FilesPage, {
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
    operationId(index = 0): string {
      return source === "server"
        ? String((requests[index]!.body as FormData).get("operationId"))
        : JSON.parse(
            String(
              fetchMock.mock.calls.filter(([url]) =>
                url.endsWith("presign-upload"),
              )[index]![1]?.body,
            ),
          ).operationId;
    },
    wrapper,
    router,
    requests,
    fetchMock,
    confirm: (index?: number) =>
      index === undefined
        ? [...confirmations.values()][0]!()
        : confirmations.get(`file-${index + 1}`)!(),
    finishDelete: (index = 0) => deletions.get(`file-${index + 1}`)!(),
    preparations,
    finishLogout: () => finishLogout(),
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

function row(index: number) {
  return within(screen.getAllByTestId("upload-row")[index]!);
}
async function launch(): Promise<void> {
  await fireEvent.click(screen.getByRole("button", { name: /^Загрузить$/ }));
  await flushPromises();
}
async function loginAgain(): Promise<void> {
  await fireEvent.update(screen.getByLabelText("Логин"), "operator");
  await fireEvent.update(screen.getByLabelText("Пароль"), "password");
  await fireEvent.click(screen.getByRole("button", { name: "Войти" }));
  await flushPromises();
}

it("предупреждает об уходе с активными файлами и снимает предупреждение после успеха", async () => {
  const { requests } = await setup("server");
  const leaving = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(leaving()).toBe(true);
  await launch();
  expect(leaving()).toBe(true);
  requests[0]!.finish();
  await flushPromises();
  expect(leaving()).toBe(false);
});

it.each(["server", "presigned", "multipart"] as const)(
  "показывает единое состояние загрузки %s и подтверждает успех только после ответа",
  async (source) => {
    const { requests, confirm } = await setup(source);
    expect(row(0).getByText("Выбран")).toBeTruthy();
    await launch();
    expect(row(0).getByText("Загружается")).toBeTruthy();
    expect(
      row(0).queryByRole("button", { name: "Выяснить результат" }),
    ).toBeNull();
    expect(row(0).queryByRole("button", { name: "Через сервер" })).toBeNull();
    for (const request of requests) {
      request.progress(
        source === "server" ? 100 : 8 / requests.length,
        source === "server" ? 100 : 8 / requests.length,
      );
      request.upload.dispatchEvent(new Event("load"));
    }
    await flushPromises();
    expect(row(0).getByText("99%")).toBeTruthy();
    expect(
      row(0).getByRole("button", { name: "Отменить" }).hasAttribute("disabled"),
    ).toBe(false);
    requests.forEach((request) => request.finish());
    await flushPromises();
    if (source !== "server") {
      expect(row(0).getByText("Загружается")).toBeTruthy();
      expect(row(0).queryByText("Успех")).toBeNull();
      confirm();
      await flushPromises();
    }
    expect(row(0).getByText("Успех")).toBeTruthy();
    expect(row(0).getByText("100%")).toBeTruthy();
  },
);

it.each(["server", "presigned", "multipart"] as const)(
  "сохраняет предел трёх передач %s и запускает очередь после подтверждения",
  async (source) => {
    const { requests, confirm } = await setup(source, 5);
    const parts = source === "multipart" ? 2 : 1;
    await launch();
    expect(requests).toHaveLength(3 * parts);
    expect(screen.getAllByText("Загружается")).toHaveLength(5);
    requests.slice(0, parts).forEach((request) => request.finish());
    await flushPromises();
    if (source !== "server") {
      expect(requests).toHaveLength(3 * parts);
      confirm(0);
      await flushPromises();
    }
    expect(requests).toHaveLength(4 * parts);
    requests.slice(parts).forEach((request) => request.finish());
    await flushPromises();
    if (source !== "server") {
      confirm(1);
      await flushPromises();
    }
    expect(requests).toHaveLength(5 * parts);
    requests.slice(4 * parts).forEach((request) => request.finish());
    await flushPromises();
    if (source !== "server") {
      confirm(2);
      confirm(3);
      confirm(4);
      await flushPromises();
    }
    expect(screen.getAllByText("Успех")).toHaveLength(5);
  },
);

it("автоматически восстанавливает потерянный ответ без кнопки проверки", async () => {
  const { requests, fetchMock, file } = await setup("server");
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url, init) =>
    url.includes("/upload-operations/")
      ? Promise.resolve(json({ status: "succeeded", file }))
      : original(url, init),
  );
  await launch();
  requests[0]!.dispatchEvent(new Event("error"));
  await flushPromises();
  expect(row(0).getByText("Успех")).toBeTruthy();
  expect(requests).toHaveLength(1);
  expect(row(0).queryByRole("button", { name: "Повторить" })).toBeNull();
});

it("повторяет подтверждённую ошибку одной кнопкой и сохраняет родительский выбор режима", async () => {
  const { requests, confirm, fetchMock } = await setup("server");
  await launch();
  const originalId = (requests[0]!.body as FormData).get("operationId");
  requests[0]!.fail();
  await flushPromises();
  expect(row(0).getByText("Ошибка загрузки")).toBeTruthy();
  expect(row(0).queryByRole("button", { name: "Напрямую в S3" })).toBeNull();
  await fireEvent.click(screen.getByRole("button", { name: "Напрямую в S3" }));
  await fireEvent.click(row(0).getByRole("button", { name: "Повторить" }));
  await flushPromises();
  const body = JSON.parse(
    String(
      fetchMock.mock.calls.find(([url]) => url.endsWith("presign-upload"))![1]
        ?.body,
    ),
  );
  expect(body.operationId).not.toBe(originalId);
  requests[1]!.finish();
  await flushPromises();
  confirm();
  await flushPromises();
  expect(row(0).getByText("Успех")).toBeTruthy();
});

it.each(["server", "presigned", "multipart"] as const)(
  "подтверждает отмену %s на сервере и сохраняет остальные строки",
  async (source) => {
    const { requests, fetchMock } = await setup(source, 5);
    await launch();
    const id = useUpload().rows.value[0]!.operationId;
    await fireEvent.click(row(0).getByRole("button", { name: "Отменить" }));
    await flushPromises();
    expect(row(0).getByText("Отменено")).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === `/api/files/upload-operations/${id}/cancel`,
      ),
    ).toBe(true);
    expect(
      requests
        .slice(source === "multipart" ? 2 : 1)
        .every((request) => !request.aborted),
    ).toBe(true);
    expect(row(0).getByRole("button", { name: "Повторить" })).toBeTruthy();
  },
);

it("не скрывает удаляемую строку, пока сервер не подтвердит очистку", async () => {
  const { requests, fetchMock } = await setup("server");
  await launch();
  requests[0]!.fail();
  await flushPromises();
  let finish!: () => void;
  fetchMock.mockResolvedValueOnce(json({ status: "processing" }));
  await fireEvent.click(row(0).getByRole("button", { name: "Удалить" }));
  await flushPromises();
  expect(row(0).getByText("Загружается")).toBeTruthy();
  expect(useUpload().rows.value[0]!.intent.value).toBe("remove");
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(json({ status: "cancelled" }));
      }),
  );
  useUpload().resume();
  await flushPromises();
  finish();
  await flushPromises();
  expect(screen.queryAllByTestId("upload-row")).toHaveLength(0);
});

it.each(["server", "presigned", "multipart"] as const)(
  "после повторного входа автоматически проверяет операцию %s без новой передачи",
  async (source) => {
    const { requests, fetchMock, file, router } = await setup(source, 1, {
      lifecycle: true,
    });
    await launch();
    const count = requests.length;
    expireSession();
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("login");
    expect(useUpload().rows.value).toHaveLength(1);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) =>
      url.includes("/upload-operations/")
        ? Promise.resolve(json({ status: "succeeded", file }))
        : original(url, init),
    );
    await loginAgain();
    await fireEvent.click(screen.getByRole("button", { name: /^Загрузки:/ }));
    await flushPromises();
    expect(row(0).getByText("Успех")).toBeTruthy();
    expect(requests).toHaveLength(count);
  },
);

it("после выхода сохраняет историю и игнорирует поздний ответ до следующего входа", async () => {
  const { requests, router } = await setup("server", 1, { lifecycle: true });
  await launch();
  await fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  await flushPromises();
  await fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
  await flushPromises();
  await fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Выйти",
    }),
  );
  await flushPromises();
  expect(router.currentRoute.value.name).toBe("login");
  expect(useUpload().rows.value).toHaveLength(1);
  requests[0]!.finish();
  await flushPromises();
  expect(useUpload().rows.value[0]!.status.value).toBe("failed");
  expect(useUpload().rows.value[0]!.result.value).toBeNull();
});

describe("итерации выбора файлов", () => {
  it("проверяет полное имя и размер без времени изменения и помнит удалённую строку до конца итерации", async () => {
    const { choose, requests } = await setup("server", 2);
    await fireEvent.click(row(0).getByRole("button", { name: "Удалить" }));
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
    expect(screen.getAllByText("Успех")).toHaveLength(3);
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
    expect(screen.getAllByText("Успех")).toHaveLength(2);
    expect(row(2).getByText("Выбран")).toBeTruthy();
    expect(requests).toHaveLength(2);
    await launch();
    expect((requests[2]!.body as FormData).get("operationId")).not.toBe(
      firstId,
    );
    requests[2]!.finish();
    await flushPromises();
    expect(screen.getAllByText("Успех")).toHaveLength(3);
  });

  it("разрешает новый выбор после удаления всех неотправленных строк", async () => {
    const { choose } = await setup("server");
    await fireEvent.click(row(0).getByRole("button", { name: "Удалить" }));
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
    await fireEvent.click(row(0).getByRole("button", { name: "Повторить" }));
    await flushPromises();
    const body = JSON.parse(
      String(
        fetchMock.mock.calls.find(([url]) => url.endsWith("presign-upload"))![1]
          ?.body,
      ),
    );
    expect(body.operationId).not.toBe(operationId);
    requests[1]!.finish();
    await flushPromises();
    confirm();
    await flushPromises();
    expect(row(0).getByText("Успех")).toBeTruthy();
  });
});

describe("удаление готового файла из загрузок", () => {
  it("подтверждает удаление из хранилища и синхронизирует модалку со списком", async () => {
    const { wrapper, requests, fetchMock } = await setup("server");
    await fireEvent.click(screen.getByRole("button", { name: /^Загрузить$/ }));
    await flushPromises();
    requests[0]!.finish();
    await flushPromises();
    await fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    const confirmation = screen.getByRole("alertdialog");
    expect(
      within(confirmation).getByText("Удалить файл из хранилища?"),
    ).toBeTruthy();
    expect(confirmation.textContent).toContain("report.txt");
    expect(
      fetchMock.mock.calls.filter(([url]) => url.endsWith("/cancel")),
    ).toHaveLength(0);
    await fireEvent.click(
      within(confirmation).getByRole("button", { name: "Отмена" }),
    );
    await flushPromises();
    expect(screen.getByText("Успех")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    await fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Удалить",
      }),
    );
    await flushPromises();
    expect(screen.queryByText("Успех")).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([url]) => url.endsWith("/cancel")),
    ).toHaveLength(1);
    expect(useFileBrowser().files.value).toHaveLength(0);
    wrapper.unmount();
  });
});

it.each(["список"])(
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
        name: origin === "список" ? "Удалить файл" : "Удалить",
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
    expect(screen.queryByText("Успех")).toBeNull();
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
        name: origin === "список" ? "Удалить файл" : "Удалить",
      }),
    );
    await fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Удалить",
      }),
    );
    await flushPromises();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByText("Успех")).toBeNull();
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
  expect(screen.getAllByText("Успех")).toHaveLength(1);
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
  await fireEvent.click(row(0).getByRole("button", { name: "Удалить" }));
  await fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Удалить",
    }),
  );
  await flushPromises();
  await choose([new File(["contents"], file.name)]);
  expect(within(screen.getByRole("dialog")).queryByText(file.name)).toBeNull();
  await fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
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
    expect(row(1).queryByRole("button", { name: "Удалить" })).toBeNull();
    if (outcome === "ошибка") requests[1]!.fail();
    else
      await fireEvent.click(
        screen.getAllByRole("button", { name: "Отменить" })[0]!,
      );
    await flushPromises();
    await fireEvent.click(row(1).getByRole("button", { name: "Удалить" }));
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

it("после подтверждения удаления готового файла повторяет очистку автоматически и сохраняет строку до ответа", async () => {
  const { requests, fetchMock } = await setup("server");
  await launch();
  requests[0]!.finish();
  await flushPromises();
  const original = fetchMock.getMockImplementation()!;
  let attempts = 0;
  fetchMock.mockImplementation((url, init) => {
    if (url.endsWith("/cancel") && attempts++ === 0)
      return Promise.reject(new Error("Нет связи"));
    return original(url, init);
  });
  await fireEvent.click(row(0).getByRole("button", { name: "Удалить" }));
  await fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Удалить",
    }),
  );
  await flushPromises();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(row(0).getByText("Загружается")).toBeTruthy();
  expect(row(0).queryByRole("button", { name: "Повторить" })).toBeNull();
  window.dispatchEvent(new Event("online"));
  await flushPromises();
  expect(screen.queryAllByTestId("upload-row")).toHaveLength(0);
  expect(useFileBrowser().files.value).toHaveLength(0);
});
