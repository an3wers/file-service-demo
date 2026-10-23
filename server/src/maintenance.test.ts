import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startMaintenance } from "./maintenance.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function task(run: () => Promise<unknown>) {
  return { run: vi.fn(run), failureMessage: "Сбой задачи" };
}

it("задача запускается при старте и затем каждые 15 секунд", async () => {
  const quotas = task(async () => 0);
  const stop = startMaintenance([quotas], vi.fn());
  expect(quotas.run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(14999);
  expect(quotas.run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(quotas.run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(15000);
  expect(quotas.run).toHaveBeenCalledTimes(3);
  await stop();
});

it("новый проход не начинается до завершения предыдущего", async () => {
  let finish!: () => void;
  const quotas = task(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const stop = startMaintenance([quotas], vi.fn());
  await vi.advanceTimersByTimeAsync(45000);
  expect(quotas.run).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(15000);
  expect(quotas.run).toHaveBeenCalledTimes(2);
  finish();
  await stop();
});

it("зависшая или упавшая уборка загрузок не задерживает уборку квот, сбой журналируется и повторяется", async () => {
  const uploads = task(() => new Promise(() => {}));
  const quotas = task(async () => {
    throw new Error("delete failed");
  });
  const log = vi.fn();
  const stop = startMaintenance([uploads, quotas], log);
  await vi.advanceTimersByTimeAsync(30000);
  expect(uploads.run).toHaveBeenCalledTimes(1);
  expect(quotas.run).toHaveBeenCalledTimes(3);
  expect(log).toHaveBeenCalledTimes(3);
  expect(log).toHaveBeenCalledWith(expect.any(Error), "Сбой задачи");
  void stop();
});

it("упавшая уборка загрузок не мешает следующим проходам уборки квот", async () => {
  const uploads = task(async () => {
    throw new Error("s3 failed");
  });
  const quotas = task(async () => 0);
  const log = vi.fn();
  const stop = startMaintenance([uploads, quotas], log);
  await vi.advanceTimersByTimeAsync(15000);
  expect(quotas.run).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledTimes(2);
  await stop();
});

it("остановка прекращает запуски и ждёт текущие проходы", async () => {
  let finish!: () => void;
  const quotas = task(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const stop = startMaintenance([quotas], vi.fn());
  let stopped = false;
  const stopping = stop().then(() => {
    stopped = true;
  });
  await vi.advanceTimersByTimeAsync(30000);
  expect(stopped).toBe(false);
  expect(quotas.run).toHaveBeenCalledTimes(1);
  finish();
  await stopping;
  expect(stopped).toBe(true);
});
