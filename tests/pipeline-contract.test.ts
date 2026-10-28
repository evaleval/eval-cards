import { readdirSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"

import { describe, expect, it } from "vitest"

import { isNotAssessable } from "../components/signals/signal-utils"
import type { ComparabilityStatus, RowAnnotations } from "../lib/backend-artifacts"
import {
  compositeScoresByModel,
  groupByHeadlineModel,
  judgeCellSummary,
  judgeConditionSummary,
  parseJudgeCondition,
  primaryMetricColumnKey,
} from "../lib/eval-processing"
import type { MergedBenchmarkSummary } from "../lib/eval-processing"
import type { HFEvalDetail, HFEvalModelResult, HFModelDetail } from "../lib/hf-data"
import { mergedSummaryToEvalSummary } from "../lib/merged-adapter"

import { fixtureEntries, loadAllFixtures, walkHierarchyResults } from "./fixtures/loader"

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")

// Tier A — pipeline contract tests.
//
// These tests assert that the pipeline-emitted artifacts in tests/fixtures/
// carry every field the TS code depends on. They run against PINNED fixtures,
// not the live cache, so an upstream data refresh doesn't make these flap.
//
// To check the live cache for drift instead, see tests/upstream-drift.test.ts.
//
// When adding a deletion that depends on a new pipeline guarantee, add a
// contract here first. Each contract should fail loudly with the offending
// file path + key path so violations are easy to fix.

const KNOWN_PIPELINE_CATEGORY_KEYS = new Set([
  "agentic",
  "reasoning",
  "general",
  "safety",
  "knowledge",
  "other",
  "coding",
  "instruction_following",
  "language_understanding",
])

const VALID_EVALUATOR_RELATIONSHIPS = new Set(["first_party", "third_party", "other"])

interface Violation {
  fixture: string
  path: string
  detail: string
}

describe("Tier A — pipeline contracts (model files)", () => {
  const models = loadAllFixtures<HFModelDetail>("models")

  it("every model_result carries source_metadata", () => {
    const violations: Violation[] = []
    for (const { id, data } of models) {
      for (const { result, path } of walkHierarchyResults<HFEvalModelResult>(data, id)) {
        if (!result.source_metadata) {
          violations.push({ fixture: id, path, detail: "missing source_metadata" })
        }
      }
    }
    expect(violations, formatViolations(violations)).toEqual([])
  })

  it("every source_metadata.evaluator_relationship is in the known set", () => {
    const violations: Violation[] = []
    for (const { id, data } of models) {
      for (const { result, path } of walkHierarchyResults<HFEvalModelResult>(data, id)) {
        const rel = result.source_metadata?.evaluator_relationship
        if (rel != null && !VALID_EVALUATOR_RELATIONSHIPS.has(rel)) {
          violations.push({ fixture: id, path, detail: `unknown evaluator_relationship=${rel}` })
        }
      }
    }
    expect(violations, formatViolations(violations)).toEqual([])
  })

  it("every hierarchy_by_category key is in PIPELINE_CATEGORY_MAP", () => {
    const violations: Violation[] = []
    for (const { id, data } of models) {
      for (const key of Object.keys(data.hierarchy_by_category ?? {})) {
        if (!KNOWN_PIPELINE_CATEGORY_KEYS.has(key.toLowerCase())) {
          violations.push({ fixture: id, path: `hierarchy_by_category.${key}`, detail: "unknown category key" })
        }
      }
    }
    expect(violations, formatViolations(violations)).toEqual([])
  })

  it("every model_result.retrieved_timestamp parses as a valid Date", () => {
    const violations: Violation[] = []
    for (const { id, data } of models) {
      for (const { result, path } of walkHierarchyResults<HFEvalModelResult>(data, id)) {
        const ts = result.retrieved_timestamp
        if (ts == null) continue
        // Pipeline emits either ISO strings or unix-seconds-as-string.
        const numeric = Number.parseFloat(ts)
        const isNumeric = Number.isFinite(numeric) && !ts.includes("-")
        const dateValue = isNumeric ? new Date(numeric * 1000) : new Date(ts)
        if (Number.isNaN(dateValue.getTime())) {
          violations.push({ fixture: id, path: `${path}.retrieved_timestamp`, detail: `unparseable: ${ts}` })
        }
      }
    }
    expect(violations, formatViolations(violations)).toEqual([])
  })

  it("model card has model_group_id matching pipelineSlugify(model_group_id) → model_route_id", () => {
    const violations: Violation[] = []
    for (const { id, data } of models) {
      if (!data.model_group_id) {
        violations.push({ fixture: id, path: "model_group_id", detail: "missing" })
        continue
      }
      const expected = data.model_group_id.replace(/\//g, "__")
      if (data.model_route_id !== expected) {
        violations.push({
          fixture: id,
          path: "model_route_id",
          detail: `${data.model_route_id} !== ${expected} (derived from ${data.model_group_id})`,
        })
      }
    }
    expect(violations, formatViolations(violations)).toEqual([])
  })

})

describe("Tier A — pipeline contracts (eval-detail files)", () => {
  const evals = loadAllFixtures<HFEvalDetail>("evals")

  it("every eval-detail carries a nullable dataset-relative benchmark card source path", () => {
    const violations: Violation[] = []
    for (const { id, data } of evals) {
      const sourcePath = data.benchmark_card_source_path
      if (sourcePath !== null && (typeof sourcePath !== "string" || !/^cards\/[^/]+\.json$/.test(sourcePath))) {
        violations.push({ fixture: id, path: "benchmark_card_source_path", detail: `invalid path: ${sourcePath}` })
      }
      if (sourcePath != null && !data.benchmark_card) {
        violations.push({ fixture: id, path: "benchmark_card_source_path", detail: "path without a card" })
      }
    }
    expect(violations, formatViolations(violations)).toEqual([])
    expect(evals.some(({ data }) => data.benchmark_card_source_path != null)).toBe(true)
    expect(evals.some(({ data }) => data.benchmark_card_source_path === null)).toBe(true)
  })

  it("every eval-detail has eval_summary_id, benchmark, benchmark_leaf_name", () => {
    const violations: Violation[] = []
    for (const { id, data } of evals) {
      for (const field of ["eval_summary_id", "benchmark", "benchmark_leaf_name"] as const) {
        if (!data[field]) {
          violations.push({ fixture: id, path: field, detail: "missing or empty" })
        }
      }
    }
    expect(violations, formatViolations(violations)).toEqual([])
  })

  it("every eval-detail has category as a non-empty string", () => {
    const violations: Violation[] = []
    for (const { id, data } of evals) {
      if (typeof data.category !== "string" || data.category.length === 0) {
        violations.push({ fixture: id, path: "category", detail: `not a non-empty string: ${data.category}` })
      }
    }
    expect(violations, formatViolations(violations)).toEqual([])
  })

  it("every model_result in eval-detail metrics carries source_metadata", () => {
    const violations: Violation[] = []
    for (const { id, data } of evals) {
      for (const [metricIdx, metric] of (data.metrics ?? []).entries()) {
        for (const [resultIdx, mr] of (metric.model_results ?? []).entries()) {
          if (!mr.source_metadata) {
            violations.push({
              fixture: id,
              path: `metrics[${metricIdx}].model_results[${resultIdx}]`,
              detail: "missing source_metadata",
            })
          }
        }
      }
    }
    expect(violations, formatViolations(violations)).toEqual([])
  })

  it("every metric has metric_summary_id and metric_name", () => {
    const violations: Violation[] = []
    for (const { id, data } of evals) {
      for (const [metricIdx, metric] of (data.metrics ?? []).entries()) {
        if (!metric.metric_summary_id) {
          violations.push({ fixture: id, path: `metrics[${metricIdx}].metric_summary_id`, detail: "missing" })
        }
        if (!metric.metric_name) {
          violations.push({ fixture: id, path: `metrics[${metricIdx}].metric_name`, detail: "missing" })
        }
      }
    }
    expect(violations, formatViolations(violations)).toEqual([])
  })

  // Guards against the eval-list emitting display strings in a
  // "<generic-metric> on <benchmark>" / "for scorer" / "model_graded" shape.
  // If the pipeline starts emitting those shapes, this test fails loudly.
  // The four fields below mirror the eval-list resolution order
  // (`evaluation_name || display_name || benchmark_leaf_name || eval_summary_id`).
  it("eval-list display strings don't match generic-metric-on-benchmark patterns", () => {
    const violations: Violation[] = []
    for (const { id, data } of evals) {
      // Pipeline emits `evaluation_name` and `display_name` on eval entries
      // even though they're not on HFEvalDetail (TS type is a subset of the
      // actual cache shape). Cast to access them.
      const extras = data as unknown as { evaluation_name?: string; display_name?: string }
      const raw =
        extras.evaluation_name ||
        extras.display_name ||
        data.benchmark_leaf_name ||
        data.eval_summary_id ||
        ""
      const normalized = raw.trim().toLowerCase()
      const reasons: string[] = []
      if (normalized.startsWith("accuracy on ")) reasons.push("startsWith('accuracy on ')")
      if (normalized.startsWith("score on ")) reasons.push("startsWith('score on ')")
      if (normalized.includes("for scorer")) reasons.push("includes('for scorer')")
      if (normalized.includes("model_graded")) reasons.push("includes('model_graded')")
      if (reasons.length > 0) {
        violations.push({
          fixture: id,
          path: "evaluation_name|display_name|benchmark_leaf_name|eval_summary_id",
          detail: `${JSON.stringify(raw)} matches: ${reasons.join(", ")}`,
        })
      }
    }
    expect(violations, formatViolations(violations)).toEqual([])
  })
})

// Tier A — judge-condition view-column contracts.
//
// The producer now emits NULLABLE divergence booleans plus a
// comparability_status, and the view's metric_id is the RENAMED (effective)
// identity with the source's own channel name carried separately as
// metric_source_label. These assert the consumer honours both: a NULL flag
// never reads as "checked, no divergence", and a display label never
// becomes the metric identity.
describe("Tier A — pipeline contracts (judge-condition view columns)", () => {
  const divergence = (has: boolean | null) => ({
    has_variant_divergence: has,
    group_id: "g1",
    divergence_magnitude: 0.02,
    threshold_used: 0.05,
    threshold_basis: "fallback_default" as const,
    differing_setup_fields: [],
    scores_in_group: [0.8, 0.82],
    this_triple_score: 0.8,
    triple_count_in_group: 2,
    score_scale_anomaly: false,
    group_variant_breakdown: [],
    signal_version: "1.0",
  })
  const annotations = (has: boolean | null, status?: ComparabilityStatus): RowAnnotations => ({
    reproducibility_gap: null,
    provenance: null,
    variant_divergence: divergence(has),
    cross_party_divergence: null,
    comparability_status: status ?? null,
  })

  it("treats a NULL divergence flag as not assessable, never as false", () => {
    expect(isNotAssessable(annotations(null))).toBe(true)
    expect(isNotAssessable(annotations(false, "mixed_scale"))).toBe(true)
    expect(isNotAssessable(annotations(false, "no_bounds"))).toBe(true)
    // An assessed group with no divergence stays silent, as before.
    expect(isNotAssessable(annotations(false, "ok"))).toBe(false)
    expect(isNotAssessable(annotations(true, "ok"))).toBe(false)
    expect(isNotAssessable(null)).toBe(false)
  })

  it("reads the row's flat comparability_status when the annotation block has none", () => {
    expect(isNotAssessable(annotations(false), "mixed_scale")).toBe(true)
    expect(isNotAssessable(annotations(false), "ok")).toBe(false)
  })

  it("does not call a row not assessable when the snapshot never declared a verdict", () => {
    // The pre-judge warehouse struct has no verdict field at all and the
    // snapshot has no comparability_status. Reading that absence as
    // "not assessable" put the chip on every annotated row of every older
    // snapshot; its flat FALSE means "checked, no divergence".
    const olderShape = {
      reproducibility_gap: null,
      provenance: null,
      variant_divergence: {
        divergence_magnitude: 0.02,
        threshold_used: 0.05,
        differing_setup_fields: [],
      },
      cross_party_divergence: null,
    } as unknown as RowAnnotations
    expect(isNotAssessable(olderShape)).toBe(false)

    const olderShapeWithFlatFalse = {
      ...olderShape,
      variant_divergence: {
        ...(olderShape.variant_divergence as object),
        has_variant_divergence: false,
      },
    } as unknown as RowAnnotations
    expect(isNotAssessable(olderShapeWithFlatFalse)).toBe(false)

    // The status is the producer's own answer and outranks a NULL flag in
    // both directions.
    expect(isNotAssessable(annotations(null), "ok")).toBe(false)
    expect(isNotAssessable(olderShape, "mixed_scale")).toBe(true)
  })

  it("parses judge_condition into judges + source label, tolerating absence", () => {
    expect(parseJudgeCondition('{"judges":["openai/gpt-4o"],"label":"gpt_score"}')).toEqual({
      judges: ["openai/gpt-4o"],
      label: "gpt_score",
    })
    // NULL means the source disclosed no judge — never "no judge".
    expect(parseJudgeCondition(null)).toBeNull()
    expect(parseJudgeCondition("not json")).toBeNull()
  })

  it("trims, drops and dedupes judge ids so the panel size is the real one", () => {
    // A blank id would render "judged by " and a repeat would claim a
    // three-judge panel where two models graded.
    expect(
      parseJudgeCondition(
        '{"judges":[" openai/gpt-4o ","openai/gpt-4o","","   ",null,7],"label":" gpt_score "}',
      ),
    ).toEqual({ judges: ["openai/gpt-4o"], label: "gpt_score" })

    // A null / blank label is not a label.
    expect(parseJudgeCondition('{"judges":["openai/gpt-4o"],"label":null}')).toEqual({
      judges: ["openai/gpt-4o"],
      label: null,
    })
    expect(parseJudgeCondition('{"judges":["openai/gpt-4o"],"label":"   "}')).toEqual({
      judges: ["openai/gpt-4o"],
      label: null,
    })

    // Nothing left after the cleanup, and no label: not a judged row.
    expect(parseJudgeCondition('{"judges":["  ",""],"label":null}')).toBeNull()
    expect(parseJudgeCondition('{"judges":[]}')).toBeNull()
    expect(parseJudgeCondition('{"judges":"openai/gpt-4o"}')).toBeNull()
    expect(parseJudgeCondition('["openai/gpt-4o"]')).toBeNull()
  })

  it("summarises a judge condition with its raw ids alongside the display names", () => {
    const names: Record<string, string> = { "openai/gpt-4o-2024-05-13": "GPT-4o" }
    const displayName = (id: string) => names[id] ?? id

    // Two dated variants that folded into one survivor render the same
    // name, so the raw id has to travel with it.
    expect(
      judgeConditionSummary(
        '{"judges":["openai/gpt-4o-2024-05-13"],"label":"gpt_score"}',
        displayName,
      ),
    ).toEqual({
      label: "judged by GPT-4o",
      names: ["GPT-4o"],
      judges: ["openai/gpt-4o-2024-05-13"],
    })

    expect(
      judgeConditionSummary(
        '{"judges":["openai/gpt-4o-2024-05-13","meta/llama-4","meta/llama-4"],"label":"score"}',
        displayName,
      ),
    ).toMatchObject({ label: "mean of 2 judges" })

    // A label with no judges names nobody.
    expect(judgeConditionSummary('{"judges":[],"label":"score"}', displayName)).toBeNull()
    expect(judgeConditionSummary(null, displayName)).toBeNull()
  })

  it("carries a matrix cell's judge panel and the readings its pick left out", () => {
    const names: Record<string, string> = {
      "openai/gpt-4o-2024-05-13": "GPT-4o",
      "meta/llama-3.1-405b-instruct-turbo": "Llama 3.1 405B",
    }
    const displayName = (id: string) => names[id] ?? id
    const format = (score: number) => score.toFixed(2)
    const gpt = '{"judges":["openai/gpt-4o-2024-05-13"],"label":"safety_gpt_score"}'
    const llama =
      '{"judges":["meta/llama-3.1-405b-instruct-turbo"],"label":"safety_llama_score"}'

    // The cell shows the headline reading; the losing panel and its number
    // have nowhere to go but the tooltip.
    expect(
      judgeCellSummary(gpt, [{ judge_condition: llama, score: 0.21 }], displayName, format),
    ).toEqual({
      label: "judged by GPT-4o",
      tooltip:
        "Judge model id: openai/gpt-4o-2024-05-13\n"
        + "Other judge readings, not ranked:\n"
        + "judged by Llama 3.1 405B: 0.21",
    })

    // An alternate with no number is still named rather than dropped.
    expect(
      judgeCellSummary(gpt, [{ judge_condition: llama, score: null }], displayName, format)
        ?.tooltip,
    ).toContain("judged by Llama 3.1 405B: —")

    // Headline pick with an undisclosed judge, alternates disclosed: say so.
    expect(
      judgeCellSummary(null, [{ judge_condition: llama, score: 0.21 }], displayName, format),
    ).toMatchObject({ label: "1 other judge reading" })

    // Nothing named a judge.
    expect(judgeCellSummary(null, [], displayName, format)).toBeNull()
    expect(judgeCellSummary(undefined, undefined, displayName, format)).toBeNull()
  })

  it("picks the matrix's ranking column from the eval's declared primary metric", () => {
    const metrics = [
      { column_key: "attack-success-rate", metric_id: "attack-success-rate", scope: "root" },
      {
        column_key: "harmbench-refusal-score",
        metric_id: "harmbench-refusal-score",
        scope: "root",
      },
      { column_key: "score::gaming", metric_id: "score", scope: "subtask" },
    ]

    expect(primaryMetricColumnKey(metrics, "harmbench-refusal-score")).toBe(
      "harmbench-refusal-score",
    )
    // No declared primary, or one no column carries: the first root metric.
    expect(primaryMetricColumnKey(metrics, undefined)).toBe("attack-success-rate")
    expect(primaryMetricColumnKey(metrics, "not-a-metric")).toBe("attack-success-rate")
    // A subtask column never becomes the ranking column.
    expect(primaryMetricColumnKey(metrics, "score")).toBe("attack-success-rate")
    expect(primaryMetricColumnKey([], "score")).toBeUndefined()
    expect(primaryMetricColumnKey(undefined, undefined)).toBeUndefined()
  })

  it("builds composite matrix cells from headline rows only", () => {
    const row = (name: string, score: number, headline: boolean) =>
      ({
        model_info: { id: "org/model-a", name, developer: "Org" },
        score,
        is_headline: headline,
      }) as unknown as import("../lib/eval-processing").ModelResultForBenchmark

    const models = compositeScoresByModel([
      {
        evaluation_name: "Sub A",
        // The data query orders headline first, so a later judge arm is
        // exactly what used to overwrite the model's summary reading.
        model_results: [row("Model A", 0.8, true), row("Model A", 0.99, false)],
      },
      { evaluation_name: "Sub B", model_results: [row("Model A", 0.6, true)] },
    ])

    expect([...models.get("org/model-a")!.scores.entries()]).toEqual([
      ["Sub A", 0.8],
      ["Sub B", 0.6],
    ])
  })

  it("groups a model's secondary readings under its headline row for sorting", () => {
    const row = (id: string, headline: boolean, tag: string) => ({
      tag,
      result: { model_route_id: id, model_info: { id, name: id }, is_headline: headline },
    })
    const rows = [
      row("a", true, "a-headline"),
      row("a", false, "a-judge-1"),
      row("a", false, "a-judge-2"),
      row("b", true, "b-headline"),
      row("b", false, "b-judge"),
      // Its model has no headline row on this page at all.
      row("c", false, "c-orphan"),
    ]
    const groups = groupByHeadlineModel(rows, (r) => r.result)
    expect(groups.map((g) => g.map((r) => r.tag))).toEqual([
      ["a-headline", "a-judge-1", "a-judge-2"],
      ["b-headline", "b-judge"],
      ["c-orphan"],
    ])

    // Whatever order the groups end up in, a secondary row never floats
    // above its own headline. Reversing the FLAT row list instead of the
    // groups is what breaks that.
    const reversed = [...groups].reverse().flat().map((r) => r.tag)
    expect(reversed).toEqual([
      "c-orphan",
      "b-headline",
      "b-judge",
      "a-headline",
      "a-judge-1",
      "a-judge-2",
    ])
  })

  it("keeps the renamed metric_id as the identity and metric_source_label as display", () => {
    // The page's metric is the view's (renamed) metric_id — wb-score, not
    // the source's own gpt_score channel name.
    const merged: MergedBenchmarkSummary = {
      merged: true,
      evaluation_id: "wildbench",
      benchmark_id: "wildbench",
      display_name: "WildBench",
      grain: "benchmark",
      preferred_metric_id: "wb-score",
      preferred_metric_display_name: "WildBench score",
      preferred_from_registry: true,
      lower_is_better: false,
      sources_count: 1,
      all_sources_count: 1,
      results_count: 1,
      models_count: 1,
      best_result: null,
      aggregate_sources: [],
      metrics: [
        {
          metric_id: "wb-score",
          display_name: "WildBench score",
          results_count: 1,
          models_count: 1,
          sources_count: 1,
          lower_is_better: false,
        },
      ],
      slices: null,
      selected_metric_id: "wb-score",
      selected_lower_is_better: false,
      selected_slice_id: null,
      results: [
        {
          model_info: { name: "Model A", id: "org/model-a" },
          evaluation_id: "openeval%2Fwildbench",
          composite_slug: "openeval",
          score: 0.8,
          score_canonical: 0.8,
          scale_conversion: "curated",
          evaluation_timestamp: "2026-01-01T00:00:00Z",
          source_metadata: {
            source_name: "OpenEval",
            source_type: "leaderboard",
            source_organization_name: "OpenEval",
            evaluator_relationship: "third_party",
          },
          is_headline: true,
          metric_source_label: "gpt_score",
        },
      ],
    }
    const adapted = mergedSummaryToEvalSummary(merged)
    expect(adapted.leaderboard_metrics?.[0].column_key).toBe("wb-score")
    expect(adapted.model_results[0].result.metric_key).toBe("wb-score")
  })
})

describe("Tier A — fixture inventory", () => {
  // Catches both directions: (a) a fixture file exists that isn't in the
  // manifest (stale/unreferenced and won't be exercised by snapshot tests),
  // (b) a manifest entry references a missing file. The "manifest entry
  // resolves to a readable file" check from earlier was redundant with the
  // 14 contract tests above (which all call loadAllFixtures at module
  // scope), but the file→manifest direction was uncovered.
  it("fixture files match the manifest exactly (no orphans, no missing)", () => {
    const groupsAndDirs = [
      ["evals", "evals"],
      ["models", "models"],
      ["developers", "developers"],
      ["model_cards", "model-cards"],
    ] as const
    const orphans: string[] = []
    const missing: string[] = []
    for (const [group, dirName] of groupsAndDirs) {
      const dir = path.join(FIXTURES_DIR, dirName)
      const onDisk = new Set(readdirSync(dir).filter((f) => f.endsWith(".json")))
      const inManifest = new Set(fixtureEntries(group).map((e) => `${e.id}.json`))
      for (const f of onDisk) if (!inManifest.has(f)) orphans.push(`${group}/${f}`)
      for (const f of inManifest) if (!onDisk.has(f)) missing.push(`${group}/${f}`)
    }
    expect({ orphans, missing }).toEqual({ orphans: [], missing: [] })
  })
})

function formatViolations(violations: Violation[]): string {
  if (violations.length === 0) return ""
  const sample = violations.slice(0, 10)
  const more = violations.length > 10 ? `\n  …and ${violations.length - 10} more` : ""
  return [
    `\n${violations.length} contract violation(s):`,
    ...sample.map((v) => `  ${v.fixture} :: ${v.path} — ${v.detail}`),
    more,
  ].join("\n")
}
