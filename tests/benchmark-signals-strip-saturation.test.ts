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
    expect(signal.detail).toBe("higher = more saturated · n = 1000")
    expect(tileText(summary)).toContain(
      "Saturation68%Moderate: compression observed, sensitivity weakening. · higher = more saturated · n = 1000",
    )
  })

  it("requires five models, as the reference does", () => {
    const summary = summaryWith(models([0.9, 0.85, 0.8, 0.75], 1000))
    const signal = deriveSaturation(summary)
    expect(signal.statValue).toBe(DASH)
    expect(signal.headline).toBe("Need at least 5 models, found 4.")
    expect(signal.breakdown.empty).toBe("Not computed: found 4 models, need 5.")
    expect(tileText(summary)).not.toContain("n =")
  })

  it("is not computed when no test-set size is reported", () => {
    const signal = deriveSaturation(summaryWith(models([0.9, 0.85, 0.8, 0.75, 0.7])))
    expect(signal.statValue).toBe(DASH)
    expect(signal.headline).toBe("No test-set size is recorded for this benchmark.")
    expect(signal.breakdown.empty).toBe(
      "Not computed: no test-set size recorded (no sample_size or samples_number on these results).",
    )
  })

  it("does not call a present but unusable sample size absent", () => {
    const signal = deriveSaturation(summaryWith(models([0.9, 0.85, 0.8, 0.75, 0.7], 0)))
    expect(signal.statValue).toBe(DASH)
    expect(signal.headline).toBe("No usable test-set size for this benchmark.")
    expect(signal.breakdown.empty).toBe(
      "Not computed: no usable test-set size (sample_size or samples_number is present but not a positive number).",
    )
  })

  it("prints a nonzero value that rounds to zero as <0.001, never 0.000", () => {
    const signal = deriveSaturation(summaryWith(models([0.9004, 0.9003, 0.9002, 0.9001, 0.9], 1e12)))
    expect(signal.statValue).toBe("41")
    expect(breakdownValue(signal, "Score range")).toBe("<0.001")
    expect(breakdownValue(signal, "SE of top/#5 difference")).toBe("<0.001")
    expect(breakdownValue(signal, "Top score (s1)")).toBe("0.900")
    for (const input of signal.breakdown.inputs) {
      expect(input.value).not.toMatch(/-0\.000|NaN|Infinity/)
    }
  })

  it.each([
    [
      "a unit that is not a fraction",
      { unit: "points", ...NO_BOUNDS },
      [0.9, 0.8, 0.7, 0.6, 0.5],
      "Not computed: unit is points and no bounds are declared.",
    ],
    [
      "a lower-is-better metric without bounds",
      { lower_is_better: true, ...NO_BOUNDS },
      [0.1, 0.2, 0.3, 0.4, 0.5],
      "Not computed: lower is better and no bounds are declared.",
    ],
    [
      "scores above the declared bounds",
      { unit: "percent" },
      [87, 86, 85, 84, 83],
      "Not computed: top scores reach 87 but declared bounds are 0 to 1.",
    ],
    [
      "bounds that are not finite",
      { unit: "points", min_score: Number.NEGATIVE_INFINITY, max_score: Number.POSITIVE_INFINITY },
      [1500, 1480, 1460, 1440, 1420],
      "Not computed: unit is points and declared bounds -Infinity to Infinity are not a usable range.",
    ],
    [
      "unbounded scores above 100",
      { unit: undefined, ...NO_BOUNDS },
      [1500, 1480, 1460, 1440, 1420],
      "Not computed: top scores reach 1500, which reads as neither a 0 to 1 fraction nor a percentage, and no bounds are declared.",
    ],
    [
      "negative scores with bounds that are declared but unusable",
      { min_score: 0, max_score: 0 },
      [-0.1, -0.2, -0.3, -0.4, -0.5],
      "Not computed: top scores go as low as -0.5 and declared bounds 0 to 0 are not a usable range.",
    ],
    [
      "unbounded negative scores",
      { ...NO_BOUNDS },
      [-0.1, -0.2, -0.3, -0.4, -0.5],
      "Not computed: top scores go as low as -0.5 and no bounds are declared.",
    ],
  ] as [string, MetricConfigOverrides, number[], string][])(
    "states the reason in the dialog for %s",
    (_name, metricConfig, scores, reason) => {
      const signal = deriveSaturation(summaryWith(models(scores, 1000), metricConfig))
      expect(signal.statValue).toBe(DASH)
      expect(signal.breakdown.empty).toBe(reason)
    },
  )

  it("says so when the metric configuration cannot be read", () => {
    const summary = summaryWith(models([0.9, 0.8, 0.7, 0.6, 0.5], 1000))
    const signal = deriveSaturation({ ...summary, metric_config: "broken" as never })
    expect(signal.statValue).toBe(DASH)
    expect(signal.breakdown.empty).toBe("Not computed: metric configuration could not be read.")
  })

  it("formats the dialog's score-like values to three decimals and sizes as integers", () => {
    const signal = deriveSaturation(summaryWith(models([0.95, 0.94, 0.93, 0.92, 0.91], 1000)))
    for (const label of [
      "Top score (s1)",
      "#5 score (s5)",
      "Score range",
      "Mean score (top 5)",
      "Effective n (n_eff)",
      "SE of top/#5 difference",
      "Normalized range (R_norm)",
    ]) {
      expect(breakdownValue(signal, label)).toMatch(/^\d+\.\d{3}$/)
    }
    expect(breakdownValue(signal, "Top score (s1)")).toBe("0.950")
    expect(breakdownValue(signal, "Score range")).toBe("0.040")
    expect(breakdownValue(signal, "Test-set size")).toBe("1000")
  })

  it.each([
    ["a top score above the declared bounds", {}, [1.2, 0.85, 0.8, 0.75, 0.7]],
    ["percent-scale scores declared with 0 to 1 bounds", { unit: "percent" }, [95, 94, 93, 92, 91]],
    ["infinite bounds on a points metric", { unit: "points", min_score: Number.NEGATIVE_INFINITY, max_score: Number.POSITIVE_INFINITY }, [1500, 1480, 1460, 1440, 1420]],
    ["no bounds and scores above 100", { unit: undefined, ...NO_BOUNDS }, [1500, 1480, 1460, 1440, 1420]],
    ["an explicit non-fraction unit without bounds", { unit: "points", ...NO_BOUNDS }, [0.9, 0.8, 0.7, 0.6, 0.5]],
    ["a negative score among the top five", { ...NO_BOUNDS }, [-0.1, -0.2, -0.3, -0.4, -0.5]],
    ["a lower-is-better metric without bounds", { lower_is_better: true, ...NO_BOUNDS }, [0.1, 0.2, 0.3, 0.4, 0.5]],
  ] as [string, MetricConfigOverrides, number[]][])("is not computed for %s", (_name, metricConfig, scores) => {
    const signal = deriveSaturation(summaryWith(models(scores, 1000), metricConfig))
    expect(signal.statValue).toBe(DASH)
    expect(signal.headline).toBe(SCALE_HEADLINE)
    expect(signal.detail).toBe("")
  })

  it("validates only the five scores used: an out-of-range sixth still computes", () => {
    // compute_saturation_metrics([0.95, 0.94, 0.93, 0.92, 0.91], 1000) -> s_index 0.6763747065348314
    const signal = deriveSaturation(summaryWith(models([0.95, 0.94, 0.93, 0.92, 0.91, -0.1], 1000)))
    expect(signal.statValue).toBe("68")
  })

  it("computes without declared bounds when every score lies in [0, 1]", () => {
    const signal = deriveSaturation(
      summaryWith(models([0.95, 0.94, 0.93, 0.92, 0.91], 1000), { unit: undefined, ...NO_BOUNDS }),
    )
    expect(signal.statValue).toBe("68")
  })

  it("reads undeclared percent scores as percentages", () => {
    // calc_saturation_metrics.py on top models 88.2, 87.9, 87.5, 86.1, 85.0 with n = 1319
    // -> Saturation Index 0.8516379261980636
    const signal = deriveSaturation(
      summaryWith(models([88.2, 87.9, 87.5, 86.1, 85.0], 1319), { unit: "percent", ...NO_BOUNDS }),
    )
    expect(signal.statValue).toBe("85")
    expect(signal.headline).toBe("High: models largely indistinguishable.")
    expect(breakdownValue(signal, "Top score (s1)")).toBe("0.882 (reported 88.2)")
  })

  it("normalises by declared bounds", () => {
    // 1 to 10 scale: (s - 1) / 9 -> [0.8, 0.7, 0.6, 0.5, 0.4]
    // compute_saturation_metrics([0.8, 0.7, 0.6, 0.5, 0.4], 1000) -> s_index 3.210414052979477e-06, "very_low"
    const signal = deriveSaturation(
      summaryWith(models([8.2, 7.3, 6.4, 5.5, 4.6], 1000), { unit: "points", min_score: 1, max_score: 10 }),
    )
    expect(signal.statValue).toBe("<1")
    expect(signal.headline).toBe("Very low: strong discriminative power.")
    expect(breakdownValue(signal, "Top score (s1)")).toBe("0.800 (reported 8.2)")
    expect(breakdownValue(signal, "#5 score (s5)")).toBe("0.400 (reported 4.6)")
  })

  it("inverts a lower-is-better metric so the lowest raw scores are the top five", () => {
    // 1 - s -> top five [0.9, 0.85, 0.8, 0.75, 0.7]
    // compute_saturation_metrics([0.9, 0.85, 0.8, 0.75, 0.7], 400) -> s_index 0.06948345122280139, "low"
    const signal = deriveSaturation(
      summaryWith(models([0.6, 0.3, 0.1, 0.25, 0.9, 0.15, 0.2], 400), { lower_is_better: true }),
    )
    expect(signal.statValue).toBe("7")
    expect(breakdownValue(signal, "Top score (s1)")).toBe("0.900 (reported 0.1)")
    expect(breakdownValue(signal, "#5 score (s5)")).toBe("0.700 (reported 0.3)")
  })

  it("computes when all five scores are equal at a boundary", () => {
    // compute_saturation_metrics([1, 1, 1, 1, 1], 1000) -> se_delta 0.0, r_norm 0.0, s_index 1.0, "very_high"
    const signal = deriveSaturation(summaryWith(models([1, 1, 1, 1, 1], 1000)))
    expect(signal.statValue).toBe("100")
    expect(signal.headline).toBe("Very high: no reliable signal for comparison.")
  })

  it("does not label a top score of 1 and a 5th of 0 as saturated", () => {
    // saturation_utils.py returns s_index 1.0 here and the paper script leaves it empty.
    const signal = deriveSaturation(summaryWith(models([1, 0.5, 0.5, 0.5, 0], 1000)))
    expect(signal.statValue).toBe(DASH)
    expect(signal.headline).toBe("Not computed: the standard error is zero.")
  })

  it("keeps the wording consistent when a low band is also within 1.96 SE", () => {
    // compute_saturation_metrics([0.9, 0.85, 0.8, 0.75, 0.7], 400)
    // -> s_index 0.06948345122280139, "low", is_statistically_similar True
    const summary = summaryWith(models([0.9, 0.85, 0.8, 0.75, 0.7], 400))
    const signal = deriveSaturation(summary)
    expect(signal.statValue).toBe("7")
    expect(signal.headline).toBe("Low: some clustering, meaningful separations remain.")
    expect(signal.detail).toBe("higher = more saturated · n = 400")
    expect(breakdownValue(signal, "Statistically similar?")).toBe("yes (Δ ≤ 1.96·SE_Δ)")
    expect(tileText(summary)).not.toMatch(/within noise|distinguishable/)
  })

  it("takes one test-set size for the page: the most common across its models", () => {
    // compute_saturation_metrics([0.95, 0.94, 0.93, 0.92, 0.91], 2000) -> s_index 0.5752394459869926
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
    expect(breakdownValue(signal, "Mean score (top 5)")).toBe("0.780")
    expect(breakdownValue(signal, "#5 score (s5)")).toBe("0.760")
  })

  it("takes the fifth of the sorted scores when several tie there", () => {
    // compute_saturation_metrics([0.9, 0.8, 0.8, 0.7, 0.7], 1000) -> s_index 0.014752094392597552, mean_score 0.78
    const signal = deriveSaturation(summaryWith(models([0.7, 0.8, 0.7, 0.9, 0.7, 0.8, 0.7], 1000)))
    expect(signal.statValue).toBe("1")
    expect(breakdownValue(signal, "#5 score (s5)")).toBe("0.700")
    expect(breakdownValue(signal, "Mean score (top 5)")).toBe("0.780")
  })

  it("ignores non-headline rows", () => {
    const extra = { ...result("m0-judge-b", 0.99, 1000), is_headline: false }
    const signal = deriveSaturation(summaryWith([...models([0.95, 0.94, 0.93, 0.92, 0.91], 1000), extra]))
    expect(signal.statValue).toBe("68")
  })
})
