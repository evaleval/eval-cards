import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { SplitBreakdown } from "@/components/split-breakdown"
import type { BenchmarkSummarySubtask } from "@/lib/eval-processing"
import { sharedLeadingWordCount, splitSharedPrefix } from "@/lib/split-names"

// The split list once cut every name off at a fixed width. BBH's 28 splits
// all start "big bench hard", so three of them read "big bench hard logical d…"
// and three "big bench hard tracking …": the part that tells them apart was
// the part removed. These pin that a name is shown whole.

function split(name: string, topScore: number, unit: string | undefined = "proportion"): BenchmarkSummarySubtask {
  return {
    subtask_key: name,
    subtask_name: name,
    display_name: name,
    canonical_display_name: name,
    metrics: [
      {
        metric_summary_id: `bbh%3A${encodeURIComponent(name)}`,
        metric_name: "Exact Match",
        display_name: "Exact Match",
        canonical_display_name: "Exact Match",
        metric_key: "exact-match",
        lower_is_better: false,
        models_count: 16,
        top_score: topScore,
        unit,
      } as BenchmarkSummarySubtask["metrics"][number],
    ],
  }
}

const BBH = [
  split("big bench hard", 0.93),
  split("big bench hard logical deduction five objects", 1),
  split("big bench hard logical deduction seven objects", 1),
  split("big bench hard logical deduction three objects", 1),
  split("big bench hard tracking shuffled objects seven objects", 1),
]

function render(subtasks: BenchmarkSummarySubtask[]) {
  return renderToStaticMarkup(
    createElement(SplitBreakdown, {
      subtasks,
      metricLabel: (name) => name ?? "Metric",
      formatScore: (score, unit) => (score == null ? "—" : `${score.toFixed(2)}${unit ? ` ${unit}` : ""}`),
    }),
  )
}

const visibleText = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ")

describe("split breakdown", () => {
  it("shows every split name whole, with nothing set to cut it off", () => {
    const html = render(BBH)

    for (const slice of BBH) expect(visibleText(html)).toContain(slice.display_name)
    expect(html).not.toContain("truncate")
  })

  it("states a shared unit once, in the header", () => {
    const text = visibleText(render(BBH))

    expect(text).toContain("Exact Match (proportion)")
    expect(text.split("proportion").length - 1).toBe(1)
    expect(text).toContain("best score among models")
  })

  it("keeps each metric's own unit when the splits do not share one metric", () => {
    const mixed = [split("suite accuracy", 0.9), split("suite latency", 1.5, "seconds")]
    const text = visibleText(render(mixed))

    expect(text).toContain("0.90 proportion")
    expect(text).toContain("1.50 seconds")
  })
})

describe("sharedLeadingWordCount", () => {
  it("counts the leading words every name shares", () => {
    expect(sharedLeadingWordCount(BBH.map((s) => s.display_name))).toBe(3)
    expect(sharedLeadingWordCount(["MMLU-Pro (Biology)", "MMLU-Pro (Business)"])).toBe(1)
  })

  it("shares nothing for a single name or unrelated names", () => {
    expect(sharedLeadingWordCount(["big bench hard"])).toBe(0)
    expect(sharedLeadingWordCount(["accuracy", "latency"])).toBe(0)
  })

  it("never empties a name made only of the shared words", () => {
    expect(splitSharedPrefix("big bench hard", 3)).toEqual({ shared: "", rest: "big bench hard" })
    expect(splitSharedPrefix("big bench hard web of lies", 3)).toEqual({ shared: "big bench hard", rest: "web of lies" })
  })
})
