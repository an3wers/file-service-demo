/**
 * Чистые помощники для загрузки файла частями. Арифметики разбиения здесь нет и
 * быть не должно: `offset`/`size`/`partCount` присылает сервер. Клиенту остаётся
 * очередь номеров и пул, который держит в полёте ровно столько частей, сколько
 * разрешил тот же ответ (`maxConcurrency`).
 */

/** Номера от `from` до `to` включительно: `range(1, 3)` → `[1, 2, 3]`. */
export function range(from: number, to: number): number[] {
  const values: number[] = []

  for (let value = from; value <= to; value += 1) {
    values.push(value)
  }

  return values
}

/** Нарезает список на куски не длиннее `size`, сохраняя порядок. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size))
  const chunks: T[][] = []

  for (let start = 0; start < items.length; start += step) {
    chunks.push(items.slice(start, start + step))
  }

  return chunks
}

/**
 * Выполняет `worker` над каждым элементом, держа в полёте не больше `limit`
 * задач одновременно.
 *
 * Первая ошибка останавливает разбор очереди, но уже запущенные задачи
 * дожидаются: `Promise.all` бросил бы сразу, оставив остальные отказы
 * необработанными (`unhandledrejection` на каждый). При отмене это ничего не
 * удлиняет — летящие запросы обрывает общий `AbortSignal`.
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items]
  let stopped = false

  const drain = async (): Promise<void> => {
    while (!stopped && queue.length > 0) {
      // Очередь одна на всех воркеров, и `shift` в JS атомарен относительно них:
      // между проверкой длины и сдвигом чужой код выполниться не может.
      const item = queue.shift() as T

      try {
        await worker(item)
      } catch (error) {
        stopped = true

        throw error
      }
    }
  }

  const width = Math.min(Math.max(1, Math.floor(limit)), items.length)
  const results = await Promise.allSettled(
    Array.from({ length: width }, () => drain()),
  )
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  )

  if (failed) {
    throw failed.reason
  }
}
