import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import { BenchmarkSignalsStrip } from "@/components/signals/benchmark-signals-strip"
import type { BenchmarkEvalSummary, ModelResultForBenchmark } from "@/lib/eval-processing"

function result(name: string, score: number, sampleSize?: number): ModelResultForBenchmark {
  return {
    model_info: { name, id: `org/${name}` },
    model_route_id: `org%2F${name}`,
    score,
    score_details: { score, sample_size: sampleSize },
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
        min_score: 0,
        max_score: 1,
      },
      score_details: { score, sample_size: sampleSize },
    },
    is_headline: true,
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
      min_score: 0,
      max_score: 1,
    },
    model_results: modelResults,
    models_count: modelResults.length,
    evaluator_names: ["OpenEval"],
    source_types: [],
    third_party_ratio: 1,
    missing_generation_config_count: 0,
    best_model: null,
    worst_model: null,
    avg_score: 0.8,
    avg_score_norm: 0.8,
  } as BenchmarkEvalSummary
}

function render(summary: BenchmarkEvalSummary): string {
  return renderToStaticMarkup(
    createElement(AudienceModeProvider, null, createElement(BenchmarkSignalsStrip, { summary })),
  )
}

describe("BenchmarkSignalsStrip — Saturation tile", () => {
  it("shows insufficient-data state with fewer than 3 reported models", () => {
    const html = render(summaryWith([result("a", 0.9), result("b", 0.8)]))
    expect(html).toContain("Saturation")
    expect(html).toContain("Only 2 models reported")
  })

  it("shows insufficient-data state when no test-set size is reported", () => {
    const html = render(
      summaryWith([result("a", 0.9), result("b", 0.85), result("c", 0.8)]),
    )
    expect(html).toContain("No test-set size is recorded")
  })

  it("computes a saturation percentage once sample_size and enough models are present", () => {
    const html = render(
      summaryWith([
        result("a", 0.95, 1000),
        result("b", 0.94, 1000),
        result("c", 0.93, 1000),
        result("d", 0.92, 1000),
        result("e", 0.91, 1000),
      ]),
    )
    expect(html).toContain("68")
    expect(html).toContain("Top 5 models")
  })
})
