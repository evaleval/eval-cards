import { describe, expect, it } from "vitest"

import { summariseScoreSpread } from "@/lib/eval-processing"

// A model's folded leaderboard row reports the producer's headline run
// and says where the study's other runs of that model landed. The runs
// are different CONFIGURATIONS, so what the row can honestly say about
// them is the observed range, not a statistic. These cover the
// arithmetic under that range.

describe("summariseScoreSpread", () => {
  it("returns the range and the count", () => {
    // Claude Opus 4.6's unassisted runs on the AISI page.
    const s = summariseScoreSpread([0.964, 0.604, 0.726, 0.75, 0.755])!
    expect(s.n).toBe(5)
    expect(s.min).toBe(0.604)
    expect(s.max).toBe(0.964)
  })

  it("reports a two-run spread as the two values it observed", () => {
    // The pair that made an interval absurd: a t-multiplier of 12.7 on
    // one degree of freedom rendered 0.50 and 0.41 as "0.45 ± 0.57",
    // wider than the scale and partly below zero. The endpoints say the
    // same thing and claim nothing.
    const s = summariseScoreSpread([0.5, 0.41])!
    expect(s.n).toBe(2)
    expect(s.min).toBe(0.41)
    expect(s.max).toBe(0.5)
  })

  it("collapses a single run to itself", () => {
    const s = summariseScoreSpread([0.42])!
    expect(s.n).toBe(1)
    expect(s.min).toBe(0.42)
    expect(s.max).toBe(0.42)
  })

  it("gives a zero-width range when every run agrees", () => {
    const s = summariseScoreSpread([0.5, 0.5, 0.5])!
    expect(s.min).toBe(s.max)
    expect(s.n).toBe(3)
  })

  it("ignores non-finite values and returns null when nothing is left", () => {
    expect(summariseScoreSpread([0.5, Number.NaN, 0.7])!.n).toBe(2)
    expect(summariseScoreSpread([])).toBeNull()
    expect(summariseScoreSpread([Number.NaN])).toBeNull()
  })
})
