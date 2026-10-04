// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react"
import { createRoot } from "react-dom/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import type { ComparisonIndex, EvalHierarchy } from "@/lib/backend-artifacts"
import type { BenchmarkEvalSummary, ModelEvaluationSummary } from "@/lib/eval-processing"

import { fixtureIndex, fixtureRawHierarchy, useSnapshot } from "./comparison-fixture"

vi.mock("next/navigation", () => import("./next-navigation-stub"))
vi.mock("@/lib/dashboard-data-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard-data-client")>()),
  fetchPeerRanks: () => Promise.resolve({}),
}))

// While no comparison data is available (still loading, failed, or a snapshot
// without the tables) the surfaces get `comparisonIndex = null`. They must
// still render, with every control, and show only what needs no peer scores:
// no histograms or ranks, overlaps ungrouped, the signals strip from the
// summary alone. Each case also renders the whole index, so every null-state
// marker is one the loaded state does not show.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MODEL = "openai%2Fgpt-5.5"
const HISTOGRAM_EVAL = "llm-stats%2Fterminal-bench-2"
const ADD_MODEL = 'button[aria-label="Add a model to this histogram"]'
const NO_PLOTS = "No benchmarks match the current search or category filters."

let restore: () => void
let full: ComparisonIndex
let hierarchy: EvalHierarchy
let model: ModelEvaluationSummary
let evalSummary: BenchmarkEvalSummary

beforeAll(async () => {
  restore = useSnapshot()
  full = fixtureIndex()
  const { cleanHierarchy } = await import("@/lib/clean-hierarchy")
  const { decorateHierarchyDerivedTags } = await import("@/lib/benchmark-tags")
  hierarchy = decorateHierarchyDerivedTags(cleanHierarchy(fixtureRawHierarchy(), full))
  const backend = await import("@/lib/data-backend")
  model = (await backend.getModelSummaryById(MODEL)) as ModelEvaluationSummary
  evalSummary = (await backend.getEvalSummaryById("llm-stats%2Fwmdp"))!
})

afterAll(() => restore?.())

interface View {
  text: string
  addModelButtons: number
}

/** Mount `element`, click each labelled control in turn (each must exist),
 *  and return what is on the page after mounting and after every click. */
async function views(element: ReactElement, labels: string[] = []): Promise<View[]> {
  const { AudienceModeProvider } = await import("@/components/audience-mode-provider")
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  const seen: View[] = []
  const look = () =>
    seen.push({
      text: document.body.textContent ?? "",
      addModelButtons: document.querySelectorAll(ADD_MODEL).length,
    })
  try {
    await act(async () => {
      root.render(createElement(AudienceModeProvider, null, element))
    })
    look()
    for (const label of labels) {
      const button = document.querySelector<HTMLElement>(`button[aria-label="${label}"]`)
      expect(button, `control "${label}"`).not.toBeNull()
      await act(async () => button!.click())
      look()
    }
  } finally {
    await act(async () => root.unmount())
    container.remove()
    document.body.innerHTML = ""
  }
  return seen
}

describe("surfaces with no comparison data", () => {
  it("model page: every view renders, with no plots, ranks or grouped overlaps", async () => {
    const { BenchmarkDetail } = await import("@/components/benchmark-detail")
    const labels = ["Scores", "Plots by source", "Plots by category", "Table view", "Plots view"]
    const render = (index: ComparisonIndex | null) =>
      views(createElement(BenchmarkDetail, { summary: model, evalHierarchy: hierarchy, comparisonIndex: index }), labels)
    const [mount, scores, bySource, byCategory, tableView, plotsView] = await render(null)
    const loaded = await render(full)

    for (const view of [mount, scores]) {
      expect(view.text).toContain("Overlaps only (0)")
      expect(view.text).toContain("paperswithcode%2Fterminal-bench-2")
      expect(view.text).toContain("llm-stats%2Fterminal-bench-2")
    }
    expect(loaded[0].text).toContain("Overlaps only (1)")
    expect(loaded[0].text).not.toContain("paperswithcode%2Fterminal-bench-2")

    for (const view of [bySource, byCategory, plotsView]) {
      expect(view.text).toContain(NO_PLOTS)
      expect(view.addModelButtons).toBe(0)
      expect(view.text).not.toMatch(/Rank \d+ of \d+/)
      expect(view.text).not.toContain("View deep dive")
    }
    for (const view of [loaded[2], loaded[3]]) {
      expect(view.text).not.toContain(NO_PLOTS)
      expect(view.addModelButtons).toBeGreaterThan(0)
      expect(view.text).toMatch(/Rank \d+ of \d+/)
    }

    expect(tableView.text).not.toContain(NO_PLOTS)
    expect(tableView.text).toBe(loaded[4].text)
  })

  it("histogram embed: says there is no histogram for the pair", async () => {
    const { BenchmarkDetail } = await import("@/components/benchmark-detail")
    expect(full.by_model?.[MODEL]?.[HISTOGRAM_EVAL]).toBeDefined()
    const render = (index: ComparisonIndex | null) =>
      views(
        createElement(BenchmarkDetail, {
          summary: model,
          evalHierarchy: hierarchy,
          comparisonIndex: index,
          embedSurface: "histogram",
          embedTargetEvalId: HISTOGRAM_EVAL,
        }),
      )
    const [empty] = await render(null)
    expect(empty.text).toContain("No histogram available for this model/benchmark pair.")
    expect(empty.addModelButtons).toBe(0)
    const [loaded] = await render(full)
    expect(loaded.text).not.toContain("No histogram available")
    expect(loaded.text).toMatch(/Rank \d+ of \d+/)
  })

  it("reported-metrics embed: lists the model's own results, overlaps ungrouped", async () => {
    const { BenchmarkDetail } = await import("@/components/benchmark-detail")
    const render = (index: ComparisonIndex | null) =>
      views(
        createElement(BenchmarkDetail, {
          summary: model,
          evalHierarchy: hierarchy,
          comparisonIndex: index,
          embedSurface: "reported-metrics",
        }),
      )
    const [empty] = await render(null)
    expect(empty.text).toContain("4 shown")
    expect(empty.text).toContain("Overlaps only (0)")
    expect(empty.text).toContain("paperswithcode%2Fterminal-bench-2")
    expect(empty.text).toContain("llm-stats%2Fterminal-bench-2")
    expect(empty.addModelButtons).toBe(0)
    const [loaded] = await render(full)
    expect(loaded.text).toContain("Overlaps only (1)")
  })

  it("signals strip: all four tiles, cross-source signals from the summary alone", async () => {
    const { BenchmarkSignalsStrip } = await import("@/components/signals/benchmark-signals-strip")
    const render = async (index: ComparisonIndex | null) => {
      const [view] = await views(
        createElement(BenchmarkSignalsStrip, { summary: evalSummary, evalHierarchy: hierarchy, comparisonIndex: index }),
      )
      return view.text
    }
    const empty = await render(null)
    for (const tile of ["Reproducibility", "Completeness", "Provenance", "Comparability"]) expect(empty).toContain(tile)
    expect(empty).toContain("Single-source benchmark: 1 reporting org.")
    expect(empty).toContain("Only one source reports this benchmark.")
    const loaded = await render(full)
    expect(loaded).toContain("2 independent sources report this benchmark")
    expect(loaded).not.toContain("Only one source reports this benchmark.")
  })
})
