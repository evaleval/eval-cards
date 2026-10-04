// @vitest-environment happy-dom
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ComparisonIndex } from "@/lib/backend-artifacts"
import type { ComparisonIndexRequest } from "@/lib/use-comparison-index"

// The hook must never hand a consumer a slice fetched for another request,
// however the responses race.

interface Deferred {
  key: string
  resolve: (index: ComparisonIndex) => void
  reject: (err: Error) => void
}

const pending = vi.hoisted(() => [] as Deferred[])
const defer = (key: string) =>
  new Promise<ComparisonIndex>((resolve, reject) => {
    pending.push({ key, resolve, reject })
  })
vi.mock("@/lib/dashboard-data-client", () => ({
  fetchComparisonIndexForModel: vi.fn((routeId: string) => defer(`model:${routeId}`)),
  fetchComparisonIndexForEvals: vi.fn((ids: string[]) => defer(`evals:${ids.join(",")}`)),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const sliceA = { evals: {}, slice: "A" } as unknown as ComparisonIndex
const sliceB = { evals: {}, slice: "B" } as unknown as ComparisonIndex

let renders: Array<{ label: string; value: ComparisonIndex | null }>
let root: Root
let container: HTMLElement

let useComparisonIndex: typeof import("@/lib/use-comparison-index").useComparisonIndex

function Probe({ label, request }: { label: string; request: ComparisonIndexRequest | null }) {
  renders.push({ label, value: useComparisonIndex(request) })
  return null
}

async function show(label: string, request: ComparisonIndexRequest | null) {
  await act(async () => root.render(createElement(Probe, { label, request })))
}

const settle = async (key: string, outcome: ComparisonIndex | Error) => {
  const entry = pending.find((p) => p.key === key)!
  pending.splice(pending.indexOf(entry), 1)
  await act(async () => {
    if (outcome instanceof Error) entry.reject(outcome)
    else entry.resolve(outcome)
  })
}

const valuesFor = (label: string) => renders.filter((r) => r.label === label).map((r) => r.value)

beforeEach(async () => {
  useComparisonIndex = (await import("@/lib/use-comparison-index")).useComparisonIndex
  renders = []
  pending.length = 0
  const client = await import("@/lib/dashboard-data-client")
  vi.mocked(client.fetchComparisonIndexForModel).mockClear()
  vi.mocked(client.fetchComparisonIndexForEvals).mockClear()
  vi.spyOn(console, "warn").mockImplementation(() => {})
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe("useComparisonIndex", () => {
  it("never shows a slice under another request, whatever order responses land in", async () => {
    await show("A", { model: "a" })
    await show("B", { model: "b" })
    expect(valuesFor("B")[0]).toBeNull()
    await settle("model:b", sliceB)
    await show("B", { model: "b" })
    await settle("model:a", sliceA)
    await show("B", { model: "b" })
    expect(valuesFor("B")).not.toContain(sliceA)
    expect(valuesFor("B").at(-1)).toBe(sliceB)
    expect(valuesFor("A").every((v) => v === null)).toBe(true)
  })

  it("returns null as soon as the request changes", async () => {
    await show("A", { model: "a" })
    await settle("model:a", sliceA)
    expect(valuesFor("A").at(-1)).toBe(sliceA)
    await show("B", { evals: ["x", "y"] })
    expect(valuesFor("B")[0]).toBeNull()
  })

  it("stays null when the request fails", async () => {
    await show("A", { model: "a" })
    await settle("model:a", new Error("503"))
    await show("A", { model: "a" })
    expect(valuesFor("A").every((v) => v === null)).toBe(true)
  })

  it("fetches nothing without a request", async () => {
    const client = await import("@/lib/dashboard-data-client")
    await show("none", null)
    await show("none", { evals: [] })
    await show("none", { model: "" })
    expect(valuesFor("none").every((v) => v === null)).toBe(true)
    expect(client.fetchComparisonIndexForModel).not.toHaveBeenCalled()
    expect(client.fetchComparisonIndexForEvals).not.toHaveBeenCalled()
  })

  it("does not refetch for an equal request in a new object", async () => {
    const client = await import("@/lib/dashboard-data-client")
    await show("E", { evals: ["b", "a"] })
    await show("E", { evals: ["a", "b", "a"] })
    expect(client.fetchComparisonIndexForEvals).toHaveBeenCalledTimes(1)
    expect(vi.mocked(client.fetchComparisonIndexForEvals).mock.calls[0][0]).toEqual(["a", "b"])
  })

  it("refetches when it returns to an earlier request and waits for that response", async () => {
    const client = await import("@/lib/dashboard-data-client")
    await show("A", { model: "a" })
    await settle("model:a", sliceA)
    await show("B", { model: "b" })
    await settle("model:b", sliceB)
    await show("A again", { model: "a" })
    expect(client.fetchComparisonIndexForModel).toHaveBeenCalledTimes(3)
    expect(valuesFor("A again")[0]).toBeNull()
    await settle("model:a", sliceA)
    expect(valuesFor("A again").at(-1)).toBe(sliceA)
    expect(valuesFor("A again")).not.toContain(sliceB)
  })
})
