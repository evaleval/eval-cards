// @vitest-environment happy-dom
import { act, createElement, startTransition, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"

import type { MergedBenchmarkSummary, MergedObservationRow } from "@/lib/eval-processing"

let payload: MergedBenchmarkSummary

let fetchImpl: (
  benchmarkId: string,
  query?: { metricId?: string; sliceId?: string; signal?: AbortSignal },
) => Promise<MergedBenchmarkSummary> = () => Promise.resolve(payload)

// Optional reactive searchParams hook so tests can emulate Next.js 15's
// patched `history.replaceState` -> `startTransition` -> `useSearchParams()` flow.
let reactiveSearchParamsOverride: URLSearchParams | null = null
const searchParamListeners = new Set<(next: URLSearchParams) => void>()

function emitReactiveSearchParams(nextQuery: string) {
  const next = new URLSearchParams(nextQuery)
  reactiveSearchParamsOverride = next
  for (const listener of searchParamListeners) {
    startTransition(() => listener(next))
  }
}

vi.mock("next/navigation", async () => {
  const stub = await import("./next-navigation-stub")
  return {
    ...stub,
    useSearchParams: () => {
      const [reactiveParams, setReactiveParams] = useState<URLSearchParams | null>(
        () => reactiveSearchParamsOverride,
      )
      useEffect(() => {
        searchParamListeners.add(setReactiveParams)
        return () => {
          searchParamListeners.delete(setReactiveParams)
        }
      }, [])
      return reactiveParams ?? stub.useSearchParams()
    },
  }
})
vi.mock("@/lib/use-comparison-index", () => ({ useComparisonIndex: () => null }))
vi.mock("@/lib/dashboard-data-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard-data-client")>()),
  fetchMergedBenchmarkSummary: (
    benchmarkId: string,
    query?: { metricId?: string; sliceId?: string; signal?: AbortSignal },
  ) => fetchImpl(benchmarkId, query),
  fetchPeerRanks: () => Promise.resolve({}),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function row(
  source: string,
  model: string,
  score: number,
  overrides: Partial<MergedObservationRow> = {},
): MergedObservationRow {
  return {
    model_info: { name: model, id: `org/${model}` },
    model_key: `org/${model}`,
    model_route_id: `org%2F${model}`,
    evaluation_id: `${source}%2Fbench`,
    composite_slug: source,
    composite_display_name: source === "src-a" ? "Source A" : "Source B",
    score,
    score_canonical: score,
    scale_conversion: "no_bounds",
    evaluation_timestamp: "2026-01-01T00:00:00Z",
    source_metadata: {
      source_name: source,
      source_type: "leaderboard",
      source_organization_name: source,
      evaluator_relationship: "third_party",
    },
    ...overrides,
  }
}

function mergedPayload(results: MergedObservationRow[]): MergedBenchmarkSummary {
  const source = (slug: string, name: string) => ({
    evaluation_id: `${slug}%2Fbench`,
    composite_slug: slug,
    composite_display_name: name,
    models_count: 1,
    results_count: 1,
    reports_preferred: true,
    slice_only: false,
  })
  return {
    merged: true,
    evaluation_id: "bench",
    benchmark_id: "bench",
    display_name: "Bench",
    grain: "benchmark",
    preferred_metric_id: "score",
    preferred_metric_display_name: "Score",
    preferred_from_registry: false,
    lower_is_better: false,
    sources_count: 2,
    all_sources_count: 2,
    results_count: results.length,
    models_count: 2,
    best_result: null,
    aggregate_sources: [source("src-a", "Source A"), source("src-b", "Source B")],
    metrics: [
      {
        metric_id: "score",
        display_name: "Score",
        results_count: results.length,
        models_count: 2,
        sources_count: 2,
        lower_is_better: false,
      },
    ],
    slices: null,
    selected_metric_id: "score",
    selected_lower_is_better: false,
    selected_slice_id: null,
    results,
  }
}

interface Rendered {
  text: string
  /** True when the note sits before the first leaderboard row in document order. */
  noteBeforeRows: boolean
  /** Model name and hover text of every row carrying a rescale mark. */
  marks: { model: string; title: string | null }[]
}

async function render(results: MergedObservationRow[]): Promise<Rendered> {
  payload = mergedPayload(results)
  const { AudienceModeProvider } = await import("@/components/audience-mode-provider")
  const { MergedBenchmarkView } = await import("@/components/merged-benchmark-view")
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(
        AudienceModeProvider,
        null,
        createElement(MergedBenchmarkView, { benchmarkId: "bench" }),
      ),
    )
  })
  const text = document.body.textContent ?? ""
  const note = Array.from(container.querySelectorAll("p")).find((p) =>
    p.textContent?.includes("may not measure the same quantity"),
  )
  const firstRow = container.querySelector("tbody tr")
  const noteBeforeRows =
    note != null &&
    firstRow != null &&
    Boolean(note.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING)
  // Desktop table only: the narrow-screen list repeats every row.
  const marks = Array.from(container.querySelectorAll("table.ec-htable [data-rescaled-mark]")).map(
    (mark) => ({
      model: mark.closest("tr")?.querySelector("a")?.textContent ?? "",
      title: mark.getAttribute("title"),
    }),
  )
  await act(async () => root.unmount())
  container.remove()
  return { text, noteBeforeRows, marks }
}

const NOTE =
  "Scores from Source B are shown multiplied by 100 to match the range of the other sources, which may not measure the same quantity."

const RESCALED = [
  row("src-a", "a", 83.8),
  row("src-b", "b", 0.767, {
    score_canonical: 76.7,
    score_published: 0.767,
    scale_harmonized: "mul100",
  }),
]

describe("the merged page's rescaling note", () => {
  it("names the source whose scores were rescaled", async () => {
    const { text, noteBeforeRows, marks } = await render(RESCALED)
    expect(text).toContain("Bench")
    expect(text).toContain(`† ${NOTE}`)
    expect(noteBeforeRows).toBe(true)
    expect(marks).toHaveLength(1)
  })

  it("sits above the leaderboard rows", async () => {
    const { noteBeforeRows } = await render(RESCALED)
    expect(noteBeforeRows).toBe(true)
  })

  it("marks only the rescaled rows, with the published value", async () => {
    const { marks } = await render(RESCALED)
    expect(marks).toEqual([{ model: "b", title: "Rescaled x100: published as 0.767" }])
  })

  it("is absent when no row was rescaled", async () => {
    const { text, marks } = await render([row("src-a", "a", 83.8), row("src-b", "b", 76.7)])
    expect(text).toContain("Bench")
    expect(text).not.toContain("are shown multiplied")
    expect(text).not.toContain("may not measure the same quantity")
    expect(marks).toEqual([])
  })

  it("updates source disclosure notes when a non-preferred metric is selected", async () => {
    const base = mergedPayload([row("src-b", "b", 12.5)])
    payload = {
      ...base,
      preferred_metric_id: "score",
      selected_metric_id: "attack-success-rate",
      selected_lower_is_better: true,
      aggregate_sources: [
        { ...base.aggregate_sources[0], reports_preferred: true, slice_only: false },
        { ...base.aggregate_sources[1], reports_preferred: false, slice_only: false },
      ],
      metrics: [
        ...base.metrics,
        {
          metric_id: "attack-success-rate",
          display_name: "Attack Success Rate",
          results_count: 1,
          models_count: 1,
          sources_count: 1,
          lower_is_better: true,
        },
      ],
    }
    const { AudienceModeProvider } = await import("@/components/audience-mode-provider")
    const { MergedBenchmarkView } = await import("@/components/merged-benchmark-view")
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(
          AudienceModeProvider,
          null,
          createElement(MergedBenchmarkView, { benchmarkId: "bench" }),
        ),
      )
    })
    const text = container.textContent ?? ""
    await act(async () => root.unmount())
    container.remove()

    expect(text).toContain("Source A does not report this metric")
    expect(text).not.toContain("Source B reports only other metrics")
    expect(text).not.toContain("Source B does not report this metric")
  })

  it("keeps EvalDetail mounted in place without a loading flash and caches revisited metrics", async () => {
    const scoreBase = mergedPayload([row("src-a", "model-alpha", 88.2)])
    const twoMetrics = [
      ...scoreBase.metrics,
      {
        metric_id: "attack-success-rate",
        display_name: "Attack Success Rate",
        results_count: 1,
        models_count: 1,
        sources_count: 1,
        lower_is_better: true,
      },
    ]
    const primaryPayload: MergedBenchmarkSummary = {
      ...scoreBase,
      metrics: twoMetrics,
      selected_metric_id: "score",
    }
    const secondaryPayload: MergedBenchmarkSummary = {
      ...scoreBase,
      metrics: twoMetrics,
      selected_metric_id: "attack-success-rate",
      selected_lower_is_better: true,
      results: [row("src-b", "model-beta", 12.5)],
    }

    let resolveSecondary!: (value: MergedBenchmarkSummary) => void
    const calls: Array<{ benchmarkId: string; metricId?: string }> = []
    fetchImpl = (benchmarkId, query) => {
      calls.push({ benchmarkId, metricId: query?.metricId })
      if (query?.metricId === "attack-success-rate") {
        return new Promise<MergedBenchmarkSummary>((resolve) => {
          resolveSecondary = resolve
        })
      }
      return Promise.resolve(primaryPayload)
    }

    try {
      const { AudienceModeProvider } = await import("@/components/audience-mode-provider")
      const { MergedBenchmarkView } = await import("@/components/merged-benchmark-view")
      const container = document.createElement("div")
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(
          createElement(
            AudienceModeProvider,
            null,
            createElement(MergedBenchmarkView, { benchmarkId: "bench" }),
          ),
        )
      })

      expect(calls).toHaveLength(1)
      expect(container.textContent).toContain("model-alpha")
      const secondaryChip = container.querySelector<HTMLButtonElement>(
        '[data-metric-chip="attack-success-rate"]',
      )
      expect(secondaryChip).not.toBeNull()

      // Click the second metric while its fetch is still pending:
      // EvalDetail MUST stay mounted (no full-page "Loading merged benchmark…" flash).
      await act(async () => {
        secondaryChip!.click()
      })
      expect(container.textContent).not.toContain("Loading merged benchmark")
      expect(container.textContent).toContain("model-alpha")
      expect(
        container.querySelector('[data-metric-chip="attack-success-rate"]')?.getAttribute("aria-pressed"),
      ).toBe("true")
      expect(container.querySelector("[data-metric-filter-pending]")).not.toBeNull()
      expect(calls).toHaveLength(2)

      // Resolve the secondary metric fetch.
      await act(async () => {
        resolveSecondary(secondaryPayload)
      })
      expect(container.textContent).toContain("model-beta")
      expect(container.querySelector("[data-metric-filter-pending]")).toBeNull()

      // Clicking back to the primary metric serves synchronously from cache (no 3rd fetch).
      const primaryChip = container.querySelector<HTMLButtonElement>('[data-metric-chip="score"]')
      expect(primaryChip).not.toBeNull()
      await act(async () => {
        primaryChip!.click()
      })
      expect(calls).toHaveLength(2)
      expect(container.textContent).toContain("model-alpha")
      expect(container.querySelector("[data-metric-filter-pending]")).toBeNull()

      await act(async () => root.unmount())
      container.remove()
    } finally {
      fetchImpl = () => Promise.resolve(payload)
    }
  })

  it("reverts selection/URL on transient metric fetch failure with reactive Next.js searchParams sync and allows immediate 1-click retry", async () => {
    const scoreBase = mergedPayload([row("src-a", "model-alpha", 88.2)])
    const twoMetrics = [
      ...scoreBase.metrics,
      {
        metric_id: "attack-success-rate",
        display_name: "Attack Success Rate",
        results_count: 1,
        models_count: 1,
        sources_count: 1,
        lower_is_better: true,
      },
    ]
    const primaryPayload: MergedBenchmarkSummary = {
      ...scoreBase,
      metrics: twoMetrics,
      selected_metric_id: "score",
    }
    const secondaryPayload: MergedBenchmarkSummary = {
      ...scoreBase,
      metrics: twoMetrics,
      selected_metric_id: "attack-success-rate",
      selected_lower_is_better: true,
      results: [row("src-b", "model-beta", 12.5)],
    }

    let secondaryAttempts = 0
    let abortedWhileInFlight = 0
    fetchImpl = (_benchmarkId, query) => {
      if (query?.metricId === "attack-success-rate") {
        secondaryAttempts += 1
        let settled = false
        query.signal?.addEventListener("abort", () => {
          if (!settled) abortedWhileInFlight += 1
        })
        if (secondaryAttempts === 1) {
          return new Promise<MergedBenchmarkSummary>((_resolve, reject) => {
            queueMicrotask(() => {
              settled = true
              reject(new Error("transient network error"))
            })
          })
        }
        return new Promise<MergedBenchmarkSummary>((resolve) => {
          queueMicrotask(() => {
            settled = true
            resolve(secondaryPayload)
          })
        })
      }
      return Promise.resolve(primaryPayload)
    }

    // Patch history.replaceState to mirror Next.js 15's real App Router wrapper
    // (skipping sync if __NA is passed; syncing useSearchParams inside startTransition otherwise).
    const originalReplaceState = window.history.replaceState.bind(window.history)
    window.history.replaceState(null, "", "/evals/test")
    reactiveSearchParamsOverride = new URLSearchParams("")
    window.history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
      const ret = originalReplaceState(data, unused, url)
      const state = data as { __NA?: boolean; _N?: boolean } | null
      if (!(state?.__NA || state?._N) && url != null) {
        const parsed = new URL(String(url), window.location.href)
        emitReactiveSearchParams(parsed.search)
      }
      return ret
    }) as typeof window.history.replaceState

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    try {
      const { AudienceModeProvider } = await import("@/components/audience-mode-provider")
      const { MergedBenchmarkView } = await import("@/components/merged-benchmark-view")
      const container = document.createElement("div")
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(
          createElement(
            AudienceModeProvider,
            null,
            createElement(MergedBenchmarkView, { benchmarkId: "bench" }),
          ),
        )
      })

      // First click fails: exactly 1 fetch (never aborted by searchParams sync),
      // error persists after startTransition sync, URL & active chip revert cleanly.
      const secondaryChip = container.querySelector<HTMLButtonElement>(
        '[data-metric-chip="attack-success-rate"]',
      )!
      await act(async () => {
        secondaryChip.click()
      })
      expect(secondaryAttempts).toBe(1)
      expect(abortedWhileInFlight).toBe(0)
      expect(container.textContent).toContain("model-alpha")
      expect(container.textContent).toContain("Could not load that metric view.")
      expect(window.location.search).toBe("")
      expect(
        container.querySelector('[data-metric-chip="score"]')?.getAttribute("aria-pressed"),
      ).toBe("true")

      // Second click on the same failed chip retries immediately (1 fetch, 0 in-flight aborts) and succeeds.
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[data-metric-chip="attack-success-rate"]')!
          .click()
      })
      expect(secondaryAttempts).toBe(2)
      expect(abortedWhileInFlight).toBe(0)
      expect(container.textContent).toContain("model-beta")
      expect(container.textContent).not.toContain("Could not load that metric view.")
      expect(window.location.search).toBe("?metric=attack-success-rate")

      await act(async () => root.unmount())
      container.remove()
    } finally {
      window.history.replaceState = originalReplaceState
      reactiveSearchParamsOverride = null
      errSpy.mockRestore()
      fetchImpl = () => Promise.resolve(payload)
    }
  })
})
