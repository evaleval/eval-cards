// @vitest-environment happy-dom
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"

import type { BenchmarkEvalSummary, BenchmarkLeaderboardRow } from "@/lib/eval-processing"

let mockParams: { id: string[] } = { id: ["openeval", "harmbench"] }
let mockSearch = new URLSearchParams()
let mockEvalSummary: BenchmarkEvalSummary

vi.mock("next/navigation", async () => ({
  ...(await import("./next-navigation-stub")),
  useParams: () => mockParams,
  useSearchParams: () => mockSearch,
}))

vi.mock("@/lib/dashboard-data-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard-data-client")>()),
  fetchEvalSummary: () => Promise.resolve(mockEvalSummary),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function row(
  id: string,
  name: string,
  values: Record<string, number | null | undefined>,
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
    source_data: { dataset_name: "HarmBench" },
    values: values as Record<string, number>,
    metrics_present: Object.values(values).filter((v) => typeof v === "number").length,
  } as BenchmarkLeaderboardRow
}

function makePerSourceSummary(
  overrides: Partial<BenchmarkEvalSummary> = {},
): BenchmarkEvalSummary {
  return {
    evaluation_id: "openeval%2Fharmbench",
    evaluation_name: "HarmBench",
    composite_benchmark_key: "openeval",
    composite_benchmark_name: "OpenEval",
    primary_metric_id: "harmbench-refusal-score",
    metric_config: {
      evaluation_description: "HarmBench Refusal Score",
      lower_is_better: false,
      score_type: "continuous",
    },
    leaderboard_metrics: [
      {
        column_key: "harmbench-refusal-score",
        metric_id: "harmbench-refusal-score",
        metric_summary_id: "harmbench%3Aharmbench-refusal-score",
        metric_name: "HarmBench Refusal Score",
        display_name: "HarmBench Refusal Score",
        lower_is_better: false,
        unit: "score",
        scope: "root",
      },
      {
        column_key: "attack-success-rate",
        metric_id: "attack-success-rate",
        metric_summary_id: "harmbench%3Aattack-success-rate",
        metric_name: "Attack Success Rate",
        display_name: "Attack Success Rate",
        lower_is_better: true,
        unit: "proportion",
        scope: "root",
      },
    ],
    // Model Gamma explicitly carries null for attack-success-rate; Model Delta
    // only reports attack-success-rate (missing harmbench-refusal-score).
    leaderboard_rows: [
      row("org/alpha", "Model Alpha", { "harmbench-refusal-score": 0.9, "attack-success-rate": 0.25 }),
      row("org/beta", "Model Beta", { "harmbench-refusal-score": 0.7, "attack-success-rate": 0.15 }),
      row("org/gamma", "Model Gamma", { "harmbench-refusal-score": 0.8, "attack-success-rate": null }),
      row("org/delta", "Model Delta", { "harmbench-refusal-score": null, "attack-success-rate": 0.08 }),
    ],
    model_results: [],
    models_count: 4,
    evaluator_names: ["OpenEval"],
    source_types: ["leaderboard"],
    third_party_ratio: 1,
    missing_generation_config_count: 0,
    avg_score: 0.8,
    avg_score_norm: 0.8,
    ...overrides,
  } as BenchmarkEvalSummary
}

async function renderEmbed(query: string, summary: BenchmarkEvalSummary) {
  mockParams = { id: ["openeval", "harmbench"] }
  mockSearch = new URLSearchParams(query)
  mockEvalSummary = summary
  const { default: EmbedEvalLeaderboard } = await import(
    "@/app/embed/eval/leaderboard/[...id]/page"
  )
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(EmbedEvalLeaderboard))
  })
  const headers = Array.from(container.querySelectorAll("thead th")).map((th) =>
    th.textContent?.trim() ?? "",
  )
  const rows = Array.from(container.querySelectorAll("tbody tr")).map((tr) => ({
    rank: tr.querySelector("td:nth-child(1)")?.textContent?.trim() ?? "",
    model: tr.querySelector("td:nth-child(2) span")?.textContent?.trim() ?? "",
    cells: Array.from(tr.querySelectorAll("td"))
      .slice(2)
      .map((td) => td.textContent?.trim() ?? ""),
  }))
  await act(async () => {
    root.unmount()
  })
  container.remove()
  return { headers, rows }
}

describe("EmbedEvalLeaderboard — metric filtering and null-cell safety", () => {
  it("filters columns and rows to ?metric= and never coerces null cells to 0", async () => {
    const { headers, rows } = await renderEmbed(
      "metric=attack-success-rate",
      makePerSourceSummary(),
    )

    // Only the selected metric column appears (never HarmBench Refusal Score):
    expect(headers).toHaveLength(3)
    expect(headers[2]).toContain("Attack Success Rate")
    expect(headers.join(" ")).not.toContain("HarmBench Refusal Score")

    // Model Gamma (explicit null on attack-success-rate) MUST be excluded, NOT coerced to 0!
    // Sorted lowest-first: Model Delta (0.08), Model Beta (0.15), Model Alpha (0.25).
    expect(rows.map((r) => r.model)).toEqual(["Model Delta", "Model Beta", "Model Alpha"])
    expect(rows.map((r) => r.rank)).toEqual(["1", "2", "3"])
  })

  it("filters to primary_metric_id by default and excludes models with null primary score", async () => {
    const { headers, rows } = await renderEmbed("", makePerSourceSummary())

    expect(headers).toHaveLength(3)
    expect(headers[2]).toContain("HarmBench Refusal Score")
    // Model Delta has null on primary refusal score -> excluded!
    expect(rows.map((r) => r.model)).toEqual(["Model Alpha", "Model Gamma", "Model Beta"])
  })

  it("preserves the multi-column matrix when primary_metric_id is absent and no ?metric= is set, displaying null cells as em-dash", async () => {
    const { headers, rows } = await renderEmbed(
      "",
      makePerSourceSummary({ primary_metric_id: undefined }),
    )

    expect(headers).toHaveLength(4)
    expect(rows).toHaveLength(4)
    const gammaRow = rows.find((r) => r.model === "Model Gamma")!
    expect(gammaRow.cells[1]).toBe("—")
    const deltaRow = rows.find((r) => r.model === "Model Delta")!
    expect(deltaRow.cells[0]).toBe("—")
  })

  it("retains an explicit ?metric= with all-null scores as an empty state rather than falling back to another metric", async () => {
    const allNullAsr = makePerSourceSummary({
      leaderboard_rows: [
        row("org/alpha", "Model Alpha", { "harmbench-refusal-score": 0.9, "attack-success-rate": null }),
        row("org/beta", "Model Beta", { "harmbench-refusal-score": 0.7, "attack-success-rate": null }),
      ],
    })
    const { headers, rows } = await renderEmbed("metric=attack-success-rate", allNullAsr)

    expect(headers).toHaveLength(3)
    expect(headers[2]).toContain("Attack Success Rate")
    expect(headers.join(" ")).not.toContain("HarmBench Refusal Score")
    expect(rows).toHaveLength(1)
    expect(rows[0].rank).toContain("No models report Attack Success Rate.")
  })

  it("retains an all-null declared primary_metric_id as an empty state rather than falling back to a secondary metric", async () => {
    const allNullPrimary = makePerSourceSummary({
      leaderboard_rows: [
        row("org/alpha", "Model Alpha", { "harmbench-refusal-score": null, "attack-success-rate": 0.25 }),
        row("org/beta", "Model Beta", { "harmbench-refusal-score": null, "attack-success-rate": 0.15 }),
      ],
    })
    const { headers, rows } = await renderEmbed("", allNullPrimary)

    expect(headers).toHaveLength(3)
    expect(headers[2]).toContain("HarmBench Refusal Score")
    expect(headers.join(" ")).not.toContain("Attack Success Rate")
    expect(rows).toHaveLength(1)
    expect(rows[0].rank).toContain("No models report HarmBench Refusal Score.")
  })

  it("never substitutes primary model_results in protocol mode when a curated study selects an all-null secondary metric", async () => {
    const curatedAllNullSecondary = makePerSourceSummary({
      collection: {
        curated: true,
        protocol_axes: [{ key: "reasoning_effort", label: "Effort" }],
      } as any,
      leaderboard_rows: [
        row("org/alpha", "Model Alpha", { "harmbench-refusal-score": 0.9, "attack-success-rate": null }),
        row("org/beta", "Model Beta", { "harmbench-refusal-score": 0.7, "attack-success-rate": null }),
      ],
      model_results: [
        {
          model_info: { id: "org/alpha", name: "Model Alpha", developer: "Org" },
          score: 0.9,
          protocol_condition: { reasoning_effort: "high" },
          evaluation_timestamp: "2026-05-01T00:00:00Z",
          source_metadata: {
            source_name: "OpenEval",
            source_type: "leaderboard",
            evaluator_relationship: "third_party",
          },
          source_data: { dataset_name: "HarmBench" },
          result: {
            evaluation_name: "HarmBench",
            evaluation_timestamp: "2026-05-01T00:00:00Z",
            metric_config: { lower_is_better: false, score_type: "continuous" },
            score_details: { score: 0.9 },
          },
        },
      ] as any,
    })

    const { headers, rows } = await renderEmbed(
      "metric=attack-success-rate",
      curatedAllNullSecondary,
    )

    expect(headers).toHaveLength(3)
    expect(headers[2]).toContain("Attack Success Rate")
    expect(rows).toHaveLength(1)
    expect(rows[0].rank).toContain("No models report Attack Success Rate.")
    expect(rows.map((r) => r.model).join(" ")).not.toContain("Model Alpha")
  })
})

describe("EmbedEvalDistribution & EmbedEvalFrontier — insufficient-data ?metric= guard", () => {
  it("renders a metric-specific empty state instead of falling back to the primary metric when ?metric= has < 3 scores", async () => {
    const sparseSecondary = makePerSourceSummary({
      leaderboard_rows: [
        row("org/alpha", "Model Alpha", { "harmbench-refusal-score": 0.9, "attack-success-rate": 0.25 }),
        row("org/beta", "Model Beta", { "harmbench-refusal-score": 0.8, "attack-success-rate": 0.15 }),
        row("org/gamma", "Model Gamma", { "harmbench-refusal-score": 0.7, "attack-success-rate": null }),
      ],
    })

    mockParams = { id: ["openeval", "harmbench"] }
    mockSearch = new URLSearchParams("metric=attack-success-rate")
    mockEvalSummary = sparseSecondary

    const { default: EmbedEvalDistribution } = await import(
      "@/app/embed/eval/distribution/[...id]/page"
    )
    const { default: EmbedEvalFrontier } = await import(
      "@/app/embed/eval/frontier/[...id]/page"
    )

    for (const [Component, expectedPrefix] of [
      [EmbedEvalDistribution, "Score distribution requires at least 3 models reporting Attack Success Rate."],
      [EmbedEvalFrontier, "Pareto frontier requires at least 3 models reporting Attack Success Rate."],
    ] as const) {
      const container = document.createElement("div")
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(createElement(Component))
      })
      const text = container.textContent ?? ""
      expect(text).toContain(expectedPrefix)
      expect(text).not.toContain("HarmBench Refusal Score")
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })
})
