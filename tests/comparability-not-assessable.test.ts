import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import { ResearcherReproducibilityCard } from "@/components/researcher-reproducibility-card"
import { BenchmarkSignalsStrip, deriveComparability } from "@/components/signals/benchmark-signals-strip"
import { ComparabilityPanel } from "@/components/signals/comparability-panel"
import type {
  BenchmarkEvalSummary,
  BenchmarkLeaderboardMetric,
  BenchmarkLeaderboardRow,
  ModelResultForBenchmark,
} from "@/lib/eval-processing"

function makeModelResult(
  overrides: Partial<ModelResultForBenchmark> = {},
): ModelResultForBenchmark {
  const score = overrides.score ?? 0.84
  return {
    model_info: { name: "Apertus-v1.5-70B", id: "swiss-ai/Apertus-v1.5-70B" },
    model_route_id: "swiss-ai%2FApertus-v1.5-70B",
    score,
    score_details: { score },
    evaluation_timestamp: "2026-09-16T00:00:00Z",
    source_metadata: {
      source_name: "swissai-apertus-evals",
      source_type: "leaderboard",
      source_organization_name: "Swiss AI",
      evaluator_relationship: "first_party",
    },
    source_data: { dataset_name: "BBQ" },
    result: {
      evaluation_name: "BBQ",
      evaluation_timestamp: "2026-09-16T00:00:00Z",
      metric_config: {
        evaluation_description: "BBQ accuracy",
        lower_is_better: false,
        score_type: "continuous",
      },
      score_details: { score },
    },
    ...overrides,
  }
}

const BBQ_METRICS: BenchmarkLeaderboardMetric[] = [
  {
    column_key: "accuracy",
    metric_summary_id: "accuracy",
    metric_name: "accuracy",
    display_name: "Accuracy",
    lower_is_better: false,
    scope: "root",
  },
  {
    column_key: "bias_amb",
    metric_summary_id: "bias_amb",
    metric_name: "bias_amb",
    display_name: "Bias (amb)",
    lower_is_better: true,
    scope: "root",
  },
  {
    column_key: "bias_dis",
    metric_summary_id: "bias_dis",
    metric_name: "bias_dis",
    display_name: "Bias (dis)",
    lower_is_better: true,
    scope: "root",
  },
]

const BBQ_ROWS: BenchmarkLeaderboardRow[] = [
  {
    model_info: { name: "Apertus-v1.5-70B", id: "swiss-ai/Apertus-v1.5-70B" },
    model_route_id: "swiss-ai%2FApertus-v1.5-70B",
    evaluation_timestamp: "2026-09-16T00:00:00Z",
    source_metadata: {
      source_name: "swissai-apertus-evals",
      source_type: "leaderboard",
      source_organization_name: "Swiss AI",
      evaluator_relationship: "first_party",
    },
    source_data: { dataset_name: "BBQ" },
    values: { accuracy: 0.84, bias_amb: 0.02, bias_dis: -0.01 },
    comparability_status_by_metric: {
      accuracy: "ok",
      bias_amb: "no_bounds",
      bias_dis: "no_bounds",
    },
    metrics_present: 3,
  },
  {
    model_info: { name: "Llama-3.3-70B-Instruct", id: "meta-llama/Llama-3.3-70B-Instruct" },
    model_route_id: "meta-llama%2FLlama-3.3-70B-Instruct",
    evaluation_timestamp: "2026-09-16T00:00:00Z",
    source_metadata: {
      source_name: "swissai-apertus-evals",
      source_type: "leaderboard",
      source_organization_name: "Swiss AI",
      evaluator_relationship: "third_party",
    },
    source_data: { dataset_name: "BBQ" },
    values: { accuracy: 0.82, bias_amb: 0.04, bias_dis: 0.03 },
    comparability_status_by_metric: {
      accuracy: "mixed_scale",
      bias_amb: "no_bounds",
      bias_dis: "no_bounds",
    },
    metrics_present: 3,
  },
]

function makeSummary(overrides: Partial<BenchmarkEvalSummary> = {}): BenchmarkEvalSummary {
  return {
    evaluation_id: "swissai-apertus-evals%2Fbbq",
    evaluation_name: "BBQ",
    composite_benchmark_key: "swissai-apertus-evals",
    composite_benchmark_name: "swissai-apertus-evals",
    metric_config: {
      evaluation_description: "BBQ accuracy",
      lower_is_better: false,
      score_type: "continuous",
    },
    model_results: [makeModelResult()],
    models_count: 2,
    evaluator_names: ["Swiss AI"],
    source_types: [],
    third_party_ratio: 0.5,
    missing_generation_config_count: 0,
    best_model: { name: "Apertus-v1.5-70B", score: 0.84 },
    worst_model: null,
    avg_score: 0.83,
    avg_score_norm: 0.83,
    ...overrides,
  } as BenchmarkEvalSummary
}

describe("Comparability (X) signal strip & dialog — not assessable verdicts", () => {
  it("surfaces unbounded metrics and mixed-scale outliers on multi-metric pages", () => {
    const summary = makeSummary({
      leaderboard_metrics: BBQ_METRICS,
      leaderboard_rows: BBQ_ROWS,
    })

    const signal = deriveComparability(summary, null)
    expect(signal.statValue).toBe("—")
    expect(signal.headline).toBe("2 of 3 metrics not assessable.")
    expect(signal.detail).toContain("no declared bounds")
    expect(signal.detail).toContain("1 model mixed scale")
    expect(signal.breakdown.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Assessable metrics", value: "1 of 3" }),
        expect.objectContaining({
          label: "Not assessable metrics",
          value: "2 (Bias (amb), Bias (dis))",
        }),
      ]),
    )
    expect(signal.breakdown.rows).toEqual([
      expect.objectContaining({
        label: "Accuracy",
        status: "warn",
        detail: expect.stringContaining("Llama-3.3-70B-Instruct"),
      }),
      expect.objectContaining({
        label: "Bias (amb)",
        status: "missing",
        detail: "Not assessable — no declared bounds",
      }),
      expect.objectContaining({
        label: "Bias (dis)",
        status: "missing",
        detail: "Not assessable — no declared bounds",
      }),
    ])

    const html = renderToStaticMarkup(
      createElement(AudienceModeProvider, null, createElement(BenchmarkSignalsStrip, { summary })),
    )
    expect(html).toContain("2 of 3 metrics not assessable.")
  })

  it("reports single-metric no_bounds pages cleanly", () => {
    const summary = makeSummary({
      model_results: [
        makeModelResult({ comparability_status: "no_bounds" }),
        makeModelResult({
          model_info: { name: "Llama-3.3-70B-Instruct", id: "meta-llama/Llama-3.3-70B-Instruct" },
          model_route_id: "meta-llama%2FLlama-3.3-70B-Instruct",
          comparability_status: "no_bounds",
        }),
      ],
    })
    const signal = deriveComparability(summary, null)
    expect(signal.headline).toBe("Not assessable for this metric's scale.")
    expect(signal.detail).toContain("no declared bounds")
    expect(signal.breakdown.rows?.[0]).toEqual(
      expect.objectContaining({
        status: "missing",
        detail: expect.stringContaining("no declared bounds"),
      }),
    )
  })

  it("keeps the existing single-source message when every row is assessed", () => {
    const summary = makeSummary({
      model_results: [makeModelResult({ comparability_status: "ok" })],
    })
    const signal = deriveComparability(summary, null)
    expect(signal.headline).toBe("Only one source reports this benchmark.")
  })

  it("ignores subtask-scope slice columns when root metrics exist", () => {
    const summary = makeSummary({
      leaderboard_metrics: [
        ...BBQ_METRICS,
        {
          column_key: "accuracy::age",
          metric_summary_id: "accuracy::age",
          metric_name: "accuracy",
          display_name: "Accuracy",
          lower_is_better: false,
          scope: "subtask",
          subtask_key: "age",
          subtask_name: "Age",
        },
      ],
      leaderboard_rows: BBQ_ROWS.map((r) => ({
        ...r,
        values: { ...r.values, "accuracy::age": 0.8 },
        comparability_status_by_metric: {
          ...r.comparability_status_by_metric,
          "accuracy::age": "no_bounds",
        },
      })),
    })
    const signal = deriveComparability(summary, null)
    // Should still count the 3 root metrics, not inflate to 4 with the subtask slice.
    expect(signal.headline).toBe("2 of 3 metrics not assessable.")
    expect(signal.breakdown.rows).toHaveLength(3)
  })

  it("does not inflate partial-metric model counts with models from fully-unassessable columns", () => {
    const summary = makeSummary({
      leaderboard_metrics: BBQ_METRICS.slice(0, 2),
      leaderboard_rows: [
        {
          ...BBQ_ROWS[0],
          comparability_status_by_metric: { accuracy: "ok", bias_amb: "no_bounds" },
        },
        {
          ...BBQ_ROWS[1],
          // Accuracy has a partial non-mixed_scale verdict (no_bounds on 1 of 2 rows)
          // while Bias (amb) is no_bounds on both rows.
          comparability_status_by_metric: { accuracy: "no_bounds", bias_amb: "no_bounds" },
        },
      ],
    })
    const signal = deriveComparability(summary, null)
    expect(signal.headline).toBe("1 of 2 metrics not assessable.")
    // Only 1 model (not 2) is affected on the partially-unassessable Accuracy column.
    expect(signal.detail).toContain("1 model no declared bounds")
    expect(signal.detail).not.toContain("2 models")
  })
})

describe("ComparabilityPanel — not assessable summary", () => {
  it("names unbounded metrics and mixed-scale models on multi-metric pages", () => {
    const html = renderToStaticMarkup(
      createElement(
        AudienceModeProvider,
        null,
        createElement(ComparabilityPanel, {
          modelResults: [makeModelResult()],
          leaderboardMetrics: BBQ_METRICS,
          leaderboardRows: BBQ_ROWS,
        }),
      ),
    )
    expect(html).toContain("Bias (amb) and Bias (dis)")
    expect(html).toContain("declare no scale bounds")
    expect(html).toContain("Llama-3.3-70B-Instruct")
    expect(html).toContain("#row-meta-llama%2FLlama-3.3-70B-Instruct")
  })

  it("uses plain-language phrasing in policy mode", () => {
    const html = renderToStaticMarkup(
      createElement(AudienceModeProvider, {
        initialMode: "policy",
        children: createElement(ComparabilityPanel, {
          modelResults: [makeModelResult()],
          leaderboardMetrics: BBQ_METRICS,
          leaderboardRows: BBQ_ROWS,
        }),
      }),
    )
    expect(html).toContain("could not be cross-checked")
    expect(html).not.toContain("not assessable")
  })
})

describe("ResearcherReproducibilityCard — expanded row comparability status", () => {
  it("shows per-metric not-assessable reasons when expanded on an unassessable row", () => {
    const html = renderToStaticMarkup(
      createElement(
        AudienceModeProvider,
        null,
        createElement(ResearcherReproducibilityCard, {
          modelResult: makeModelResult(),
          comparabilityByMetric: [
            { label: "Accuracy", status: "mixed_scale" },
            { label: "Bias (amb)", status: "no_bounds" },
          ],
        }),
      ),
    )
    expect(html).toContain("Comparability")
    expect(html).toContain("Not assessable (mixed scales)")
    expect(html).toContain("Not assessable (no declared bounds)")
  })

  it("stays quiet when the row's comparability was assessed ok", () => {
    const html = renderToStaticMarkup(
      createElement(
        AudienceModeProvider,
        null,
        createElement(ResearcherReproducibilityCard, {
          modelResult: makeModelResult({ comparability_status: "ok" }),
          comparabilityByMetric: [{ label: "Accuracy", status: "ok" }],
        }),
      ),
    )
    expect(html).not.toContain("Not assessable")
  })
})
