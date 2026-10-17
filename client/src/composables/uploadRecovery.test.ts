import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { ApiError } from "@/api/client";
import { clearSession, startSession } from "@/api/session";
import {
  cancelUploadOperation,
  failUploadOperation,
  resolveUploadOperation,
  uploadViaServer,
} from "@/api/files";
import type { FileDto } from "@/types/api";
import { useUpload } from "./useUpload";

vi.mock("@/api/files", () => ({
  cancelUploadOperation: vi.fn(),
  failUploadOperation: vi.fn(),
  resolveUploadOperation: vi.fn(),
  uploadViaServer: vi.fn(),
  presignUpload: vi.fn(),
  putToPresignedUrl: vi.fn(),
  putPart: vi.fn(),
  completeUpload: vi.fn(),
  getMultipartStatus: vi.fn(),
  fetchPartUrls: vi.fn(),
}));
vi.mock("./useFileBrowser", () => ({
  useFileBrowser: () => ({ refresh: vi.fn() }),
}));

const file = () =>
  new File(["hello"], "report.txt", { type: "text/plain", lastModified: 1000 });
const ready = {
  id: "file-1",
  name: "report.txt",
  directory: "",
  status: "ready",
  size: 5,
} as FileDto;
const networkError = () => new ApiError(0, "NETWORK_ERROR", "Нет связи");
const upload = useUpload();
function login(): void {
  startSession({
    accessToken: "token",
    expiresIn: 3600,
    user: { login: "operator" },
  });
}
function launch(): void {
  upload.addFiles([file()]);
  upload.submit("");
}

beforeEach(() => {
  upload.reset();
  clearSession();
  localStorage.clear();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.mocked(resolveUploadOperation).mockResolvedValue({ status: "processing" });
  vi.mocked(cancelUploadOperation).mockResolvedValue({ status: "cancelled" });
  vi.mocked(failUploadOperation).mockResolvedValue({ status: "discarded" });
  login();
});
afterEach(() => {
  upload.reset();
  clearSession();
  vi.useRealTimers();
});

describe("автоматическое восстановление загрузки", () => {
  it("восстанавливает успех после потери ответа без новой передачи", async () => {
    vi.mocked(uploadViaServer).mockRejectedValue(networkError());
    vi.mocked(resolveUploadOperation).mockResolvedValue({
      status: "succeeded",
      file: ready,
    });
    launch();
    await flushPromises();
    expect(upload.rows.value[0]!.status.value).toBe("succeeded");
    expect(uploadViaServer).toHaveBeenCalledOnce();
    expect(failUploadOperation).not.toHaveBeenCalled();
  });

  it("после минуты показывает ошибку и продолжает проверку до успеха", async () => {
    vi.mocked(uploadViaServer).mockRejectedValue(networkError());
    launch();
    await flushPromises();
    const row = upload.rows.value[0]!;
    expect(row.status.value).toBe("uploading");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(row.status.value).toBe("failed");
    expect(row.message.value).toContain("Проверим загрузку автоматически");
    expect(row.pending.value).toBe(true);
    vi.mocked(resolveUploadOperation).mockResolvedValue({
      status: "succeeded",
      file: ready,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(row.status.value).toBe("succeeded");
    expect(uploadViaServer).toHaveBeenCalledOnce();
  });

  it("ограничивает зависший запрос проверки и сохраняет фоновое восстановление", async () => {
    vi.mocked(uploadViaServer).mockRejectedValue(networkError());
    vi.mocked(resolveUploadOperation).mockImplementation(
      (_id, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Отменено", "AbortError")),
          );
        }),
    );
    launch();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(upload.rows.value[0]!.status.value).toBe("failed");
    expect(vi.mocked(resolveUploadOperation).mock.calls.length).toBeGreaterThan(
      1,
    );
    expect(uploadViaServer).toHaveBeenCalledOnce();
  });

  it("делает только два автоматических повтора и очищает подтверждённую неудачу", async () => {
    vi.mocked(uploadViaServer).mockRejectedValue(networkError());
    vi.mocked(resolveUploadOperation).mockResolvedValue({ status: "failed" });
    launch();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(uploadViaServer).toHaveBeenCalledTimes(3);
    expect(
      new Set(vi.mocked(uploadViaServer).mock.calls.map((args) => args[3]))
        .size,
    ).toBe(1);
    expect(failUploadOperation).toHaveBeenCalledOnce();
    expect(upload.rows.value[0]!.status.value).toBe("failed");
    expect(upload.rows.value[0]!.pending.value).toBe(false);
  });

  it("не повторяет ошибку размера автоматически", async () => {
    vi.mocked(uploadViaServer).mockRejectedValue(
      new ApiError(413, "PAYLOAD_TOO_LARGE", "Лимит"),
    );
    launch();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(uploadViaServer).toHaveBeenCalledOnce();
    expect(upload.rows.value[0]!.status.value).toBe("failed");
  });

  it("не начинает новую передачу при неизвестном исходе", async () => {
    vi.mocked(uploadViaServer).mockRejectedValue(networkError());
    launch();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(65_000);
    await upload.retry(upload.rows.value[0]!);
    expect(uploadViaServer).toHaveBeenCalledOnce();
    expect(failUploadOperation).not.toHaveBeenCalled();
  });

  it("после окончательной очистки ручной повтор создаёт новую операцию", async () => {
    vi.mocked(uploadViaServer).mockRejectedValue(networkError());
    vi.mocked(resolveUploadOperation).mockResolvedValue({ status: "failed" });
    launch();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(4_000);
    const row = upload.rows.value[0]!;
    const originalId = row.operationId;
    vi.mocked(uploadViaServer).mockResolvedValue(ready);
    await upload.retry(row);
    await flushPromises();
    expect(row.operationId).not.toBe(originalId);
    expect(row.status.value).toBe("succeeded");
  });

  it("не отправляет файл повторно, если завершение ошибки обнаружило успех", async () => {
    vi.mocked(uploadViaServer).mockRejectedValue(
      new ApiError(502, "STORAGE_ERROR", "Ошибка"),
    );
    vi.mocked(resolveUploadOperation).mockResolvedValue({ status: "failed" });
    vi.mocked(failUploadOperation).mockResolvedValue({
      status: "succeeded",
      file: ready,
    });
    launch();
    await flushPromises();
    expect(upload.rows.value[0]!.status.value).toBe("succeeded");
    expect(uploadViaServer).toHaveBeenCalledOnce();
  });
});

describe("устойчивая отмена и удаление", () => {
  it("отменяет уже сохранённый файл через сервер и ждёт подтверждения", async () => {
    vi.mocked(uploadViaServer).mockResolvedValue(ready);
    launch();
    await flushPromises();
    const row = upload.rows.value[0]!;
    vi.mocked(cancelUploadOperation).mockResolvedValueOnce({
      status: "processing",
    });
    upload.cancelRow(row);
    await flushPromises();
    expect(row.status.value).toBe("uploading");
    expect(row.intent.value).toBe("cancel");
    await upload.retry(row);
    expect(uploadViaServer).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(row.status.value).toBe("cancelled");
  });

  it("после тайм-аута отмены показывает ошибку и завершает её автоматически", async () => {
    vi.mocked(uploadViaServer).mockResolvedValue(ready);
    launch();
    await flushPromises();
    const row = upload.rows.value[0]!;
    vi.mocked(cancelUploadOperation).mockRejectedValue(networkError());
    upload.cancelRow(row);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(row.status.value).toBe("failed");
    expect(row.message.value).toContain("Не удалось подтвердить отмену");
    vi.mocked(cancelUploadOperation).mockResolvedValue({ status: "cancelled" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(row.status.value).toBe("cancelled");
  });

  it("не скрывает неизвестную загрузку до подтверждения удаления", async () => {
    vi.mocked(uploadViaServer).mockRejectedValue(networkError());
    launch();
    await flushPromises();
    const row = upload.rows.value[0]!;
    vi.mocked(cancelUploadOperation).mockResolvedValueOnce({
      status: "processing",
    });
    upload.remove(row);
    await flushPromises();
    expect(upload.rows.value).toContain(row);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(upload.rows.value).toHaveLength(0);
  });

  it("после нового входа автоматически продолжает отмену, прерванную выходом", async () => {
    vi.mocked(uploadViaServer).mockResolvedValue(ready);
    launch();
    await flushPromises();
    vi.mocked(cancelUploadOperation).mockRejectedValue(networkError());
    const row = upload.rows.value[0]!;
    upload.cancelRow(row);
    await flushPromises();
    upload.stop();
    clearSession();
    const count = vi.mocked(cancelUploadOperation).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cancelUploadOperation).toHaveBeenCalledTimes(count);
    vi.mocked(cancelUploadOperation).mockResolvedValue({ status: "cancelled" });
    login();
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();
    expect(row.status.value).toBe("cancelled");
  });
});

describe("восстановление после перезагрузки", () => {
  it("восстанавливает неизвестную операцию без содержимого файла и автоматически находит успех", async () => {
    vi.mocked(uploadViaServer).mockRejectedValue(networkError());
    launch();
    await flushPromises();
    const originalId = upload.rows.value[0]!.operationId;
    const saved = localStorage.getItem("file-service.uploads.v1")!;
    expect(saved).not.toContain('"source"');
    upload.reset();
    localStorage.setItem("file-service.uploads.v1", saved);
    vi.resetModules();
    const reloaded = (await import("./useUpload")).useUpload();
    const session = await import("@/api/session");
    reloaded.restore();
    expect(reloaded.rows.value[0]!.source).toBeNull();
    vi.mocked(resolveUploadOperation).mockResolvedValue({
      status: "succeeded",
      file: ready,
    });
    session.startSession({
      accessToken: "token",
      expiresIn: 3600,
      user: { login: "operator" },
    });
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();
    expect(reloaded.rows.value[0]!.operationId).toBe(originalId);
    expect(reloaded.rows.value[0]!.status.value).toBe("succeeded");
    expect(uploadViaServer).toHaveBeenCalledOnce();
    reloaded.reset();
    session.clearSession();
  });

  it("проверяет исходный файл перед повтором восстановленной ошибки", async () => {
    vi.mocked(uploadViaServer).mockRejectedValue(networkError());
    launch();
    await flushPromises();
    const saved = JSON.parse(localStorage.getItem("file-service.uploads.v1")!);
    saved[0].pending = false;
    saved[0].status = "failed";
    saved[0].intent = "fail";
    upload.reset();
    localStorage.setItem("file-service.uploads.v1", JSON.stringify(saved));
    vi.resetModules();
    const reloaded = (await import("./useUpload")).useUpload();
    const session = await import("@/api/session");
    reloaded.restore();
    session.startSession({
      accessToken: "token",
      expiresIn: 3600,
      user: { login: "operator" },
    });
    await vi.advanceTimersByTimeAsync(0);
    const row = reloaded.rows.value[0]!;
    await reloaded.retry(row, new File(["other"], "other.txt"));
    expect(row.source).toBeNull();
    expect(row.message.value).toContain("Выберите исходный файл");
    vi.mocked(uploadViaServer).mockResolvedValue(ready);
    await reloaded.retry(row, file());
    await flushPromises();
    expect(row.status.value).toBe("succeeded");
    reloaded.reset();
    session.clearSession();
  });

  it("после перезагрузки повторяет сохранённую отмену без новой передачи", async () => {
    vi.mocked(uploadViaServer).mockResolvedValue(ready);
    launch();
    await flushPromises();
    vi.mocked(cancelUploadOperation).mockRejectedValue(networkError());
    upload.remove(upload.rows.value[0]!);
    await flushPromises();
    const saved = JSON.parse(localStorage.getItem("file-service.uploads.v1")!);
    saved[0].pending = false;
    saved[0].status = "succeeded";
    upload.reset();
    localStorage.setItem("file-service.uploads.v1", JSON.stringify(saved));
    vi.resetModules();
    const reloaded = (await import("./useUpload")).useUpload();
    const session = await import("@/api/session");
    reloaded.restore();
    expect(reloaded.rows.value[0]!.intent.value).toBe("remove");
    vi.mocked(cancelUploadOperation).mockResolvedValue({ status: "cancelled" });
    session.startSession({
      accessToken: "token",
      expiresIn: 3600,
      user: { login: "operator" },
    });
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();
    expect(reloaded.rows.value).toHaveLength(0);
    expect(uploadViaServer).toHaveBeenCalledOnce();
    reloaded.reset();
    session.clearSession();
  });
});

it("сохраняет итерацию выбора открытой при неизвестном результате после тайм-аута", async () => {
  vi.mocked(uploadViaServer).mockRejectedValue(networkError());
  launch();
  await flushPromises();
  await vi.advanceTimersByTimeAsync(60_000);
  upload.addFiles([file()]);
  expect(upload.rows.value).toHaveLength(1);
  expect(upload.rows.value[0]!.pending.value).toBe(true);
});

it("после исчерпания попыток показывает ошибку, пока сервер повторяет очистку", async () => {
  vi.mocked(uploadViaServer).mockRejectedValue(networkError());
  vi.mocked(resolveUploadOperation).mockResolvedValue({ status: "failed" });
  vi.mocked(failUploadOperation).mockRejectedValue(networkError());
  launch();
  await flushPromises();
  await vi.advanceTimersByTimeAsync(4_000);
  const row = upload.rows.value[0]!;
  expect(row.status.value).toBe("failed");
  expect(row.pending.value).toBe(true);
  expect(uploadViaServer).toHaveBeenCalledTimes(3);
  vi.mocked(failUploadOperation).mockResolvedValue({ status: "discarded" });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(row.pending.value).toBe(false);
  expect(row.status.value).toBe("failed");
});

it("ожидает pending и 503 дольше минуты без передачи и сохраняет два повтора для установленной неудачи", async () => {
  vi.mocked(uploadViaServer).mockRejectedValue(networkError());
  vi.mocked(resolveUploadOperation).mockResolvedValue({ status: "pending" });
  launch();
  await flushPromises();
  await vi.advanceTimersByTimeAsync(65_000);
  const row = upload.rows.value[0]!;
  expect(row.status.value).toBe("failed");
  expect(row.pending.value).toBe(true);
  expect(uploadViaServer).toHaveBeenCalledOnce();
  vi.mocked(resolveUploadOperation).mockRejectedValue(
    new ApiError(503, "STORAGE_UNAVAILABLE", "Нет хранилища"),
  );
  await vi.advanceTimersByTimeAsync(15_000);
  expect(uploadViaServer).toHaveBeenCalledOnce();
  expect(failUploadOperation).not.toHaveBeenCalled();
  vi.mocked(resolveUploadOperation).mockResolvedValue({
    status: "failed",
    reason: "size_mismatch",
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(uploadViaServer).toHaveBeenCalledTimes(3);
  expect(
    new Set(vi.mocked(uploadViaServer).mock.calls.map((args) => args[3])).size,
  ).toBe(1);
});
