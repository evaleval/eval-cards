import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import { EvalDetail } from "@/components/eval-detail"
import type { BenchmarkEvalSummary, ModelResultForBenchmark } from "@/lib/eval-processing"

vi.mock("next/navigation", () => import("./next-navigation-stub"))

// The leaderboard ranks CLIENT-side, so a NULL backend rank is not enough
// on its own: these render the real component and read the rows it emits.
// One ranked row per model, the model's other judge readings beneath it,
// unranked and labelled. A judged page folds nothing: a second judge
// panel is another reading of the same cell, not another run of the
// model, so it keeps its own row whether or not the page also varies a
// protocol.

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

    // Two models on the page, so two ranks and no third: the three judge
    // rows are shown but never ranked.
    expect(html.match(/#1/g) ?? []).toHaveLength(1)
    expect(html.match(/#2/g) ?? []).toHaveLength(1)
    expect(html).not.toContain("#3")

    // Judge labels: the panel on the headline row, each single judge
    // beneath it. Names come from the server-resolved map — Claude is a
    // judge with no result row on this page and still reads as a name —
    // and an id the map cannot place keeps its raw spelling.
    expect(html).toContain("mean of 3 judges")
    expect(html).toContain("judged by GPT-4o")
    expect(html).toContain("judged by Claude 3.5 Sonnet")
    expect(html).toContain("judged by meta/llama-4")
    // The panel's members are named on the multi-judge row itself.
    expect(html).toContain("Judges: GPT-4o, Claude 3.5 Sonnet, meta/llama-4")
    // The source's own channel name rides along as provenance.
    expect(html).toContain("gpt_score")

    // Judge rows sit beneath their model's headline row, before the next
    // model's row.
    const judgeIndex = html.indexOf("judged by GPT-4o")
    const headlineIndex = html.indexOf("mean of 3 judges")
    const nextModelIndex = html.indexOf("Model B")
    expect(headlineIndex).toBeLessThan(judgeIndex)
    expect(judgeIndex).toBeLessThan(nextModelIndex)

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

    // Two models → two ranks; neither the judge row nor the assisted run
    // takes one, and the assisted 0.95 never outranks Model A.
    expect(html.match(/#1/g) ?? []).toHaveLength(1)
    expect(html).not.toContain("#3")
    expect(html).toContain("Study-specific protocol")
    // The page varies a protocol, so Model B's runs fold. The assisted
    // 0.95 is inside that fold, counted in neither its score nor its
    // range, and the row says so rather than hiding it.
    expect(html).toContain("1 assisted run also listed")
    // The judge reading is not a run of the model, so it stays its own
    // row rather than folding into Model A's number.
    expect(html).toContain("Another judge&#x27;s reading of the same model — shown, not ranked")

    // Because the backend already withheld the rank, the control cannot
    // put these rows back into the standings; it governs whether they are
    // shown at all, and says so.
    expect(html).toContain("labeled and never ranked")
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

    // Two dated variants of one model resolve to the same display name;
    // the raw id in the tooltip is what separates those rows.
    expect(html).toContain("Judge model id: openai/gpt-4o")
    // The compact (mobile) list and the desktop table both carry the
    // source's own channel name.
    expect((html.match(/gpt_score/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})
