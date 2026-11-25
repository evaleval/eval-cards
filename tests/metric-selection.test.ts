// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import {
  BenchmarkDetail,
  buildBenchmarkGroups,
  buildOverlapSummaryInputs,
} from "@/components/benchmark-detail"
import { EvalDetail } from "@/components/eval-detail"
import {
  MetricFilterBar,
  MetricFilterControl,
  type MetricFilterItem,
} from "@/components/metric-filter-control"
import { deriveSaturation } from "@/components/signals/benchmark-signals-strip"
import type { ComparisonIndex, EvalHierarchy } from "@/lib/backend-artifacts"
import type { BenchmarkEvaluation, EvaluationResult, ModelSummaryCore } from "@/lib/benchmark-schema"
import type { BenchmarkEvalSummary, BenchmarkLeaderboardRow } from "@/lib/eval-processing"
import {
  buildEvalMetricFilterOptions,
  buildModelMetricFilterOptions,
  computeMetricStandings,
  filterModelEntriesByMetric,
  humanizeMetricIdentifier,
  isStderrMetricSummaryId,
  isStatedUnitlessReading,
} from "@/lib/metric-selection"
import { buildOverlapRows } from "@/lib/overlaps"

vi.mock("next/navigation", () => import("./next-navigation-stub"))
vi.mock("@/lib/dashboard-data-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard-data-client")>()),
  fetchPeerRanks: () => Promise.resolve({}),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeResult(
  overrides: Omit<Partial<EvaluationResult>, "metric_config" | "score_details"> & {
    metric_key: string
    score: number
    metric_config?: Partial<EvaluationResult["metric_config"]>
    score_details?: Partial<EvaluationResult["score_details"]>
  },
): EvaluationResult {
  const { metric_key, score, metric_config, score_details, ...rest } = overrides
  return {
    evaluation_name: overrides.display_name ?? metric_key,
    evaluation_timestamp: "2026-06-01T00:00:00Z",
    metric_key,
    metric_summary_id: `eval%3A${metric_key}`,
    is_lead_metric: false,
    metric_config: {
      evaluation_description: overrides.display_name ?? metric_key,
      lower_is_better: false,
      score_type: "continuous",
      ...metric_config,
    },
    score_details: {
      score,
      ...score_details,
    },
    ...rest,
  } as EvaluationResult
}

function makeEval(params: {
  evalSummaryId: string
  evaluationId?: string
  displayName: string
  primaryMetricId?: string
  familyId?: string
  isSlice?: boolean
  parentBenchmarkId?: string
  results: EvaluationResult[]
}): BenchmarkEvaluation {
  return {
    evaluation_id: params.evaluationId ?? `${params.evalSummaryId}/default/1`,
    eval_summary_id: params.evalSummaryId,
    benchmark: params.displayName,
    display_name: params.displayName,
    family_id: params.familyId ?? "swissai",
    benchmark_family_name: "SwissAI",
    primary_metric_id: params.primaryMetricId,
    is_slice: params.isSlice,
    parent_benchmark_id: params.parentBenchmarkId,
    retrieved_timestamp: "1770000000",
    model_info: {
      id: "nvidia/nemotron-3-5-lightning",
      name: "Nemotron 3.5 Lightning",
      developer: "NVIDIA",
    },
    source_metadata: {
      source_name: "SwissAI",
      source_type: "leaderboard",
      source_organization_name: "SwissAI",
      evaluator_relationship: "third_party",
    },
    source_data: { dataset_name: params.displayName },
    evaluation_results: params.results,
  } as BenchmarkEvaluation
}

async function withMounted(
  element: ReactElement,
  run: (container: HTMLElement) => Promise<void>,
  initialMode: "research" | "policy" = "research",
) {
  window.localStorage.setItem("eval-cards-audience-mode", initialMode)
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(createElement(AudienceModeProvider, { initialMode, children: element }))
    })
    await run(container)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    document.body.innerHTML = ""
    window.localStorage.removeItem("eval-cards-audience-mode")
  }
}

describe("lib/metric-selection — pure filtering, deduplication, and bad-input refusal", () => {
  it("refuses stderr companions, blank metric keys, and non-finite scores while deduplicating multi-tag buckets and slice folds", () => {
    const squadEval = makeEval({
      evalSummaryId: "swissai%2Fsquad-v2",
      displayName: "SQuAD v2",
      primaryMetricId: "exact-match",
      results: [
        makeResult({
          metric_key: "exact-match",
          display_name: "Exact Match",
          score: 0.72,
          is_lead_metric: true,
          metric_config: { lower_is_better: false, unit: "proportion" },
        }),
        makeResult({
          metric_key: "lenient-accuracy",
          display_name: "Lenient Accuracy",
          score: 0.86,
          is_lead_metric: false,
          metric_config: { lower_is_better: false, unit: "proportion" },
        }),
        // Bad inputs that must be refused:
        makeResult({
          metric_key: "exact-match",
          metric_summary_id: "eval%3Aexact_match_stderr",
          score: 0.01,
        }),
        makeResult({
          metric_key: "   ",
          score: 0.5,
        }),
        makeResult({
          metric_key: "nan-metric",
          score: Number.NaN,
        }),
      ],
    })

    // Two slice evals under one parent benchmark should count as 1 benchmark group.
    const sliceA = makeEval({
      evalSummaryId: "bfcl%2Fbfcl-simple",
      displayName: "BFCL Simple",
      isSlice: true,
      parentBenchmarkId: "bfcl-v3",
      results: [
        makeResult({
          metric_key: "lenient-accuracy",
          display_name: "Lenient Accuracy",
          score: 0.91,
          is_lead_metric: false,
          metric_config: { lower_is_better: false, unit: "proportion" },
        }),
      ],
    })
    const sliceB = makeEval({
      evalSummaryId: "bfcl%2Fbfcl-parallel",
      displayName: "BFCL Parallel",
      isSlice: true,
      parentBenchmarkId: "bfcl-v3",
      results: [
        makeResult({
          metric_key: "lenient-accuracy",
          display_name: "Lenient Accuracy",
          score: 0.88,
          is_lead_metric: false,
          metric_config: { lower_is_better: false, unit: "proportion" },
        }),
      ],
    })

    // Simulate squadEval duplicated across two evaluations_by_tag buckets ("reading", "qa"):
    const entries = [
      ...squadEval.evaluation_results.map((result) => ({ evaluation: squadEval, result })),
      ...squadEval.evaluation_results.map((result) => ({ evaluation: squadEval, result })),
      ...sliceA.evaluation_results.map((result) => ({ evaluation: sliceA, result })),
      ...sliceB.evaluation_results.map((result) => ({ evaluation: sliceB, result })),
    ]

    expect(isStderrMetricSummaryId("eval%3Aexact_match_stderr")).toBe(true)
    expect(humanizeMetricIdentifier("pass-at-10")).toBe("Pass@10")

    const options = buildModelMetricFilterOptions(entries)
    expect(options.map((o) => o.metricKey)).toEqual(["lenient-accuracy", "exact-match"])
    // 1 group for squad-v2 + 1 folded parent group for bfcl-v3 = 2 groups (no multi-tag double count!)
    expect(options[0]).toMatchObject({
      metricKey: "lenient-accuracy",
      label: "Lenient Accuracy",
      evalCount: 2,
      leadEvalCount: 0,
      nonLeadEvalCount: 2,
      direction: "higher",
    })
    expect(options[1]).toMatchObject({
      metricKey: "exact-match",
      label: "Exact Match",
      evalCount: 1,
      leadEvalCount: 1,
      nonLeadEvalCount: 0,
    })
  })

  it("marks at most one setup run per eval_summary_id as lead when filtering, while keeping tag-bucket duplicates consistent and retaining paired stderr", () => {
    const zeroShot = makeEval({
      evalSummaryId: "ifeval%2Fifeval",
      evaluationId: "ifeval%2Fifeval/0-shot/1",
      displayName: "IFEval",
      primaryMetricId: "prompt_strict_acc",
      results: [
        makeResult({
          metric_key: "inst_loose_acc",
          metric_summary_id: "ifeval%3Ainst_loose_acc",
          display_name: "Instruction Loose Accuracy",
          score: 0.81,
          is_lead_metric: false,
          metric_config: { lower_is_better: false, unit: "proportion" },
        }),
        makeResult({
          metric_key: "inst_loose_stderr",
          metric_summary_id: "ifeval%3Ainst_loose_stderr",
          score: 0.015,
          metric_config: { lower_is_better: false, unit: "proportion" },
        }),
        makeResult({
          metric_key: "prompt_strict_stderr",
          metric_summary_id: "ifeval%3Aprompt_strict_stderr",
          score: 0.02,
          metric_config: { lower_is_better: false, unit: "proportion" },
        }),
      ],
    })
    const fiveShot = makeEval({
      evalSummaryId: "ifeval%2Fifeval",
      evaluationId: "ifeval%2Fifeval/5-shot/1",
      displayName: "IFEval",
      primaryMetricId: "prompt_strict_acc",
      results: [
        makeResult({
          metric_key: "inst_loose_acc",
          metric_summary_id: "ifeval%3Ainst_loose_acc",
          display_name: "Instruction Loose Accuracy",
          score: 0.85,
          is_lead_metric: false,
          metric_config: { lower_is_better: false, unit: "proportion" },
        }),
      ],
    })

    // Duplicate zeroShot across two tag buckets, plus fiveShot:
    const rawEntries = [
      ...zeroShot.evaluation_results.map((result) => ({
        evaluation: zeroShot,
        result,
        category: "instruction_following" as any,
      })),
      ...zeroShot.evaluation_results.map((result) => ({
        evaluation: zeroShot,
        result,
        category: "general" as any,
      })),
      ...fiveShot.evaluation_results.map((result) => ({
        evaluation: fiveShot,
        result,
        category: "instruction_following" as any,
      })),
    ]

    const filtered = filterModelEntriesByMetric(rawEntries, "inst_loose_acc")
    // Retains inst_loose_acc + paired inst_loose_stderr, drops unrelated prompt_strict_stderr
    expect(
      filtered.some((e) => e.result.metric_summary_id === "ifeval%3Aprompt_strict_stderr"),
    ).toBe(false)
    expect(
      filtered.some((e) => e.result.metric_summary_id === "ifeval%3Ainst_loose_stderr"),
    ).toBe(true)

    const groups = buildBenchmarkGroups(filtered, undefined, "/models/test", "inst_loose_acc")
    expect(groups).toHaveLength(1)
    expect(groups[0].variants).toHaveLength(2)
    // Exactly ONE variant in the group is marked is_lead_metric: true, and it carries auxStderr!
    const leadVariants = groups[0].variants.filter((v) => v.result.is_lead_metric)
    expect(leadVariants).toHaveLength(1)
    expect(leadVariants[0].auxStderr).toBe(0.015)
    expect(groups[0].headline.kind).toBe("own")
    expect(groups[0].evalDetailHref).toContain("metric=inst_loose_acc")
  })

  it("formats stated-unitless secondary metrics as raw numbers in Scores (never %)", () => {
    const bbqEval = makeEval({
      evalSummaryId: "helm%2Fbbq",
      displayName: "BBQ",
      primaryMetricId: "accuracy",
      results: [
        makeResult({
          metric_key: "accuracy",
          display_name: "Accuracy",
          score: 0.91,
          is_lead_metric: true,
          metric_config: { lower_is_better: false, unit: "proportion" },
        }),
        makeResult({
          metric_key: "amb_bias_score",
          display_name: "Ambiguous Bias Score",
          score: 0.097,
          is_lead_metric: false,
          metric_config: { lower_is_better: true, unit: undefined },
        }),
      ],
    })

    expect(isStatedUnitlessReading(bbqEval.evaluation_results[1], bbqEval)).toBe(true)
    expect(isStatedUnitlessReading(bbqEval.evaluation_results[0], bbqEval)).toBe(false)

    const rawEntries = bbqEval.evaluation_results.map((result) => ({
      evaluation: bbqEval,
      result,
      category: "safety" as any,
    }))
    const filtered = filterModelEntriesByMetric(rawEntries, "amb_bias_score")
    const groups = buildBenchmarkGroups(filtered, undefined, "/models/test", "amb_bias_score")
    expect(groups[0].avgDisplayScore).toBe("0.097")

    const overlapInputs = buildOverlapSummaryInputs(groups)
    const rows = buildOverlapRows({
      benchmarkIndex: [],
      comparisonIndex: null,
      currentModelRouteId: "nvidia%2Fnemotron-3-5-lightning",
      currentModelIdentityKeys: new Set(["nvidia/nemotron-3-5-lightning"]),
      familyDisplayByKey: new Map(),
      leadReadings: overlapInputs.leadReadings,
      summaryCandidates: overlapInputs.candidates,
      summaryJoinRows: overlapInputs.joinRows,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].statedUnitless).toBe(true)
    expect(rows[0].appearances[0].displayScore).toBe("0.097")
    expect(rows[0].appearances[0].displayScore).not.toContain("%")

    // Population A (comparison-index) with score_canonical = 0.097 and [-1, 1] bounds
    // must ALSO stay statedUnitless (never rescaled ×100 to "9.7%")!
    const popARows = buildOverlapRows({
      benchmarkIndex: [
        {
          key: "bbq",
          display_name: "BBQ",
          appearances: [
            {
              family_key: "helm",
              benchmark_key: "bbq",
              constituent_evaluation_ids: ["helm%2Fbbq"],
            },
            {
              family_key: "swissai",
              benchmark_key: "bbq",
              constituent_evaluation_ids: ["swissai%2Fbbq"],
            },
          ] as any,
        },
      ],
      comparisonIndex: {
        generated_at: "",
        config_version: 2,
        metric_group_order: [],
        by_model: {
          "nvidia%2Fnemotron-3-5-lightning": {
            "helm%2Fbbq": {
              "eval%3Aamb_bias_score": {
                score: 0.097,
                score_canonical: 0.097,
                scale_conversion: "none",
                rank: 1,
                total: 2,
                submission_count: 1,
                submission_axis: "default",
              },
            },
          },
        },
        evals: {
          "helm%2Fbbq": {
            evaluation_id: "helm%2Fbbq",
            display_name: "BBQ",
            benchmark_id: "bbq",
            family_id: "helm",
            is_slice: false,
            parent_benchmark_id: null,
            metrics: [
              {
                metric_summary_id: "eval%3Aamb_bias_score",
                metric_id: "amb_bias_score",
                metric_key: "amb_bias_score",
                metric_name: "Ambiguous Bias Score",
                group: "safety",
                group_order: 1,
                lower_is_better: true,
                unit: null,
                canonical_min_score: -1,
                canonical_max_score: 1,
                scores: [],
              },
            ],
          },
        },
      } as unknown as ComparisonIndex,
      currentModelRouteId: "nvidia%2Fnemotron-3-5-lightning",
      currentModelIdentityKeys: new Set(["nvidia/nemotron-3-5-lightning"]),
      familyDisplayByKey: new Map([["helm", "HELM"]]),
      leadReadings: overlapInputs.leadReadings,
      summaryCandidates: overlapInputs.candidates,
      summaryJoinRows: overlapInputs.joinRows,
    })
    expect(popARows).toHaveLength(1)
    expect(popARows[0].statedUnitless).toBe(true)
    expect(popARows[0].mean).toBeCloseTo(0.097)
    expect(popARows[0].appearances[0].displayScore).toBe("0.097")
    expect(popARows[0].appearances[0].displayScore).not.toContain("%")
  })

  it("computes competition standings independent of sort order and withholds rank when direction is unknown", () => {
    const sampleRows = [
      { id: "m-tied-1", score: 0.2 },
      { id: "m-tied-2", score: 0.2 },
      { id: "m-third", score: 0.45 },
      { id: "m-missing", score: null },
    ]
    const lowerRanks = computeMetricStandings(
      sampleRows,
      (r) => r.score,
      (r) => r.id,
      true,
    )
    expect(lowerRanks.get("m-tied-1")).toBe(1)
    expect(lowerRanks.get("m-tied-2")).toBe(1)
    expect(lowerRanks.get("m-third")).toBe(3)
    expect(lowerRanks.has("m-missing")).toBe(false)

    const unknownDirRanks = computeMetricStandings(
      sampleRows,
      (r) => r.score,
      (r) => r.id,
      null,
    )
    expect(unknownDirRanks.size).toBe(0)
  })
})

describe("MetricFilterControl & MetricFilterBar — chips, overflow search, keyboard navigation, and clear", () => {
  it("stays hidden when <=1 option exists and renders searchable combobox in dropdown mode", async () => {
    const singleItem: MetricFilterItem[] = [{ key: "acc", label: "Accuracy", count: 5 }]
    await withMounted(
      createElement(MetricFilterControl, {
        items: singleItem,
        value: null,
        onChange: () => {},
        defaultItem: { label: "Main metric", count: 5 },
      }),
      async (container) => {
        expect(container.querySelector("[data-metric-filter-trigger]")).toBeNull()
      },
    )

    let latestValue: string | null = null
    const manyItems: MetricFilterItem[] = Array.from({ length: 9 }, (_, i) => ({
      key: `metric-${i + 1}`,
      label: i === 6 ? "Lenient Accuracy" : `Metric ${i + 1}`,
      count: 20 - i,
      direction: "higher",
      badge: i === 6 ? "non-primary" : null,
    }))

    const React = await import("react")
    function DropdownHarness() {
      const [val, setVal] = React.useState<string | null>(null)
      latestValue = val
      return createElement(MetricFilterControl, {
        items: manyItems,
        value: val,
        onChange: setVal,
        defaultItem: { label: "Main metric", sublabel: "default", count: 40 },
      })
    }

    await withMounted(createElement(DropdownHarness), async () => {
      const trigger = document.querySelector<HTMLButtonElement>("[data-metric-filter-trigger]")!
      expect(trigger).not.toBeNull()
      expect(trigger.classList.contains("ec-pill")).toBe(false)
      expect(trigger.textContent).toContain("Main metric")

      await act(async () => {
        trigger.click()
      })

      const searchInput = document.querySelector<HTMLInputElement>("[data-metric-filter-search]")!
      expect(searchInput).not.toBeNull()

      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set
        setter?.call(searchInput, "lenient")
        searchInput.dispatchEvent(new Event("input", { bubbles: true }))
      })

      const options = document.querySelectorAll('[role="option"]')
      expect(options).toHaveLength(1)
      expect(options[0].textContent).toContain("Lenient Accuracy")
      expect(options[0].textContent).toContain("non-primary")

      await act(async () => {
        searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      })
      expect(latestValue).toBe("metric-7")

      const clearBtn = document.querySelector<HTMLButtonElement>("[data-metric-filter-clear]")!
      expect(clearBtn).not.toBeNull()
      await act(async () => {
        clearBtn.click()
      })
      expect(latestValue).toBeNull()
    })
  })

  it("renders Option 2A Quick Chips + More (+N) searchable overflow without .ec-pill and pins selected overflow metric inline", async () => {
    const React = await import("react")
    const manyItems: MetricFilterItem[] = Array.from({ length: 9 }, (_, i) => ({
      key: `metric-${i + 1}`,
      label: i === 7 ? "Degeneration" : `Metric ${i + 1}`,
      count: 30 - i,
      direction: "higher",
      badge: i === 7 ? "non-primary" : null,
    }))

    let latestValue: string | null = null
    function BarHarness() {
      const [val, setVal] = React.useState<string | null>(null)
      latestValue = val
      return createElement(MetricFilterBar, {
        items: manyItems,
        value: val,
        onChange: setVal,
        defaultItem: { label: "Main metric", chipLabel: "Main", sublabel: "default", count: 165 },
        statusText: val ? "Filtered" : "All 165 benchmarks",
      })
    }

    await withMounted(createElement(BarHarness), async (container) => {
      // Never uses .ec-pill (guards comparison-slice-render exercisePlots):
      expect(container.querySelectorAll(".ec-pill")).toHaveLength(0)

      // Shows Main + top 4 inline chips = 5 chips, plus More (+5) trigger:
      const initialChips = container.querySelectorAll("[data-metric-chip]")
      expect(initialChips).toHaveLength(5)
      expect(initialChips[0].textContent).toContain("Main")
      const moreBtn = container.querySelector<HTMLButtonElement>("[data-metric-filter-trigger]")!
      expect(moreBtn.textContent).toContain("More (+5)")

      // Open More (+5) -> search "degeneration" -> select -> pins as 6th active chip!
      await act(async () => {
        moreBtn.click()
      })
      const searchInput = document.querySelector<HTMLInputElement>("[data-metric-filter-search]")!
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set
        setter?.call(searchInput, "degeneration")
        searchInput.dispatchEvent(new Event("input", { bubbles: true }))
      })
      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-metric-option="metric-8"]')!.click()
      })

      expect(latestValue).toBe("metric-8")
      const pinnedOverflow = container.querySelector<HTMLButtonElement>("[data-metric-chip-overflow]")!
      expect(pinnedOverflow).not.toBeNull()
      expect(pinnedOverflow.textContent).toContain("Degeneration")

      // Exactly one Reset button in MetricFilterBar:
      const clearBtns = container.querySelectorAll<HTMLButtonElement>("[data-metric-filter-clear]")
      expect(clearBtns).toHaveLength(1)
      await act(async () => {
        clearBtns[0].click()
      })
      expect(latestValue).toBeNull()
      expect(container.querySelector("[data-metric-chip-overflow]")).toBeNull()
    })
  })
})

describe("Model View (BenchmarkDetail) — Option 2A post-Hero Quick-Chips bar scoping Lede, §2, §3, and §4", () => {
  const squadEval = makeEval({
    evalSummaryId: "swissai%2Fsquad-v2",
    displayName: "SQuAD v2",
    primaryMetricId: "exact-match",
    results: [
      makeResult({
        metric_key: "exact-match",
        metric_summary_id: "swissai%3Aexact-match",
        display_name: "Exact Match",
        score: 0.72,
        position: 5,
        total: 40,
        is_lead_metric: true,
        metric_config: { lower_is_better: false, unit: "proportion" },
      }),
      makeResult({
        metric_key: "lenient-accuracy",
        metric_summary_id: "swissai%3Alenient-accuracy",
        display_name: "Lenient Accuracy",
        score: 0.88,
        position: 2,
        total: 40,
        is_lead_metric: false,
        metric_config: { lower_is_better: false, unit: "proportion" },
      }),
    ],
  })

  const mathEval = makeEval({
    evalSummaryId: "swissai%2Fmath-500",
    displayName: "MATH-500",
    primaryMetricId: "exact-match",
    results: [
      makeResult({
        metric_key: "exact-match",
        metric_summary_id: "swissai%3Amath-em",
        display_name: "Exact Match",
        score: 0.64,
        position: 8,
        total: 40,
        is_lead_metric: true,
        metric_config: { lower_is_better: false, unit: "proportion" },
      }),
    ],
  })

  const modelSummary: ModelSummaryCore = {
    model_info: {
      id: "nvidia/nemotron-3-5-lightning",
      name: "Nemotron 3.5 Lightning",
      developer: "NVIDIA",
    },
    total_evaluations: 2,
    categories_covered: ["reasoning" as any],
    evaluations_by_tag: {
      reasoning: [squadEval, mathEval],
    },
    overall_avg_score: 0.68,
    last_updated: "2026-06-01T00:00:00Z",
  } as unknown as ModelSummaryCore

  const comparisonIndex: ComparisonIndex = {
    generated_at: "2026-06-01T00:00:00Z",
    config_version: 2,
    comparison_index_version: 2,
    metric_group_order: ["capability"],
    by_model: {
      "nvidia%2Fnemotron-3-5-lightning": {
        "swissai%2Fsquad-v2": {
          "swissai%3Aexact-match": { score: 0.72, rank: 2, total: 2, submission_count: 1, submission_axis: "default" },
          "swissai%3Alenient-accuracy": { score: 0.88, rank: 1, total: 2, submission_count: 1, submission_axis: "default" },
        },
        "swissai%2Fmath-500": {
          "swissai%3Amath-em": { score: 0.64, rank: 2, total: 2, submission_count: 1, submission_axis: "default" },
        },
      },
    },
    evals: {
      "swissai%2Fsquad-v2": {
        evaluation_id: "swissai%2Fsquad-v2",
        display_name: "SQuAD v2",
        benchmark_id: "squad-v2",
        family_id: "swissai",
        family_display_name: "SwissAI",
        is_slice: false,
        parent_benchmark_id: null,
        metrics: [
          {
            metric_summary_id: "swissai%3Aexact-match",
            metric_id: "exact-match",
            metric_key: "exact-match",
            metric_name: "Exact Match",
            group: "capability",
            group_order: 0,
            lower_is_better: false,
            unit: "proportion",
            scores: [
              { model_route_id: "peer%2Fm1", model_group_id: "peer/m1", model_family_id: "peer/m1", model_family_name: "Peer M1", score: 0.8, rank: 1, total: 2, submission_count: 1, submission_axis: "default" },
              { model_route_id: "nvidia%2Fnemotron-3-5-lightning", model_group_id: "nvidia/nemotron-3-5-lightning", model_family_id: "nvidia/nemotron-3-5-lightning", model_family_name: "Nemotron 3.5 Lightning", score: 0.72, rank: 2, total: 2, submission_count: 1, submission_axis: "default" },
            ],
          },
          {
            metric_summary_id: "swissai%3Alenient-accuracy",
            metric_id: "lenient-accuracy",
            metric_key: "lenient-accuracy",
            metric_name: "Lenient Accuracy",
            group: "capability",
            group_order: 1,
            lower_is_better: false,
            unit: "proportion",
            scores: [
              { model_route_id: "nvidia%2Fnemotron-3-5-lightning", model_group_id: "nvidia/nemotron-3-5-lightning", model_family_id: "nvidia/nemotron-3-5-lightning", model_family_name: "Nemotron 3.5 Lightning", score: 0.88, rank: 1, total: 2, submission_count: 1, submission_axis: "default" },
              { model_route_id: "peer%2Fm1", model_group_id: "peer/m1", model_family_id: "peer/m1", model_family_name: "Peer M1", score: 0.79, rank: 2, total: 2, submission_count: 1, submission_axis: "default" },
            ],
          },
        ],
      },
      "swissai%2Fmath-500": {
        evaluation_id: "swissai%2Fmath-500",
        display_name: "MATH-500",
        benchmark_id: "math-500",
        family_id: "swissai",
        family_display_name: "SwissAI",
        is_slice: false,
        parent_benchmark_id: null,
        metrics: [
          {
            metric_summary_id: "swissai%3Amath-em",
            metric_id: "exact-match",
            metric_key: "exact-match",
            metric_name: "Exact Match",
            group: "capability",
            group_order: 0,
            lower_is_better: false,
            unit: "proportion",
            scores: [
              { model_route_id: "peer%2Fm1", model_group_id: "peer/m1", model_family_id: "peer/m1", model_family_name: "Peer M1", score: 0.75, rank: 1, total: 2, submission_count: 1, submission_axis: "default" },
              { model_route_id: "nvidia%2Fnemotron-3-5-lightning", model_group_id: "nvidia/nemotron-3-5-lightning", model_family_id: "nvidia/nemotron-3-5-lightning", model_family_name: "Nemotron 3.5 Lightning", score: 0.64, rank: 2, total: 2, submission_count: 1, submission_axis: "default" },
            ],
          },
        ],
      },
    },
  } as unknown as ComparisonIndex

  const hierarchy: EvalHierarchy = {
    families: [
      {
        key: "swissai",
        display_name: "SwissAI",
        constituent_evaluation_ids: ["swissai%2Fsquad-v2", "swissai%2Fmath-500"],
        standalone_benchmarks: [
          { key: "squad-v2", display_name: "SQuAD v2", constituent_evaluation_ids: ["swissai%2Fsquad-v2"] },
          { key: "math-500", display_name: "MATH-500", constituent_evaluation_ids: ["swissai%2Fmath-500"] },
        ],
      } as any,
    ],
    benchmark_index: [],
  }

  it("renders a single post-Hero Quick-Chips bar and scopes Lede, §2, §3, and §4 together when a metric chip is clicked", async () => {
    await withMounted(
      createElement(BenchmarkDetail, {
        summary: modelSummary,
        evalHierarchy: hierarchy,
        comparisonIndex,
      }),
      async () => {
        // Placed directly inside the Reported metrics section (not immediately after <header>), single instance on page:
        expect(document.querySelector("header + [data-metric-filter-bar]")).toBeNull()
        expect(document.querySelector("section [data-metric-filter-bar]")).not.toBeNull()
        expect(document.querySelectorAll("[data-metric-filter-bar]")).toHaveLength(1)

        // Default: Main metric shows both SQuAD v2 (72.0%) and MATH-500 (64.0%)
        expect(document.body.textContent).toContain("2 shown · 2 reported")
        expect(document.body.textContent).toContain("SQuAD v2")
        expect(document.body.textContent).toContain("MATH-500")
        expect(document.body.textContent).toContain("72.0%")

        // Click 1-click Quick Chip for Lenient Accuracy:
        const lenientChip = document.querySelector<HTMLButtonElement>(
          '[data-metric-chip="lenient-accuracy"]',
        )!
        expect(lenientChip).not.toBeNull()
        expect(lenientChip.classList.contains("ec-pill")).toBe(false)
        await act(async () => {
          lenientChip.click()
        })

        // Whole-card scope (Option 2A): Lede + §2 + §3 + §4 all scope to the 1 benchmark reporting Lenient Accuracy!
        expect(document.body.textContent).toContain("1 of 2 benchmarks report Lenient Accuracy")
        expect(document.body.textContent).toContain("1 of 2 benchmarks · Lenient Accuracy")
        expect(document.body.textContent).toContain("1 shown")
        expect(document.body.textContent).toContain("88.0%")
        // MATH-500 does not report Lenient Accuracy, so it disappears from BOTH §2 rank tags and §4!
        expect(document.body.textContent).not.toContain("MATH-500")

        const overlapRowButtons = Array.from(
          document.querySelectorAll("button.grid[aria-expanded]"),
        )
        expect(overlapRowButtons).toHaveLength(1)
        expect(overlapRowButtons[0].textContent).toContain("SQuAD v2")
        expect(overlapRowButtons[0].textContent).toContain("88.0%")

        // Switch to Plots by source: only SQuAD v2 renders, on 0.88, with 0 extra metric tabs!
        const plotsBySourceBtn = document.querySelector<HTMLButtonElement>(
          'button[aria-label="Plots by source"]',
        )!
        await act(async () => {
          plotsBySourceBtn.click()
        })
        expect(document.body.textContent).toContain("1 chart")
        expect(document.body.textContent).toContain("0.88")
        expect(document.body.textContent).not.toContain("0.72")

        // Search for a non-matching string while metric filter is active -> Reset button works!
        const searchInput = document.querySelector<HTMLInputElement>(
          'input[placeholder="Search benchmarks or setups…"]',
        )!
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value",
          )?.set
          setter?.call(searchInput, "math")
          searchInput.dispatchEvent(new Event("input", { bubbles: true }))
        })
        const resetBtn = Array.from(document.querySelectorAll("button")).find(
          (b) => b.textContent?.trim() === "Reset to main metric",
        )!
        expect(resetBtn).not.toBeUndefined()
        await act(async () => {
          resetBtn.click()
        })
        // After resetting to Main metric, "math" search now matches MATH-500!
        expect(document.body.textContent).toContain("0.64")
      },
    )
  })

  it("falls back cleanly to Main metric when initialMetricKey names an unknown metric and preserves MetricFilterBar in standalone embed", async () => {
    await withMounted(
      createElement(BenchmarkDetail, {
        summary: modelSummary,
        evalHierarchy: hierarchy,
        comparisonIndex,
        initialMetricKey: "does-not-exist",
      }),
      async () => {
        const overlapRowButtons = document.querySelectorAll("button.grid[aria-expanded]")
        expect(overlapRowButtons).toHaveLength(2)
        expect(document.querySelector("[data-metric-filter-clear]")).toBeNull()
      },
    )

    await withMounted(
      createElement(BenchmarkDetail, {
        summary: modelSummary,
        evalHierarchy: hierarchy,
        comparisonIndex,
        embedSurface: "reported-metrics",
      }),
      async () => {
        expect(document.querySelector("header")).toBeNull()
        expect(document.querySelectorAll("[data-metric-filter-bar]")).toHaveLength(1)
      },
    )
  })

  it("propagates ?metric= and scopes Summary view, preserving reproducibility gaps on present-but-partial configs and keeping unannotated completeness unknown", async () => {
    // 1. Present-but-partial generation_config with row annotation has_reproducibility_gap: true
    // MUST still surface the reproducibility gap warning (never treated as complete)!
    const annotatedSquad = makeEval({
      evalSummaryId: "swissai%2Fsquad-v2",
      displayName: "SQuAD v2",
      primaryMetricId: "exact-match",
      results: [
        makeResult({
          metric_key: "exact-match",
          metric_summary_id: "swissai%3Aexact-match",
          display_name: "Exact Match",
          score: 0.72,
          is_lead_metric: true,
          generation_config: { details: { temperature: 0 } } as any,
          evalcards: { annotations: { reproducibility_gap: { has_reproducibility_gap: true } } } as any,
          metric_config: { lower_is_better: false, unit: "proportion" },
        }),
        makeResult({
          metric_key: "lenient-accuracy",
          metric_summary_id: "swissai%3Alenient-accuracy",
          display_name: "Lenient Accuracy",
          score: 0.88,
          is_lead_metric: false,
          generation_config: { details: { temperature: 0 } } as any,
          evalcards: { annotations: { reproducibility_gap: { has_reproducibility_gap: true } } } as any,
          metric_config: { lower_is_better: false, unit: "proportion" },
        }),
      ],
    })
    const annotatedSummary: ModelSummaryCore = {
      ...modelSummary,
      total_evaluations: 12,
      reproducibility_summary: { results_total: 12, has_reproducibility_gap_count: 10 },
      evaluations_by_tag: { reasoning: [annotatedSquad, mathEval] },
    } as unknown as ModelSummaryCore

    await withMounted(
      createElement(BenchmarkDetail, {
        summary: annotatedSummary,
        evalHierarchy: hierarchy,
        comparisonIndex,
        initialMetricKey: "lenient-accuracy",
      }),
      async () => {
        expect(document.querySelector("header + [data-metric-filter-bar]")).toBeNull()
        expect(document.querySelector("section [data-metric-filter-bar]")).not.toBeNull()
        expect(document.body.textContent).toContain("1 reported")
        expect(document.body.textContent).toContain("Lenient Accuracy")
        expect(document.body.textContent).toContain("88.0%")
        expect(document.body.textContent).not.toContain("Math 500")
        // Uses scoped result count (not card-wide 12 results) and preserves gap warning despite present generation_config!
        expect(document.body.textContent).not.toContain("12 results")
        expect(document.body.textContent).toContain(
          "No reported score discloses every setup item that applies to it.",
        )
        expect(document.body.textContent).not.toContain(
          "Every reported score discloses the setup items that apply to it.",
        )
      },
      "policy",
    )

    // 2. When row reproducibility annotations are absent (unknown completeness),
    // filtering MUST NOT fabricate "Every reported score discloses…" even if generation_config is present!
    const unannotatedSquad = makeEval({
      evalSummaryId: "swissai%2Fsquad-v2",
      displayName: "SQuAD v2",
      primaryMetricId: "exact-match",
      results: [
        makeResult({
          metric_key: "lenient-accuracy",
          metric_summary_id: "swissai%3Alenient-accuracy",
          display_name: "Lenient Accuracy",
          score: 0.88,
          is_lead_metric: false,
          generation_config: { details: { temperature: 0 } } as any,
          metric_config: { lower_is_better: false, unit: "proportion" },
        }),
      ],
    })
    await withMounted(
      createElement(BenchmarkDetail, {
        summary: {
          ...modelSummary,
          evaluations_by_tag: { reasoning: [unannotatedSquad, mathEval] },
        } as unknown as ModelSummaryCore,
        evalHierarchy: hierarchy,
        comparisonIndex,
        initialMetricKey: "lenient-accuracy",
      }),
      async () => {
        expect(document.body.textContent).not.toContain(
          "Every reported score discloses the setup items that apply to it.",
        )
      },
      "policy",
    )

    // 3. Mixed annotation coverage (one annotated complete/gap + one unannotated):
    // MUST suppress universal or partial-denominator completeness claims so
    // unknown rows are never folded into "Every reported score discloses..."!
    for (const annotatedHasGap of [false, true]) {
      const annotatedEval = makeEval({
        evalSummaryId: "swissai%2Fsquad-v2",
        displayName: "SQuAD v2",
        primaryMetricId: "exact-match",
        results: [
          makeResult({
            metric_key: "lenient-accuracy",
            metric_summary_id: "swissai%3Alenient-accuracy",
            display_name: "Lenient Accuracy",
            score: 0.88,
            is_lead_metric: false,
            generation_config: { details: { temperature: 0 } } as any,
            evalcards: {
              annotations: {
                reproducibility_gap: { has_reproducibility_gap: annotatedHasGap },
              },
            } as any,
            metric_config: { lower_is_better: false, unit: "proportion" },
          }),
        ],
      })
      const unannotatedPeer = makeEval({
        evalSummaryId: "swissai%2Fmath-500",
        displayName: "MATH-500",
        primaryMetricId: "exact-match",
        results: [
          makeResult({
            metric_key: "lenient-accuracy",
            metric_summary_id: "swissai%3Amath-lenient",
            display_name: "Lenient Accuracy",
            score: 0.76,
            is_lead_metric: false,
            generation_config: { details: { temperature: 0 } } as any,
            metric_config: { lower_is_better: false, unit: "proportion" },
          }),
        ],
      })
      await withMounted(
        createElement(BenchmarkDetail, {
          summary: {
            ...modelSummary,
            evaluations_by_tag: { reasoning: [annotatedEval, unannotatedPeer] },
          } as unknown as ModelSummaryCore,
          evalHierarchy: hierarchy,
          comparisonIndex,
          initialMetricKey: "lenient-accuracy",
        }),
        async () => {
          expect(document.body.textContent).not.toContain(
            "Every reported score discloses the setup items that apply to it.",
          )
          expect(document.body.textContent).not.toContain("disclose every setup item")
        },
        "policy",
      )
    }
  })
})

describe("Per-Source Benchmark View (EvalDetail) — Option 2A post-Hero Quick-Chips bar", () => {
  const HARMBENCH_METRICS = [
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

  function hbRow(
    id: string,
    name: string,
    values: Record<string, number>,
  ): BenchmarkLeaderboardRow {
    return {
      model_info: { id, name, developer: "Org", release_date: "2025-05-01" },
      model_route_id: encodeURIComponent(id),
      evaluation_timestamp: "2026-05-01T00:00:00Z",
      source_metadata: {
        source_name: "OpenEval",
        source_type: "leaderboard",
        source_organization_name: "OpenEval",
        evaluator_relationship: "third_party",
      },
      source_data: { dataset_name: "HarmBench", samples_number: 200 },
      values,
      metrics_present: Object.keys(values).length,
    } as BenchmarkLeaderboardRow
  }

  const HARMBENCH_ROWS: BenchmarkLeaderboardRow[] = [
    hbRow("org/alpha", "Model Alpha", { "harmbench-refusal-score": 0.85, "attack-success-rate": 0.35 }),
    hbRow("org/beta", "Model Beta", { "harmbench-refusal-score": 0.85, "attack-success-rate": 0.25 }),
    hbRow("org/gamma", "Model Gamma", { "harmbench-refusal-score": 0.40, "attack-success-rate": 0.60 }),
    hbRow("org/delta", "Model Delta", { "attack-success-rate": 0.12 }),
    hbRow("org/zeta", "Model Zeta", { "attack-success-rate": 0.08 }),
  ]

  function makeHarmBenchSummary(
    overrides: Partial<BenchmarkEvalSummary> = {},
  ): BenchmarkEvalSummary {
    return {
      evaluation_id: "openeval%2Fharmbench",
      evaluation_name: "HarmBench",
      composite_benchmark_key: "openeval",
      composite_benchmark_name: "OpenEval",
      primary_metric_id: "harmbench-refusal-score",
      metric_config: {
        evaluation_description: "HarmBench Refusal Score across adversarial prompts.",
        lower_is_better: false,
        score_type: "continuous",
        min_score: 0,
        max_score: 1,
      },
      leaderboard_metrics: HARMBENCH_METRICS,
      leaderboard_rows: HARMBENCH_ROWS,
      model_results: [
        { model_info: { id: "org/alpha", name: "Model Alpha" }, score: 0.85, score_details: { score: 0.85, sample_size: 200 }, evaluation_timestamp: "2026-05-01T00:00:00Z", source_metadata: { source_name: "OpenEval", source_type: "leaderboard", evaluator_relationship: "third_party" }, source_data: { dataset_name: "HarmBench", samples_number: 200 }, result: { evaluation_name: "HarmBench", evaluation_timestamp: "2026-05-01T00:00:00Z", metric_config: { lower_is_better: false, score_type: "continuous" }, score_details: { score: 0.85, sample_size: 200 } } },
      ] as any,
      models_count: 5,
      evaluator_names: ["OpenEval"],
      source_types: ["leaderboard"],
      third_party_ratio: 1,
      missing_generation_config_count: 0,
      avg_score: 0.7,
      avg_score_norm: 0.7,
      ...overrides,
    } as BenchmarkEvalSummary
  }

  it("builds EvalMetricFilterOptions with primary first and exact model counts", () => {
    const opts = buildEvalMetricFilterOptions({
      metrics: HARMBENCH_METRICS,
      rows: HARMBENCH_ROWS,
      primaryColumnKey: "harmbench-refusal-score",
      getLabel: (m) => m.display_name ?? m.column_key,
    })
    expect(opts).toEqual([
      expect.objectContaining({
        columnKey: "harmbench-refusal-score",
        modelCount: 3,
        isPrimary: true,
        lowerIsBetter: false,
      }),
      expect.objectContaining({
        columnKey: "attack-success-rate",
        modelCount: 5,
        isPrimary: false,
        lowerIsBetter: true,
      }),
    ])
  })

  it("renders the post-Hero Quick-Chips bar and filters Hero, Metric Spec, Signals, Distribution, and Leaderboard to one metric column", async () => {
    const onSelectMetric = vi.fn()
    await withMounted(
      createElement(EvalDetail, {
        summary: makeHarmBenchSummary(),
        onSelectMetric,
      }),
      async () => {
        // Placed inside the Leaderboard section (consistent with Model View's Reported metrics section):
        expect(document.querySelector("header + [data-metric-filter-bar][data-eval-metric-bar]")).toBeNull()
        expect(document.querySelector("section [data-metric-filter-bar][data-eval-metric-bar]")).not.toBeNull()

        // Default primary metric: 3 of 5 models shown, 1 metric column (Columns picker hidden)
        expect(document.body.textContent).toContain("Showing 3 of 5 models reporting this measure")
        expect(document.body.textContent).toContain("3 of 5 models · HarmBench Refusal Score")
        expect(
          Array.from(document.querySelectorAll("button")).some(
            (b) => b.textContent?.trim() === "Columns",
          ),
        ).toBe(false)

        const bodyRowsDefault = document.querySelectorAll("table.ec-htable tbody tr")
        expect(bodyRowsDefault).toHaveLength(3)
        const defaultRanks = Array.from(bodyRowsDefault).map((tr) =>
          tr.querySelector("td")?.textContent?.trim(),
        )
        expect(defaultRanks).toEqual(["#1", "#1", "#3"])
        expect(document.querySelector("table.ec-htable")?.textContent).not.toContain("Model Zeta")

        // Switch to Attack Success Rate via 1-click Quick Chip:
        const asrChip = document.querySelector<HTMLButtonElement>(
          '[data-metric-chip="attack-success-rate"]',
        )!
        expect(asrChip).not.toBeNull()
        await act(async () => {
          asrChip.click()
        })
        expect(onSelectMetric).toHaveBeenCalledWith("attack-success-rate")

        // Now all 5 models reporting Attack Success Rate appear, sorted lowest-first (Model Zeta 0.08 is #1):
        expect(document.body.textContent).toContain("Showing 5 of 5 models reporting this measure")
        expect(document.body.textContent).toContain("Attack Success Rate: Lower is better ↓")
        expect(document.body.innerHTML).toContain("<dt>Score scale</dt><dd>Attack Success Rate: not reported</dd>")
        expect(document.body.textContent).not.toContain("HarmBench Refusal Score across adversarial prompts.")
        expect(document.body.textContent).toContain("Not computed for this metric's scale.")

        const asrRows = Array.from(document.querySelectorAll("table.ec-htable tbody tr"))
        expect(asrRows).toHaveLength(5)
        expect(asrRows[0].textContent).toContain("Model Zeta")
        expect(asrRows[0].querySelector("td")?.textContent?.trim()).toBe("#1")

        // Click "Model" header to sort alphabetically — Model Zeta MUST keep its #1 competition rank!
        const modelTh = Array.from(document.querySelectorAll("table.ec-htable thead th")).find(
          (th) => th.textContent?.startsWith("Model"),
        ) as HTMLElement
        await act(async () => {
          modelTh.click()
        })
        const alphaSortedRows = Array.from(document.querySelectorAll("table.ec-htable tbody tr"))
        const zetaRow = alphaSortedRows.find((tr) => tr.textContent?.includes("Model Zeta"))!
        expect(zetaRow.querySelector("td")?.textContent?.trim()).toBe("#1")
      },
    )
  })

  it("keeps Quick Chips + More (+N) overflow on benchmarks with >5 metrics (e.g. SQuAD 2.0)", async () => {
    const eightMetrics = Array.from({ length: 8 }, (_, i) => ({
      column_key: `m-${i + 1}`,
      metric_id: `m-${i + 1}`,
      metric_summary_id: `squad%3Am-${i + 1}`,
      metric_name: i === 6 ? "NoAns F1" : `Measure ${i + 1}`,
      display_name: i === 6 ? "NoAns F1" : `Measure ${i + 1}`,
      lower_is_better: false,
      unit: "proportion",
      scope: "root" as const,
    }))
    const rows = [
      hbRow("org/m1", "Model 1", Object.fromEntries(eightMetrics.map((m, i) => [m.column_key, 0.9 - i * 0.02]))),
      hbRow("org/m2", "Model 2", Object.fromEntries(eightMetrics.slice(0, 7).map((m, i) => [m.column_key, 0.8 - i * 0.02]))),
      hbRow("org/m3", "Model 3", Object.fromEntries(eightMetrics.slice(0, 4).map((m, i) => [m.column_key, 0.7 - i * 0.02]))),
    ]
    await withMounted(
      createElement(EvalDetail, {
        summary: makeHarmBenchSummary({
          primary_metric_id: "m-1",
          leaderboard_metrics: eightMetrics,
          leaderboard_rows: rows,
        }),
      }),
      async () => {
        // 4 inline chips + More (+4) overflow trigger (never collapses to a bare dropdown!)
        expect(document.querySelectorAll("[data-metric-chip]")).toHaveLength(4)
        const moreBtn = document.querySelector<HTMLButtonElement>("[data-metric-filter-trigger]")!
        expect(moreBtn.textContent).toContain("More (+4)")

        await act(async () => {
          moreBtn.click()
        })
        await act(async () => {
          document.querySelector<HTMLButtonElement>('[data-metric-option="m-7"]')!.click()
        })
        // Overflow metric NoAns F1 pins inline as 5th chip and filters to the 2 models reporting m-7!
        expect(document.querySelector("[data-metric-chip-overflow]")?.textContent).toContain("NoAns F1")
        expect(document.querySelectorAll("table.ec-htable tbody tr")).toHaveLength(2)
      },
    )
  })

  it("updates PolicyOverview model count and direction in Summary mode when ?metric= is selected", async () => {
    await withMounted(
      createElement(EvalDetail, {
        summary: makeHarmBenchSummary(),
        selectedMetricId: "attack-success-rate",
      }),
      async () => {
        expect(document.body.textContent).toContain("Attack Success Rate: Lower scores are better.")
        expect(document.body.textContent).toContain("Compared across 5 models.")
      },
      "policy",
    )
  })

  it("preserves unfiltered matrix when primary_metric_id is absent, and filters to single column on chip click", async () => {
    await withMounted(
      createElement(EvalDetail, {
        summary: makeHarmBenchSummary({ primary_metric_id: undefined }),
      }),
      async () => {
        // Starts on unfiltered matrix (both columns visible, Columns button shown):
        expect(
          Array.from(document.querySelectorAll("button")).some(
            (b) => b.textContent?.trim() === "Columns",
          ),
        ).toBe(true)
        expect(document.querySelectorAll("table.ec-htable thead th")).toHaveLength(8)

        // Click HarmBench Refusal Score quick chip -> filters to 3 models and 1 metric column!
        const refusalChip = document.querySelector<HTMLButtonElement>(
          '[data-metric-chip="harmbench-refusal-score"]',
        )!
        await act(async () => {
          refusalChip.click()
        })
        expect(document.querySelectorAll("table.ec-htable tbody tr")).toHaveLength(3)
        expect(document.querySelectorAll("table.ec-htable thead th")).toHaveLength(7)
      },
    )
  })

  it("never plots another metric's distribution when the selected metric has <3 reporting models, and never leaks primary bounds into secondary Saturation breakdown", async () => {
    const sparseSummary = makeHarmBenchSummary({
      leaderboard_metrics: [
        ...HARMBENCH_METRICS,
        {
          column_key: "lenient-accuracy",
          metric_id: "lenient-accuracy",
          metric_summary_id: "harmbench%3Alenient-accuracy",
          metric_name: "Lenient Accuracy",
          display_name: "Lenient Accuracy",
          lower_is_better: false,
          unit: "proportion",
          scope: "root" as const,
        },
        {
          column_key: "word-count",
          metric_id: "word-count",
          metric_summary_id: "harmbench%3Aword-count",
          metric_name: "Word Count",
          display_name: "Word Count",
          lower_is_better: false,
          unit: undefined,
          scope: "root" as const,
        },
      ],
      leaderboard_rows: [
        hbRow("org/m1", "Model 1", { "harmbench-refusal-score": 0.9, "attack-success-rate": 0.1, "lenient-accuracy": 0.92, "word-count": 410 }),
        hbRow("org/m2", "Model 2", { "harmbench-refusal-score": 0.8, "attack-success-rate": 0.2, "lenient-accuracy": 0.88, "word-count": 390 }),
        hbRow("org/m3", "Model 3", { "harmbench-refusal-score": 0.7, "attack-success-rate": 0.3, "lenient-accuracy": 0.84, "word-count": 420 }),
        hbRow("org/m4", "Model 4", { "harmbench-refusal-score": 0.6, "attack-success-rate": 0.4, "lenient-accuracy": 0.80, "word-count": 380 }),
        hbRow("org/m5", "Model 5", { "attack-success-rate": 0.5, "lenient-accuracy": 0.76, "word-count": 405 }),
      ],
    })

    const lenientSat = deriveSaturation(sparseSummary, {
      metricId: "lenient-accuracy",
      columnKey: "lenient-accuracy",
      label: "Lenient Accuracy",
      lowerIsBetter: false,
      unit: "proportion",
      isPrimary: false,
    })
    expect(lenientSat.statUnit).toBe("%")
    expect(
      lenientSat.breakdown.inputs.find((i) => i.label === "Scores scaled to 0 to 1 by")?.value,
    ).toBe("no declared bounds; values above 1.5 read as percent")

    const wordCountSat = deriveSaturation(sparseSummary, {
      metricId: "word-count",
      columnKey: "word-count",
      label: "Word Count",
      lowerIsBetter: false,
      unit: null,
      isPrimary: false,
    })
    expect(wordCountSat.statValue).toBe("—")

    const twoModelSummary = makeHarmBenchSummary({
      leaderboard_rows: [
        hbRow("org/m1", "Model 1", { "harmbench-refusal-score": 0.9, "attack-success-rate": 0.1 }),
        hbRow("org/m2", "Model 2", { "harmbench-refusal-score": 0.8, "attack-success-rate": 0.2 }),
        hbRow("org/m3", "Model 3", { "attack-success-rate": 0.3 }),
        hbRow("org/m4", "Model 4", { "attack-success-rate": 0.4 }),
      ],
    })
    await withMounted(
      createElement(EvalDetail, {
        summary: twoModelSummary,
      }),
      async () => {
        expect(document.body.textContent).toContain(
          "Score distribution requires at least 3 models reporting HarmBench Refusal Score.",
        )
      },
    )
  })

  it("labels median aggregate_components honestly as Median (never Avg of) and renders non-blank variant labels when expanded", async () => {
    const medianSummary = makeHarmBenchSummary({
      leaderboard_metrics: [HARMBENCH_METRICS[1]],
      leaderboard_rows: [],
      model_results: [
        {
          model_info: { id: "Qwen/Qwen3-235B-A22B", name: "Qwen3 235B A22B", developer: "Qwen" },
          model_route_id: "Qwen%2FQwen3-235B-A22B",
          score: 0.6825,
          score_details: { score: 0.6825 },
          value_aggregation: "median",
          aggregate_components: [
            {
              evaluation_id: "helm_safety/qwen_qwen3-235b-a22b-instruct-2507-fp8/1777589809",
              composite_display_name: "HELM Safety",
              score: 0.796,
              source_name: "Stanford CRFM",
              source_organization_name: "crfm",
            },
            {
              evaluation_id: "helm_safety/qwen_qwen3-235b-a22b-fp8-tput/1777589809",
              composite_display_name: "HELM Safety",
              score: 0.569,
              source_name: "Stanford CRFM",
              source_organization_name: "crfm",
            },
          ],
          evaluation_timestamp: "2026-05-01T00:00:00Z",
          source_metadata: {
            source_name: "Stanford CRFM",
            source_type: "documentation",
            source_organization_name: "crfm",
            evaluator_relationship: "third_party",
          },
          source_data: { dataset_name: "HarmBench" },
          result: {
            evaluation_name: "HarmBench",
            evaluation_timestamp: "2026-05-01T00:00:00Z",
            metric_config: { lower_is_better: false, score_type: "continuous" },
            score_details: { score: 0.6825 },
          },
        },
      ] as any,
    })

    await withMounted(createElement(EvalDetail, { summary: medianSummary }), async () => {
      expect(document.body.textContent).toContain("Median of 2")
      expect(document.body.textContent).not.toContain("Avg of 2")

      const expandBtn = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Expand details"]',
      )!
      expect(expandBtn).not.toBeNull()
      await act(async () => {
        expandBtn.click()
      })
      expect(document.body.textContent).toContain("Median across 2 reports")
      expect(document.body.textContent).toContain("qwen3-235b-a22b-instruct-2507-fp8")
      expect(document.body.textContent).toContain("qwen3-235b-a22b-fp8-tput")
      expect(document.body.textContent).toContain("Stanford CRFM")
    })
  })

  it("shows 'Direction not reported' on single-source evals with null lower_is_better (never 'Sources disagree')", async () => {
    const singleSourceUnknownDir = makeHarmBenchSummary({
      merged_view: undefined,
      leaderboard_metrics: [
        {
          ...HARMBENCH_METRICS[0],
          column_key: "refusal-rate",
          metric_id: "refusal-rate",
          display_name: "Refusal Rate",
          lower_is_better: null,
        },
        HARMBENCH_METRICS[1],
      ],
      leaderboard_rows: [
        hbRow("org/m1", "Model 1", { "refusal-rate": 0.9, "harmbench-refusal-score": 0.8 }),
        hbRow("org/m2", "Model 2", { "refusal-rate": 0.7, "harmbench-refusal-score": 0.6 }),
      ],
    })
    await withMounted(
      createElement(EvalDetail, {
        summary: singleSourceUnknownDir,
        selectedMetricId: "refusal-rate",
      }),
      async () => {
        expect(document.body.textContent).toContain("Direction not reported")
        expect(document.body.textContent).not.toContain("Sources disagree on direction")
      },
    )

    const mergedUnknownDir = makeHarmBenchSummary({
      merged_view: true,
      metric_config: {
        evaluation_description: "Merged",
        lower_is_better: null,
        score_type: "continuous",
      },
      leaderboard_metrics: [
        {
          ...HARMBENCH_METRICS[0],
          lower_is_better: null,
        },
      ],
      leaderboard_rows: [],
      model_results: [],
    })
    await withMounted(
      createElement(EvalDetail, {
        summary: mergedUnknownDir,
      }),
      async () => {
        expect(document.body.textContent).toContain("Sources disagree on direction")
      },
    )
  })

  it("preserves ?metric= in single-metric EmbedButton URLs when metricBarOverride selects a non-default metric", async () => {
    const mergedSummary = makeHarmBenchSummary({
      evaluation_id: "harmbench",
      merged_view: true,
      primary_metric_id: "attack-success-rate",
      leaderboard_metrics: [HARMBENCH_METRICS[0]],
      leaderboard_rows: [],
      model_results: [
        {
          model_info: { id: "org/a", name: "Model A", developer: "Org" },
          model_route_id: "org%2Fa",
          score: 0.1,
          score_details: { score: 0.1 },
          evaluation_timestamp: "2026-05-01T00:00:00Z",
          source_metadata: {
            source_name: "OpenEval",
            source_type: "leaderboard",
            source_organization_name: "OpenEval",
            evaluator_relationship: "third_party",
          },
          source_data: { dataset_name: "HarmBench" },
          result: {
            evaluation_name: "HarmBench",
            evaluation_timestamp: "2026-05-01T00:00:00Z",
            metric_config: { lower_is_better: true, score_type: "continuous" },
            score_details: { score: 0.1 },
          },
        },
        {
          model_info: { id: "org/b", name: "Model B", developer: "Org" },
          model_route_id: "org%2Fb",
          score: 0.2,
          score_details: { score: 0.2 },
          evaluation_timestamp: "2026-05-01T00:00:00Z",
          source_metadata: {
            source_name: "OpenEval",
            source_type: "leaderboard",
            source_organization_name: "OpenEval",
            evaluator_relationship: "third_party",
          },
          source_data: { dataset_name: "HarmBench" },
          result: {
            evaluation_name: "HarmBench",
            evaluation_timestamp: "2026-05-01T00:00:00Z",
            metric_config: { lower_is_better: true, score_type: "continuous" },
            score_details: { score: 0.2 },
          },
        },
        {
          model_info: { id: "org/c", name: "Model C", developer: "Org" },
          model_route_id: "org%2Fc",
          score: 0.3,
          score_details: { score: 0.3 },
          evaluation_timestamp: "2026-05-01T00:00:00Z",
          source_metadata: {
            source_name: "OpenEval",
            source_type: "leaderboard",
            source_organization_name: "OpenEval",
            evaluator_relationship: "third_party",
          },
          source_data: { dataset_name: "HarmBench" },
          result: {
            evaluation_name: "HarmBench",
            evaluation_timestamp: "2026-05-01T00:00:00Z",
            metric_config: { lower_is_better: true, score_type: "continuous" },
            score_details: { score: 0.3 },
          },
        },
      ] as any,
    })

    await withMounted(
      createElement(EvalDetail, {
        summary: mergedSummary,
        metricBarOverride: {
          label: "Metric",
          items: [
            {
              key: "harmbench-refusal-score",
              label: "HarmBench Refusal Score",
              count: 92,
              direction: "higher",
              isDefault: true,
            },
            {
              key: "attack-success-rate",
              label: "Attack Success Rate",
              count: 137,
              direction: "lower",
              isDefault: false,
            },
          ],
          value: "attack-success-rate",
          onChange: () => {},
        },
      }),
      async () => {
        const embedButtons = Array.from(
          document.querySelectorAll<HTMLButtonElement>(".embed-button-root > button"),
        )
        expect(embedButtons.length).toBeGreaterThanOrEqual(2)
        const snippets: string[] = []
        for (const btn of embedButtons) {
          await act(async () => {
            btn.click()
          })
          const textarea = btn.parentElement?.querySelector("textarea")
          if (textarea) snippets.push(textarea.value)
          await act(async () => {
            btn.click()
          })
        }
        expect(
          snippets.some((s) => s.includes("/embed/eval/leaderboard/harmbench?metric=attack-success-rate")),
        ).toBe(true)
        expect(
          snippets.some((s) => s.includes("/embed/eval/distribution/harmbench?metric=attack-success-rate")),
        ).toBe(true)
      },
    )
  })

  it("keeps MetricFilterBar and Reset available when ?metric= points to an all-null secondary metric", async () => {
    const onSelectMetric = vi.fn()
    const allNullSecondary = makeHarmBenchSummary({
      leaderboard_metrics: [HARMBENCH_METRICS[0], HARMBENCH_METRICS[1]],
      leaderboard_rows: [
        hbRow("org/m1", "Model 1", { "harmbench-refusal-score": 0.9 }),
        hbRow("org/m2", "Model 2", { "harmbench-refusal-score": 0.8 }),
        hbRow("org/m3", "Model 3", { "harmbench-refusal-score": 0.7 }),
      ],
    })

    await withMounted(
      createElement(EvalDetail, {
        summary: allNullSecondary,
        selectedMetricId: "attack-success-rate",
        onSelectMetric,
      }),
      async () => {
        expect(
          document.querySelector("[data-metric-filter-bar][data-eval-metric-bar]"),
        ).not.toBeNull()
        const zeroChip = document.querySelector<HTMLButtonElement>(
          '[data-metric-chip="attack-success-rate"]',
        )
        expect(zeroChip).not.toBeNull()
        expect(zeroChip?.textContent).toContain("0")

        const resetBtn = document.querySelector<HTMLButtonElement>(
          "[data-metric-filter-clear]",
        )!
        expect(resetBtn).not.toBeNull()
        await act(async () => {
          resetBtn.click()
        })
        expect(onSelectMetric).toHaveBeenCalledWith(null)
        expect(document.querySelectorAll("table.ec-htable tbody tr")).toHaveLength(3)
      },
    )
  })

  it("replaceUrlQueryParam updates and clears ?metric= in place with null state so Next.js syncs useSearchParams", async () => {
    const { replaceUrlQueryParam } = await import("@/lib/metric-selection")
    window.history.replaceState({ __NA: true }, "", "/evals/harmbench?source=src-a#leaderboard")
    const replaceSpy = vi.spyOn(window.history, "replaceState")
    try {
      const next1 = replaceUrlQueryParam(
        "/evals/harmbench",
        new URLSearchParams("source=src-a"),
        "metric",
        "harmbench-refusal-score",
      )
      expect(next1).toBe("/evals/harmbench?source=src-a&metric=harmbench-refusal-score#leaderboard")
      expect(window.location.search).toBe("?source=src-a&metric=harmbench-refusal-score")
      expect(window.location.hash).toBe("#leaderboard")
      expect(replaceSpy).toHaveBeenLastCalledWith(
        null,
        "",
        "/evals/harmbench?source=src-a&metric=harmbench-refusal-score#leaderboard",
      )

      const next2 = replaceUrlQueryParam(
        "/evals/harmbench",
        new URLSearchParams("source=src-a&metric=harmbench-refusal-score"),
        "metric",
        null,
      )
      expect(next2).toBe("/evals/harmbench?source=src-a#leaderboard")
      expect(window.location.search).toBe("?source=src-a")
      expect(replaceSpy).toHaveBeenLastCalledWith(
        null,
        "",
        "/evals/harmbench?source=src-a#leaderboard",
      )
    } finally {
      replaceSpy.mockRestore()
    }
  })

  it("ScoreDistribution preserves uncontrolled metric selection across parent rerenders with new series array identity", async () => {
    const { ScoreDistribution } = await import("@/components/score-distribution")
    const makeSeries = (keys: Array<{ key: string; label: string; values: number[] }>) =>
      keys.map((item) => ({ ...item, values: [...item.values] }))

    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      const baseSeries = [
        { key: "accuracy", label: "Accuracy", values: [0.6, 0.7, 0.8] },
        { key: "latency", label: "Latency", values: [120, 150, 180] },
        { key: "cost", label: "Cost", values: [1.1, 1.5, 2.0] },
      ]

      await act(async () => {
        root.render(
          createElement(ScoreDistribution, {
            series: makeSeries(baseSeries),
            initialKey: "accuracy",
          }),
        )
      })

      const findPill = (label: string) =>
        Array.from(container.querySelectorAll<HTMLButtonElement>("button.ec-pill")).find(
          (b) => b.textContent?.trim() === label,
        )

      expect(findPill("Accuracy")?.className).toContain("on")

      // User picks a non-default chart metric
      await act(async () => {
        findPill("Latency")!.click()
      })
      expect(findPill("Latency")?.className).toContain("on")

      // Parent rerenders (e.g. leaderboard sort/pagination) with a freshly built equivalent series array
      await act(async () => {
        root.render(
          createElement(ScoreDistribution, {
            series: makeSeries(baseSeries),
            initialKey: "accuracy",
          }),
        )
      })
      expect(findPill("Latency")?.className).toContain("on")

      // Removing the selected series falls back to initialKey
      await act(async () => {
        root.render(
          createElement(ScoreDistribution, {
            series: makeSeries([baseSeries[0], baseSeries[2]]),
            initialKey: "accuracy",
          }),
        )
      })
      expect(findPill("Accuracy")?.className).toContain("on")

      // Intentional initialKey change resets uncontrolled selection
      await act(async () => {
        root.render(
          createElement(ScoreDistribution, {
            series: makeSeries(baseSeries),
            initialKey: "cost",
          }),
        )
      })
      expect(findPill("Cost")?.className).toContain("on")
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })
})
