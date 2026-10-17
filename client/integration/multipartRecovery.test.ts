import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { Buffer } from "node:buffer";
import {
  buildHarness,
  THREE_PART_SIZE,
  toFileDto,
} from "../../server/src/modules/files/testing/index";
import { useUpload } from "../src/composables/useUpload";
import { clearSession, startSession } from "@/api/session";
import { ApiError } from "@/api/client";
import { putPart } from "@/api/files";

vi.mock("../../server/src/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../src/composables/useFileBrowser", () => ({
  useFileBrowser: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/api/files", async (original) => ({
  ...(await original<typeof import("@/api/files")>()),
  putPart: vi.fn(),
}));

const upload = useUpload();
beforeEach(() => {
  upload.reset();
  clearSession();
  vi.useFakeTimers();
  startSession({
    accessToken: "token",
    expiresIn: 3600,
    user: { login: "operator" },
  });
});
afterEach(() => {
  upload.reset();
  clearSession();
  vi.useRealTimers();
});

it.each(["передачи части", "подтверждения"])(
  "продолжает составную загрузку после исчерпания попыток %s по реальному результату модуля",
  async (failure) => {
    const h = buildHarness();
    const sent: number[] = [];
    let failures = 0;
    let confirms = 0;
    let stoppedReports = 0;
    vi.mocked(putPart).mockImplementation(async (url, blob) => {
      const query = new URL(url).searchParams;
      const number = Number(query.get("partNumber"));
      if (failure === "передачи части" && number === 2 && failures++ < 3)
        throw new ApiError(0, "NETWORK_ERROR", "Нет связи");
      h.objectStore.uploadPart(
        query.get("uploadId")!,
        number,
        Buffer.alloc(blob.size),
      );
      sent.push(number);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        let result: unknown;
        if (path.endsWith("/presign-upload"))
          result = await h.files.createPresignedUpload(body);
        else if (path.endsWith("/resolve")) {
          const id = path.split("/").at(-2)!;
          if (body.stoppedUploadId && stoppedReports++ === 0)
            return new Response(
              JSON.stringify({
                error: {
                  code: "STORAGE_UNAVAILABLE",
                  message: "Нет хранилища",
                },
              }),
              { status: 503 },
            );
          const status = await h.files.resolveUploadOperation(
            id,
            body.stoppedUploadId,
          );
          result =
            status.status === "succeeded"
              ? { ...status, file: toFileDto(status.file) }
              : status;
        } else if (path.endsWith("/part-urls"))
          result = await h.files.getPartUrls(path.split("/").at(-3)!, body);
        else if (path.endsWith("/multipart"))
          result = await h.files.getMultipartStatus(path.split("/").at(-2)!);
        else if (path.endsWith("/complete")) {
          if (failure === "подтверждения" && confirms++ < 2)
            return new Response(
              JSON.stringify({
                error: { code: "STORAGE_UNAVAILABLE", message: "Нет связи" },
              }),
              { status: 503 },
            );
          result = toFileDto(
            await h.files.completeUpload(path.split("/").at(-2)!),
          );
        } else if (path.endsWith("/fail"))
          result = await h.files.failUploadOperation(path.split("/").at(-2)!);
        else throw new Error(`Неожиданный запрос ${path}`);
        return new Response(JSON.stringify(result), { status: 200 });
      }),
    );
    upload.setMode("presigned");
    upload.addFiles([new File([new Uint8Array(THREE_PART_SIZE)], "big.bin")]);
    upload.submit("");
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    const row = upload.rows.value[0]!;
    expect(row.status.value).toBe("succeeded");
    expect(row.attempts).toBe(1);
    expect(stoppedReports).toBe(2);
    expect(sent.filter((number) => number === 1)).toHaveLength(1);
    expect(sent.filter((number) => number === 2)).toHaveLength(1);
    expect(sent.filter((number) => number === 3)).toHaveLength(1);
    expect(await h.rowCount()).toBe(1);
  },
);
