import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import { EvalDetail } from "@/components/eval-detail"
import type { BenchmarkEvalSummary, ModelResultForBenchmark } from "@/lib/eval-processing"

// A protocol-varied study (the AISI inference-scaling shape) repeats one
// model name down the page: nine "Claude Opus 4.6" rows are nine runs at
// different reasoning budgets. Only the headline run is ranked, so the
// rest read as duplicates of it unless the varying axis is on the row.
// These render the real component and read what a viewer would see.

function result(overrides: Partial<ModelResultForBenchmark>): ModelResultForBenchmark {
  const score = overrides.score ?? 0.8
  return {
    model_info: { name: "Claude Opus 4.6", id: "anthropic/claude-opus-4.6" },
    model_route_id: "anthropic%2Fclaude-opus-4.6",
    score,
    score_details: { score },
    evaluation_timestamp: "2026-02-04T00:00:00Z",
    source_metadata: {
      source_name: "UK AI Security Institute",
      source_type: "paper",
      source_organization_name: "UK AI Security Institute",
      evaluator_relationship: "third_party",
    },
    source_data: { dataset_name: "Terminal-Bench 2.0" },
    result: {
      evaluation_name: "accuracy",
      evaluation_timestamp: "2026-02-04T00:00:00Z",
      metric_config: {
        evaluation_description: "accuracy",
        lower_is_better: false,
        score_type: "continuous",
      },
      score_details: { score },
    },
    metric_source_label: "accuracy",
    ...overrides,
  }
}

/** The study's declared axes, exactly as the collections sidecar serves
 *  them for `uk-aisi-inference-scaling`. */
const PROTOCOL_AXES = [
  { key: "scaffold", type: "categorical", values: ["S-adaptive", "ReAct"] },
  { key: "compaction", type: "boolean" },
  { key: "feedback", type: "categorical", values: ["none", "answer_feedback"] },
  { key: "token_limit", type: "int", unit: "tokens" },
  { key: "reasoning_tokens", type: "int", unit: "tokens" },
  { key: "reasoning_effort", type: "categorical", values: ["high", "xhigh"] },
]

function run(
  score: number,
  condition: Record<string, unknown>,
  overrides: Partial<ModelResultForBenchmark> = {},
): ModelResultForBenchmark {
  return result({
    score,
    is_headline: false,
    protocol_condition: JSON.stringify({
      scaffold: "S-adaptive",
      token_limit: 10_000_000,
      ...condition,
    }),
    ...overrides,
  })
}

function summaryWith(
  modelResults: ModelResultForBenchmark[],
  collection?: Record<string, unknown>,
): BenchmarkEvalSummary {
  return {
    evaluation_id: "aisi-inference-scaling%2Fterminal-bench-2",
    evaluation_name: "Terminal-Bench 2.0",
    composite_benchmark_key: "aisi-inference-scaling",
    composite_benchmark_name: "AISI inference scaling",
    metric_config: {
      evaluation_description: "accuracy",
      lower_is_better: false,
      score_type: "continuous",
      min_score: 0,
      max_score: 1,
    },
    model_results: modelResults,
    models_count: 1,
    evaluator_names: ["UK AI Security Institute"],
    source_types: [],
    third_party_ratio: 1,
    missing_generation_config_count: 0,
    best_model: { name: "Claude Opus 4.6", score: 0.96 },
    worst_model: null,
    avg_score: 0.75,
    avg_score_norm: 0.75,
    collection: {
      collection_id: "uk-aisi-inference-scaling",
      display_name: "How Inference Compute Shapes Frontier LLM Evaluation",
      curated: true,
      kind: "paper_study",
      protocol_axes: PROTOCOL_AXES,
      compute_axis: { key: "token_limit", label: "token budget (limit)", unit: "tokens" },
      ...collection,
    },
  } as unknown as BenchmarkEvalSummary
}

function render(summary: BenchmarkEvalSummary): string {
  return renderToStaticMarkup(
    createElement(AudienceModeProvider, null, createElement(EvalDetail, { summary })),
  )
}

/** The page from the bug report, trimmed to the rows that matter. */
const OPUS_PAGE = [
  run(0.964, { feedback: "none", reasoning_effort: "high", reasoning_tokens: 32000, compaction: false }, { is_headline: true }),
  run(0.604, { feedback: "none", reasoning_effort: "high", reasoning_tokens: 16000, compaction: false }),
  run(0.726, { feedback: "none", reasoning_effort: "xhigh", reasoning_tokens: 32000, compaction: false }),
  run(0.75, { feedback: "none", reasoning_effort: "xhigh", reasoning_tokens: 64000, compaction: false }),
  run(0.755, { feedback: "none", reasoning_effort: null, reasoning_tokens: null, compaction: false }),
  run(1.0, { feedback: "answer_feedback", reasoning_effort: "high", reasoning_tokens: 32000, compaction: true }),
]

describe("EvalDetail leaderboard — protocol condition columns", () => {
  it("gives every varying axis its own column so same-named rows are distinguishable", () => {
    const html = render(summaryWith(OPUS_PAGE))

    // Headers for the axes that vary, with the study's own ordering.
    expect(html).toContain("Compaction")
    expect(html).toContain("Thinking tokens")
    expect(html).toContain("Effort")
    // Constant axes explain nothing and stay out; feedback is already
    // carried by the assisted badge.
    expect(html).not.toContain("Scaffold")
    expect(html).not.toContain("Token budget</th>")

    // Cell values: the compact count form, the effort words, and the
    // "not set" mark for the run that declared no effort.
    expect(html).toContain("16k")
    expect(html).toContain("32k")
    expect(html).toContain("64k")
    expect(html).toContain("xhigh")
    expect(html).toContain("Effort: not set for this run")
  })

  it("still ranks one reading per model — the extra runs are labelled, not renumbered", () => {
    const html = render(summaryWith(OPUS_PAGE))

    // Six rows, one model, one rank: a model's standing is its headline
    // reading, so the 1.00 assisted run does not take #1 and the
    // unranked runs are not numbered #2..#6.
    expect(html.match(/#1/g) ?? []).toHaveLength(1)
    expect(html).not.toContain("#2")
    expect(html).toContain("Another run of the same model — shown, not ranked")
    expect(html).toContain("Assisted run (answer feedback) — shown, not ranked")
  })

  it("subordinates the extra runs to their model's ranked row", () => {
    const html = render(summaryWith(OPUS_PAGE))

    // A dash reads as "ranked nowhere". These rows are readings of the
    // row above them, so they get a branch glyph and an indent instead.
    expect(html).toContain("\u21b3")
    expect(html.match(/&#x2014;<\/span>/g) ?? []).toHaveLength(0)
    // The reason is on the element, not only in a hover tooltip.
    expect(html).toContain('aria-label="Another run of the same model — shown, not ranked"')
    expect(html).toContain('aria-label="Rank 1"')
  })

  it("drops the score sort arrow while the rows are grouped, not sorted", () => {
    // The grouped order reads 0.96, 0.60, 0.73 … 1.00; a descending
    // arrow over that column promises a descent it does not make.
    const grouped = render(summaryWith(OPUS_PAGE))
    expect(grouped).toContain("Grouped by model")
    expect(grouped).not.toContain("Score↓")
    expect(grouped).not.toContain("accuracy↓")
  })

  it("keeps the score arrow on a page where every row is ranked", () => {
    const flat = render(
      summaryWith([
        run(0.96, { feedback: "none", reasoning_effort: "high" }, { is_headline: true }),
        run(0.7, { feedback: "none", reasoning_effort: "high" }, {
          model_info: { name: "GPT-5.4", id: "openai/gpt-5.4" },
          model_route_id: "openai%2Fgpt-5.4",
          is_headline: true,
        }),
      ]),
    )
    expect(flat).not.toContain("Grouped by model")
    expect(flat).toContain("↓")
  })

  it("adds no columns when the page's runs share one condition", () => {
    const html = render(
      summaryWith([
        run(0.96, { feedback: "none", reasoning_effort: "high", reasoning_tokens: 32000 }, { is_headline: true }),
        run(0.7, { feedback: "none", reasoning_effort: "high", reasoning_tokens: 32000 }, {
          model_info: { name: "GPT-5.4", id: "openai/gpt-5.4" },
          model_route_id: "openai%2Fgpt-5.4",
          is_headline: true,
        }),
      ]),
    )
    expect(html).not.toContain("Thinking tokens")
    expect(html).not.toContain("Effort")
  })

  it("falls back to row-discovered axes when the collection declares none", () => {
    const html = render(
      summaryWith(OPUS_PAGE, { protocol_axes: undefined }),
    )
    expect(html).toContain("Thinking tokens")
    expect(html).toContain("Effort")
  })
})
