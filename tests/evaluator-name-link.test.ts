import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import { EvaluatorIndexProvider } from "@/components/org-metadata-provider"
import { EvalDetail } from "@/components/eval-detail"
import type { BenchmarkEvalSummary } from "@/lib/eval-processing"

vi.mock("next/navigation", () => import("./next-navigation-stub"))

// A name only links to /evaluators/<slug> when it is an org that has such
// a page. The bug this pins: a merged page carried its sources' composite
// display names, which are study and leaderboard TITLES, in
// `evaluator_names`, so the hero read "Reported by How Inference Compute
// Shapes Frontier LLM Evaluation" and linked that title to an evaluator
// page that does not exist.

const KNOWN_EVALUATORS = ["UK AI Security Institute", "Arcadia Impact"]

function summaryWith(evaluatorNames: string[]): BenchmarkEvalSummary {
  const score = 0.8
  return {
    evaluation_id: "cyber-ctfs",
    evaluation_name: "Cyber CTFs",
    composite_benchmark_key: "cyber-ctfs",
    composite_benchmark_name: "Cyber CTFs",
    metric_config: {
      evaluation_description: "accuracy",
      lower_is_better: false,
      score_type: "continuous",
      min_score: 0,
      max_score: 1,
    },
    model_results: [
      {
        model_info: { name: "GPT-5.4", id: "openai/gpt-5.4" },
        model_route_id: "openai%2Fgpt-5.4",
        score,
        score_details: { score },
        evaluation_timestamp: "2026-09-16T00:00:00Z",
        source_metadata: {
          source_name: "UK AI Security Institute",
          source_type: "evaluation_run",
          source_organization_name: "UK AI Security Institute",
          evaluator_relationship: "third_party",
        },
        source_data: { dataset_name: "Cyber CTFs" },
        evaluator_display_name: "UK AI Security Institute",
        is_headline: true,
        result: {
          evaluation_name: "accuracy",
          evaluation_timestamp: "2026-09-16T00:00:00Z",
          metric_config: {
            evaluation_description: "accuracy",
            lower_is_better: false,
            score_type: "continuous",
          },
          score_details: { score },
        },
      },
    ],
    models_count: 1,
    evaluator_names: evaluatorNames,
    verified_evaluator_names: evaluatorNames,
    source_types: [],
    third_party_ratio: 1,
    missing_generation_config_count: 0,
    best_model: { name: "GPT-5.4", score },
    worst_model: null,
    avg_score: score,
    avg_score_norm: score,
  } as unknown as BenchmarkEvalSummary
}

function render(summary: BenchmarkEvalSummary, evaluatorNames: string[] | null): string {
  return renderToStaticMarkup(
    createElement(
      AudienceModeProvider,
      null,
      createElement(EvaluatorIndexProvider, {
        names: evaluatorNames,
        children: createElement(EvalDetail, { summary }),
      }),
    ),
  )
}

describe("EvalDetail evaluator links", () => {
  it("links a name that has an evaluator page", () => {
    const html = render(summaryWith(["UK AI Security Institute"]), KNOWN_EVALUATORS)
    expect(html).toContain('href="/evaluators/uk-ai-security-institute"')
    expect(html).toContain("UK AI Security Institute")
  })

  it("renders a study title as plain text, never as an evaluator link", () => {
    const title = "How Inference Compute Shapes Frontier LLM Evaluation"
    const html = render(summaryWith([title]), KNOWN_EVALUATORS)
    expect(html).toContain(title)
    expect(html).not.toContain("evaluators/how-inference-compute")
    expect(html).not.toContain("/evaluators/")
  })

  it("links nothing when the index is unavailable", () => {
    // An href built from a display string the index cannot confirm is a
    // guaranteed 404, so a missing index costs a link rather than
    // producing a broken one. The name and its badge still render.
    const html = render(summaryWith(["UK AI Security Institute"]), null)
    expect(html).toContain("UK AI Security Institute")
    expect(html).not.toContain("/evaluators/")
  })

  it("links nothing for a study title when the index is unavailable", () => {
    const title = "How Inference Compute Shapes Frontier LLM Evaluation"
    const html = render(summaryWith([title]), null)
    expect(html).toContain(title)
    expect(html).not.toContain("/evaluators/")
  })
})
