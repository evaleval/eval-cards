import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import { EvalDetail } from "@/components/eval-detail"
import type {
  BenchmarkEvalSummary,
  BenchmarkLeaderboardRow,
  ModelResultForBenchmark,
} from "@/lib/eval-processing"

vi.mock("next/navigation", () => import("./next-navigation-stub"))

// An eval with more than one root metric renders the model × metric pivot
// instead of the per-row leaderboard. The pivot keeps one row per model, so
// the two things the per-row path gets for free have to be carried here: the
// page ranks on its own primary metric (OpenEval HarmBench declares
// harmbench-refusal-score, which is NOT the first column), and a judged cell
// names its panel and the readings the producer's headline pick left out.

const METRICS = [
  {
    column_key: "attack-success-rate",
    metric_id: "attack-success-rate",
    metric_summary_id: "harmbench%3Aattack-success-rate",
    metric_name: "Attack Success Rate",
    display_name: "Attack Success Rate",
    lower_is_better: true,
    unit: "proportion",
    scope: "root" as const,
  },
  {
    column_key: "harmbench-refusal-score",
    metric_id: "harmbench-refusal-score",
    metric_summary_id: "harmbench%3Aharmbench-refusal-score",
    metric_name: "HarmBench Refusal Score",
    display_name: "HarmBench Refusal Score",
    lower_is_better: false,
    unit: "score",
    scope: "root" as const,
  },
]

const GPT_JUDGE = JSON.stringify({
  judges: ["openai/gpt-4o-2024-05-13"],
  label: "safety_gpt_score",
})
const LLAMA_JUDGE = JSON.stringify({
  judges: ["meta/llama-3.1-405b-instruct-turbo"],
  label: "safety_llama_score",
})

// Resolved server-side against models_view — the same map the per-row
// leaderboard labels with, handed to the matrix so one judge id reads the
// same on both surfaces.
const JUDGE_NAMES = {
  "openai/gpt-4o-2024-05-13": "GPT-4o",
  "meta/llama-3.1-405b-instruct-turbo": "Llama 3.1 405B Instruct Turbo",
}

function modelInfo(letter: string) {
  return { name: `Model ${letter}`, id: `org/model-${letter.toLowerCase()}` }
}

function row(
  letter: string,
  attackSuccessRate: number,
  refusalScore: number,
  judge?: {
    condition: string
    alternates?: Array<{ judge_condition: string; score: number | null }>
  },
): BenchmarkLeaderboardRow {
  return {
    model_info: modelInfo(letter),
    model_route_id: `org%2Fmodel-${letter.toLowerCase()}`,
    evaluation_timestamp: "2026-01-01T00:00:00Z",
    source_metadata: {
      source_name: "OpenEval",
      source_type: "leaderboard",
      source_organization_name: "OpenEval",
      evaluator_relationship: "third_party",
    },
    source_data: { dataset_name: "HarmBench" },
    values: {
      "attack-success-rate": attackSuccessRate,
      "harmbench-refusal-score": refusalScore,
    },
    judge_condition_by_metric: judge
      ? { "harmbench-refusal-score": judge.condition }
      : undefined,
    judge_alternates_by_metric: judge?.alternates
      ? { "harmbench-refusal-score": judge.alternates }
      : undefined,
    metrics_present: 2,
  } as BenchmarkLeaderboardRow
}

function modelResult(letter: string, score: number): ModelResultForBenchmark {
  return {
    model_info: modelInfo(letter),
    model_route_id: `org%2Fmodel-${letter.toLowerCase()}`,
    score,
    score_details: { score },
    evaluation_timestamp: "2026-01-01T00:00:00Z",
    source_metadata: {
      source_name: "OpenEval",
      source_type: "leaderboard",
      source_organization_name: "OpenEval",
      evaluator_relationship: "third_party",
    },
    source_data: { dataset_name: "HarmBench" },
    result: {
      evaluation_name: "HarmBench Refusal Score",
      evaluation_timestamp: "2026-01-01T00:00:00Z",
      metric_config: {
        evaluation_description: "HarmBench Refusal Score",
        lower_is_better: false,
        score_type: "continuous",
      },
      score_details: { score },
    },
  } as ModelResultForBenchmark
}

// Attack-success-rate and refusal score rank the models in OPPOSITE orders,
// so the rendered order alone says which column the page sorted on.
const ROWS: BenchmarkLeaderboardRow[] = [
  row("A", 0.10, 0.90, {
    condition: GPT_JUDGE,
    alternates: [{ judge_condition: LLAMA_JUDGE, score: 0.21 }],
  }),
  row("B", 0.40, 0.70, { condition: GPT_JUDGE }),
  row("C", 0.70, 0.50, { condition: GPT_JUDGE }),
  row("D", 0.95, 0.30, { condition: GPT_JUDGE }),
]

function summaryWith(
  overrides: Partial<BenchmarkEvalSummary> = {},
): BenchmarkEvalSummary {
  return {
    judge_display_names: JUDGE_NAMES,
    evaluation_id: "openeval%2Fharmbench",
    evaluation_name: "HarmBench",
    composite_benchmark_key: "openeval",
    composite_benchmark_name: "OpenEval",
    primary_metric_id: "harmbench-refusal-score",
    metric_config: {
      evaluation_description: "HarmBench Refusal Score",
      lower_is_better: false,
      score_type: "continuous",
      min_score: 0,
      max_score: 1,
    },
    leaderboard_metrics: METRICS,
    leaderboard_rows: ROWS,
    model_results: [
      modelResult("A", 0.9),
      modelResult("B", 0.7),
      modelResult("C", 0.5),
      modelResult("D", 0.3),
    ],
    models_count: 4,
    evaluator_names: ["OpenEval"],
    source_types: [],
    third_party_ratio: 1,
    missing_generation_config_count: 0,
    best_model: { name: "Model A", score: 0.9 },
    worst_model: { name: "Model D", score: 0.3 },
    avg_score: 0.6,
    avg_score_norm: 0.6,
    ...overrides,
  } as BenchmarkEvalSummary
}

function render(summary: BenchmarkEvalSummary): string {
  return renderToStaticMarkup(
    createElement(AudienceModeProvider, null, createElement(EvalDetail, { summary })),
  )
}

describe("EvalDetail multi-metric matrix — primary metric and judge cells", () => {
  it("sorts, charts and ranks on the declared primary metric, not the first column", () => {
    const html = render(summaryWith())

    // The sort indicator rides the sorted header only.
    expect(html).toContain("HarmBench Refusal Score ▼")
    expect(html).not.toContain("Attack Success Rate ▼")
    expect(html).not.toContain("Attack Success Rate ▲")

    // Refusal-score order, i.e. the reverse of the attack-success-rate one.
    const order = ["Model A", "Model B", "Model C", "Model D"].map((name) =>
      html.indexOf(name),
    )
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)

    // The distribution panel opens on the same metric rather than on
    // whichever column plots first, so its heading and its direction hint
    // describe the ranking under it.
    expect(html).toContain('class="ec-pill on" title="HarmBench Refusal Score · score"')
    expect(html).toContain('aria-label="HarmBench Refusal Score distribution: 4 models"')
    expect(html).toContain("higher is better")
  })

  it("falls back to the first root metric when the page declares no primary", () => {
    const html = render(summaryWith({ primary_metric_id: undefined }))

    expect(html).toContain("Attack Success Rate ▲")
    expect(html).not.toContain("HarmBench Refusal Score ▼")
  })

  it("labels a judged cell and keeps the losing judge's reading in its tooltip", () => {
    const html = render(summaryWith())

    // The panel behind the number the cell shows, in the per-row
    // leaderboard's own wording and through the server-resolved names.
    expect((html.match(/judged by GPT-4o/g) ?? []).length).toBe(4)
    // The alternate reading is named and valued inside the same tooltip —
    // it is the only place the pivot can carry it.
    expect(html).toContain("Other judge readings, not ranked:")
    expect(html).toContain("judged by Llama 3.1 405B Instruct Turbo: 0.21")
    expect(html).toContain("Judge model id: openai/gpt-4o-2024-05-13")

    // And it stays a tooltip: one row per model, no row for the losing
    // judge and no rank for it.
    expect(html.match(/#\d+/g) ?? []).toHaveLength(4)
    expect(html).not.toContain("#5")
  })

  it("says nothing about judges on a matrix baked before the judge axis", () => {
    const html = render(
      summaryWith({
        leaderboard_rows: ROWS.map((matrixRow) => ({
          ...matrixRow,
          judge_condition_by_metric: undefined,
          judge_alternates_by_metric: undefined,
        })),
      }),
    )

    expect(html).not.toContain("judged by")
    expect(html).not.toContain("Other judge readings")
  })
})
