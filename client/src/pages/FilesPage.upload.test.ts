import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { fireEvent, screen } from "@testing-library/vue";
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

async function setup(source: UploadSource) {
  let uploaded = false;
  let confirm!: () => void;
  const file: FileDto = {
    id: "file-1",
    name: "report.txt",
    directory: "",
    extension: "txt",
    contentType: "text/plain",
    size: 8,
    etag: "etag",
    status: "ready",
    uploadSource: source,
    bucket: "files",
    key: "file-1.txt",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/files/presign-upload") {
      return json(
        source === "presigned"
          ? {
              strategy: "single",
              id: file.id,
              key: file.key,
              directory: "",
              uploadUrl: "https://storage.test/file",
              requiredHeaders: { "Content-Type": "text/plain" },
              expiresAt: "2026-01-01T01:00:00Z",
            }
          : {
              strategy: "multipart",
              id: file.id,
              key: file.key,
              directory: "",
              uploadId: "upload-1",
              size: 8,
              partSize: 4,
              partCount: 2,
              maxConcurrency: 2,
              expiresAt: "2026-01-01T01:00:00Z",
              parts: [
                {
                  partNumber: 1,
                  offset: 0,
                  size: 4,
                  url: "https://storage.test/part-1",
                },
                {
                  partNumber: 2,
                  offset: 4,
                  size: 4,
                  url: "https://storage.test/part-2",
                },
              ],
            },
      );
    }
    if (url === `/api/files/${file.id}/complete`) {
      return new Promise<Response>((resolve) => {
        confirm = () => {
          uploaded = true;
          resolve(json(file));
        };
      });
    }
    if (url.startsWith("/api/directories"))
      return json({ parent: "", items: [] });
    return json({
      items: uploaded ? [file] : [],
      pagination: {
        page: 1,
        limit: 20,
        total: uploaded ? 1 : 0,
        totalPages: uploaded ? 1 : 0,
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const requests: UploadRequest[] = [];
  class UploadRequest extends EventTarget {
    status = source === "server" ? 201 : 200;
    responseText = source === "server" ? JSON.stringify(file) : "";
    upload = new EventTarget();
    body: XMLHttpRequestBodyInit | null = null;
    open() {}
    setRequestHeader() {}
    send(body: XMLHttpRequestBodyInit) {
      this.body = body;
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
      if (source === "server") uploaded = true;
      this.dispatchEvent(new Event("load"));
    }
    abort() {
      this.dispatchEvent(new Event("abort"));
    }
  }
  vi.stubGlobal("XMLHttpRequest", UploadRequest);
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (
    this: HTMLInputElement,
  ) {
    Object.defineProperty(this, "files", {
      configurable: true,
      value: [new File(["contents"], "report.txt", { type: "text/plain" })],
    });
    this.dispatchEvent(new Event("change"));
  });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: FilesPage }],
  });
  await router.push("/");
  await router.isReady();
  const wrapper = mount(FilesPage, {
    attachTo: document.body,
    global: { plugins: [router] },
  });
  await flushPromises();
  await fireEvent.click(screen.getByRole("button", { name: "Загрузить файл" }));
  await flushPromises();
  if (source !== "server") {
    await fireEvent.click(
      screen.getByRole("button", { name: "Напрямую в S3" }),
    );
  }
  await fireEvent.click(screen.getByRole("button", { name: "Выбрать файл" }));
  await flushPromises();
  return { wrapper, requests, fetchMock, confirm: () => confirm(), file };
}

beforeEach(() => {
  useFileBrowser().reset();
  useUpload().selectedFile.value = null;
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
      const operation = useUpload().operation.value!;

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
      expect(useUpload().operation.value).toBe(operation);
      expect(
        screen.getByText(
          source === "server" ? "Обрабатываем…" : "Подтверждаем…",
        ),
      ).toBeTruthy();

      if (source === "server") requests[0]!.finish();
      else confirm();
      await flushPromises();

      expect(wrapper.text()).toContain("report.txt");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(operation.outcome.value).toEqual({ status: "succeeded", file });
      expect(operation.uploading.value).toBe(false);
    },
  );

  it("отменяет передачу через сервер и сохраняет отмену после закрытия диалога", async () => {
    const { requests } = await setup("server");
    await fireEvent.click(screen.getByRole("button", { name: /^Загрузить$/ }));
    await flushPromises();
    const operation = useUpload().operation.value!;
    const abort = vi.spyOn(requests[0]!, "abort");

    await fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    await flushPromises();
    expect(abort).toHaveBeenCalledOnce();
    expect(operation.outcome.value).toEqual({ status: "cancelled" });
    expect(operation.uploading.value).toBe(false);
    await fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await flushPromises();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useUpload().operation.value?.outcome.value).toEqual({
      status: "cancelled",
    });
  });
});
