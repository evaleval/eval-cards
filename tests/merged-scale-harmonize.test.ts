import { describe, expect, it } from "vitest"

import { harmonizeUnboundedScales, scaleHarmonizedNotes } from "@/lib/merged-adapter"
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

  it("does not convert on a single shared model that scores zero on one side", () => {
    const input = [row("a", "m", 40), row("a", "z", 30), row("b", "m", 0), row("b", "y", 0.5)]
    expect(harmonizeUnboundedScales(input, false)).toEqual({ rows: input, toPercent: null })
  })

  it("still converts when one zero pair sits among agreeing pairs", () => {
    const { rows, toPercent } = harmonizeUnboundedScales(
      [
        row("a", "m", 40),
        row("a", "n", 30),
        row("a", "o", 20),
        row("a", "z", 10),
        row("b", "m", 0.41),
        row("b", "n", 0.3),
        row("b", "o", 0.2),
        row("b", "z", 0),
      ],
      false,
    )
    expect(toPercent).toBe(true)
    expect(rows.map((r) => r.score_canonical)).toEqual([41, 40, 30, 30, 20, 20, 10, 0])
  })

  it("skips a shared model that scores zero on both sides", () => {
    const { rows, toPercent } = harmonizeUnboundedScales(
      [row("a", "m", 40), row("a", "z", 0), row("b", "m", 0.4), row("b", "z", 0)],
      false,
    )
    expect(toPercent).toBe(true)
    expect(rows.map((r) => r.score_canonical)).toEqual([40, 40, 0, 0])
  })

  it("rounds away float noise so a converted score ties with the native one", () => {
    const { rows } = harmonizeUnboundedScales(
      [row("p", "a", 58), row("p", "b", 30), row("f", "a", 0.58), row("f", "c", 0.07)],
      false,
    )
    expect(scores(rows)).toEqual([
      ["p", "a", 58],
      ["f", "a", 58],
      ["p", "b", 30],
      ["f", "c", 7],
    ])
    expect(String(rows[1].score_canonical)).toBe("58")

    const down = harmonizeUnboundedScales(
      [row("p", "a", 56.7), row("f1", "b", 0.3), row("f2", "c", 0.5)],
      false,
    )
    expect(down.rows.map((r) => r.score_canonical)).toEqual([0.567, 0.5, 0.3])

    const total = harmonizeUnboundedScales([row("t", "a", 2086), row("p", "b", 60)], false, 2800)
    expect(total.rows.map((r) => r.score_canonical)).toEqual([74.5, 60])
  })

  it("leaves a precisely published score as it converts", () => {
    const { rows } = harmonizeUnboundedScales(
      [row("p", "a", 12.34567890126), row("f", "a", 0.1234567890126)],
      false,
    )
    expect(scores(rows)).toEqual([
      ["p", "a", 12.34567890126],
      ["f", "a", 12.34567890126],
    ])
  })

  it("leaves a pool of raw totals alone when no source is on another scale", () => {
    const input = [row("t1", "a", 2086), row("t2", "b", 1400)]
    expect(harmonizeUnboundedScales(input, false, 2800)).toEqual({ rows: input, toPercent: null })
  })

  it("keeps null and NaN rows last, in place and untouched", () => {
    const blank = row("f", "x", 0.9, { score_canonical: null })
    const nan = row("p", "y", 12, { score_canonical: Number.NaN })
    const { rows, toPercent } = harmonizeUnboundedScales(
      [row("p", "a", 80), row("f", "b", 0.9), blank, nan],
      false,
    )
    expect(toPercent).toBe(true)
    expect(rows.slice(0, 2).map((r) => r.score_canonical)).toEqual([90, 80])
    expect(rows[2]).toBe(blank)
    expect(rows[3]).toBe(nan)
  })

  it("leaves a pool with negative scores alone", () => {
    const input = [row("a", "m", 80), row("a", "n", -5), row("b", "o", 0.8)]
    expect(harmonizeUnboundedScales(input, false)).toEqual({ rows: input, toPercent: null })
  })

  it("keeps percent when as many sources use it as use fractions", () => {
    const { rows, toPercent } = harmonizeUnboundedScales(
      [row("p", "a", 40), row("f", "b", 0.5)],
      false,
    )
    expect(toPercent).toBe(true)
    expect(scores(rows)).toEqual([
      ["f", "b", 50],
      ["p", "a", 40],
    ])
  })

  it("converts on the sources' ranges alone when they share no model", () => {
    const { rows, toPercent } = harmonizeUnboundedScales(
      [row("p", "a", 40), row("p", "b", 35), row("f", "c", 0.5), row("f", "d", 0.2)],
      false,
    )
    expect(toPercent).toBe(true)
    expect(rows.map((r) => r.score_canonical)).toEqual([50, 40, 35, 20])
  })
})

describe("scaleHarmonizedNotes", () => {
  it("names each rescaled source once and says what was done to its scores", () => {
    expect(
      scaleHarmonizedNotes([
        { name: "LLM Stats", kind: "mul100" },
        { name: "LLM Stats", kind: "mul100" },
        { name: "Other", kind: "mul100" },
        { name: "BenchPress", kind: undefined },
      ]),
    ).toEqual([
      "Scores from LLM Stats, Other are shown multiplied by 100 to match the range of the other sources, which may not measure the same quantity.",
    ])
    expect(scaleHarmonizedNotes([{ name: "A", kind: "div100" }])[0]).toContain(
      "Scores from A are shown divided by 100 to match",
    )
    expect(scaleHarmonizedNotes([{ name: "A", kind: "of_total" }])[0]).toContain(
      "shown as a share of the benchmark's published maximum to match",
    )
    expect(scaleHarmonizedNotes([{ name: "A", kind: undefined }])).toEqual([])
  })
})
