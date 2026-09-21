import { describe, expect, it } from "vitest"

import { mergedSummaryToEvalSummary } from "@/lib/merged-adapter"
import {
  evaluateReproducibilitySlots,
  evidenceFromResult,
} from "@/lib/reproducibility-slots"
import type {
  MergedBenchmarkSummary,
  MergedObservationRow,
} from "@/lib/eval-processing"
import type { SourceMetadata } from "@/lib/benchmark-schema"

// The merged page mounts the full EvalDetail component on the adapted
// payload, so these assertions pin the parts EvalDetail actually renders:
// pooled observation rows (echoes intact), per-row source attribution,
// the single-column leaderboard matrix, and inferred canonical-scale
// bounds for score-bar normalisation.

function sourceMeta(name: string): SourceMetadata {
  return {
    source_name: name,
    source_type: "leaderboard",
    source_organization_name: name,
    evaluator_relationship: "third_party",
  }
}

function row(overrides: Partial<MergedObservationRow>): MergedObservationRow {
  return {
    model_info: { name: "Model A", id: "org/model-a" },
    model_route_id: "org%2Fmodel-a",
    evaluation_id: "src-a%2Fbench",
    composite_slug: "src-a",
    composite_display_name: "Source A",
    score: 50,
    score_canonical: 50,
    scale_conversion: "none",
    evaluation_timestamp: "2026-01-01T00:00:00Z",
    source_metadata: sourceMeta("Source A"),
    ...overrides,
  }
}

function mergedPayload(results: MergedObservationRow[]): MergedBenchmarkSummary {
  return {
    merged: true,
    evaluation_id: "bench",
    benchmark_id: "bench",
    display_name: "Bench",
    grain: "benchmark",
    preferred_metric_id: "accuracy",
    preferred_metric_display_name: "Accuracy",
    preferred_from_registry: true,
    lower_is_better: false,
    sources_count: 2,
    all_sources_count: 2,
    results_count: results.length,
    models_count: 2,
    best_result: null,
    aggregate_sources: [
      {
        evaluation_id: "src-a%2Fbench",
        composite_slug: "src-a",
        composite_display_name: "Source A",
        models_count: 2,
        results_count: 2,
        reports_preferred: true,
        slice_only: false,
      },
      {
        evaluation_id: "src-b%2Fbench",
        composite_slug: "src-b",
        composite_display_name: "Source B",
        models_count: 1,
        results_count: 1,
        reports_preferred: true,
        slice_only: false,
      },
    ],
    metrics: [
      {
        metric_id: "accuracy",
        display_name: "Accuracy",
        results_count: results.length,
        models_count: 2,
        sources_count: 2,
        lower_is_better: false,
      },
    ],
    slices: null,
    selected_metric_id: "accuracy",
    selected_lower_is_better: false,
    selected_slice_id: null,
    results,
  }
}

describe("mergedSummaryToEvalSummary — EvalDetail surface", () => {
  it("pools all sources' rows, keeps echo republications, and attributes each row to its own source", () => {
    const results = [
      row({ score: 91.2, score_canonical: 91.2 }),
      // Echo of the same model republished by another source — must stay.
      row({
        evaluation_id: "src-b%2Fbench",
        composite_slug: "src-b",
        composite_display_name: "Source B",
        score: 91.2,
        score_canonical: 91.2,
        source_metadata: sourceMeta("Source B"),
      }),
      row({
        model_info: { name: "Model B", id: "org/model-b" },
        model_route_id: "org%2Fmodel-b",
        score: 55.5,
        score_canonical: 55.5,
      }),
    ]
    const adapted = mergedSummaryToEvalSummary(mergedPayload(results))

    expect(adapted.evaluation_name).toBe("Bench")
    expect(adapted.model_results).toHaveLength(3)
    // Per-row attribution: each observation carries ITS source, not a
    // single global one.
    expect(adapted.model_results.map((r) => r.source_metadata.source_name)).toEqual([
      "Source A",
      "Source B",
      "Source A",
    ])
    // ?source= pre-highlight hook.
    expect(adapted.model_results.map((r) => r.merged_source_slug)).toEqual([
      "src-a",
      "src-b",
      "src-a",
    ])
    // Single-column leaderboard matrix keyed by the selected metric.
    expect(adapted.leaderboard_metrics).toHaveLength(1)
    expect(adapted.leaderboard_metrics?.[0].column_key).toBe("accuracy")
    expect(adapted.leaderboard_rows?.map((r) => r.values.accuracy)).toEqual([91.2, 91.2, 55.5])
    // Reporting orgs, from the rows. A source's composite display name is
    // the title of a leaderboard or a paper, not an organisation.
    expect(adapted.evaluator_names).toEqual(["Source A", "Source B"])
    // Collection-page gate (spec requirement 8): the adapter must never
    // set the per-source-only `collection` attachment — it is what keeps
    // the Compute chip and trajectory panels off merged pages.
    expect("collection" in adapted).toBe(false)
    expect(adapted.collection).toBeUndefined()
  })

  it("never lets a study title into an evaluator field", () => {
    // The bug this pins: a composite's display name is the study's title
    // ("How Inference Compute Shapes Frontier LLM Evaluation"), and
    // reading it as an evaluator both misattributes the work and links a
    // title to an evaluator page that does not exist.
    const payload = mergedPayload([
      row({
        composite_slug: "aisi-inference-scaling",
        composite_display_name: "How Inference Compute Shapes Frontier LLM Evaluation",
        evaluator_display_name: "UK AI Security Institute",
        is_verified_evaluator: true,
        collection_id: "uk-aisi-inference-scaling",
        source_metadata: sourceMeta("UK AI Security Institute"),
      }),
    ])
    payload.aggregate_sources = [
      {
        evaluation_id: "aisi-inference-scaling%2Fcyber-ctfs",
        composite_slug: "aisi-inference-scaling",
        composite_display_name: "How Inference Compute Shapes Frontier LLM Evaluation",
        models_count: 1,
        results_count: 1,
        reports_preferred: true,
        slice_only: false,
      },
    ]
    payload.collections = {
      "uk-aisi-inference-scaling": {
        curated: true,
        display_name: "How Inference Compute Shapes Frontier LLM Evaluation",
        kind: "paper_study",
        url: "https://arxiv.org/abs/2606.17930",
        protocol_axes: [
          { key: "token_limit", type: "int", unit: "tokens" },
          { key: "reasoning_tokens", type: "int", unit: "tokens" },
        ],
      },
    }

    const adapted = mergedSummaryToEvalSummary(payload)

    expect(adapted.evaluator_names).toEqual(["UK AI Security Institute"])
    expect(adapted.verified_evaluator_names).toEqual(["UK AI Security Institute"])
    for (const name of [
      ...adapted.evaluator_names,
      ...(adapted.verified_evaluator_names ?? []),
    ]) {
      expect(name).not.toBe("How Inference Compute Shapes Frontier LLM Evaluation")
    }
    // The study is what the results are PART OF, carried separately so it
    // can be named without turning on the study-only panels.
    expect(adapted.study_refs).toEqual([
      {
        collection_id: "uk-aisi-inference-scaling",
        name: "How Inference Compute Shapes Frontier LLM Evaluation",
        url: "https://arxiv.org/abs/2606.17930",
        // The family the study's own rows sit under, which is what makes
        // the study's name a way back to its other benchmarks.
        family_key: "aisi-inference-scaling",
      },
    ])
    expect(adapted.collection).toBeUndefined()
    // Axis descriptors survive so merged token values get their unit.
    expect(
      adapted.protocol_axes_by_collection?.["uk-aisi-inference-scaling"]?.map((a) => a.key),
    ).toEqual(["token_limit", "reasoning_tokens"])
  })

  it("keeps each row's own upstream provenance", () => {
    // Two sources of one benchmark are two datasets: replacing both with
    // the benchmark's name throws away the repo, url and sample count the
    // fact row already carried.
    const adapted = mergedSummaryToEvalSummary(
      mergedPayload([
        row({
          source_data: { dataset_name: "MMLU-Pro", hf_repo: "TIGER-Lab/MMLU-Pro", samples_number: 12032 },
        }),
        row({
          composite_slug: "src-b",
          source_metadata: sourceMeta("Source B"),
          source_data: { dataset_name: "MMLU-Pro (mirror)", hf_repo: "other/mmlu-pro" },
        }),
        row({ model_info: { name: "Model C", id: "org/model-c" } }),
      ]),
    )
    const sourceData = adapted.model_results.map((result) => result.source_data)
    expect(sourceData[0]).toEqual({
      dataset_name: "MMLU-Pro",
      hf_repo: "TIGER-Lab/MMLU-Pro",
      samples_number: 12032,
    })
    expect(sourceData[1]).toEqual({
      dataset_name: "MMLU-Pro (mirror)",
      hf_repo: "other/mmlu-pro",
    })
    // A row that carries none still names the benchmark.
    expect(sourceData[2]).toEqual({ dataset_name: "Bench" })
    expect(adapted.leaderboard_rows?.[0].source_data).toEqual(sourceData[0])
    expect(adapted.model_results[0].result.source_data).toEqual(sourceData[0])
  })

  it("prefers a source organisation over a whitespace-only evaluator name", () => {
    const adapted = mergedSummaryToEvalSummary(
      mergedPayload([
        row({
          evaluator_display_name: "   ",
          source_metadata: sourceMeta("Papers with Code"),
        }),
      ]),
    )
    expect(adapted.evaluator_names).toEqual(["Papers with Code"])
  })

  it("orders reporters the same way whatever order the rows arrive in", () => {
    // Equal scores for one model have no source tie-break in the query,
    // so row order alone is not stable, and the hero shows only the first
    // two names.
    const make = (name: string) =>
      row({ composite_slug: name, source_metadata: sourceMeta(name), evaluator_display_name: name })
    const forward = [make("BenchPress"), make("TIGER-Lab"), make("TIGER-Lab")]
    const reversed = [make("TIGER-Lab"), make("BenchPress"), make("TIGER-Lab")]
    const names = (rows: MergedObservationRow[]) =>
      mergedSummaryToEvalSummary(mergedPayload(rows)).evaluator_names
    // Most-reported first, so the two the hero shows are the main ones.
    expect(names(forward)).toEqual(["TIGER-Lab", "BenchPress"])
    expect(names(reversed)).toEqual(names(forward))
  })

  it("names no reporter when the visible rows carry no organisation", () => {
    const adapted = mergedSummaryToEvalSummary(
      mergedPayload([
        row({
          evaluator_display_name: undefined,
          source_metadata: {
            source_name: undefined,
            source_type: "leaderboard",
            source_organization_name: "",
            evaluator_relationship: "third_party",
          } as SourceMetadata,
        }),
      ]),
    )
    expect(adapted.evaluator_names).toEqual([])
  })

  it("verifies only the orgs whose own rows are verified", () => {
    const adapted = mergedSummaryToEvalSummary(
      mergedPayload([
        row({ evaluator_display_name: "Source A", is_verified_evaluator: true }),
        row({
          composite_slug: "src-b",
          evaluator_display_name: "Source B",
          is_verified_evaluator: false,
          source_metadata: sourceMeta("Source B"),
        }),
      ]),
    )
    expect(adapted.evaluator_names).toEqual(["Source A", "Source B"])
    expect(adapted.verified_evaluator_names).toEqual(["Source A"])
  })

  it("names no study when the rows' collections are not curated", () => {
    const payload = mergedPayload([row({ collection_id: "crfm/helm-lite" })])
    const adapted = mergedSummaryToEvalSummary(payload)
    expect(adapted.study_refs).toBeUndefined()
    expect(adapted.protocol_axes_by_collection).toBeUndefined()
  })

  it("excludes flagged rows (null score_canonical) from the pool entirely", () => {
    // A raw unconverted 7.5 must never be pooled with canonical 0-1
    // scores — it would fake a #1 rank and poison the bounds inference.
    const results = [
      row({ score: 0.8, score_canonical: 0.8 }),
      row({ score: 7.5, score_canonical: null, scale_conversion: "flagged" }),
    ]
    const adapted = mergedSummaryToEvalSummary(mergedPayload(results))
    expect(adapted.model_results.map((r) => r.score)).toEqual([0.8])
    expect(adapted.leaderboard_rows).toHaveLength(1)
    expect(adapted.avg_score).toBeCloseTo(0.8)
    expect(adapted.metric_config.max_score).toBe(1)
  })

  it("keeps assisted study rows out of the default merged pool", () => {
    const assistedCondition = JSON.stringify({
      feedback: "answer_feedback",
      token_limit: 5_000_000,
    })
    const results = [
      row({
        model_info: { name: "Assisted Model", id: "org/assisted" },
        model_route_id: "org%2Fassisted",
        score: 0.99,
        score_canonical: 0.99,
        protocol_condition: assistedCondition,
      }),
      row({ score: 0.8, score_canonical: 0.8 }),
      row({
        model_info: { name: "Model B", id: "org/model-b" },
        model_route_id: "org%2Fmodel-b",
        score: 0.7,
        score_canonical: 0.7,
        protocol_condition: JSON.stringify({ feedback: "none" }),
      }),
    ]
    const adapted = mergedSummaryToEvalSummary(mergedPayload(results))

    expect(adapted.model_results.map((result) => result.model_info.name)).toEqual([
      "Model A",
      "Model B",
    ])
    expect(adapted.leaderboard_rows?.map((result) => result.values.accuracy)).toEqual([
      0.8,
      0.7,
    ])
    expect(adapted.avg_score).toBeCloseTo(0.75)
    expect(adapted.best_model).toEqual({ name: "Model A", score: 0.8 })
  })

  it("keeps non-headline judge rows out of the merged pool", () => {
    // Three judge readings of one model are three rows on the
    // per-source page, but ONE observation on the merged page.
    const judged = (judge: string, score: number) =>
      row({
        score,
        score_canonical: score,
        is_headline: false,
        judge_condition: JSON.stringify({ judges: [judge], label: `${judge}_score` }),
        metric_source_label: `${judge}_score`,
      })
    const results = [
      row({
        score: 0.8,
        score_canonical: 0.8,
        is_headline: true,
        judge_condition: JSON.stringify({ judges: ["a", "b", "c"], label: "score" }),
      }),
      judged("a", 0.99),
      judged("b", 0.61),
      row({
        model_info: { name: "Model B", id: "org/model-b" },
        model_route_id: "org%2Fmodel-b",
        score: 0.7,
        score_canonical: 0.7,
      }),
    ]
    const adapted = mergedSummaryToEvalSummary(mergedPayload(results))

    expect(adapted.model_results.map((r) => r.score)).toEqual([0.8, 0.7])
    expect(adapted.models_count).toBe(2)
    // The losing judge's 0.99 never becomes the page's best model.
    expect(adapted.best_model).toEqual({ name: "Model A", score: 0.8 })
    expect(adapted.avg_score).toBeCloseTo(0.75)
  })

  it("livebench regression: a flagged raw score above 1 neither ranks nor flips the scale to 0-100", () => {
    // Shape of the live /evals/livebench bug: canonical pool is 0-1 but
    // one flagged row carries a raw 1.4155. Before the fix it ranked #1
    // AND dragged the bounds inference to a bogus 0-100 scale.
    const results = [
      row({
        model_info: { name: "Flagged Model", id: "org/flagged" },
        score: 1.4155,
        score_canonical: null,
        scale_conversion: "flagged",
      }),
      row({ score: 0.85, score_canonical: 0.85 }),
      row({
        model_info: { name: "Model B", id: "org/model-b" },
        score: 0.62,
        score_canonical: 0.62,
      }),
      row({
        model_info: { name: "Model C", id: "org/model-c" },
        score: 0.1,
        score_canonical: 0.1,
      }),
    ]
    const adapted = mergedSummaryToEvalSummary(mergedPayload(results))
    expect(adapted.model_results).toHaveLength(3)
    expect(adapted.model_results.map((r) => r.model_info.name)).not.toContain("Flagged Model")
    expect(adapted.metric_config.min_score).toBe(0)
    expect(adapted.metric_config.max_score).toBe(1)
    // Best model comes from the converted pool, not the flagged raw row.
    expect(adapted.best_model).toEqual({ name: "Model A", score: 0.85 })
  })

  it("infers 0–1 bounds when every pooled score fits the unit scale", () => {
    const adapted = mergedSummaryToEvalSummary(
      mergedPayload([
        row({ score: 0.12, score_canonical: 0.12 }),
        row({ score: 0.9, score_canonical: 0.9 }),
      ]),
    )
    expect(adapted.metric_config.min_score).toBe(0)
    expect(adapted.metric_config.max_score).toBe(1)
  })

  it("carries the harness through, so a source earns the same credit on both pages", () => {
    // The reproducibility slots ask which harness produced the run. A row
    // that answers that on its own source page must answer it here too.
    const adapted = mergedSummaryToEvalSummary(
      mergedPayload([
        row({ eval_library: { name: "lm-evaluation-harness", version: "0.4.5" } }),
        row({
          model_info: { name: "Model B", id: "org/model-b" },
          model_route_id: "org%2Fmodel-b",
          eval_library: {} as MergedObservationRow["eval_library"],
        }),
      ]),
    )
    const [withLibrary, withoutLibrary] = adapted.model_results
    expect(withLibrary.eval_library).toEqual({
      name: "lm-evaluation-harness",
      version: "0.4.5",
    })
    const credited = evaluateReproducibilitySlots(evidenceFromResult(withLibrary))
    expect(credited.slots.find((slot) => slot.id === "harness")?.state).toBe("disclosed")
    expect(credited.slots.find((slot) => slot.id === "harness_pin")?.state).toBe("disclosed")

    // An empty struct names nothing, so it earns nothing.
    const uncredited = evaluateReproducibilitySlots(evidenceFromResult(withoutLibrary))
    expect(uncredited.slots.find((slot) => slot.id === "harness")?.state).toBe("missing")
    expect(uncredited.slots.find((slot) => slot.id === "harness_pin")?.state).toBe("missing")
  })

  it("infers 0–100 bounds for percent-scale scores", () => {
    const adapted = mergedSummaryToEvalSummary(
      mergedPayload([
        row({ score: 12.5, score_canonical: 12.5 }),
        row({ score: 91.4, score_canonical: 91.4 }),
      ]),
    )
    expect(adapted.metric_config.min_score).toBe(0)
    expect(adapted.metric_config.max_score).toBe(100)
  })

  it("falls back to the data range for unbounded scales (e.g. Elo), rounded for display", () => {
    const adapted = mergedSummaryToEvalSummary(
      mergedPayload([
        row({ score: 1024.31, score_canonical: 1024.31 }),
        row({ score: 1619.7821471012762, score_canonical: 1619.7821471012762 }),
      ]),
    )
    expect(adapted.metric_config.min_score).toBe(0)
    expect(adapted.metric_config.max_score).toBe(1620)
  })
})
