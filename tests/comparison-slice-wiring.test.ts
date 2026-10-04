// @vitest-environment happy-dom
import { act, createElement, type ComponentType } from "react"
import { createRoot } from "react-dom/client"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { ComparisonIndex, EvalHierarchy } from "@/lib/backend-artifacts"
import type { BenchmarkEvalSummary, MergedBenchmarkSummary, ModelEvaluationSummary } from "@/lib/eval-processing"

import { fixtureIndex, fixtureRawHierarchy, useSnapshot } from "./comparison-fixture"

// Which comparison slice each surface requests: model pages and both embeds
// ask for the model under the route id BenchmarkDetail reads it by; per-source
// and merged eval pages ask for exactly the siblings the signals strip reads;
// composite eval pages ask for nothing. Each page must then hand that slice on.

const nav = vi.hoisted(() => {
  const router = { replace: () => {}, push: () => {}, back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => {} }
  return { params: {} as Record<string, string | string[]>, search: new URLSearchParams(), router }
})
vi.mock("next/navigation", () => ({
  useParams: () => nav.params,
  useSearchParams: () => nav.search,
  usePathname: () => "/test",
  useRouter: () => nav.router,
}))

const client = vi.hoisted(() => ({
  modelSummaries: {} as Record<string, unknown>,
  evalSummaries: {} as Record<string, unknown>,
  mergedSummary: null as unknown,
  hierarchy: null as unknown,
  modelSlice: { evals: {}, slice: "model" },
  evalsSlice: { evals: {}, slice: "evals" },
}))
const fetchModelSummary = vi.hoisted(() => vi.fn(async (id: string) => {
  if (!(id in client.modelSummaries)) throw new Error(`404 ${id}`)
  return client.modelSummaries[id]
}))
const fetchComparisonIndexForModel = vi.hoisted(() => vi.fn())
const fetchComparisonIndexForEvals = vi.hoisted(() => vi.fn())
vi.mock("@/lib/dashboard-data-client", () => ({
  fetchModelSummary,
  fetchEvalSummary: async (id: string) => client.evalSummaries[id] ?? client.evalSummaries["*"],
  fetchMergedBenchmarkSummary: async () => client.mergedSummary,
  fetchEvalHierarchy: async () => client.hierarchy,
  fetchBenchmarkMetadata: async () => ({}),
  fetchModelCards: async () => [],
  fetchPeerRanks: async () => ({}),
  fetchComparisonIndexForModel,
  fetchComparisonIndexForEvals,
}))

const received = vi.hoisted(() => ({ benchmarkDetail: [] as any[], evalDetail: [] as any[] }))
vi.mock("@/components/benchmark-detail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/benchmark-detail")>()),
  BenchmarkDetail: (props: any) => {
    received.benchmarkDetail.push(props)
    return null
  },
}))
vi.mock("@/components/eval-detail", () => ({
  EvalDetail: (props: any) => {
    received.evalDetail.push(props)
    return null
  },
}))
vi.mock("@/components/navigation", () => ({ Navigation: () => null }))
vi.mock("@/components/reader-mode-bar", () => ({ ReaderModeBar: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let restore: () => void
let full: ComparisonIndex
let hierarchy: EvalHierarchy
let gpt: ModelEvaluationSummary
let wmdpSource: BenchmarkEvalSummary
let wmdpMerged: MergedBenchmarkSummary

beforeAll(async () => {
  restore = useSnapshot()
  full = fixtureIndex()
  const { cleanHierarchy } = await import("@/lib/clean-hierarchy")
  const { decorateHierarchyDerivedTags } = await import("@/lib/benchmark-tags")
  hierarchy = decorateHierarchyDerivedTags(cleanHierarchy(fixtureRawHierarchy(), full))
  const backend = await import("@/lib/data-backend")
  gpt = (await backend.getModelSummaryById("openai%2Fgpt-5.5")) as ModelEvaluationSummary
  wmdpSource = (await backend.getEvalSummaryById("llm-stats%2Fwmdp"))!
  wmdpMerged = (await backend.getMergedBenchmarkSummary("wmdp")) as MergedBenchmarkSummary
})

afterAll(() => restore?.())

beforeEach(() => {
  fetchComparisonIndexForModel.mockReset().mockResolvedValue(client.modelSlice)
  fetchComparisonIndexForEvals.mockReset().mockResolvedValue(client.evalsSlice)
  received.benchmarkDetail = []
  received.evalDetail = []
  nav.search = new URLSearchParams()
  client.hierarchy = hierarchy
  client.modelSummaries = { "openai%2Fgpt-5.5": gpt }
  fetchModelSummary.mockClear()
  client.evalSummaries = {}
})

async function mount(page: ComponentType) {
  const { AudienceModeProvider } = await import("@/components/audience-mode-provider")
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(AudienceModeProvider, null, createElement(page)))
  })
  for (let i = 0; i < 5; i++) await act(async () => {})
  const html = container.innerHTML
  await act(async () => root.unmount())
  container.remove()
  return html
}

const last = <T,>(list: T[]) => list[list.length - 1]

describe("model surfaces request the model slice", () => {
  it("model page, under the summary's route id", async () => {
    nav.params = { id: ["openai", "gpt-5.5"] }
    await mount((await import("@/app/models/[...id]/page")).default)
    expect(fetchComparisonIndexForModel.mock.calls).toEqual([["openai%2Fgpt-5.5"]])
    expect(fetchComparisonIndexForEvals).not.toHaveBeenCalled()
    expect(last(received.benchmarkDetail).comparisonIndex).toBe(client.modelSlice)
  })

  it("model page reached through another spelling of the model", async () => {
    // The summary endpoint folds the alias; only the summary knows the
    // canonical route id the slice is keyed by.
    client.modelSummaries = { "openai%2FGPT-5.5-2026-04-23": gpt }
    nav.params = { id: ["openai", "GPT-5.5-2026-04-23"] }
    await mount((await import("@/app/models/[...id]/page")).default)
    expect(fetchModelSummary.mock.calls).toEqual([["openai%2FGPT-5.5-2026-04-23"]])
    expect(fetchComparisonIndexForModel.mock.calls).toEqual([[gpt.model_route_id]])
    expect(gpt.model_route_id).toBe("openai%2Fgpt-5.5")
    expect(fetchModelSummary.mock.calls[0][0]).not.toBe(fetchComparisonIndexForModel.mock.calls[0][0])
    expect(last(received.benchmarkDetail).comparisonIndex).toBe(client.modelSlice)
  })

  it("histogram embed", async () => {
    nav.params = { id: ["llm-stats", "wmdp"] }
    nav.search = new URLSearchParams("model=openai/gpt-5.5")
    await mount((await import("@/app/embed/eval/histogram/[...id]/page")).default)
    expect(fetchComparisonIndexForModel.mock.calls).toEqual([["openai%2Fgpt-5.5"]])
    expect(last(received.benchmarkDetail).comparisonIndex).toBe(client.modelSlice)
  })

  it("reported-metrics embed", async () => {
    nav.params = { id: ["openai", "gpt-5.5"] }
    await mount((await import("@/app/embed/model/reported-metrics/[...id]/page")).default)
    expect(fetchComparisonIndexForModel.mock.calls).toEqual([["openai%2Fgpt-5.5"]])
    expect(last(received.benchmarkDetail).comparisonIndex).toBe(client.modelSlice)
  })

  it("nothing is passed on while the request fails", async () => {
    fetchComparisonIndexForModel.mockReset().mockRejectedValue(new Error("503"))
    nav.params = { id: ["openai", "gpt-5.5"] }
    await mount((await import("@/app/models/[...id]/page")).default)
    expect(received.benchmarkDetail.length).toBeGreaterThan(0)
    expect(received.benchmarkDetail.every((props) => props.comparisonIndex == null)).toBe(true)
  })
})

describe("eval pages request the signals strip's siblings", () => {
  it("per-source eval page", async () => {
    const { crossSuiteSiblingEvalIds } = await import("@/components/signals/benchmark-signals-strip")
    client.evalSummaries = { "*": wmdpSource }
    nav.params = { id: ["llm-stats", "wmdp"] }
    await mount((await import("@/app/evals/[...id]/page")).default)
    const siblings = crossSuiteSiblingEvalIds(wmdpSource, hierarchy)
    expect(siblings.length).toBeGreaterThan(1)
    expect(fetchComparisonIndexForEvals).toHaveBeenCalledTimes(1)
    expect([...fetchComparisonIndexForEvals.mock.calls[0][0]].sort()).toEqual([...siblings].sort())
    expect(fetchComparisonIndexForModel).not.toHaveBeenCalled()
    const props = last(received.evalDetail)
    expect(props.summary).toBe(wmdpSource)
    expect(props.evalHierarchy).toBe(hierarchy)
    expect(props.comparisonIndex).toBe(client.evalsSlice)
  })

  it("merged eval page", async () => {
    const { crossSuiteSiblingEvalIds } = await import("@/components/signals/benchmark-signals-strip")
    const { mergedSummaryToEvalSummary } = await import("@/lib/merged-adapter")
    client.mergedSummary = wmdpMerged
    nav.params = { id: ["wmdp"] }
    await mount((await import("@/app/evals/[...id]/page")).default)
    const siblings = crossSuiteSiblingEvalIds(mergedSummaryToEvalSummary(wmdpMerged), hierarchy)
    expect(siblings.length).toBeGreaterThan(1)
    expect(fetchComparisonIndexForEvals).toHaveBeenCalledTimes(1)
    expect([...fetchComparisonIndexForEvals.mock.calls[0][0]].sort()).toEqual([...siblings].sort())
    expect(fetchComparisonIndexForModel).not.toHaveBeenCalled()
    const props = last(received.evalDetail)
    expect(props.evalHierarchy).toBe(hierarchy)
    expect(props.comparisonIndex).toBe(client.evalsSlice)
  })

  it("per-source eval page while the request fails", async () => {
    fetchComparisonIndexForEvals.mockReset().mockRejectedValue(new Error("503"))
    client.evalSummaries = { "*": wmdpSource }
    nav.params = { id: ["llm-stats", "wmdp"] }
    const html = await mount((await import("@/app/evals/[...id]/page")).default)
    expect(fetchComparisonIndexForEvals).toHaveBeenCalledTimes(1)
    expect(html).not.toContain("not found")
    expect(received.evalDetail.length).toBeGreaterThan(0)
    expect(last(received.evalDetail).summary).toBe(wmdpSource)
    expect(received.evalDetail.every((props) => props.comparisonIndex == null)).toBe(true)
  })

  it("merged eval page while the request fails", async () => {
    fetchComparisonIndexForEvals.mockReset().mockRejectedValue(new Error("503"))
    client.mergedSummary = wmdpMerged
    nav.params = { id: ["wmdp"] }
    const html = await mount((await import("@/app/evals/[...id]/page")).default)
    expect(fetchComparisonIndexForEvals).toHaveBeenCalledTimes(1)
    expect(html).not.toContain("not found")
    expect(received.evalDetail.length).toBeGreaterThan(0)
    expect(received.evalDetail.every((props) => props.comparisonIndex == null)).toBe(true)
  })

  it("composite eval page requests nothing", async () => {
    const composite = {
      ...wmdpSource,
      is_aggregated: true,
      aggregate_sources: [
        { evaluation_id: "llm-stats%2Fwmdp" },
        { evaluation_id: "benchpress%2Fwmdp" },
      ],
    } as unknown as BenchmarkEvalSummary
    client.evalSummaries = { "*": wmdpSource, "llm-stats%2Fwmdp%2Fall": composite }
    nav.params = { id: ["llm-stats", "wmdp", "all"] }
    const html = await mount((await import("@/app/evals/[...id]/page")).default)
    expect(html).toContain(composite.evaluation_name)
    expect(html).not.toContain("not found")
    expect(fetchComparisonIndexForEvals).not.toHaveBeenCalled()
    expect(fetchComparisonIndexForModel).not.toHaveBeenCalled()
    expect(received.evalDetail).toEqual([])
  })
})
