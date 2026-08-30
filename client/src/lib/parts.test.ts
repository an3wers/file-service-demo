import { describe, expect, it } from "vitest"
import { chunk, range, runPool } from "./parts"

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe("range", () => {
  it("включает обе границы", () => {
    expect(range(1, 3)).toEqual([1, 2, 3])
  })

  it("на одном элементе даёт список из него", () => {
    expect(range(7, 7)).toEqual([7])
  })

  it("на пустом диапазоне даёт пустой список", () => {
    expect(range(3, 2)).toEqual([])
  })
})

describe("chunk", () => {
  it("режет по размеру пачки, последняя короче", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it("не режет, когда пачка длиннее списка", () => {
    expect(chunk([1, 2], 100)).toEqual([[1, 2]])
  })

  it("на пустом списке не даёт ни одной пачки", () => {
    expect(chunk([], 10)).toEqual([])
  })
})

describe("runPool", () => {
  it("обрабатывает все элементы", async () => {
    const seen: number[] = []

    await runPool(range(1, 7), 3, async (item) => {
      await tick()
      seen.push(item)
    })

    expect([...seen].sort((a, b) => a - b)).toEqual(range(1, 7))
  })

  it("держит в полёте не больше `limit` задач", async () => {
    let inFlight = 0
    let peak = 0

    await runPool(range(1, 10), 3, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await tick()
      inFlight -= 1
    })

    expect(peak).toBe(3)
  })

  it("не поднимает параллельность выше числа элементов", async () => {
    let peak = 0
    let inFlight = 0

    await runPool([1, 2], 8, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await tick()
      inFlight -= 1
    })

    expect(peak).toBe(2)
  })

  it("пробрасывает ошибку и перестаёт брать новые элементы", async () => {
    const started: number[] = []
    const failure = new Error("часть не долетела")

    const run = runPool(range(1, 20), 2, async (item) => {
      started.push(item)
      await tick()

      if (item === 1) {
        throw failure
      }
    })

    await expect(run).rejects.toBe(failure)
    // Второй воркер успевает добрать лишь то, что взял до отказа первого.
    expect(started.length).toBeLessThan(20)
  })

  it("на пустом списке завершается, не вызывая worker", async () => {
    let calls = 0

    await runPool([], 4, async () => {
      calls += 1
    })

    expect(calls).toBe(0)
  })
})
