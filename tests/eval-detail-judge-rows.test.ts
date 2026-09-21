import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import { EvalDetail } from "@/components/eval-detail"
import type { BenchmarkEvalSummary, ModelResultForBenchmark } from "@/lib/eval-processing"

vi.mock("next/navigation", () => import("./next-navigation-stub"))

// The leaderboard ranks CLIENT-side, so a NULL backend rank is not enough
// on its own: these render the real component and read the rows it emits.
// One row per model, ranked by the score it reports; a model's other
// judge / protocol readings fold into that row and are listed when it is
// expanded (which static markup does not reach — `tagFoldMembers` in
// eval-processing.test.ts covers the unfurled list).

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
    },
    ...overrides,
  }
}

function judgeRow(judge: string, label: string, score: number): ModelResultForBenchmark {
  return result({
    score,
    is_headline: false,
    judge_condition: JSON.stringify({ judges: [judge], label }),
    metric_source_label: label,
  })
}

// The server resolves these against models_view; GPT-4o and Claude are
// placed (Claude has no result row on the page at all), the llama judge is
// not, so it must keep its raw id.
const JUDGE_NAMES = {
  "openai/gpt-4o": "GPT-4o",
  "anthropic/claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
}

function summaryWith(modelResults: ModelResultForBenchmark[]): BenchmarkEvalSummary {
  return {
    judge_display_names: JUDGE_NAMES,
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
    models_count: 2,
    evaluator_names: ["OpenEval"],
    source_types: [],
    third_party_ratio: 1,
    missing_generation_config_count: 0,
    best_model: { name: "Model A", score: 0.8 },
    worst_model: null,
    avg_score: 0.75,
    avg_score_norm: 0.75,
  } as BenchmarkEvalSummary
}

function render(summary: BenchmarkEvalSummary): string {
  return renderToStaticMarkup(
    createElement(AudienceModeProvider, null, createElement(EvalDetail, { summary })),
  )
}

const HEADLINE = result({
  score: 0.8,
  is_headline: true,
  judge_condition: JSON.stringify({
    judges: ["openai/gpt-4o", "anthropic/claude-3-5-sonnet-20241022", "meta/llama-4"],
    label: "score",
  }),
  metric_source_label: "score",
})
const MODEL_B = result({
  model_info: { name: "Model B", id: "org/model-b" },
  model_route_id: "org%2Fmodel-b",
  score: 0.7,
})

describe("EvalDetail leaderboard rows — judge and protocol readings", () => {
  it("ranks headline rows only and shows each model's judge rows beneath it", () => {
    const html = render(
      summaryWith([
        HEADLINE,
        // A single judge scored this model far higher than its headline
        // reading — it must not take a rank, let alone #1.
        judgeRow("openai/gpt-4o", "gpt_score", 0.99),
        judgeRow("anthropic/claude-3-5-sonnet-20241022", "claude_score", 0.61),
        judgeRow("meta/llama-4", "llama_score", 0.55),
        MODEL_B,
      ]),
    )

    // Two models on the page, so two rows and two ranks: the three judge
    // readings fold into Model A's row rather than standing beside it.
    expect(html.match(/#1/g) ?? []).toHaveLength(1)
    expect(html.match(/#2/g) ?? []).toHaveLength(1)
    expect(html).not.toContain("#3")

    // The folded row keeps the headline reading's judge label — the
    // panel, named from the server-resolved map.
    expect(html).toContain("mean of 3 judges")
    expect(html).toContain("Judges: GPT-4o, Claude 3.5 Sonnet, meta/llama-4")
    // Model A read 0.8 / 0.99 / 0.61 / 0.55, so its row reports the mean
    // of the four, not the headline 0.8 and not the 0.99 a single judge
    // handed it.
    expect(html).toContain("mean of 4 runs")
    expect(html).toContain("0.74")

    // The extra readings are not loose rows any more.
    expect(html).not.toContain("judged by GPT-4o")
    expect(html).not.toContain("shown, not ranked")

    // The study banner is keyed on protocol_condition alone — a judged
    // page is not a study page.
    expect(html).not.toContain("Study-specific protocol")
    expect(html).not.toContain("larger inference budgets")
  })

  it("keeps the assisted protocol row shown-but-unranked, with its banner and label", () => {
    const html = render(
      summaryWith([
        HEADLINE,
        judgeRow("openai/gpt-4o", "gpt_score", 0.99),
        MODEL_B,
        result({
          model_info: { name: "Model B", id: "org/model-b" },
          model_route_id: "org%2Fmodel-b",
          score: 0.95,
          // The producer never marks an assisted row as its model's
          // headline reading — the fixture has to model that.
          is_headline: false,
          protocol_condition: JSON.stringify({ feedback: "answer_feedback", token_limit: 5000000 }),
        }),
      ]),
    )

    // Two models → two rows, two ranks, and the assisted 0.95 neither
    // takes a rank of its own nor lifts Model B above Model A: it is
    // listed inside Model B's fold but not counted in its median.
    expect(html.match(/#1/g) ?? []).toHaveLength(1)
    expect(html).not.toContain("#3")
    expect(html).toContain("Study-specific protocol")
    expect(html).toContain("labeled and counted in each model")
    expect(html.indexOf("Model A")).toBeLessThan(html.indexOf("Model B"))

    // Because the backend already withheld the rank, the control cannot
    // put these rows back into the standings; it governs whether they are
    // shown at all, and says so.
    expect(html).toContain("Hide assisted runs")
    expect(html).not.toContain("Include assisted runs in ranking")
  })

  it("keeps the old ranking toggle on a snapshot that still serves assisted rows as headlines", () => {
    const html = render(
      summaryWith([
        HEADLINE,
        MODEL_B,
        result({
          model_info: { name: "Model C", id: "org/model-c" },
          model_route_id: "org%2Fmodel-c",
          score: 0.95,
          protocol_condition: JSON.stringify({ feedback: "answer_feedback", token_limit: 5000000 }),
        }),
      ]),
    )

    expect(html).toContain("Include assisted runs in ranking")
    expect(html).not.toContain("Hide assisted runs")
  })

  it("names the judge's raw id on a single-judge row and repeats the source channel on the compact list", () => {
    const html = render(
      summaryWith([
        HEADLINE,
        judgeRow("openai/gpt-4o", "gpt_score", 0.99),
        MODEL_B,
      ]),
    )

    // The single-judge reading folds in, so neither its tooltip nor its
    // own source channel is on the page any more.
    expect(html).not.toContain("Judge model id: openai/gpt-4o")
    expect(html).not.toContain("gpt_score")
    // What the folded row carries is the HEADLINE reading's panel label
    // and channel, in both the compact list and the desktop table.
    expect((html.match(/mean of 3 judges/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect((html.match(/font-size:10px">score<\/span>/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})
