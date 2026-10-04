import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import { BenchmarkSignalsStrip, deriveSaturation } from "@/components/signals/benchmark-signals-strip"
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

type MetricConfigOverrides = Partial<BenchmarkEvalSummary["metric_config"]>

function summaryWith(
  modelResults: ModelResultForBenchmark[],
  metricConfig: MetricConfigOverrides = {},
): BenchmarkEvalSummary {
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
      unit: "proportion",
      ...metricConfig,
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

function tileText(summary: BenchmarkEvalSummary): string {
  const html = renderToStaticMarkup(
    createElement(AudienceModeProvider, null, createElement(BenchmarkSignalsStrip, { summary })),
  )
  const tile = html.slice(html.indexOf("sig-saturation"))
  return tile.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'")
}

function models(scores: number[], sampleSize?: number): ModelResultForBenchmark[] {
  return scores.map((score, i) => result(`m${i}`, score, sampleSize))
}

function breakdownValue(signal: ReturnType<typeof deriveSaturation>, label: string): string | undefined {
  return signal.breakdown.inputs.find((line) => line.label === label)?.value
}

const NO_BOUNDS = { min_score: undefined, max_score: undefined }
const SCALE_HEADLINE = "Not computed for this metric's scale."
const DASH = "\u2014"

describe("BenchmarkSignalsStrip, Saturation tile", () => {
  it("computes the reference index and names the band in the reference's words", () => {
    // compute_saturation_metrics([0.95, 0.94, 0.93, 0.92, 0.91], 1000) -> s_index 0.6763747065348314, "moderate"
    const summary = summaryWith(models([0.95, 0.94, 0.93, 0.92, 0.91], 1000))
    const signal = deriveSaturation(summary)
    expect(signal.statValue).toBe("68")
    expect(signal.statUnit).toBe("%")
    expect(signal.headline).toBe("Moderate: compression observed, sensitivity weakening.")
    expect(signal.detail).toBe("higher = more saturated")
    expect(tileText(summary)).toContain(
      "Saturation68%Moderate: compression observed, sensitivity weakening. · higher = more saturated",
    )
  })

  it("requires five models, as the reference does", () => {
    const signal = deriveSaturation(summaryWith(models([0.9, 0.85, 0.8, 0.75], 1000)))
    expect(signal.statValue).toBe(DASH)
    expect(signal.headline).toBe("Need at least 5 models, found 4.")
  })

  it("is not computed when no test-set size is reported", () => {
    const signal = deriveSaturation(summaryWith(models([0.9, 0.85, 0.8, 0.75, 0.7])))
    expect(signal.statValue).toBe(DASH)
    expect(signal.headline).toBe("No test-set size is recorded for this benchmark.")
  })

  it("is not computed when a score falls outside the declared bounds", () => {
    const signal = deriveSaturation(summaryWith(models([1.2, 0.85, 0.8, 0.75, 0.7], 1000)))
    expect(signal.statValue).toBe(DASH)
    expect(signal.headline).toBe(SCALE_HEADLINE)
  })

  it("is not computed for percent-scale scores declared with 0 to 1 bounds", () => {
    const signal = deriveSaturation(
      summaryWith(models([95, 94, 93, 92, 91], 1000), { unit: "percent" }),
    )
    expect(signal.statValue).toBe(DASH)
    expect(signal.headline).toBe(SCALE_HEADLINE)
  })

  it.each([
    ["infinite bounds", { unit: "points", min_score: Number.NEGATIVE_INFINITY, max_score: Number.POSITIVE_INFINITY }, [1500, 1480, 1460, 1440, 1420]],
    ["no bounds, scores above 1", { unit: undefined, ...NO_BOUNDS }, [8.9, 8.5, 8.1, 7.7, 7.3]],
    ["a 1 to 10 scale", { unit: undefined, min_score: 1, max_score: 10 }, [8.9, 8.5, 8.1, 7.7, 7.3]],
    ["a 0 to 10 scale with scores inside it", { unit: undefined, min_score: 0, max_score: 10 }, [0.9, 0.8, 0.7, 0.6, 0.5]],
    ["a non-proportion unit inside 0 to 1", { unit: "points" }, [0.9, 0.8, 0.7, 0.6, 0.5]],
    ["a negative score", { ...NO_BOUNDS }, [0.9, 0.8, 0.7, 0.6, -0.1]],
    ["percent scores above 100", { unit: "percent", ...NO_BOUNDS }, [120, 94, 93, 92, 91]],
    ["a lower-is-better metric", { lower_is_better: true }, [0.1, 0.2, 0.3, 0.4, 0.5]],
  ] as [string, MetricConfigOverrides, number[]][])("is not computed for %s", (_name, metricConfig, scores) => {
    const signal = deriveSaturation(summaryWith(models(scores, 1000), metricConfig))
    expect(signal.statValue).toBe(DASH)
    expect(signal.headline).toBe(SCALE_HEADLINE)
    expect(signal.detail).toBe("")
  })

  it("computes without declared bounds when every score lies in [0, 1]", () => {
    const signal = deriveSaturation(
      summaryWith(models([0.95, 0.94, 0.93, 0.92, 0.91], 1000), { unit: undefined, ...NO_BOUNDS }),
    )
    expect(signal.statValue).toBe("68")
    expect(breakdownValue(signal, "Score scale")).toBe("proportion")
  })

  it("divides declared percent scores by 100, as the paper script does", () => {
    // calc_saturation_metrics.py on top models 88.2, 87.9, 87.5, 86.1, 85.0 with n = 1319
    // -> Saturation Index 0.8516379261980636
    const signal = deriveSaturation(
      summaryWith(models([88.2, 87.9, 87.5, 86.1, 85.0], 1319), { unit: "percent", ...NO_BOUNDS }),
    )
    expect(signal.statValue).toBe("85")
    expect(signal.headline).toBe("High: models largely indistinguishable.")
    expect(breakdownValue(signal, "Score scale")).toBe("percent, divided by 100")
    expect(breakdownValue(signal, "Top score (s1)")).toBe("0.882")
  })

  it("does not label a zero standard error as saturated", () => {
    // saturation_utils.py returns s_index 1.0 here and the paper script leaves it empty.
    const spread = deriveSaturation(summaryWith(models([1, 0.5, 0.5, 0.5, 0], 1000)))
    expect(spread.statValue).toBe(DASH)
    expect(spread.headline).toBe("Not computed: the standard error is zero.")

    const allPerfect = deriveSaturation(summaryWith(models([1, 1, 1, 1, 1], 1000)))
    expect(allPerfect.statValue).toBe(DASH)
    expect(allPerfect.headline).toBe("Not computed: the standard error is zero.")
  })

  it("keeps the wording consistent when a low band is also within 1.96 SE", () => {
    // compute_saturation_metrics([0.9, 0.85, 0.8, 0.75, 0.7], 400)
    // -> s_index 0.06948345122280139, "low", is_statistically_similar True
    const summary = summaryWith(models([0.9, 0.85, 0.8, 0.75, 0.7], 400))
    const signal = deriveSaturation(summary)
    expect(signal.statValue).toBe("7")
    expect(signal.headline).toBe("Low: some clustering, meaningful separations remain.")
    expect(signal.detail).toBe("higher = more saturated")
    expect(breakdownValue(signal, "Statistically similar?")).toBe("yes (Δ ≤ 1.96·SE_Δ)")
    const text = tileText(summary)
    expect(text).not.toMatch(/within noise|distinguishable/)
  })

  it("takes one test-set size for the page: the most common across its models", () => {
    // n = 2000 -> s_index 0.5752394459869926; n = 100 would give 0.8836911949724001
    const signal = deriveSaturation(
      summaryWith([
        ...models([0.95, 0.94, 0.93, 0.92, 0.91], 100),
        ...[0.6, 0.5, 0.4, 0.3, 0.2, 0.1].map((score, i) => result(`rest${i}`, score, 2000)),
      ]),
    )
    expect(breakdownValue(signal, "Test-set size")).toBe("2000")
    expect(signal.statValue).toBe("58")
  })

  it("uses only the top five scores, including for the mean", () => {
    // compute_saturation_metrics([0.8, 0.79, 0.78, 0.77, 0.76], 1000)
    // -> s_index 0.8626295106100751, mean_score 0.78
    const signal = deriveSaturation(summaryWith(models([0.1, 0.77, 0.8, 0.2, 0.76, 0.79, 0.78], 1000)))
    expect(signal.statValue).toBe("86")
    expect(breakdownValue(signal, "Mean score (top 5)")).toBe("0.78")
    expect(breakdownValue(signal, "#5 score (s5)")).toBe("0.76")
  })

  it("ignores non-headline rows", () => {
    const extra = { ...result("m0-judge-b", 0.99, 1000), is_headline: false }
    const signal = deriveSaturation(summaryWith([...models([0.95, 0.94, 0.93, 0.92, 0.91], 1000), extra]))
    expect(signal.statValue).toBe("68")
  })
})
