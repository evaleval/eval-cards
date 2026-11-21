import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { SummaryMetricsList, buildBenchmarkGroups } from "@/components/benchmark-detail"
import type { BenchmarkEvaluation, EvalTag, EvaluationResult } from "@/lib/benchmark-schema"
import { readingUnit } from "@/lib/headline-readings"

vi.mock("next/navigation", () => import("./next-navigation-stub"))

// A model page row is one eval and leads with one reading: the one view-data
// flags `is_lead_metric`. The row once showed the mean of every reading the
// model had on the eval (lm-eval's BBQ task reports three accuracies and 24
// signed bias scores) beside a rank computed on accuracy alone, and merged
// evals whose ids shared a prefix before a ".". These pin what a reader sees.
// The flag itself is pinned against DuckDB in view-data.test.ts ("model page
// lead metric"), including the rule for a snapshot without the column.

const MODEL_ID = "nvidia/nemotron-3-5-lightning-30b-a3b"

type Metric = {
  id: string
  name?: string
  score: number
  lowerIsBetter?: boolean
  unit?: string
  /** [position, total] on this metric; absent when the pipeline ranked no row. */
  rank?: [number, number]
  lead?: boolean
}

// Readings from warehouse snapshot 2026-11-20T19-17-21Z.
// Nemotron 3.5 Lightning on swissai-apertus-evals/bbq (primary: accuracy).
const BBQ: Metric[] = [
  { id: "accuracy", name: "Accuracy", score: 0.6485331327361007, unit: "proportion", rank: [14, 16], lead: true },
  { id: "accuracy::amb", name: "Accuracy (amb)", score: 0.41602270395951585, unit: "proportion", rank: [16, 16] },
  { id: "accuracy::disamb", name: "Accuracy (disamb)", score: 0.8810435615126855, unit: "proportion", rank: [5, 16] },
  // The source states no unit for its bias scores: signed, on [-1, 1].
  { id: "amb_bias_score", score: 0.097, lowerIsBetter: true, rank: [15, 16] },
  { id: "disamb_bias_score_Sexual_orientation", score: -0.0025445292620864812, lowerIsBetter: true, rank: [3, 16] },
]
// Gemma 3 27B on openeval/harmbench (primary: harmbench-refusal-score, which
// this model has no reading on).
const HARMBENCH: Metric[] = [
  { id: "attack-success-rate", name: "Attack Success Rate", score: 0.2133, lowerIsBetter: true, unit: "proportion", rank: [98, 128], lead: true },
  { id: "refusal-rate", name: "Refusal Rate", score: 0.3933, unit: "proportion", rank: [27, 118] },
]

function entry(
  metric: Metric,
  {
    evalId = "swissai-apertus-evals%2Fbbq",
    primaryMetricId,
    slice,
  }: { evalId?: string; primaryMetricId?: string; slice?: { parent: string } } = {},
) {
  const result = {
    // What view-data ships for a metric the registry has not named: the
    // eval's name, not the metric's.
    evaluation_name: metric.name ?? "BBQ",
    display_name: metric.name,
    canonical_display_name: metric.name,
    metric_summary_id: `${evalId}%3A${encodeURIComponent(metric.id)}`,
    metric_key: metric.id,
    evaluation_timestamp: "",
    source_data: { dataset_name: "BBQ" },
    metric_config: {
      lower_is_better: Boolean(metric.lowerIsBetter),
      score_type: "continuous",
      min_score: 0,
      max_score: 1,
      unit: metric.unit,
    },
    score_details: { score: metric.score },
    is_lead_metric: Boolean(metric.lead),
    position: metric.rank?.[0],
    total: metric.rank?.[1],
  } as unknown as EvaluationResult
  const evaluation = {
    schema_version: "1.0",
    eval_summary_id: evalId,
    evaluation_id: evalId,
    retrieved_timestamp: "",
    benchmark: "BBQ",
    display_name: "BBQ",
    canonical_display_name: "BBQ",
    primary_metric_id: primaryMetricId,
    is_slice: Boolean(slice),
    parent_benchmark_id: slice?.parent,
    source_data: { dataset_name: "BBQ" },
    source_metadata: {
      source_name: "Swiss AI Initiative",
      source_type: "evaluation_run",
      source_organization_name: "Swiss AI Initiative",
      evaluator_relationship: "third_party",
    },
    model_info: { name: "Nemotron 3.5 Lightning", id: MODEL_ID },
    evaluation_results: [result],
  } as unknown as BenchmarkEvaluation
  return { evaluation, result, category: "safety" as EvalTag }
}

function renderSummaryMarkup(entries: ReturnType<typeof entry>[]) {
  return renderToStaticMarkup(
    createElement(SummaryMetricsList, {
      groups: buildBenchmarkGroups(entries, undefined),
      hierarchyIndex: null,
      sourcePrefixFamily: new Map(),
    }),
  )
}

// The text a reader sees: tags dropped, whitespace (incl. nbsp) collapsed.
function renderSummary(entries: ReturnType<typeof entry>[]) {
  return renderSummaryMarkup(entries)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;| /g, " ")
    .replace(/\s+/g, " ")
}

function occurrences(text: string, needle: string) {
  return text.split(needle).length - 1
}

describe("model page summary row for an eval with many metrics", () => {
  const entries = BBQ.map((metric) => entry(metric, { primaryMetricId: "accuracy" }))

  it("leads with the flagged reading: its name, direction, own rank and value", () => {
    const text = renderSummary(entries)

    expect(text).toContain("Bbq Safety ↑ Higher is better · Accuracy rank 14 of 16 64.9% ")
    expect(text).not.toContain("↓ Lower is better")
  })

  it("shows no mean over the metrics", () => {
    const text = renderSummary(entries)

    const meanOfAll = (BBQ.reduce((sum, metric) => sum + metric.score, 0) / BBQ.length) * 100
    expect(text).not.toContain(`${meanOfAll.toFixed(1)}%`)
    expect(text).not.toContain("avg of")
    expect(text).not.toContain("—")
    expect(text).not.toContain("NaN")
  })

  it("lists every reading under the row with its own name, direction, rank and value", () => {
    const text = renderSummary(entries)

    expect(occurrences(text, "└")).toBe(BBQ.length)
    expect(text).toContain("Accuracy ↑ on swissai-apertus-evals/bbq · Swissai Apertus Evals / Bbq rank 14 of 16 64.9% ")
    expect(text).toContain("Accuracy (amb) ↑ on swissai-apertus-evals/bbq · Swissai Apertus Evals / Bbq rank 16 of 16 41.6% ")
    expect(text).toContain("Accuracy (disamb) ↑ on swissai-apertus-evals/bbq · Swissai Apertus Evals / Bbq rank 5 of 16 88.1% ")
    expect(text).toContain("Amb Bias Score ↓ on swissai-apertus-evals/bbq · Swissai Apertus Evals / Bbq rank 15 of 16 0.0970 ")
    expect(text).toContain(
      "Disamb Bias Score Sexual Orientation ↓ on swissai-apertus-evals/bbq · Swissai Apertus Evals / Bbq rank 3 of 16 -0.0025 ",
    )
  })

  it("prints a reading with no unit as the number it is, not as a percentage", () => {
    const text = renderSummary(entries)

    expect(text).not.toContain("-0.25%")
    expect(text).not.toContain("9.70%")
  })

  it("names the ranked metric in the rank's tooltip", () => {
    const html = renderSummaryMarkup(entries)

    // Once on the row, once on the accuracy line under it.
    expect(occurrences(html, "Ranked 14 of 16 models reported on this benchmark, by Accuracy.")).toBe(2)
    expect(occurrences(html, "Ranked 3 of 16 models reported on this benchmark, by Disamb Bias Score Sexual Orientation.")).toBe(1)
  })

  it("shows no rank beside a reading the pipeline did not rank", () => {
    const unranked = BBQ.map((metric) =>
      entry(metric.lead ? { ...metric, rank: undefined } : metric, { primaryMetricId: "accuracy" }),
    )
    const text = renderSummary(unranked)

    expect(text).toContain("Bbq Safety ↑ Higher is better · Accuracy 64.9% ")
    expect(text).toContain("Accuracy ↑ on swissai-apertus-evals/bbq · Swissai Apertus Evals / Bbq 64.9% ")
    expect(text).toContain("rank 16 of 16 41.6% ")
  })
})

describe("model page summary row when the model has no reading on the eval's primary metric", () => {
  const entries = HARMBENCH.map((metric) =>
    entry(metric, { evalId: "openeval%2Fharmbench", primaryMetricId: "harmbench-refusal-score" }),
  )

  it("leads with the flagged metric and that metric's own rank and direction", () => {
    const text = renderSummary(entries)

    expect(text).toContain("Harmbench Safety ↓ Lower is better · Attack Success Rate rank 98 of 128 21.3% ")
    expect(text).toContain("Refusal Rate ↑ on openeval/harmbench · Openeval / Harmbench rank 27 of 118 39.3% ")
    expect(text).not.toContain("—")
  })

  it("gives the Researcher-view group the same number", () => {
    const [group] = buildBenchmarkGroups(entries, undefined)

    expect(group.avgRawScore).toBe(0.2133)
    expect(group.avgDisplayScore).toBe("0.213 Proportion")
  })
})

describe("model page summary rows for evals whose ids share a prefix before a '.'", () => {
  // aixamine-jailbreak, CohereLabs/c4ai-command-r-08-2024: two evals.
  const entries = [
    entry({ id: "score", name: "Score", score: 76.182, unit: "percent", rank: [48, 104], lead: true }, {
      evalId: "aixamine-jailbreak%2Fcipher",
      primaryMetricId: "score",
    }),
    entry({ id: "score", name: "Score", score: 63.5, unit: "percent", rank: [52, 103], lead: true }, {
      evalId: "aixamine-jailbreak%2Fcipher.Self%20Defined",
      primaryMetricId: "score",
    }),
  ]

  it("keeps each eval on its own row with its own number and rank", () => {
    const text = renderSummary(entries)

    expect(text).toContain("2 benchmarks")
    expect(text).toContain(
      "Cipher Safety ↑ Higher is better · Score on aixamine-jailbreak/cipher rank 48 of 104 76.2% ",
    )
    expect(text).toContain(
      "Cipher.Self Defined Safety ↑ Higher is better · Score on aixamine-jailbreak/cipher.Self Defined rank 52 of 103 63.5% ",
    )
  })

  it("averages nothing across them", () => {
    const text = renderSummary(entries)

    expect(text).not.toContain("69.8%")
    expect(text).not.toContain("avg of")
    expect(text).not.toContain("└")
  })
})

describe("the number of a Researcher-view group", () => {
  it("is the lead reading for a group of one eval", () => {
    const [group] = buildBenchmarkGroups(
      BBQ.map((metric) => entry(metric, { primaryMetricId: "accuracy" })),
      undefined,
    )

    expect(group.avgRawScore).toBeCloseTo(0.6485331327361007, 12)
    expect(group.avgDisplayScore).toBe("0.649 Proportion")
  })

  // Slice evals fold into one group around their parent; with no eval of
  // the parent's own, the group's number comes from its parts.
  const slice = (name: string, metric: Metric) =>
    entry(metric, {
      evalId: `livebench%2Fcoding.${name}`,
      primaryMetricId: metric.id,
      slice: { parent: "coding" },
    })

  it("is the mean of the parts' lead readings when they are one metric, labelled", () => {
    const groups = buildBenchmarkGroups(
      [
        slice("a", { id: "accuracy", score: 0.4, unit: "proportion", lead: true }),
        slice("b", { id: "accuracy", score: 0.6, unit: "proportion", lead: true }),
      ],
      undefined,
    )

    expect(groups).toHaveLength(1)
    expect(groups[0].avgRawScore).toBeCloseTo(0.5, 12)
    expect(groups[0].scoreNote).toBe("avg of 2 parts")
  })

  it("is no number, and the count of parts, for parts on different metrics", () => {
    const groups = buildBenchmarkGroups(
      [
        slice("a", { id: "accuracy", score: 0.4, unit: "proportion", lead: true }),
        slice("b", { id: "f1", score: 0.6, unit: "proportion", lead: true }),
      ],
      undefined,
    )

    expect(groups).toHaveLength(1)
    expect(groups[0].avgDisplayScore).toBe("2 parts")
    expect(groups[0].avgRawScore).toBeNaN()
    expect(groups[0].scoreNote).toBeNull()
  })

  it("still gives each folded eval its own Summary row", () => {
    const text = renderSummary([
      slice("a", { id: "accuracy", name: "Accuracy", score: 0.4, unit: "proportion", rank: [3, 9], lead: true }),
      slice("b", { id: "f1", name: "F1", score: 0.6, unit: "proportion", rank: [2, 7], lead: true }),
    ])

    expect(text).toContain("Coding.a Safety ↑ Higher is better · Accuracy on livebench/coding.a rank 3 of 9 40.0% ")
    expect(text).toContain("Coding.b Safety ↑ Higher is better · F1 on livebench/coding.b rank 2 of 7 60.0% ")
  })
})

describe("readingUnit", () => {
  it("keeps a reading's own unit", () => {
    expect(readingUnit("points", "proportion", { metricKey: "elo", primaryMetricId: "accuracy" })).toBe("points")
  })

  it("lends the eval's unit only to a reading on the eval's primary metric", () => {
    const keys = { metricKey: "amb_bias_score", primaryMetricId: "accuracy" }

    expect(readingUnit(undefined, "proportion", keys)).toBeUndefined()
    expect(readingUnit(undefined, "proportion", { ...keys, metricKey: "accuracy" })).toBe("proportion")
  })

  it("keeps the eval's unit when the row names no primary metric", () => {
    expect(readingUnit(undefined, "proportion", { metricKey: "accuracy" })).toBe("proportion")
  })
})
