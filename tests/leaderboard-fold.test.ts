import { describe, expect, it } from "vitest"

import { summariseScores } from "@/lib/eval-processing"

// A model's leaderboard row folds its runs on the page into one number:
// the mean, with a 95% interval describing how far the runs spread. The
// runs are different CONFIGURATIONS, so that interval is about the setup
// moving the score, not sampling error — the UI has to say so, and these
// cover the arithmetic under it.

describe("summariseScores", () => {
  it("returns the mean, range and count", () => {
    // Claude Opus 4.6's unassisted runs on the AISI page.
    const s = summariseScores([0.964, 0.604, 0.726, 0.75, 0.755])!
    expect(s.n).toBe(5)
    expect(s.mean).toBeCloseTo(0.7598, 4)
    expect(s.min).toBe(0.604)
    expect(s.max).toBe(0.964)
  })

  it("uses the t distribution, not 1.96, for the small folds we actually have", () => {
    // n=5 -> t(0.975, 4) = 2.776. sd = 0.13137..., se = sd/sqrt(5).
    const s = summariseScores([0.964, 0.604, 0.726, 0.75, 0.755])!
    const values = [0.964, 0.604, 0.726, 0.75, 0.755]
    const mean = values.reduce((a, b) => a + b, 0) / 5
    const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / 4)
    expect(s.ci95).toBeCloseTo(2.776 * (sd / Math.sqrt(5)), 6)
    // The normal approximation would be visibly too tight here.
    expect(s.ci95!).toBeGreaterThan(1.96 * (sd / Math.sqrt(5)))
  })

  it("widens the interval sharply for a two-run fold", () => {
    // t(0.975, 1) = 12.706 — two runs say very little, and the interval
    // must not pretend otherwise.
    const s = summariseScores([0.8, 0.72])!
    expect(s.n).toBe(2)
    expect(s.mean).toBeCloseTo(0.76, 10)
    // sd = 0.056568, se = 0.04, so the interval is 12.706 * 0.04.
    expect(s.ci95).toBeCloseTo(0.50824, 5)
  })

  it("still computes the interval for two runs, so callers can decide", () => {
    // The arithmetic is right; it is the DISPLAY that must not show
    // "0.45 ± 0.57" for a 0.50 / 0.41 pair. summariseScores reports it and
    // the leaderboard suppresses it below three runs.
    const s = summariseScores([0.5, 0.41])!
    expect(s.n).toBe(2)
    expect(s.ci95!).toBeGreaterThan(0.5)
  })

  it("gives no interval for a single run", () => {
    const s = summariseScores([0.42])!
    expect(s.mean).toBe(0.42)
    expect(s.ci95).toBeNull()
    expect(s.min).toBe(0.42)
    expect(s.max).toBe(0.42)
  })

  it("gives a zero interval when every run agrees", () => {
    expect(summariseScores([0.5, 0.5, 0.5])!.ci95).toBe(0)
  })

  it("ignores non-finite values and returns null when nothing is left", () => {
    expect(summariseScores([0.5, Number.NaN, 0.7])!.n).toBe(2)
    expect(summariseScores([])).toBeNull()
    expect(summariseScores([Number.NaN])).toBeNull()
  })
})
