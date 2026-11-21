// @vitest-environment happy-dom

import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import type { BenchmarkEvaluationCardData } from "@/components/benchmark-evaluation-card"
import { EvalDetail } from "@/components/eval-detail"
import { ModelCompareDialog } from "@/components/model-compare-dialog"
import { buildCrossSuiteAggregate, deriveComparability } from "@/components/signals/benchmark-signals-strip"
import type {
  ComparisonIndex,
  ComparisonMetricEntry,
  EvalHierarchy,
} from "@/lib/backend-artifacts"
import { buildDistributionSeries, buildDistributionSliceAxis } from "@/lib/distribution-series"
import { formatReading } from "@/lib/headline-readings"
import type { BenchmarkEvalSummary, BenchmarkLeaderboardRow } from "@/lib/eval-processing"

vi.mock("next/navigation", () => import("./next-navigation-stub"))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Each surface here is fed a page whose metrics differ in direction, unit
// or identity, and must keep every metric on its own terms.

const lm = (column_key: string, lower_is_better: boolean | null, unit: string | null) =>
  ({
    column_key,
    metric_id: column_key,
    metric_summary_id: column_key,
    metric_name: column_key,
    display_name: column_key,
    lower_is_better,
    unit,
    scope: "root",
  }) as unknown as NonNullable<BenchmarkEvalSummary["leaderboard_metrics"]>[number]

const lbRow = (name: string, values: Record<string, number>) =>
  ({
    model_info: { name, id: name, release_date: "2025-01-01" },
    model_route_id: name,
    evaluation_timestamp: "2026-01-01T00:00:00Z",
    source_metadata: { source_name: "S", source_type: "leaderboard" },
    source_data: { dataset_name: "D" },
    values,
    metrics_present: Object.keys(values).length,
  }) as unknown as BenchmarkLeaderboardRow

function page(overrides: Partial<BenchmarkEvalSummary> = {}): BenchmarkEvalSummary {
  return {
    evaluation_id: "src%2Fbench",
    evaluation_name: "Bench",
    composite_benchmark_name: "Src",
    // The primary is NOT the first column, and the two run opposite ways.
    primary_metric_id: "refusal-score",
    metric_config: {
      evaluation_description: "Refusal score",
      lower_is_better: false,
      unit: "percent",
      min_score: null,
      max_score: null,
    },
    leaderboard_metrics: [lm("attack-success-rate", true, "proportion"), lm("refusal-score", false, "percent"), lm("tokens", null, null)],
    leaderboard_rows: ["A", "B", "C", "D"].map((n, i) =>
      lbRow(n, { "attack-success-rate": 0.1 * (i + 1), "refusal-score": 90 - 10 * i, tokens: 100 + i }),
    ),
    model_results: [],
    models_count: 4,
    evaluator_names: [],
    source_types: [],
    third_party_ratio: 1,
    missing_generation_config_count: 0,
    avg_score: 0,
    avg_score_norm: 0,
    ...overrides,
  } as unknown as BenchmarkEvalSummary
}

describe("distribution series keep each metric's own direction and unit", () => {
  it("never fills a null unit or direction from the primary metric", () => {
    const series = buildDistributionSeries(page(), null, "__all__", "__all__")!
    const byKey = Object.fromEntries(series.map((s) => [s.key, s]))
    expect(byKey["attack-success-rate"]).toMatchObject({ lowerIsBetter: true, unit: "proportion" })
    expect(byKey["refusal-score"]).toMatchObject({ lowerIsBetter: false, unit: "percent" })
    expect(byKey.tokens.lowerIsBetter).toBeNull()
    expect(byKey.tokens.unit).toBeUndefined()
  })

  it("puts the primary metric first, so the embed opens on it", () => {
    const series = buildDistributionSeries(page(), null, "__all__", "__all__")!
    expect(series[0].key).toBe("refusal-score")
  })

  it("builds the slice axis on primary_metric_id, not the first column", () => {
    const slice = (key: string) =>
      ({ ...lm(`refusal-score::${key}`, false, "percent"), metric_id: "refusal-score", scope: "subtask", subtask_key: key, subtask_name: key }) as never
    const summary = page({
      leaderboard_metrics: [...page().leaderboard_metrics!, slice("x"), slice("y")],
    })
    expect(buildDistributionSliceAxis(summary)).toMatchObject({
      primaryColumn: "refusal-score",
      lowerIsBetter: false,
      unit: "percent",
    })
  })
})

describe("eval page labels", () => {
  const render = (summary: BenchmarkEvalSummary) =>
    renderToStaticMarkup(createElement(AudienceModeProvider, null, createElement(EvalDetail, { summary })))

  it("names the primary metric on the page-level direction and scale, and invents no bounds", () => {
    const html = render(page())
    // The hero states the primary metric's direction as that metric's.
    expect(html).toContain("<span>Refusal-score: Higher is better ↑</span>")
    expect(html).not.toContain("<span>Higher is better ↑</span>")
    // metric_config reports no bounds: shown as unknown, not as 0 – 1.
    expect(html).toContain("<dt>Score scale</dt><dd>Refusal-score: not reported</dd>")
    expect(html).not.toContain("0 – 1")
  })

  it("shows a metric with no reported direction as such in its distribution", () => {
    const html = render(page({ primary_metric_id: "tokens" }))
    expect(html).toContain("direction not reported")
  })
})

// ---------------------------------------------------------------------------
// Comparability across sources
// ---------------------------------------------------------------------------

function metricEntry(
  metric_id: string,
  unit: string,
  scores: Array<[string, number]>,
  lower_is_better = false,
  split: string | null = null,
): ComparisonMetricEntry {
  return {
    metric_summary_id: metric_id,
    metric_name: metric_id,
    metric_id,
    metric_key: metric_id,
    group: "capability",
    group_order: 0,
    lower_is_better,
    unit,
    scores: scores.map(([model, score]) => ({
      model_route_id: model,
      model_family_name: model,
      score,
      split,
    })),
  } as unknown as ComparisonMetricEntry
}

const hierarchy: EvalHierarchy = {
  families: [
    { key: "a", display_name: "Source A" },
    { key: "b", display_name: "Source B" },
    { key: "c", display_name: "Source C" },
  ] as never,
  benchmark_index: [
    {
      key: "bench",
      display_name: "Bench",
      appearances: ["a", "b", "c"].map((f) => ({
        family_key: f,
        benchmark_key: "bench",
        constituent_evaluation_ids: [`${f}%2Fbench`],
      })) as never,
    },
  ],
}

function index(evals: Record<string, ComparisonMetricEntry[]>): ComparisonIndex {
  return {
    generated_at: "",
    config_version: 1,
    metric_group_order: [],
    evals: Object.fromEntries(
      Object.entries(evals).map(([id, metrics]) => [id, { evaluation_id: id, metrics } as never]),
    ),
  }
}

const accuracyPage = page({
  evaluation_id: "a%2Fbench",
  benchmark_id: "bench",
  primary_metric_id: "accuracy",
  metric_config: { evaluation_description: "Accuracy", lower_is_better: false, unit: "proportion" },
} as Partial<BenchmarkEvalSummary>)

describe("cross-source comparability compares one measurement only", () => {
  it("never compares a sibling that reports a different metric, nor counts it divergent", () => {
    const cross = buildCrossSuiteAggregate(
      accuracyPage,
      hierarchy,
      index({
        "a%2Fbench": [metricEntry("accuracy", "proportion", [["m1", 0.8]])],
        // Same benchmark, a different measurement whose name would have
        // matched the old /score/ pick. Far from 0.8, so comparing it
        // would have called m1 divergent.
        "b%2Fbench": [metricEntry("score", "proportion", [["m1", 0.2]])],
        // The same metric on the percent scale: one measurement.
        "c%2Fbench": [metricEntry("accuracy", "percent", [["m1", 81]])],
      }),
    )!
    expect([...cross.comparedEvalIds].sort()).toEqual(["a%2Fbench", "c%2Fbench"])
    expect(cross.comparedCount).toBe(1)
    expect(cross.divergentCount).toBe(0)
    // Spread on one scale: 80 vs 81 percent, within 5 points.
    expect(cross.modelRows[0].spread).toBeCloseTo(1)
    expect(cross.thresholdLabel).toBe("5.00 pts")

    const signal = deriveComparability(accuracyPage, cross)
    expect(signal.statValue).toBe("100")
    expect(signal.breakdown.inputs).toContainEqual({
      label: "Sources not reporting Accuracy (not compared)",
      value: "1",
    })
  })

  it("says so when no other source reports the page's metric", () => {
    const cross = buildCrossSuiteAggregate(
      accuracyPage,
      hierarchy,
      index({
        "a%2Fbench": [metricEntry("accuracy", "proportion", [["m1", 0.8]])],
        "b%2Fbench": [metricEntry("score", "proportion", [["m1", 0.2]])],
      }),
    )!
    const signal = deriveComparability(accuracyPage, cross)
    expect(signal.statValue).toBe("—")
    expect(signal.headline).toBe("No other source reports Accuracy.")
  })

  it("does not compare readings of different splits", () => {
    const cross = buildCrossSuiteAggregate(
      accuracyPage,
      hierarchy,
      index({
        "a%2Fbench": [metricEntry("accuracy", "proportion", [["m1", 0.8]], false, "test")],
        "b%2Fbench": [metricEntry("accuracy", "proportion", [["m1", 0.2]], false, "validation")],
      }),
    )!
    expect(cross.comparedCount).toBe(0)
    expect(cross.divergentCount).toBe(0)
    expect(cross.notComparableCount).toBe(1)
  })

  it("does not compare readings on scales that do not convert", () => {
    const cross = buildCrossSuiteAggregate(
      accuracyPage,
      hierarchy,
      index({
        "a%2Fbench": [metricEntry("accuracy", "proportion", [["m1", 0.8]])],
        "b%2Fbench": [metricEntry("accuracy", "points", [["m1", 80]])],
      }),
    )!
    expect(cross.comparedCount).toBe(0)
    expect(cross.divergentCount).toBe(0)
    expect(cross.notComparableCount).toBe(1)
  })

  it("judges no agreement on a scale with no stated bounds", () => {
    const pointsPage = page({
      evaluation_id: "a%2Fbench",
      primary_metric_id: "index",
      metric_config: { evaluation_description: "Index", lower_is_better: false, unit: "points", min_score: null, max_score: null },
    } as unknown as Partial<BenchmarkEvalSummary>)
    const cross = buildCrossSuiteAggregate(
      pointsPage,
      hierarchy,
      index({
        "a%2Fbench": [metricEntry("index", "points", [["m1", 10]])],
        "b%2Fbench": [metricEntry("index", "points", [["m1", 10.1]])],
      }),
    )!
    expect(cross.comparedCount).toBe(0)
    expect(cross.divergentCount).toBe(0)
    expect(cross.notComparableCount).toBe(1)
  })

  it("does not compare readings of opposite direction", () => {
    const cross = buildCrossSuiteAggregate(
      accuracyPage,
      hierarchy,
      index({
        "a%2Fbench": [metricEntry("accuracy", "proportion", [["m1", 0.8]])],
        "b%2Fbench": [metricEntry("accuracy", "proportion", [["m1", 0.2]], true)],
      }),
    )!
    expect(cross.comparedCount).toBe(0)
    expect(cross.divergentCount).toBe(0)
    expect(cross.notComparableCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Models index compare dialog
// ---------------------------------------------------------------------------

describe("one reading as text", () => {
  it("formats by the stated unit only, never by magnitude or unit-name guess", () => {
    expect(formatReading(0.8264462809917356, "percent")).toBe("0.83%")
    expect(formatReading(0.8, "proportion")).toBe("80%")
    expect(formatReading(80, "percent")).toBe("80%")
    expect(formatReading(0.8, "score")).toBe("0.8 score")
    expect(formatReading(0.8, "accuracy")).toBe("0.8 accuracy")
    expect(formatReading(0.8, undefined)).toBe("0.8")
  })
})

describe("model compare dialog", () => {
  it("keeps two models' top scores on different metrics of one benchmark apart, and marks no best", async () => {
    const model = (id: string, metric: string, score: number) =>
      ({
        id,
        model_name: id,
        model_family_name: id,
        developer: "Dev",
        top_scores: [{ benchmark: "ACEBench", metric, score }],
        benchmark_names: ["ACEBench"],
      }) as unknown as BenchmarkEvaluationCardData
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(ModelCompareDialog, {
          models: [model("m1", "Accuracy", 0.7), model("m2", "Score", 0.9)],
          open: true,
          onOpenChange: () => {},
        }),
      )
    })
    const rows = [...document.body.querySelectorAll("tr")].filter((tr) =>
      tr.textContent?.includes("ACEBench"),
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((tr) => tr.textContent)).toEqual([
      expect.stringContaining("Accuracy"),
      expect.stringContaining("Score"),
    ])
    // Each row holds one model's number; the other model's cell is empty.
    expect(rows[0].textContent).toContain("0.7")
    expect(rows[0].textContent).not.toContain("0.9")
    // No cell is marked best: top_scores carries no direction.
    for (const tr of rows) {
      for (const td of tr.querySelectorAll("td")) {
        expect(td.getAttribute("style") ?? "").not.toContain("background")
        expect(td.innerHTML).not.toContain("var(--accent)")
      }
    }
    await act(async () => root.unmount())
  })

  it("puts one metric's proportion and percent readings on one scale, and labels other units", async () => {
    const model = (id: string, score: number, unit: string) =>
      ({
        id,
        model_name: id,
        model_family_name: id,
        developer: "Dev",
        top_scores: [{ benchmark: "B", metric: "Accuracy", score, unit }],
        benchmark_names: ["B"],
      }) as unknown as BenchmarkEvaluationCardData
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(ModelCompareDialog, {
          models: [model("m1", 0.8, "proportion"), model("m2", 80, "percent"), model("m3", 7, "points")],
          open: true,
          onOpenChange: () => {},
        }),
      )
    })
    const row = [...document.body.querySelectorAll("tr")].find((tr) => tr.querySelectorAll("td").length > 1 && tr.textContent?.includes("Accuracy"))!
    const cells = [...row.querySelectorAll("td")].slice(1).map((td) => td.textContent)
    expect(cells).toEqual(["80%", "80%", "7 points"])
    await act(async () => root.unmount())
  })
})

describe("policy overview", () => {
  it("states the direction as the primary metric's on a page of opposite-direction metrics", async () => {
    const { PolicyOverview } = await import("@/components/policy-overview")
    const html = renderToStaticMarkup(createElement(PolicyOverview, { summary: page() }))
    expect(html).toContain(">refusal-score: Higher scores are better.<")
    expect(html).not.toContain(">Higher scores are better.")
  })
})

describe("provenance wording", () => {
  it("calls an any-metric count coverage, not replication", () => {
    const cross = buildCrossSuiteAggregate(
      accuracyPage,
      hierarchy,
      index({
        "a%2Fbench": [metricEntry("accuracy", "proportion", [["m1", 0.8]])],
        "b%2Fbench": [metricEntry("latency", "seconds", [["m1", 2]])],
      }),
    )!
    expect(cross.reportingSourcesByModel.get("m1")?.size).toBe(2)
    const html = renderToStaticMarkup(
      createElement(AudienceModeProvider, null, createElement(EvalDetail, { summary: accuracyPage, evalHierarchy: hierarchy, comparisonIndex: index({
        "a%2Fbench": [metricEntry("accuracy", "proportion", [["m1", 0.8]])],
        "b%2Fbench": [metricEntry("latency", "seconds", [["m1", 2]])],
      }) })),
    )
    expect(html).toContain("reported by more than one source, on any metric")
    expect(html).not.toMatch(/replicated|independent sources/)
  })
})
