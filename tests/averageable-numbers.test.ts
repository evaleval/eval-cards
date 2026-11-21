import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import {
  BenchmarkDeepDiveDialogPanel,
  buildBenchmarkGroups,
  buildOverlapSummaryInputs,
  familyScore,
  getGroupPeerRank,
} from "@/components/benchmark-detail"
import { Dialog } from "@/components/ui/dialog"
import type {
  BenchmarkIndexEntry,
  ComparisonEvalEntry,
  ComparisonIndex,
  ComparisonMetricEntry,
  ScaleConversion,
} from "@/lib/backend-artifacts"
import type { BenchmarkEvaluation, EvalTag, EvaluationResult } from "@/lib/benchmark-schema"
import { averageable, averageReadings, type AverageableReading } from "@/lib/headline-readings"
import { buildOverlapRows, type OverlapLeadReading } from "@/lib/overlaps"

vi.mock("next/navigation", () => import("./next-navigation-stub"))

// Every number on a model page is a reported result, or a labelled average
// of results that are one measurement. These pin the one rule that says
// which readings are one measurement, and each place a model page combines
// readings.

const MODEL_ID = "CIR-AMS/BTRM_Qwen2_7b_0613"
const MODEL_ROUTE = encodeURIComponent(MODEL_ID)

function reading(overrides: Partial<AverageableReading> = {}): AverageableReading {
  return { metricKey: "accuracy", lowerIsBetter: false, unit: "proportion", score: 0.5, ...overrides }
}

describe("averageable", () => {
  it("accepts readings of one metric, direction and unit", () => {
    expect(averageable([reading({ score: 0.4 }), reading({ score: 0.6 })])).toBe(true)
    expect(averageReadings([reading({ score: 0.4 }), reading({ score: 0.6 })])).toEqual({
      mean: 0.5,
      unit: "proportion",
    })
  })

  it("refuses an accuracy beside a score", () => {
    // RewardBench 2: Factuality is reported as accuracy, the other parts as score.
    const parts = [
      reading({ metricKey: "accuracy", score: 0.5347 }),
      reading({ metricKey: "score", score: 0.5737 }),
    ]
    expect(averageable(parts)).toBe(false)
    expect(averageReadings(parts)).toBeNull()
  })

  it("refuses a refusal score beside an attack success rate", () => {
    const harmbench = [
      reading({ metricKey: "harmbench-refusal-score", score: 0.616 }),
      reading({ metricKey: "attack-success-rate", lowerIsBetter: true, score: 0.376 }),
    ]
    expect(averageable(harmbench)).toBe(false)
  })

  it("refuses one metric read in opposite directions", () => {
    expect(averageable([reading(), reading({ lowerIsBetter: true })])).toBe(false)
  })

  it("refuses one metric on different stated splits, and accepts a reading that states none", () => {
    expect(averageable([reading({ split: "train" }), reading({ split: "test" })])).toBe(false)
    expect(averageable([reading({ split: "train" }), reading({ split: null })])).toBe(true)
  })

  it("refuses one metric in units nothing converts between", () => {
    expect(averageable([reading({ unit: "usd" }), reading({ unit: null })])).toBe(false)
    expect(averageable([reading({ unit: "points" }), reading({ unit: "proportion" })])).toBe(false)
    expect(averageable([reading({ unit: "percentage_points" }), reading({ unit: "proportion" })])).toBe(false)
  })

  it("converts a percent and a proportion of one metric by their units when the producer has not", () => {
    // 416 model x benchmark rows on snapshot 2026-11-20T19-17-21Z pair a
    // percent and a proportion of one metric with scale_conversion no_bounds.
    const pair = [
      reading({ unit: "proportion", score: 0.8, scaleConversion: "no_bounds" as ScaleConversion }),
      reading({ unit: "percent", score: 60, scaleConversion: "no_bounds" as ScaleConversion }),
    ]
    expect(averageable(pair)).toBe(true)
    const average = averageReadings(pair)!
    expect(average.unit).toBe("percent")
    expect(average.mean).toBeCloseTo(70, 10)
  })

  it("accepts a percent and a proportion of one metric the producer puts on one scale, and converts them", () => {
    const pair = [
      reading({ unit: "proportion", score: 0.8, scoreCanonical: 0.8, scaleConversion: "none" as ScaleConversion }),
      reading({ unit: "percent", score: 60, scoreCanonical: 0.6, scaleConversion: "div100" as ScaleConversion }),
    ]
    expect(averageable(pair)).toBe(true)
    const average = averageReadings(pair)!
    expect(average.unit).toBe("percent")
    expect(average.mean).toBeCloseTo(70, 10)
  })

  it("refuses a metric with no id", () => {
    expect(averageable([reading({ metricKey: null })])).toBe(false)
  })
})

type Metric = {
  id: string
  /** The registry's display name; absent on a metric it has not named. */
  name?: string
  score: number
  unit?: string
  rank?: [number, number]
  lead?: boolean
  split?: string
}

function entry(
  metric: Metric,
  { evalId, name, parent }: { evalId: string; name: string; parent?: string },
) {
  const result = {
    evaluation_name: metric.name ?? name,
    display_name: metric.name,
    canonical_display_name: metric.name,
    metric_summary_id: `${evalId}%3A${metric.id}`,
    metric_key: metric.id,
    evaluation_timestamp: "",
    source_data: { dataset_name: name },
    metric_config: {
      lower_is_better: false,
      score_type: "continuous",
      min_score: 0,
      max_score: 1,
      unit: metric.unit ?? "proportion",
    },
    score_details: { score: metric.score },
    is_lead_metric: metric.lead ?? true,
    position: metric.rank?.[0],
    total: metric.rank?.[1],
    split: metric.split,
  } as unknown as EvaluationResult
  const evaluation = {
    schema_version: "1.0",
    eval_summary_id: evalId,
    evaluation_id: evalId,
    retrieved_timestamp: "",
    benchmark: name,
    display_name: name,
    family_id: "reward-bench",
    benchmark_family_name: "RewardBench",
    benchmark_parent_name: parent ? "RewardBench 2" : undefined,
    is_slice: Boolean(parent),
    parent_benchmark_id: parent,
    source_data: { dataset_name: name },
    source_metadata: {
      source_name: "RewardBench",
      source_type: "evaluation_run",
      source_organization_name: "Allen AI",
      evaluator_relationship: "third_party",
    },
    model_info: { name: "BTRM Qwen2 7b", id: MODEL_ID },
    evaluation_results: [result],
  } as unknown as BenchmarkEvaluation
  return { evaluation, result, category: "safety" as EvalTag }
}

// CIR-AMS/BTRM_Qwen2_7b_0613, warehouse snapshot 2026-11-20T19-17-21Z.
const RB2_PARTS: Array<[string, string, Metric]> = [
  ["factuality", "RewardBench 2 Factuality", { id: "accuracy", name: "Accuracy", score: 0.5347, rank: [200, 243] }],
  ["focus", "RewardBench 2 Focus", { id: "score", name: "Score", score: 0.5737, rank: [149, 191] }],
  ["math", "RewardBench 2 Math", { id: "score", name: "Score", score: 0.6066, rank: [113, 191] }],
  ["precise-if", "RewardBench 2 Precise IF", { id: "score", name: "Score", score: 0.3563, rank: [116, 191] }],
  ["ties", "RewardBench 2 Ties", { id: "score", name: "Score", score: 0.6527, rank: [64, 191] }],
]
const rb2Entries = () =>
  RB2_PARTS.map(([slug, name, metric]) =>
    entry(metric, { evalId: `reward-bench%2Frewardbench-2-${slug}`, name, parent: "rewardbench-2" }),
  )

function deepDiveText(group: ReturnType<typeof buildBenchmarkGroups>[number]) {
  const html = renderToStaticMarkup(
    createElement(
      AudienceModeProvider,
      null,
      createElement(Dialog, { open: true }, createElement(BenchmarkDeepDiveDialogPanel, { group })),
    ),
  )
  const text = (fragment: string) =>
    fragment
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;| /g, " ")
      .replace(/\s+/g, " ")
      .trim()
  const header = text(html.split("Reported rows")[0] ?? "")
  const rows = (html.split("<tbody>")[1] ?? "")
    .split("</tr>")
    .filter((row) => row.includes("<td"))
    .map((row) => row.split("</td>").slice(0, -1).map(text).join(" | "))
  return { header, rows }
}

describe("a benchmark shown only through parts on different metrics (RewardBench 2)", () => {
  const [group] = buildBenchmarkGroups(rb2Entries(), undefined)

  it("has no number and no rank: it says how many parts", () => {
    expect(group.key).toBe("reward-bench%2Frewardbench-2")
    expect(group.avgDisplayScore).toBe("5 parts")
    expect(group.avgRawScore).toBeNaN()
    expect(group.scoreNote).toBeNull()
    expect(getGroupPeerRank(group)).toBeNull()
    expect(group.bestRankPosition).toBeNull()
  })

  it("prints `5 parts` in the deep-dive header, with no rank, and lists each part with its own score and rank", () => {
    const { header, rows } = deepDiveText(group)
    expect(header).toMatch(/5 parts$/)
    expect(header).not.toMatch(/Avg|Score|N\/A|NaN|#/)
    expect(rows).toHaveLength(5)
    expect(rows.find((row) => row.includes("0.535"))).toMatch(/\| #200\/243$/)
    expect(rows.find((row) => row.includes("0.653"))).toMatch(/\| #64\/191$/)
  })

  it("stands in the Scores table with no number, its parts listed with their own score, metric and rank", () => {
    const inputs = buildOverlapSummaryInputs([group])
    const rows = buildOverlapRows({
      benchmarkIndex: undefined,
      comparisonIndex: undefined,
      currentModelRouteId: MODEL_ROUTE,
      currentModelIdentityKeys: new Set([MODEL_ID]),
      familyDisplayByKey: new Map(),
      leadReadings: inputs.leadReadings,
      summaryCandidates: inputs.candidates,
      summaryJoinRows: inputs.joinRows,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].mean).toBeNaN()
    const listed = rows[0].appearances[0].parts?.map((p) => [p.name, p.metricName, p.displayScore, p.rank])
    expect(listed?.sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      ["RewardBench 2 Factuality", "Accuracy", "53.5%", { position: 200, total: 243 }],
      ["RewardBench 2 Focus", "Score", "57.4%", { position: 149, total: 191 }],
      ["RewardBench 2 Math", "Score", "60.7%", { position: 113, total: 191 }],
      ["RewardBench 2 Precise IF", "Score", "35.6%", { position: 116, total: 191 }],
      ["RewardBench 2 Ties", "Score", "65.3%", { position: 64, total: 191 }],
    ])
  })
})

// The Scores table reads RewardBench 2 through benchmark_index, whose
// reward-bench appearance lists the parts as its constituent evals.
describe("a benchmark_index appearance made of parts", () => {
  const metric = (evalId: string, m: Partial<ComparisonMetricEntry>, score: number): ComparisonMetricEntry => ({
    metric_summary_id: `${evalId}%3A${m.metric_key}`,
    metric_name: m.metric_name ?? "",
    metric_id: m.metric_key ?? null,
    metric_key: m.metric_key ?? null,
    group: "capability",
    group_order: 0,
    lower_is_better: false,
    unit: "proportion",
    scores: [{ model_route_id: MODEL_ROUTE, score } as never],
    ...m,
  })
  const evalOf = (evalId: string, benchmarkId: string, parent: string | null, metrics: ComparisonMetricEntry[]) =>
    ({
      evaluation_id: evalId,
      benchmark_id: benchmarkId,
      parent_benchmark_id: parent,
      display_name: benchmarkId,
      is_slice: parent != null,
      metrics,
    }) as unknown as ComparisonEvalEntry
  const indexOf = (evals: ComparisonEvalEntry[]): ComparisonIndex =>
    ({ evals: Object.fromEntries(evals.map((e) => [e.evaluation_id, e])) }) as unknown as ComparisonIndex
  const leadsOf = (evals: ComparisonEvalEntry[]) =>
    new Map<string, OverlapLeadReading>(
      evals.map((e) => [e.evaluation_id, { metricSummaryId: e.metrics[0].metric_summary_id, split: null, rank: null }]),
    )
  const build = (entry: BenchmarkIndexEntry, evals: ComparisonEvalEntry[]) =>
    buildOverlapRows({
      benchmarkIndex: [entry],
      comparisonIndex: indexOf(evals),
      currentModelRouteId: MODEL_ROUTE,
      currentModelIdentityKeys: new Set([MODEL_ROUTE]),
      familyDisplayByKey: new Map(),
      leadReadings: leadsOf(evals),
    })

  it("has no number when the parts are not one measurement, not the first part's score", () => {
    const evals = RB2_PARTS.map(([slug, , m]) => {
      const id = `reward-bench%2Frewardbench-2-${slug}`
      return evalOf(id, `rewardbench-2-${slug}`, "rewardbench-2", [
        metric(id, { metric_key: m.id, metric_name: m.name }, m.score),
      ])
    })
    const rows = build(
      {
        key: "rewardbench-2",
        display_name: "RewardBench 2",
        appearances: [
          {
            family_key: "reward-bench",
            benchmark_key: "rewardbench-2",
            constituent_evaluation_ids: evals.map((e) => e.evaluation_id),
            is_canonical_home: false,
          },
        ],
      },
      evals,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].canonicalDisplayName).toBe("RewardBench 2")
    expect(rows[0].mean).toBeNaN()
    expect(rows[0].appearances[0].parts).toHaveLength(5)
  })

  it("is the parts' mean when they are one measurement (open-medical-llm MMLU)", () => {
    const subjects: Array<[string, number]> = [
      ["anatomy", 0.6],
      ["college-biology", 0.8],
    ]
    const evals = subjects.map(([slug, score]) => {
      const id = `open-medical-llm%2Fmmlu-${slug}`
      return evalOf(id, `mmlu-${slug}`, "mmlu", [metric(id, { metric_key: "accuracy", metric_name: "Accuracy" }, score)])
    })
    const rows = build(
      {
        key: "mmlu",
        display_name: "MMLU",
        appearances: [
          {
            family_key: "open-medical-llm",
            benchmark_key: "mmlu",
            constituent_evaluation_ids: evals.map((e) => e.evaluation_id),
            is_canonical_home: false,
          },
        ],
      },
      evals,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].mean).toBeCloseTo(0.7, 12)
    expect(rows[0].appearances[0].parts?.map((p) => p.displayScore)).toEqual(["60.0%", "80.0%"])
  })

  it("is the benchmark's own eval when the appearance lists it among others", () => {
    const evals = ["anatomy", "college-biology"].map((slug, i) => {
      const id = `open-medical-llm%2Fmmlu-${slug}`
      return evalOf(id, `mmlu-${slug}`, "mmlu", [
        metric(id, { metric_key: "accuracy", metric_name: "Accuracy" }, 0.6 + i / 10),
      ])
    })
    const rows = build(
      {
        key: "mmlu-college-biology",
        display_name: "MMLU College Biology",
        appearances: [
          {
            family_key: "open-medical-llm",
            benchmark_key: "mmlu-college-biology",
            constituent_evaluation_ids: evals.map((e) => e.evaluation_id),
            is_canonical_home: false,
          },
        ],
      },
      evals,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].appearances[0].parts).toBeUndefined()
    expect(rows[0].mean).toBe(0.7)
  })
})

describe("a benchmark shown with its own eval and its parts (RewardBench)", () => {
  const groups = buildBenchmarkGroups(
    [
      entry({ id: "score", name: "Score", score: 0.7029, rank: [110, 317] }, {
        evalId: "reward-bench%2Frewardbench",
        name: "RewardBench",
      }),
      entry({ id: "accuracy", name: "Accuracy", score: 0.77365, lead: false }, {
        evalId: "reward-bench%2Frewardbench",
        name: "RewardBench",
      }),
      entry({ id: "accuracy", name: "Accuracy", score: 0.9749, rank: [15, 173] }, {
        evalId: "reward-bench%2Frewardbench-chat",
        name: "RewardBench Chat",
        parent: "rewardbench",
      }),
      entry({ id: "accuracy", name: "Accuracy", score: 0.5724, rank: [106, 173] }, {
        evalId: "reward-bench%2Frewardbench-chat-hard",
        name: "RewardBench Chat Hard",
        parent: "rewardbench",
      }),
    ],
    undefined,
  )

  it("shows the own eval's lead reading with its unit and its own rank, never a mean", () => {
    expect(groups).toHaveLength(1)
    const [group] = groups
    expect(group.avgRawScore).toBe(0.7029)
    expect(group.avgDisplayScore).toBe("0.703 Proportion")
    expect(group.scoreNote).toBeNull()
    expect(getGroupPeerRank(group)).toEqual({ position: 110, total: 317 })
  })

  it("stands in the Scores table as the own eval's reading, its parts listed beneath with their own ranks", () => {
    const inputs = buildOverlapSummaryInputs(groups)
    const rows = buildOverlapRows({
      benchmarkIndex: undefined,
      comparisonIndex: undefined,
      currentModelRouteId: MODEL_ROUTE,
      currentModelIdentityKeys: new Set([MODEL_ID]),
      familyDisplayByKey: new Map(),
      leadReadings: inputs.leadReadings,
      summaryCandidates: inputs.candidates,
      summaryJoinRows: inputs.joinRows,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].mean).toBe(0.7029)
    expect(rows[0].appearances[0].parts).toBeUndefined()
    expect(
      rows[0].appearances[0].ownEvalParts?.map((p) => [p.name, p.displayScore, p.rank]).sort((a, b) =>
        String(a[0]).localeCompare(String(b[0])),
      ),
    ).toEqual([
      ["RewardBench Chat", "97.5%", { position: 15, total: 173 }],
      ["RewardBench Chat Hard", "57.2%", { position: 106, total: 173 }],
    ])
  })

  it("labels the deep-dive number Score and keeps each part's own rank", () => {
    const { header, rows } = deepDiveText(groups[0])
    expect(header).toMatch(/Score 0\.703 Proportion #110\/317$/)
    expect(rows.find((row) => row.includes("0.975"))).toMatch(/\| #15\/173$/)
  })
})

describe("a benchmark shown only through parts of one measurement", () => {
  const parts = (scores: number[]) =>
    buildBenchmarkGroups(
      scores.map((score, i) =>
        entry({ id: "accuracy", name: "Accuracy", score, rank: [i + 1, 50] }, {
          evalId: `open-medical-llm%2Fmmlu-part-${i}`,
          name: `MMLU part ${i}`,
          parent: "mmlu",
        }),
      ),
      undefined,
    )[0]

  it("is their mean labelled `avg of N parts`, with no rank", () => {
    const group = parts([0.6, 0.8])
    expect(group.avgRawScore).toBeCloseTo(0.7, 12)
    expect(group.scoreNote).toBe("avg of 2 parts")
    expect(getGroupPeerRank(group)).toBeNull()
    const { header } = deepDiveText(group)
    expect(header).toMatch(/Avg of 2 parts 0\.7 Proportion$/)
  })

  it("shows a single part's score labelled `1 part`", () => {
    const group = parts([0.6])
    expect(group.avgRawScore).toBe(0.6)
    expect(group.scoreNote).toBe("1 part")
    expect(getGroupPeerRank(group)).toBeNull()
  })

  it("keeps parts on different splits apart", () => {
    const group = buildBenchmarkGroups(
      ["train", "test"].map((split, i) =>
        entry({ id: "accuracy", name: "Accuracy", score: 0.5 + i / 10, split }, {
          evalId: `open-medical-llm%2Fmmlu-part-${i}`,
          name: `MMLU part ${i}`,
          parent: "mmlu",
        }),
      ),
      undefined,
    )[0]
    expect(group.avgDisplayScore).toBe("2 parts")
    expect(group.avgRawScore).toBeNaN()
  })
})

describe("the Scores table for one benchmark several sources report (HarmBench)", () => {
  // meta-llama/llama-3.1, warehouse snapshot 2026-11-20T19-17-21Z.
  const sources: Array<[string, string, Partial<ComparisonMetricEntry>, number, string | null]> = [
    ["openeval", "openeval%2Fharmbench", { metric_key: "harmbench-refusal-score", metric_name: "HarmBench Refusal Score", unit: "score" }, 0.61625, "train"],
    ["helm", "helm-safety%2Fharmbench", { metric_key: "harmbench-refusal-score", metric_name: "HarmBench Refusal Score", unit: "proportion" }, 0.616, null],
    ["swissai-apertus-evals", "swissai-apertus-evals%2Fharmbench", { metric_key: "attack-success-rate", metric_name: "Attack Success Rate", unit: "proportion", lower_is_better: true }, 0.37604166666666666, "test"],
  ]
  const comparisonIndex = {
    evals: Object.fromEntries(
      sources.map(([, evalId, m, score]) => [
        evalId,
        {
          evaluation_id: evalId,
          benchmark_id: "harmbench",
          parent_benchmark_id: null,
          metrics: [
            {
              metric_summary_id: `harmbench%3A${m.metric_key}`,
              metric_id: m.metric_key,
              group: "capability",
              group_order: 0,
              lower_is_better: false,
              scores: [{ model_route_id: "meta-llama%2Fllama-3.1", score, score_canonical: score, scale_conversion: "none" }],
              ...m,
            },
          ],
        },
      ]),
    ),
  } as unknown as ComparisonIndex
  const rows = buildOverlapRows({
    benchmarkIndex: [
      {
        key: "harmbench",
        display_name: "HarmBench",
        appearances: sources.map(([family, evalId]) => ({
          family_key: family,
          benchmark_key: "harmbench",
          constituent_evaluation_ids: [evalId],
          is_canonical_home: false,
        })),
      },
    ],
    comparisonIndex,
    currentModelRouteId: "meta-llama%2Fllama-3.1",
    currentModelIdentityKeys: new Set(["meta-llama%2Fllama-3.1"]),
    familyDisplayByKey: new Map(),
    leadReadings: new Map(
      sources.map(([, evalId, m, , split]) => [evalId, { metricSummaryId: `harmbench%3A${m.metric_key}`, split, rank: null }]),
    ),
  })

  it("combines only the sources on one metric, and names the metric on each of the benchmark's rows", () => {
    expect(rows.map((row) => [row.canonicalDisplayName, row.appearances.map((a) => a.familyKey).sort(), row.mean])).toEqual([
      ["HarmBench · HarmBench Refusal Score", ["helm", "openeval"], expect.closeTo(0.616125, 10)],
      ["HarmBench · Attack Success Rate", ["swissai-apertus-evals"], 0.37604166666666666],
    ])
    expect(new Set(rows.map((row) => row.rowKey)).size).toBe(2)
  })

  it("keeps a source on another split of the same metric apart", () => {
    const split = buildOverlapRows({
      benchmarkIndex: [
        {
          key: "harmbench",
          display_name: "HarmBench",
          appearances: sources.slice(0, 2).map(([family, evalId]) => ({
            family_key: family,
            benchmark_key: "harmbench",
            constituent_evaluation_ids: [evalId],
            is_canonical_home: false,
          })),
        },
      ],
      comparisonIndex,
      currentModelRouteId: "meta-llama%2Fllama-3.1",
      currentModelIdentityKeys: new Set(["meta-llama%2Fllama-3.1"]),
      familyDisplayByKey: new Map(),
      leadReadings: new Map([
        ["openeval%2Fharmbench", { metricSummaryId: "harmbench%3Aharmbench-refusal-score", split: "train", rank: null }],
        ["helm-safety%2Fharmbench", { metricSummaryId: "harmbench%3Aharmbench-refusal-score", split: "test", rank: null }],
      ]),
    })
    expect(split).toHaveLength(2)
  })
})

describe("a rank on a model page", () => {
  // llm-stats/lmarena-text reports an arena score (1465-1483) on a metric
  // named "rank"; its rank is the row's own position.
  const rankEntry = (rank?: [number, number]) =>
    entry({ id: "rank", name: "Rank", score: 1473, unit: "points", rank }, {
      evalId: "llm-stats%2Flmarena-text",
      name: "LMArena Text",
    })

  it("is the row's position out of its total, never its score", () => {
    const [group] = buildBenchmarkGroups([rankEntry([3, 40])], undefined)
    expect(group.variants[0].rankPosition).toBe(3)
    expect(getGroupPeerRank(group)).toEqual({ position: 3, total: 40 })
    expect(deepDiveText(group).rows[0]).toMatch(/\| #3\/40$/)
  })

  it("is absent when the row has no position", () => {
    const [group] = buildBenchmarkGroups([rankEntry()], undefined)
    expect(group.variants[0].rankPosition).toBeNull()
    expect(getGroupPeerRank(group)).toBeNull()
    expect(deepDiveText(group).rows[0]).not.toContain("#")
  })
})

describe("a deep-dive row", () => {
  it("names its metric when no label on the row does", () => {
    const group = buildBenchmarkGroups(
      [
        entry({ id: "Copyright_avg_scores", score: 0.657, rank: [3, 8], lead: false }, {
          evalId: "agentharm%2Fagentharm-copyright",
          name: "AgentHarm Copyright",
        }),
        entry({ id: "Copyright_avg_refusals", score: 0.25, rank: [1, 8] }, {
          evalId: "agentharm%2Fagentharm-copyright",
          name: "AgentHarm Copyright",
        }),
      ],
      undefined,
    )[0]
    // The registry names neither metric, so the rows' labels are the eval's.
    const { rows } = deepDiveText(group)
    expect(rows.find((row) => row.includes("0.657"))).toMatch(/^AgentHarm Copyright .*Copyright Avg Scores/)
    expect(rows.find((row) => row.includes("0.25 "))).toMatch(/^AgentHarm Copyright .*Copyright Avg Refusals/)
  })
})

describe("a Researcher-list family header", () => {
  const own = (evalId: string, metric: Metric) => buildBenchmarkGroups([entry(metric, { evalId, name: evalId })], undefined)[0]

  it("is the mean of its groups' own readings when they are one measurement, labelled", () => {
    const score = familyScore([
      own("a%2Fone", { id: "accuracy", name: "Accuracy", score: 0.4 }),
      own("a%2Ftwo", { id: "accuracy", name: "Accuracy", score: 0.6 }),
    ])
    expect(score).toEqual({ text: "0.5 Proportion", note: "avg of 2" })
  })

  it("has no number when they are not, and counts the benchmarks instead", () => {
    const score = familyScore([
      own("a%2Fone", { id: "accuracy", name: "Accuracy", score: 0.4 }),
      own("a%2Ftwo", { id: "f1", name: "F1", score: 0.6 }),
    ])
    expect(score).toEqual({ text: "2 benchmarks", note: null })
  })
})
