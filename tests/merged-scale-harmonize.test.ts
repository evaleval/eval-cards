import { describe, expect, it } from "vitest"

import { harmonizeUnboundedScales } from "@/lib/merged-adapter"
import type { MergedObservationRow } from "@/lib/eval-processing"

function row(
  source: string,
  model: string,
  score: number,
  overrides: Partial<MergedObservationRow> = {},
): MergedObservationRow {
  return {
    model_info: { name: model, id: `org/${model}` },
    model_key: `org/${model}`,
    evaluation_id: `${source}%2Fbench`,
    composite_slug: source,
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

const scores = (rows: MergedObservationRow[]) =>
  rows.map((r) => [r.composite_slug, r.model_info.name, r.score_canonical])

describe("harmonizeUnboundedScales", () => {
  it("puts a fraction source onto a percent source's scale (cybergym)", () => {
    const { rows, toPercent } = harmonizeUnboundedScales(
      [
        row("benchpress", "a", 83.8),
        row("benchpress", "b", 76.7),
        row("benchpress", "c", 73.8),
        row("llm-stats", "x", 0.951),
        row("llm-stats", "b", 0.767),
        row("llm-stats", "c", 0.738),
      ],
      false,
    )
    expect(toPercent).toBe(true)
    expect(scores(rows)).toEqual([
      ["llm-stats", "x", 95.1],
      ["benchpress", "a", 83.8],
      ["benchpress", "b", 76.7],
      ["llm-stats", "b", 76.7],
      ["benchpress", "c", 73.8],
      ["llm-stats", "c", 73.8],
    ])
    expect(rows.find((r) => r.composite_slug === "llm-stats")?.scale_harmonized).toBe("mul100")
    expect(rows.find((r) => r.composite_slug === "benchpress")?.scale_harmonized).toBeUndefined()
    // The published number is untouched.
    expect(rows.find((r) => r.model_info.name === "x")?.score).toBe(0.951)
  })

  it("keeps the majority scale and sorts lower-is-better ascending", () => {
    const { rows, toPercent } = harmonizeUnboundedScales(
      [row("p", "a", 40), row("f1", "b", 0.3), row("f2", "c", 0.5)],
      true,
    )
    expect(toPercent).toBe(false)
    expect(scores(rows)).toEqual([
      ["f1", "b", 0.3],
      ["p", "a", 0.4],
      ["f2", "c", 0.5],
    ])
  })

  it("leaves the pool alone when every source is on one scale", () => {
    const input = [row("a", "m", 80), row("b", "n", 60)]
    expect(harmonizeUnboundedScales(input, false)).toEqual({ rows: input, toPercent: null })
  })

  it("leaves the pool alone for scores outside 0-100 (Elo)", () => {
    const input = [row("a", "m", 1250), row("b", "n", 0.8)]
    expect(harmonizeUnboundedScales(input, false).toPercent).toBeNull()
  })

  it("leaves the pool alone when a row carries a registry conversion", () => {
    const input = [row("a", "m", 80), row("b", "n", 0.8, { scale_conversion: "none" })]
    expect(harmonizeUnboundedScales(input, false).toPercent).toBeNull()
  })

  it("does not move scales the shared models say already agree", () => {
    // Source b's scores are all <= 1 but on the same 0-100 scale as a.
    const input = [row("a", "m", 1.2), row("a", "z", 30), row("b", "m", 0.9)]
    expect(harmonizeUnboundedScales(input, false).toPercent).toBeNull()
  })

  it("reads a raw-total source as a share of the published maximum (MME)", () => {
    const { rows, toPercent } = harmonizeUnboundedScales(
      [row("pwc", "a", 2549.8), row("pwc", "b", 1450.3), row("llm-stats", "c", 0.731)],
      false,
      2800,
    )
    expect(toPercent).toBe(false)
    expect(rows.map((r) => [r.model_info.name, Number(r.score_canonical?.toFixed(4))])).toEqual([
      ["a", 0.9106],
      ["c", 0.731],
      ["b", 0.518],
    ])
    expect(rows[0].scale_harmonized).toBe("of_total")
    expect(rows[1].scale_harmonized).toBeUndefined()
  })

  it("leaves a raw total alone without a published maximum, or above it", () => {
    const input = [row("pwc", "a", 2549.8), row("llm-stats", "c", 0.731)]
    expect(harmonizeUnboundedScales(input, false).toPercent).toBeNull()
    expect(harmonizeUnboundedScales(input, false, 1000).toPercent).toBeNull()
  })
})
