import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import { EvalDetail } from "@/components/eval-detail"
import {
  buildCrossSourceContext,
  crossSourceRowsFromMerged,
  mergedPayloadIsComparable,
  type CrossSourceRow,
} from "@/lib/cross-source-context"
import type {
  BenchmarkEvalSummary,
  MergedBenchmarkSummary,
  MergedObservationRow,
} from "@/lib/eval-processing"
import type { SourceMetadata } from "@/lib/benchmark-schema"

vi.mock("next/navigation", () => import("./next-navigation-stub"))

// The context strip places one source's score among the other sources'
// measurements of the same (model, benchmark). The curated study sidecar
// covers exactly one page; this builds the same shape for the ~250
// benchmarks that have a second source and no sidecar entry.

const row = (over: Partial<CrossSourceRow> & Pick<CrossSourceRow, "modelKey" | "score" | "sourceSlug">): CrossSourceRow => ({
  displayName: over.modelKey,
  sourceLabel: over.sourceSlug,
  ...over,
})

describe("buildCrossSourceContext", () => {
  it("makes the subject source the mark and the others the points", () => {
    const payload = buildCrossSourceContext(
      [
        row({ modelKey: "m1", displayName: "Model One", score: 0.5, sourceSlug: "vals-ai", sourceLabel: "Vals.ai" }),
        row({ modelKey: "m1", score: 0.41, sourceSlug: "llm-stats", sourceLabel: "LLM Stats" }),
        row({ modelKey: "m1", score: 0.62, sourceSlug: "third", sourceLabel: "Third" }),
      ],
      { subjectSourceSlug: "vals-ai", subjectLabel: "This source" },
    )!
    const model = payload.models[0]
    expect(model.score).toBe(0.5)
    expect(model.points.map((p) => p.source)).toEqual(["LLM Stats", "Third"])
    // Points ascend so the strip reads left to right.
    expect(model.points.map((p) => p.score)).toEqual([0.41, 0.62])
    expect(payload.subjectLabel).toBe("This source")
  })

  it("drops models with nobody to compare against, and names them", () => {
    // A strip with a single mark implies a comparison that was never made.
    const payload = buildCrossSourceContext(
      [
        row({ modelKey: "paired", score: 0.5, sourceSlug: "a" }),
        row({ modelKey: "paired", score: 0.4, sourceSlug: "b" }),
        row({ modelKey: "lonely", displayName: "Lonely", score: 0.9, sourceSlug: "a" }),
      ],
      { subjectSourceSlug: "a" },
    )!
    expect(payload.models.map((m) => m.key)).toEqual(["paired"])
    expect(payload.modelsWithoutContext).toEqual(["Lonely"])
  })

  it("returns null when no model has a second source", () => {
    expect(
      buildCrossSourceContext([
        row({ modelKey: "m1", score: 0.5, sourceSlug: "a" }),
        row({ modelKey: "m2", score: 0.6, sourceSlug: "a" }),
      ]),
    ).toBeNull()
    expect(buildCrossSourceContext([])).toBeNull()
  })

  it("anchors a merged page on the widest-coverage source", () => {
    // No source is "this" one there, so every strip needs the same anchor
    // or they cannot be read down the column.
    const payload = buildCrossSourceContext([
      row({ modelKey: "m1", score: 0.5, sourceSlug: "wide" }),
      row({ modelKey: "m1", score: 0.4, sourceSlug: "narrow" }),
      row({ modelKey: "m2", score: 0.7, sourceSlug: "wide" }),
      row({ modelKey: "m2", score: 0.6, sourceSlug: "narrow" }),
      row({ modelKey: "m3", score: 0.3, sourceSlug: "wide" }),
    ])!
    for (const model of payload.models) {
      expect(model.points.map((p) => p.source)).toEqual(["narrow"])
    }
  })

  it("carries no study instrumentation it does not have", () => {
    // Bands, attempt counts and a with-oracle companion are things only a
    // study records; inventing them would draw marks nobody measured.
    const payload = buildCrossSourceContext([
      row({ modelKey: "m1", score: 0.5, sourceSlug: "a" }),
      row({ modelKey: "m1", score: 0.4, sourceSlug: "b" }),
    ])!
    const model = payload.models[0]
    expect(model.assisted).toBeNull()
    expect(model.attemptsMin).toBe(0)
    expect(model.attemptsMax).toBe(0)
    expect(model.hiddenCount).toBe(0)
    expect(payload.modelsWithoutAssisted).toEqual([])
  })

  it("skips rows with no usable score", () => {
    const payload = buildCrossSourceContext([
      row({ modelKey: "m1", score: 0.5, sourceSlug: "a" }),
      row({ modelKey: "m1", score: Number.NaN, sourceSlug: "b" }),
      row({ modelKey: "m1", score: 0.4, sourceSlug: "c" }),
    ])!
    expect(payload.models[0].points).toHaveLength(1)
  })

  it("orders best-covered models first", () => {
    const payload = buildCrossSourceContext([
      row({ modelKey: "thin", score: 0.5, sourceSlug: "a" }),
      row({ modelKey: "thin", score: 0.4, sourceSlug: "b" }),
      row({ modelKey: "thick", score: 0.5, sourceSlug: "a" }),
      row({ modelKey: "thick", score: 0.4, sourceSlug: "b" }),
      row({ modelKey: "thick", score: 0.3, sourceSlug: "c" }),
    ])!
    expect(payload.models.map((m) => m.key)).toEqual(["thick", "thin"])
  })

  it("does not count the page's own source as another measurement", () => {
    // A source that republishes a model twice is still one source, and a
    // second reading of its own is this page speaking, not a comparison.
    const payload = buildCrossSourceContext(
      [
        row({ modelKey: "m1", score: 0.5, sourceSlug: "mine", sourceLabel: "Mine" }),
        row({ modelKey: "m1", score: 0.52, sourceSlug: "mine", sourceLabel: "Mine" }),
        row({ modelKey: "m1", score: 0.41, sourceSlug: "other", sourceLabel: "Other" }),
      ],
      { subjectSourceSlug: "mine" },
    )!
    expect(payload.models[0].points.map((p) => p.source)).toEqual(["Other"])
  })

  it("draws no strip for a model the page's own source never measured", () => {
    expect(
      buildCrossSourceContext(
        [
          row({ modelKey: "m1", score: 0.5, sourceSlug: "other" }),
          row({ modelKey: "m1", score: 0.4, sourceSlug: "third" }),
        ],
        { subjectSourceSlug: "mine" },
      ),
    ).toBeNull()
  })

  it("reads a lower-is-better score as published, without inverting it", () => {
    // The plot's axis is linear over the raw values; nothing here knows
    // the metric's direction, and a flipped subject mark would read as
    // the opposite claim.
    const payload = buildCrossSourceContext(
      [
        row({ modelKey: "m1", score: 0.12, sourceSlug: "mine" }),
        row({ modelKey: "m1", score: 0.3, sourceSlug: "other" }),
        row({ modelKey: "m1", score: 0.45, sourceSlug: "third" }),
      ],
      { subjectSourceSlug: "mine" },
    )!
    expect(payload.models[0].score).toBe(0.12)
    expect(payload.models[0].points.map((p) => p.score)).toEqual([0.3, 0.45])
  })
})

// The rows come from the merged payload for the page's benchmark: the
// producer's own cross-source join, already on the canonical scale.

function sourceMeta(name: string): SourceMetadata {
  return {
    source_name: name,
    source_type: "leaderboard",
    source_organization_name: name,
    evaluator_relationship: "third_party",
  }
}

const observation = (over: Partial<MergedObservationRow>): MergedObservationRow => ({
  model_info: { name: "Model A", id: "org/model-a" },
  model_key: "org/model-a",
  evaluation_id: "src-a%2Fbench",
  composite_slug: "src-a",
  composite_display_name: "Source A",
  score: 0.5,
  score_canonical: 0.5,
  scale_conversion: "none",
  evaluation_timestamp: "2026-01-01T00:00:00Z",
  source_metadata: sourceMeta("Source A"),
  is_headline: true,
  ...over,
})

const mergedPayload = (results: MergedObservationRow[]): MergedBenchmarkSummary =>
  ({
    merged: true,
    evaluation_id: "bench",
    benchmark_id: "bench",
    display_name: "Bench",
    grain: "benchmark",
    preferred_metric_id: "accuracy",
    selected_metric_id: "accuracy",
    selected_lower_is_better: false,
    selected_slice_id: null,
    lower_is_better: false,
    metrics: [],
    slices: null,
    aggregate_sources: [],
    results,
  }) as unknown as MergedBenchmarkSummary

describe("crossSourceRowsFromMerged", () => {
  it("leaves out a score reached with answer feedback", () => {
    const rows = crossSourceRowsFromMerged(
      mergedPayload([
        observation({}),
        observation({
          composite_slug: "src-b",
          composite_display_name: "Source B",
          protocol_condition: '{"feedback":"answer_feedback"}',
          score_canonical: 0.9,
        }),
      ]),
    )
    expect(rows.map((r) => r.sourceSlug)).toEqual(["src-a"])
  })

  it("leaves out a reading the producer did not pick", () => {
    // A losing judge panel or protocol arm is another reading of one
    // cell, not another source measuring the model.
    const rows = crossSourceRowsFromMerged(
      mergedPayload([
        observation({}),
        observation({
          composite_slug: "src-b",
          composite_display_name: "Source B",
          is_headline: false,
          score_canonical: 0.7,
        }),
      ]),
    )
    expect(rows.map((r) => r.sourceSlug)).toEqual(["src-a"])
  })

  it("leaves out a number that could not go on the canonical scale", () => {
    const rows = crossSourceRowsFromMerged(
      mergedPayload([
        observation({}),
        observation({
          composite_slug: "src-b",
          composite_display_name: "Source B",
          score: 68.5,
          score_canonical: null,
        }),
      ]),
    )
    expect(rows.map((r) => r.sourceSlug)).toEqual(["src-a"])
  })

  it("keeps one reading per source and model", () => {
    const rows = crossSourceRowsFromMerged(
      mergedPayload([
        observation({ score_canonical: 0.62 }),
        observation({ score_canonical: 0.58 }),
        observation({
          composite_slug: "src-b",
          composite_display_name: "Source B",
          score_canonical: 0.44,
        }),
      ]),
    )
    expect(rows.map((r) => [r.sourceSlug, r.score])).toEqual([
      ["src-a", 0.62],
      ["src-b", 0.44],
    ])
  })
})

describe("mergedPayloadIsComparable", () => {
  const page = { benchmarkId: "bench", metricId: "accuracy" }

  it("accepts the payload that answers the page's own question", () => {
    expect(
      mergedPayloadIsComparable(
        { benchmark_id: "bench", selected_metric_id: "accuracy", grain: "benchmark" },
        page,
      ),
    ).toBe(true)
  })

  it("omits a payload on another metric", () => {
    // The merged accessor falls back to its preferred metric when it
    // cannot serve the one asked for, and two metrics do not share an axis.
    expect(
      mergedPayloadIsComparable(
        { benchmark_id: "bench", selected_metric_id: "exact_match", grain: "benchmark" },
        page,
      ),
    ).toBe(false)
  })

  it("omits a payload at slice grain, or for another benchmark", () => {
    expect(
      mergedPayloadIsComparable(
        { benchmark_id: "bench", selected_metric_id: "accuracy", grain: "slice" },
        page,
      ),
    ).toBe(false)
    expect(
      mergedPayloadIsComparable(
        { benchmark_id: "other-bench", selected_metric_id: "accuracy", grain: "benchmark" },
        page,
      ),
    ).toBe(false)
  })
})

// A merged page lists one row per model and source already, so every
// reading the strip would draw is a row on the page. It gets no strip
// even when a payload is handed to it.

function summaryWith(extra: Record<string, unknown>): BenchmarkEvalSummary {
  return {
    evaluation_id: "mine%2Fbench",
    evaluation_name: "Bench",
    composite_benchmark_key: "mine",
    composite_benchmark_name: "Mine",
    metric_config: {
      evaluation_description: "accuracy",
      lower_is_better: false,
      score_type: "continuous",
      min_score: 0,
      max_score: 1,
    },
    // The distribution panel that carries the view toggle needs three
    // ranked readings before it is drawn at all.
    model_results: ["a", "b", "c"].map((letter, index) => ({
      model_info: { name: `Model ${letter.toUpperCase()}`, id: `org/model-${letter}` },
      model_route_id: `org%2Fmodel-${letter}`,
      score: 0.5 - index * 0.1,
      score_details: { score: 0.5 - index * 0.1 },
      evaluation_timestamp: "2026-01-01T00:00:00Z",
      source_metadata: sourceMeta("Mine"),
      source_data: { dataset_name: "Bench" },
      is_headline: true,
      result: {
        evaluation_name: "accuracy",
        evaluation_timestamp: "2026-01-01T00:00:00Z",
        metric_config: {
          evaluation_description: "accuracy",
          lower_is_better: false,
          score_type: "continuous",
        },
        score_details: { score: 0.5 - index * 0.1 },
      },
    })),
    models_count: 3,
    evaluator_names: ["Mine"],
    source_types: [],
    third_party_ratio: 1,
    missing_generation_config_count: 0,
    best_model: { name: "Model A", score: 0.5 },
    worst_model: null,
    avg_score: 0.4,
    avg_score_norm: 0.4,
    ...extra,
  } as unknown as BenchmarkEvalSummary
}

describe("the Context view's scope", () => {
  const context = buildCrossSourceContext(
    [
      row({ modelKey: "org/model-a", displayName: "Model A", score: 0.5, sourceSlug: "mine" }),
      row({ modelKey: "org/model-a", displayName: "Model A", score: 0.41, sourceSlug: "other" }),
    ],
    { subjectSourceSlug: "mine", subjectLabel: "This source" },
  )

  const render = (extra: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(
        AudienceModeProvider,
        null,
        createElement(EvalDetail, { summary: summaryWith(extra), crossSourceContext: context }),
      ),
    )

  it("offers the view on a per-source page", () => {
    expect(render({})).toContain(">Context<")
  })

  it("does not offer it on a merged page", () => {
    expect(render({ merged_view: true })).not.toContain(">Context<")
  })
})
