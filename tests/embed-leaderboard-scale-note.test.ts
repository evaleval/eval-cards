// @vitest-environment happy-dom
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"

import type { MergedBenchmarkSummary, MergedObservationRow } from "@/lib/eval-processing"

let payload: MergedBenchmarkSummary

vi.mock("next/navigation", async () => ({
  ...(await import("./next-navigation-stub")),
  useParams: () => ({ id: ["bench"] }),
}))
vi.mock("@/lib/dashboard-data-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard-data-client")>()),
  fetchMergedBenchmarkSummary: () => Promise.resolve(payload),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function row(
  source: string,
  model: string,
  score: number,
  overrides: Partial<MergedObservationRow> = {},
): MergedObservationRow {
  return {
    model_info: { name: model, id: `org/${model}` },
    model_key: `org/${model}`,
    model_route_id: `org%2F${model}`,
    evaluation_id: `${source}%2Fbench`,
    composite_slug: source,
    composite_display_name: source === "src-a" ? "Source A" : "Source B",
    score,
    score_canonical: score,
    scale_conversion: "no_bounds",
    evaluation_timestamp: "2026-01-01T00:00:00Z",
    source_metadata: {
      source_name: source,
      source_type: "leaderboard",
      source_organization_name: source,
      evaluator_relationship: "third_party",
    },
    ...overrides,
  }
}

function mergedPayload(results: MergedObservationRow[]): MergedBenchmarkSummary {
  const source = (slug: string, name: string) => ({
    evaluation_id: `${slug}%2Fbench`,
    composite_slug: slug,
    composite_display_name: name,
    models_count: 1,
    results_count: 1,
    reports_preferred: true,
    slice_only: false,
  })
  return {
    merged: true,
    evaluation_id: "bench",
    benchmark_id: "bench",
    display_name: "Bench",
    grain: "benchmark",
    preferred_metric_id: "score",
    preferred_metric_display_name: "Score",
    preferred_from_registry: false,
    lower_is_better: false,
    sources_count: 2,
    all_sources_count: 2,
    results_count: results.length,
    models_count: 2,
    best_result: null,
    aggregate_sources: [source("src-a", "Source A"), source("src-b", "Source B")],
    metrics: [
      {
        metric_id: "score",
        display_name: "Score",
        results_count: results.length,
        models_count: 2,
        sources_count: 2,
        lower_is_better: false,
      },
    ],
    slices: null,
    selected_metric_id: "score",
    selected_lower_is_better: false,
    selected_slice_id: null,
    results,
  }
}

async function render(results: MergedObservationRow[]) {
  payload = mergedPayload(results)
  const { default: EmbedEvalLeaderboard } = await import("@/app/embed/eval/leaderboard/[...id]/page")
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(EmbedEvalLeaderboard))
  })
  const note = container.querySelector("[data-scale-note]")
  const firstRow = container.querySelector("tbody tr")
  const rendered = {
    rows: container.querySelectorAll("tbody tr").length,
    note: note?.textContent ?? null,
    noteBeforeRows:
      note != null &&
      firstRow != null &&
      Boolean(note.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING),
    marks: Array.from(container.querySelectorAll("[data-rescaled-mark]")).map((mark) => ({
      model: mark.closest("tr")?.querySelector("td:nth-child(2) span")?.textContent ?? "",
      title: mark.getAttribute("title"),
    })),
  }
  await act(async () => root.unmount())
  container.remove()
  return rendered
}

describe("the merged leaderboard embed", () => {
  it("discloses rescaled scores with the note and a mark on each rescaled row", async () => {
    const { rows, note, noteBeforeRows, marks } = await render([
      row("src-a", "a", 83.8),
      row("src-b", "b", 0.767, {
        score_canonical: 76.7,
        score_published: 0.767,
        scale_harmonized: "mul100",
      }),
    ])
    expect(rows).toBe(2)
    expect(note).toBe(
      "† Scores from Source B are shown multiplied by 100 to match the range of the other sources, which may not measure the same quantity.",
    )
    expect(noteBeforeRows).toBe(true)
    expect(marks).toEqual([{ model: "b", title: "Rescaled x100: published as 0.767" }])
  })

  it("shows no note and no mark when no row was rescaled", async () => {
    const { rows, note, marks } = await render([row("src-a", "a", 83.8), row("src-b", "b", 76.7)])
    expect(rows).toBe(2)
    expect(note).toBeNull()
    expect(marks).toEqual([])
  })
})
