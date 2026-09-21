import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import { EvalDetail } from "@/components/eval-detail"
import type { BenchmarkEvalSummary, ModelResultForBenchmark } from "@/lib/eval-processing"

import { setSearchParams } from "./next-navigation-stub"

vi.mock("next/navigation", () => import("./next-navigation-stub"))

/** The separator the unranked-row tooltips already use. Spelled by code
 *  point so this file adds none of its own. */
const DASH = "\u2014"


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

describe("EvalDetail leaderboard — folded model rows", () => {
  it("shows the study's axes, with units, on the rows it folds", () => {
    const html = render(summaryWith(OPUS_PAGE))

    // Headers for the budgets the study declares a unit for, and for the
    // axes that vary, in the study's own ordering.
    expect(html).toContain("Token budget")
    expect(html).toContain("Compaction")
    expect(html).toContain("Thinking tokens")
    expect(html).toContain("Effort")
    // A constant scaffold explains nothing, and the answer oracle is
    // already on the assisted badge and in the assisted-run count, so
    // neither earns a column.
    expect(html).not.toContain("Scaffold")
    expect(html).not.toContain(">Feedback<")
    expect(html).not.toContain("Feedback:")

    // Cell values carry the declared unit, and the effort words are
    // humanised.
    expect(html).toContain("16k tokens")
    expect(html).toContain("32k tokens")
    expect(html).toContain("64k tokens")
    expect(html).toContain("10M tokens")
    expect(html).toContain("X-high")
    // The exact value stays reachable.
    expect(html).toContain("10,000,000 tokens")
    // A null on an applicable axis is an absence of reporting, never a
    // missing limit.
    expect(html).toContain("Not reported")
    expect(html).not.toContain("No limit")
  })

  it("still ranks one reading per model — the extra runs are labelled, not renumbered", () => {
    const html = render(summaryWith(OPUS_PAGE))

    // Six rows, one model, one rank: a model's standing is its headline
    // reading, so the 1.00 assisted run does not take #1 and the
    // unranked runs are not numbered #2..#6.
    expect(html.match(/#1/g) ?? []).toHaveLength(1)
    expect(html).not.toContain("#2")
  })

  it("keeps the declared budgets when the page's runs share one condition", () => {
    // A constant budget is still the budget every score on the page was
    // produced under; only the axes that explain nothing drop out.
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
    expect(html).toContain("Token budget")
    expect(html).toContain("Thinking tokens")
    expect(html).toContain("10M tokens")
    expect(html).toContain("32k tokens")
    expect(html).not.toContain("Effort")
  })

  it("labels both token budgets on an aggregate-only page that reports neither thinking budget", () => {
    // The cyber shape: one cell per model at the run cap, thinking
    // tokens never reported. The column has to stay, saying so.
    const html = render(
      summaryWith([
        run(0.85, {}, {
          is_headline: true,
          protocol_condition: JSON.stringify({
            scaffold: "ReAct",
            compaction: true,
            feedback: "none",
            token_limit: 50_000_000,
            reasoning_tokens: null,
            reasoning_effort: null,
          }),
        }),
        run(0.62, {}, {
          model_info: { name: "GPT-5.4", id: "openai/gpt-5.4" },
          model_route_id: "openai%2Fgpt-5.4",
          is_headline: true,
          protocol_condition: JSON.stringify({
            scaffold: "ReAct",
            compaction: true,
            feedback: "none",
            token_limit: 100_000_000,
            reasoning_tokens: null,
            reasoning_effort: null,
          }),
        }),
      ]),
    )
    expect(html).toContain("Token budget")
    expect(html).toContain("Thinking tokens")
    expect(html).toContain("50M tokens")
    expect(html).toContain("100M tokens")
    expect(html).toContain("Not reported")
  })

  it("makes protocol headers sortable and announces the sort state", () => {
    const html = render(summaryWith(OPUS_PAGE))
    expect(html).toContain('aria-sort="none"')
    // The header is a button, and its title names the axis it sorts on.
    expect(html).toContain("Protocol axis &quot;token_limit&quot; (tokens)")
  })

  it("labels each value in the narrow layout instead of running them together", () => {
    const html = render(summaryWith(OPUS_PAGE))
    // The narrow block names the axis next to its value; the old
    // "xhigh · 32k · on" form said which settings but not which was which.
    expect(html).toContain("Token budget:")
    expect(html).toContain("Thinking tokens:")
    expect(html).not.toContain("xhigh · 32k")
  })

  it("offers a filter per axis whose value varies", () => {
    const html = render(summaryWith(OPUS_PAGE))
    // Options read as formatted values; the raw identity behind them,
    // which is what the URL and the filter compare on, is covered by the
    // collections unit tests.
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain("Not reported")
  })

  it("falls back to row-discovered axes when the collection declares none", () => {
    const html = render(
      summaryWith(OPUS_PAGE, { protocol_axes: undefined }),
    )
    expect(html).toContain("Thinking tokens")
    expect(html).toContain("Effort")
  })

  it("states the answer oracle once, not once per layout", () => {
    const html = render(summaryWith(OPUS_PAGE))

    // The folded row counts the assisted runs it lists, and the run list
    // badges them. A Feedback column would be the same fact a third and
    // fourth time, and in the narrow layout it costs a whole line.
    expect(html).toContain("1 assisted run also listed")
    expect(html).not.toContain(">Feedback<")
    expect(html).not.toContain("Feedback:")
    expect(html).not.toContain("Answer feedback")
  })

  it("badges an assisted run without spelling out its feedback value", () => {
    setSearchParams("protocol.reasoning_tokens=number%3A32000")
    try {
      const html = render(summaryWith(OPUS_PAGE))
      // One of the three matching runs is assisted, and the badge is the
      // only thing that says so.
      expect(html).toContain("assisted")
      expect(html).not.toContain("Answer feedback")
      expect(html).not.toContain(">Feedback<")
      expect(html).not.toContain("Feedback:")
    } finally {
      setSearchParams()
    }
  })

  it("reports the headline run's score and standing, never a statistic across the runs", () => {
    const html = render(summaryWith(OPUS_PAGE))

    // The producer picked the 0.964 run as this model's headline
    // reading. The mean of the six readings is 0.80 and the assisted run
    // reached 1.00; the row reports neither, because the six are
    // different configurations rather than repeated samples.
    expect(html).toContain("0.96")
    expect(html).not.toContain("mean of")
    expect(html).not.toContain("±")
    expect(html).not.toContain("95%")
    expect(html.match(/#1/g) ?? []).toHaveLength(1)
  })

  it("ranges over the unassisted runs and says how many assisted ones are listed", () => {
    const html = render(summaryWith(OPUS_PAGE))

    // 0.604 to 0.964 across the five unassisted runs. The assisted 1.00
    // is listed with them but never widens the range or moves the score.
    expect(html).toContain("0.60 to 0.96 across 5 runs")
    expect(html).toContain("1 assisted run also listed")
    expect(html).not.toContain("across 6 runs")
  })

  it("summarises a varied budget as a range and a constant one as itself", () => {
    const html = render(summaryWith(OPUS_PAGE))

    // Thinking tokens ran at 16k, 32k and 64k, and one run did not
    // report the axis at all.
    expect(html).toContain("16k to 64k tokens, some not reported")
    // The token budget was the same for every run, so the row states it.
    expect(html).toContain("10M tokens")
  })

  it("gives a model with one run its own score and standing", () => {
    const html = render(
      summaryWith([
        ...OPUS_PAGE,
        run(0.7, { feedback: "none", reasoning_effort: "high", reasoning_tokens: 32000 }, {
          model_info: { name: "GPT-5.4", id: "openai/gpt-5.4" },
          model_route_id: "openai%2Fgpt-5.4",
          is_headline: true,
        }),
      ]),
    )

    expect(html.match(/#1/g) ?? []).toHaveLength(1)
    expect(html.match(/#2/g) ?? []).toHaveLength(1)
    // One run has no range to report.
    expect(html).not.toContain("across 1 runs")
  })

  it("switches to every run when a protocol filter narrows the page, without renumbering", () => {
    setSearchParams("protocol.reasoning_tokens=number%3A32000")
    try {
      const html = render(summaryWith(OPUS_PAGE))

      // Three runs used a 32k thinking budget. The headline run keeps the
      // standing it had in the full field; the other two never take one.
      expect(html.match(/#1/g) ?? []).toHaveLength(1)
      expect(html).not.toContain("#2")
      expect(html).toContain(`Another run of the same model ${DASH} shown, not ranked`)
      expect(html).toContain(`Assisted run (answer feedback) ${DASH} shown, not ranked`)
      // A run list, not a folded row.
      expect(html).not.toContain("across 5 runs")
      expect(html).toContain("Show one row per model")
    } finally {
      setSearchParams()
    }
  })

  it("keeps a merged page's sources on their own rows, each with its own score", () => {
    // Two sources measured the same model. They share no protocol and no
    // comparability contract, so there is nothing to collapse them to:
    // each keeps its own score, standing and source.
    const summary = summaryWith([
      run(0.9, { feedback: "none", reasoning_tokens: 64000 }, {
        is_headline: true,
        collection_id: "uk-aisi-inference-scaling",
      }),
      result({
        score: 0.41,
        is_headline: true,
        collection_id: "some-leaderboard",
        protocol_condition: undefined,
        merged_source_slug: "llm-stats",
      }),
    ])
    const merged = {
      ...summary,
      collection: undefined,
      merged_view: true,
      protocol_axes_by_collection: { "uk-aisi-inference-scaling": PROTOCOL_AXES },
    } as unknown as BenchmarkEvalSummary

    const html = render(merged)
    expect(html).toContain("0.90")
    expect(html).toContain("0.41")
    expect(html.match(/#1/g) ?? []).toHaveLength(1)
    expect(html.match(/#2/g) ?? []).toHaveLength(1)
    // Nothing folded, so nothing claims to stand for both readings.
    expect(html).not.toContain("also listed")
    expect(html).not.toContain("across 2 runs")
  })

  it("ranks by the headline run, so a weak secondary run cannot demote its model", () => {
    // A's headline is 0.90 with a 0.10 second run; B's single run is 0.80.
    // By headline, A leads. By a mean across A's runs (0.50), B would.
    const html = render(
      summaryWith([
        run(0.9, { feedback: "none", reasoning_tokens: 32000 }, { is_headline: true }),
        run(0.1, { feedback: "none", reasoning_tokens: 16000 }),
        run(0.8, { feedback: "none", reasoning_tokens: 32000 }, {
          model_info: { name: "GPT-5.4", id: "openai/gpt-5.4" },
          model_route_id: "openai%2Fgpt-5.4",
          is_headline: true,
        }),
      ]),
    )

    expect(html.indexOf("Claude Opus 4.6")).toBeLessThan(html.indexOf("GPT-5.4"))
    expect(html).toContain("0.90")
    expect(html).toContain("0.80")
    // The mean is nowhere on the page; the two runs are in the range.
    expect(html).not.toContain("0.50")
    expect(html).toContain("0.10 to 0.90 across 2 runs")
    expect(html.match(/#1/g) ?? []).toHaveLength(1)
    expect(html.match(/#2/g) ?? []).toHaveLength(1)
  })

  it("does the same on a lower-is-better metric", () => {
    // A's headline is 0.10 with a 0.90 second run; B's single run is 0.20.
    // Lower is better, so A leads by headline and would trail by mean.
    const base = summaryWith([
      run(0.1, { feedback: "none", reasoning_tokens: 32000 }, { is_headline: true }),
      run(0.9, { feedback: "none", reasoning_tokens: 16000 }),
      run(0.2, { feedback: "none", reasoning_tokens: 32000 }, {
        model_info: { name: "GPT-5.4", id: "openai/gpt-5.4" },
        model_route_id: "openai%2Fgpt-5.4",
        is_headline: true,
      }),
    ])
    const html = render({
      ...base,
      metric_config: { ...base.metric_config, lower_is_better: true },
    } as BenchmarkEvalSummary)

    expect(html.indexOf("Claude Opus 4.6")).toBeLessThan(html.indexOf("GPT-5.4"))
    expect(html).toContain("0.10")
    expect(html).toContain("0.20")
    expect(html).not.toContain("0.50")
    expect(html).toContain("0.10 to 0.90 across 2 runs")
    expect(html.match(/#1/g) ?? []).toHaveLength(1)
    expect(html.match(/#2/g) ?? []).toHaveLength(1)
  })

  it("leaves a model with no headline reading as flat unranked runs", () => {
    // Nothing here is the producer's pick, so there is no reading whose
    // score and standing the row could report. Promoting the first run
    // would put a secondary number under the model's name.
    const html = render(
      summaryWith([
        run(0.9, { feedback: "none", reasoning_tokens: 32000 }, {
          model_info: { name: "GPT-5.4", id: "openai/gpt-5.4" },
          model_route_id: "openai%2Fgpt-5.4",
          is_headline: true,
        }),
        run(0.4, { feedback: "none", reasoning_tokens: 32000 }),
        run(0.3, { feedback: "none", reasoning_tokens: 16000 }),
      ]),
    )

    // One standing on the page, and it belongs to the model that has a
    // headline. The other model's two runs are listed, unranked.
    expect(html.match(/#1/g) ?? []).toHaveLength(1)
    expect(html).not.toContain("#2")
    expect(html).toContain("0.40")
    expect(html).toContain("0.30")
    // No fold was built around them, so nothing summarises them as one.
    expect(html).not.toContain("across 2 runs")
  })

  it("never turns a published curve's thresholds into protocol values", () => {
    // An aggregate-only record is ONE cell at its run cap, with every
    // curve point kept in the score details. Reading those thresholds as
    // protocol points would invent runs the study never reported.
    const score = 0.85
    const html = render(
      summaryWith([
        run(score, {}, {
          is_headline: true,
          protocol_condition: JSON.stringify({
            scaffold: "ReAct",
            compaction: true,
            feedback: "none",
            token_limit: 50_000_000,
            reasoning_tokens: null,
            reasoning_effort: null,
          }),
          score_details: {
            score,
            details: {
              published_curve: [
                { token_threshold: 500_000, score: 0.1 },
                { token_threshold: 1_500_000, score: 0.3 },
                { token_threshold: 15_000_000, score: 0.7 },
              ],
            },
          } as unknown as ModelResultForBenchmark["score_details"],
        }),
      ]),
    )
    expect(html).toContain("50M tokens")
    for (const threshold of ["500k tokens", "1.5M tokens", "15M tokens"]) {
      expect(html).not.toContain(threshold)
    }
    expect(html).not.toContain("Token threshold")
  })

  it("reads a row against its own collection's axes on a mixed page", () => {
    // A merged page pools rows from several sources. An axis the row's
    // own collection never declares does not apply to it; saying "Not
    // reported" there would blame the source for a silence that is not
    // theirs.
    const summary = summaryWith(
      [
        run(0.9, { feedback: "none", reasoning_tokens: 64000 }, {
          is_headline: true,
          collection_id: "uk-aisi-inference-scaling",
        }),
        result({
          score: 0.4,
          is_headline: true,
          model_info: { name: "GPT-5.4", id: "openai/gpt-5.4" },
          model_route_id: "openai%2Fgpt-5.4",
          collection_id: "some-leaderboard",
          protocol_condition: undefined,
        }),
      ],
    )
    const mixed = {
      ...summary,
      collection: undefined,
      merged_view: true,
      protocol_axes_by_collection: { "uk-aisi-inference-scaling": PROTOCOL_AXES },
    } as unknown as BenchmarkEvalSummary

    const html = render(mixed)
    expect(html).toContain("Token budget")
    expect(html).toContain("10M tokens")
    expect(html).toContain("Not applicable")
  })
})
