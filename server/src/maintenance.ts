export interface MaintenanceTask {
  run: () => Promise<unknown>;
  failureMessage: string;
}

export function startMaintenance(
  tasks: readonly MaintenanceTask[],
  log: (error: unknown, message: string) => void,
): () => Promise<void> {
  const running = new Map<MaintenanceTask, Promise<void>>();
  function tick(): void {
    for (const task of tasks) {
      if (running.has(task)) continue;
      running.set(
        task,
        (async () => task.run())()
          .then(
            () => undefined,
            (error: unknown) => log(error, task.failureMessage),
          )
          .finally(() => running.delete(task)),
      );
    }
  }
  const timer = setInterval(tick, 15_000);
  timer.unref();
  tick();
  return async () => {
    clearInterval(timer);
    await Promise.all(running.values());
  };
}
