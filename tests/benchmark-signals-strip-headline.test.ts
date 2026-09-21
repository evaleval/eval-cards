import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import { BenchmarkSignalsStrip } from "@/components/signals/benchmark-signals-strip"
import type { BenchmarkEvalSummary, ModelResultForBenchmark } from "@/lib/eval-processing"

// The strip's percentages are page-level statistics over the benchmark's
// results. A model's judge panels are extra READINGS of that model, not
// extra results: counting them moves a page's reproducibility and
// provenance numbers the moment a source discloses a second judge.

function result(overrides: Partial<ModelResultForBenchmark>): ModelResultForBenchmark {
  const score = overrides.score ?? 0.8
  return {
    model_info: { name: "Model A", id: "org/model-a" },
    model_route_id: "org%2Fmodel-a",
    score,
    score_details: { score },
    evaluation_timestamp: "2026-01-01T00:00:00Z",
    source_metadata: {
      source_name: "OpenEval",
      source_type: "leaderboard",
      source_organization_name: "OpenEval",
      evaluator_relationship: "third_party",
    },
    source_data: { dataset_name: "Bench" },
    result: {
      evaluation_name: "Score",
      evaluation_timestamp: "2026-01-01T00:00:00Z",
      metric_config: {
        evaluation_description: "Score",
        lower_is_better: false,
        score_type: "continuous",
      },
      score_details: { score },
      generation_config: {
        generation_args: { temperature: 0.2, max_tokens: 4096 },
      },
    },
    ...overrides,
  }
}

function summaryWith(modelResults: ModelResultForBenchmark[]): BenchmarkEvalSummary {
  return {
    evaluation_id: "openeval%2Fwildbench",
    evaluation_name: "WildBench",
    composite_benchmark_key: "openeval",
    composite_benchmark_name: "OpenEval",
    metric_config: {
      evaluation_description: "WildBench score",
      lower_is_better: false,
      score_type: "continuous",
    },
    model_results: modelResults,
    models_count: 1,
    evaluator_names: ["OpenEval"],
    source_types: [],
    third_party_ratio: 1,
    missing_generation_config_count: 0,
    best_model: { name: "Model A", score: 0.8 },
    worst_model: null,
    avg_score: 0.8,
    avg_score_norm: 0.8,
  } as BenchmarkEvalSummary
}

function render(summary: BenchmarkEvalSummary): string {
  return renderToStaticMarkup(
    createElement(
      AudienceModeProvider,
      null,
      createElement(BenchmarkSignalsStrip, { summary }),
    ),
  )
}

// One headline reading with a complete setup, plus two judge readings that
// document nothing. Only the headline row is the benchmark's result.
const HEADLINE = result({ is_headline: true })
const JUDGE_ROWS = [
  result({
    score: 0.82,
    is_headline: false,
    judge_condition: JSON.stringify({ judges: ["openai/gpt-4o"], label: "gpt_score" }),
    result: {
      evaluation_name: "Score",
      evaluation_timestamp: "2026-01-01T00:00:00Z",
      metric_config: {
        evaluation_description: "Score",
        lower_is_better: false,
        score_type: "continuous",
      },
      score_details: { score: 0.82 },
    },
  }),
  result({
    score: 0.79,
    is_headline: false,
    judge_condition: JSON.stringify({ judges: ["meta/llama-4"], label: "llama_score" }),
    result: {
      evaluation_name: "Score",
      evaluation_timestamp: "2026-01-01T00:00:00Z",
      metric_config: {
        evaluation_description: "Score",
        lower_is_better: false,
        score_type: "continuous",
      },
      score_details: { score: 0.79 },
    },
  }),
]

describe("BenchmarkSignalsStrip — headline-only aggregates", () => {
  it("counts one result per model, not one per judge reading", () => {
    const withJudges = render(summaryWith([HEADLINE, ...JUDGE_ROWS]))
    const headlineOnly = render(summaryWith([HEADLINE]))

    // The judge rows must not change any page-level number.
    expect(withJudges).toEqual(headlineOnly)
    // The fixture discloses temperature and max_tokens, which the OLD rule
    // called a complete setup because those were the only two questions it
    // asked. Under the slot rule it still has to say which harness produced
    // the run, which version of it, and over how many items — so "complete"
    // is no longer the right word for it.
    expect(withJudges).toContain("2 of 5 applicable setup questions are answered.")
    // The old behaviour read "1 of 3 triples document the full setup."
    expect(withJudges).not.toContain("of 3 triples")
  })
})
