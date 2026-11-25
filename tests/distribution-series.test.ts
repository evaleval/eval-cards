import { describe, expect, it } from "vitest"

import {
  buildDistributionSeries,
  buildDistributionSliceAxis,
} from "@/lib/distribution-series"
import type { BenchmarkEvalSummary } from "@/lib/eval-processing"
import fixtures from "./fixtures/distribution-eval-summaries.json"

// Fixtures are trimmed real payloads captured from the live
// /api/eval-summary route (evalcards.evalevalai.com), so these assertions
// exercise the actual deployed data shape, not a hand-built mock.
const ALL = "__all__"
const summaryOf = (k: keyof typeof fixtures) =>
  fixtures[k] as unknown as BenchmarkEvalSummary

describe("buildDistributionSeries — metric chip selection", () => {
  it("vals-ai/math-500: collapses the redundant self-slice subtask to a single Accuracy chip", () => {
    const summary = summaryOf("math500")
    // The live payload carries two metrics with the same metric_summary_id:
    // root `accuracy` + subtask `accuracy::vals ai math500`. The subtask is a
    // self-slice (its key is just the slugified eval), so it must NOT become a
    // second chip.
    expect((summary.leaderboard_metrics ?? []).map((m) => m.scope).sort()).toEqual([
      "root",
      "subtask",
    ])
    const sliceAxis = buildDistributionSliceAxis(summary)
    // A lone self-slice is not a real slice axis.
    expect(sliceAxis).toBeNull()
    const series = buildDistributionSeries(summary, sliceAxis, ALL, ALL)
    expect(series).not.toBeNull()
    expect(series!.length).toBe(1)
    expect(series![0].label).toBe("Accuracy")
  })

  it("agentharm: keeps every distinct root metric (multi-metric embed unbroken)", () => {
    const summary = summaryOf("agentharm")
    const rootCount = (summary.leaderboard_metrics ?? []).filter(
      (m) => m.scope !== "subtask",
    ).length
    expect(rootCount).toBeGreaterThan(1)
    const sliceAxis = buildDistributionSliceAxis(summary)
    const series = buildDistributionSeries(summary, sliceAxis, ALL, ALL)
    expect(series).not.toBeNull()
    expect(series!.length).toBe(rootCount)
    // No two chips share a label (the duplication the fix targets).
    const labels = series!.map((s) => s.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it("never coerces null or empty-string matrix cells to 0 points", () => {
    const summary = {
      evaluation_id: "openeval%2Fharmbench",
      evaluation_name: "HarmBench",
      primary_metric_id: "attack-success-rate",
      leaderboard_metrics: [
        {
          column_key: "attack-success-rate",
          metric_id: "attack-success-rate",
          metric_summary_id: "harmbench%3Aattack-success-rate",
          display_name: "Attack Success Rate",
          lower_is_better: true,
          unit: "proportion",
          scope: "root",
        },
      ],
      leaderboard_rows: [
        { model_info: { id: "a", name: "A" }, values: { "attack-success-rate": 0.2 } },
        { model_info: { id: "b", name: "B" }, values: { "attack-success-rate": 0.4 } },
        { model_info: { id: "c", name: "C" }, values: { "attack-success-rate": null } },
        { model_info: { id: "d", name: "D" }, values: { "attack-success-rate": "" } },
        { model_info: { id: "e", name: "E" }, values: { "attack-success-rate": undefined } },
      ],
    } as unknown as BenchmarkEvalSummary

    // Only 2 finite scores exist — null/empty cells must NOT be coerced to 0
    // to clear the >=3 point threshold.
    expect(buildDistributionSeries(summary, null, ALL, ALL)).toBeNull()
  })
})
