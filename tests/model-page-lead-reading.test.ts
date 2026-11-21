import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import {
  BenchmarkDeepDiveDialogPanel,
  buildBenchmarkGroups,
  buildOverlapSummaryInputs,
  getGroupPeerRank,
} from "@/components/benchmark-detail"
import { Dialog } from "@/components/ui/dialog"
import type { BenchmarkEvaluation, EvalTag, EvaluationResult } from "@/lib/benchmark-schema"
import { buildOverlapRows } from "@/lib/overlaps"

vi.mock("next/navigation", () => import("./next-navigation-stub"))

// Beyond the Summary view, a model page shows one number or one rank for an
// eval in three more places: the overlaps table, the deep-dive table and the
// rank beside a Researcher-view group. Each reads the reading view-data flags
// `is_lead_metric`, and a rank is the rank of the number it sits beside.

const MODEL_ID = "mistralai/mistral-small"

type Metric = {
  id: string
  score: number
  /** [position, total] on this metric; absent when the pipeline ranked no row. */
  rank?: [number, number]
  lead?: boolean
}

// Mistral Small on agentharm/agentharm-copyright, warehouse snapshot
// 2026-11-20T19-17-21Z. The eval is ranked on the refusal rate; the scores
// metric is the higher number and the one a name pattern would pick.
const COPYRIGHT = "agentharm%2Fagentharm-copyright"
const COPYRIGHT_METRICS: Metric[] = [
  { id: "Copyright_avg_scores", score: 0.6574900793650794, rank: [3, 8] },
  { id: "Copyright_avg_refusals", score: 0.25, rank: [1, 8], lead: true },
]

function entry(metric: Metric, { evalId = COPYRIGHT, parent }: { evalId?: string; parent?: string } = {}) {
  const localId = decodeURIComponent(evalId).split("/")[1]
  const result = {
    evaluation_name: "AgentHarm Copyright",
    metric_summary_id: `${localId}%3A${encodeURIComponent(metric.id)}`,
    metric_key: metric.id,
    evaluation_timestamp: "",
    source_data: { dataset_name: "AgentHarm" },
    metric_config: { lower_is_better: false, score_type: "continuous", min_score: 0, max_score: 1, unit: "proportion" },
    score_details: { score: metric.score },
    is_lead_metric: Boolean(metric.lead),
    position: metric.rank?.[0],
    total: metric.rank?.[1],
  } as unknown as EvaluationResult
  const evaluation = {
    schema_version: "1.0",
    eval_summary_id: evalId,
    evaluation_id: evalId,
    retrieved_timestamp: "",
    benchmark: "AgentHarm Copyright",
    display_name: "AgentHarm Copyright",
    family_id: "agentharm",
    benchmark_family_name: "AgentHarm",
    is_slice: Boolean(parent),
    parent_benchmark_id: parent,
    source_data: { dataset_name: "AgentHarm" },
    source_metadata: {
      source_name: "Arcadia Impact",
      source_type: "evaluation_run",
      source_organization_name: "Arcadia Impact",
      evaluator_relationship: "third_party",
    },
    model_info: { name: "Mistral Small", id: MODEL_ID },
    evaluation_results: [result],
  } as unknown as BenchmarkEvaluation
  return { evaluation, result, category: "safety" as EvalTag }
}

const copyrightGroups = (metrics: Metric[] = COPYRIGHT_METRICS) =>
  buildBenchmarkGroups(
    metrics.map((metric) => entry(metric)),
    undefined,
  )

describe("overlaps table row for a benchmark only one source reports", () => {
  it("shows the lead reading's value and names its metric", () => {
    const inputs = buildOverlapSummaryInputs(copyrightGroups())
    const rows = buildOverlapRows({
      benchmarkIndex: undefined,
      comparisonIndex: undefined,
      currentModelRouteId: encodeURIComponent(MODEL_ID),
      currentModelIdentityKeys: new Set([MODEL_ID]),
      familyDisplayByKey: new Map(),
      leadReadings: inputs.leadReadings,
      summaryCandidates: inputs.candidates,
      summaryJoinRows: inputs.joinRows,
    })

    expect(rows).toHaveLength(1)
    expect(rows[0].appearances).toHaveLength(1)
    expect(rows[0].appearances[0].metricSummaryId).toBe("agentharm-copyright%3ACopyright_avg_refusals")
    expect(rows[0].appearances[0].displayScore).toBe("25.0%")
    expect(rows[0].mean).toBe(0.25)
  })

  it("tells the overlaps builder which reading each eval's row leads with, and its rank", () => {
    const { leadReadings } = buildOverlapSummaryInputs(copyrightGroups())

    expect([...leadReadings]).toEqual([
      [
        COPYRIGHT,
        {
          metricSummaryId: "agentharm-copyright%3ACopyright_avg_refusals",
          split: null,
          rank: { position: 1, total: 8 },
        },
      ],
    ])
  })
})

// The deep-dive table's rows as a reader sees them: one string per row,
// cells joined by " | ".
function deepDiveText(metrics: Metric[]) {
  const [group] = copyrightGroups(metrics)
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
      .replace(/&nbsp;| /g, " ")
      .replace(/\s+/g, " ")
      .trim()
  const rows = (html.split("<tbody>")[1] ?? "")
    .split("</tr>")
    .filter((row) => row.includes("<td"))
    .map((row) => row.split("</td>").slice(0, -1).map(text).join(" | "))
  const bestRank = text(html.split("Best rank")[1]?.split("Sources")[0] ?? "")
  return { rows, bestRank }
}

describe("deep-dive table", () => {
  it("gives each row the model's rank on that row's own metric", () => {
    const { rows } = deepDiveText(COPYRIGHT_METRICS)

    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.includes("0.657"))).toMatch(/\| 0\.657 Proportion \| #3\/8$/)
    expect(rows.find((row) => row.includes("0.25 "))).toMatch(/\| 0\.25 Proportion \| #1\/8$/)
  })

  it("shows no rank on a row the pipeline did not rank", () => {
    const { rows } = deepDiveText([COPYRIGHT_METRICS[0], { ...COPYRIGHT_METRICS[1], rank: undefined }])

    expect(rows.find((row) => row.includes("0.657"))).toMatch(/\| #3\/8$/)
    const unranked = rows.find((row) => row.includes("0.25 "))
    expect(unranked).toMatch(/\| 0\.25 Proportion \| —$/)
    expect(unranked).not.toContain("#")
  })

  it("takes Best rank from the rows' own ranks", () => {
    expect(deepDiveText(COPYRIGHT_METRICS).bestRank).toBe("#1/8")
    expect(deepDiveText([COPYRIGHT_METRICS[0], { ...COPYRIGHT_METRICS[1], rank: undefined }]).bestRank).toBe("#3/8")
    expect(deepDiveText(COPYRIGHT_METRICS.map((metric) => ({ ...metric, rank: undefined }))).bestRank).toBe("N/A")
  })
})

describe("the rank beside a Researcher-view group's number", () => {
  it("is the lead reading's own rank for a group of one eval", () => {
    const leadOffPrimary = copyrightGroups([
      { ...COPYRIGHT_METRICS[0], lead: true },
      { ...COPYRIGHT_METRICS[1], lead: false },
    ])[0]

    expect(leadOffPrimary.avgRawScore).toBe(0.6574900793650794)
    expect(getGroupPeerRank(leadOffPrimary)).toEqual({ position: 3, total: 8 })
  })

  it("is absent when the pipeline did not rank the lead reading", () => {
    const [group] = copyrightGroups([COPYRIGHT_METRICS[0], { ...COPYRIGHT_METRICS[1], rank: undefined }])

    expect(group.avgRawScore).toBe(0.25)
    expect(getGroupPeerRank(group)).toBeNull()
  })

  it("is absent for a group of parts, whose number is no one reading", () => {
    const groups = buildBenchmarkGroups(
      [
        entry(COPYRIGHT_METRICS[1], { parent: "agentharm" }),
        entry(
          { id: "Fraud_avg_refusals", score: 0.4583, rank: [4, 8], lead: true },
          { evalId: "agentharm%2Fagentharm-fraud", parent: "agentharm" },
        ),
      ],
      undefined,
    )

    expect(groups).toHaveLength(1)
    expect(getGroupPeerRank(groups[0])).toBeNull()
  })
})
