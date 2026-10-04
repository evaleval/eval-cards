import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { useSnapshot } from "./comparison-fixture"

// Comparison and view queries share one DuckDB connection, so every reader
// must wait its turn on the one queue. This drives them concurrently through
// a connection that counts overlapping readers.

const ROUTE_ID = "openai%2Fgpt-5.5"
const EVAL_IDS = ["llm-stats%2Fwmdp", "benchpress%2Fwmdp", "wmdp"]

const tracking = vi.hoisted(() => ({ inFlight: 0, maxInFlight: 0, failSql: null as string | null }))

let restore: () => void

beforeAll(async () => {
  restore = useSnapshot()
  vi.resetModules()
  const duckdb = await import("@/lib/duckdb")
  const realGetConnection = duckdb.getConnection
  vi.doMock("@/lib/duckdb", async () => ({
    ...duckdb,
    getConnection: async () => {
      const connection = await realGetConnection()
      return new Proxy(connection, {
        get(target, prop, receiver) {
          if (prop === "runAndRead" || prop === "runAndReadAll") {
            return async (sql: string, ...rest: unknown[]) => {
              tracking.inFlight += 1
              tracking.maxInFlight = Math.max(tracking.maxInFlight, tracking.inFlight)
              try {
                await new Promise((resolve) => setTimeout(resolve, 2))
                if (tracking.failSql && String(sql).includes(tracking.failSql)) {
                  tracking.failSql = null
                  throw new Error("injected query failure")
                }
                return await (target as never as Record<string, (...a: unknown[]) => unknown>)[prop as string](
                  sql,
                  ...rest,
                )
              } finally {
                tracking.inFlight -= 1
              }
            }
          }
          const value = Reflect.get(target, prop, receiver)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
    },
  }))
})

afterAll(() => {
  vi.doUnmock("@/lib/duckdb")
  vi.resetModules()
  restore?.()
})

async function runAll() {
  const table = await import("@/lib/comparison-table")
  const backend = await import("@/lib/data-backend")
  return Promise.all([
    table.cleanerInput(),
    table.sliceForModel(ROUTE_ID),
    table.sliceForEvals(EVAL_IDS),
    backend.getModelCardsLite(),
    backend.getEvalListLiteData(),
  ])
}

describe("shared connection queue", () => {
  it("runs comparison and view queries one at a time with stable results", async () => {
    const table = await import("@/lib/comparison-table")
    const backend = await import("@/lib/data-backend")
    const baseline = [
      await table.cleanerInput(),
      await table.sliceForModel(ROUTE_ID),
      await table.sliceForEvals(EVAL_IDS),
      await backend.getModelCardsLite(),
      await backend.getEvalListLiteData(),
    ]
    expect(baseline[1]).not.toBeNull()

    tracking.maxInFlight = 0
    const rounds = await Promise.all([runAll(), runAll(), runAll()])
    for (const round of rounds) expect(round).toStrictEqual(baseline)
    expect(tracking.maxInFlight).toBe(1)
  })

  it("keeps serving after a failed query", async () => {
    const table = await import("@/lib/comparison-table")
    const duckdb = await import("@/lib/duckdb")
    const expected = await table.sliceForEvals(EVAL_IDS)

    tracking.failSql = "FROM comparison_scores"
    const failing = table.sliceForModel(ROUTE_ID)
    const rejected = duckdb.serialized(() => Promise.reject(new Error("rejected task")))
    const next = table.sliceForEvals(EVAL_IDS)

    await expect(failing).rejects.toThrow("injected query failure")
    await expect(rejected).rejects.toThrow("rejected task")
    expect(await next).toStrictEqual(expected)
  })
})
