import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import { EvalDetail } from "@/components/eval-detail"
import { ContextPlot } from "@/components/score-distribution"
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

  it("omits a source whose canonical numbers are on the other scale", () => {
    // benchpress publishes scicode as 21 to 60.2 and Artificial Analysis
    // publishes the same models as 0 to 0.602, both in the canonical
    // column. Side by side they read as a hundredfold disagreement.
    const payload = buildCrossSourceContext(
      [
        row({ modelKey: "m1", score: 0.52, sourceSlug: "mine", sourceLabel: "Mine" }),
        row({ modelKey: "m1", score: 52.2, sourceSlug: "hundreds", sourceLabel: "Hundreds" }),
        row({ modelKey: "m1", score: 0.48, sourceSlug: "other", sourceLabel: "Other" }),
      ],
      { subjectSourceSlug: "mine" },
    )!
    expect(payload.models[0].points.map((p) => p.source)).toEqual(["Other"])
    expect(payload.contextSources.map((s) => s.id)).toEqual(["mine", "other"])
  })

  it("draws nothing when the only other source is on the other scale", () => {
    expect(
      buildCrossSourceContext(
        [
          row({ modelKey: "m1", score: 0.52, sourceSlug: "mine" }),
          row({ modelKey: "m1", score: 52.2, sourceSlug: "hundreds" }),
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
  const renderWith = (extra: Record<string, unknown>, loader?: () => Promise<null>) =>
    renderToStaticMarkup(
      createElement(
        AudienceModeProvider,
        null,
        createElement(EvalDetail, {
          summary: summaryWith(extra),
          crossSourceContextLoader: loader,
        }),
      ),
    )

  it("offers the view on a per-source page without paying for it", () => {
    // The payload is a multi-megabyte download. Knowing a second source
    // exists is what offers the chip; opening it is what fetches.
    const loader = vi.fn(async () => null)
    expect(renderWith({}, loader)).toContain(">Context<")
    expect(loader).not.toHaveBeenCalled()
  })

  it("does not offer it without a loader or a curated payload", () => {
    expect(renderWith({})).not.toContain(">Context<")
  })

  it("does not offer it on a merged page", () => {
    const loader = vi.fn(async () => null)
    expect(renderWith({ merged_view: true }, loader)).not.toContain(">Context<")
    expect(loader).not.toHaveBeenCalled()
  })

  it("does not offer it on a multi-metric page", () => {
    // That branch renders no distribution panel, so there is nothing for
    // the chip to sit in and nothing worth fetching for.
    const loader = vi.fn(async () => null)
    const html = renderWith(
      {
        leaderboard_metrics: [
          { column_key: "accuracy", display_name: "Accuracy" },
          { column_key: "f1", display_name: "F1" },
        ],
        leaderboard_rows: [
          {
            model_info: { name: "Model A", id: "org/model-a" },
            model_route_id: "org%2Fmodel-a",
            values: { accuracy: 0.5, f1: 0.4 },
          },
        ],
      },
      loader,
    )
    expect(html).not.toContain(">Context<")
    expect(loader).not.toHaveBeenCalled()
  })

  it("does not offer it while a sibling split is the active leaderboard", () => {
    // The strip speaks for the benchmark the page fetched it for; the
    // scores beside it would be the split's.
    const loader = vi.fn(async () => null)
    const summary = summaryWith({})
    const html = renderToStaticMarkup(
      createElement(
        AudienceModeProvider,
        null,
        createElement(EvalDetail, {
          summary,
          activeSummary: summaryWith({ evaluation_id: "mine%2Fbench-fr" }),
          crossSourceContextLoader: loader,
        }),
      ),
    )
    expect(html).not.toContain(">Context<")
    expect(loader).not.toHaveBeenCalled()
  })
})

// A canonical score is whatever the registry's scale for the metric is.
// The study plot was written for one study's fractions; a derived payload
// has to say which scale its numbers are on or 60.2 is drawn as 6020.0%.

describe("the scale the strip draws on", () => {
  const derived = (...scores: number[]) =>
    buildCrossSourceContext(
      scores.map((score, index) =>
        row({
          modelKey: "m1",
          displayName: "Model One",
          score,
          sourceSlug: index === 0 ? "mine" : `other-${index}`,
        }),
      ),
      { subjectSourceSlug: "mine", subjectLabel: "This source" },
    )!

  const plot = (payload: Parameters<typeof ContextPlot>[0]["context"]) =>
    renderToStaticMarkup(createElement(ContextPlot, { context: payload }))

  it("reads a canonical 0-100 metric as it is published", () => {
    const payload = derived(85, 80, 60.2)
    expect(payload.scoreScale).toBe("raw")
    const html = plot(payload)
    expect(html).toContain("85.00")
    expect(html).not.toContain("8500.0%")
    expect(html).toContain("reported score, on this metric&#x27;s canonical scale")
  })

  it("still reads a fraction metric as a percentage", () => {
    const payload = derived(0.85, 0.8)
    expect(payload.scoreScale).toBe("fraction")
    const html = plot(payload)
    expect(html).toContain("85.0%")
    // Percent formatting is not the study's claim about what it measured.
    expect(html).not.toContain("binary run success rates")
  })

  it("says nothing about task counts it never measured", () => {
    expect(plot(derived(0.85, 0.8))).not.toContain("0 tasks")
  })

  it("leaves a curated payload's scale, wording and task counts alone", () => {
    const curated = {
      ...derived(0.85, 0.8),
      subjectLabel: null,
      scoreScale: null,
      models: derived(0.85, 0.8).models.map((model) => ({ ...model, nTasks: 86 })),
    }
    const html = plot(curated)
    expect(html).toContain("85.0%")
    expect(html).toContain("Current study (no feedback)")
    expect(html).toContain("86 tasks")
    expect(html).toContain("binary run success rates")
  })
})
