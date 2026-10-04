import { describe, expect, it } from "vitest"

import {
  categorizeSaturation,
  computeNEff,
  computeSaturationIndex,
  computeSaturationMetrics,
} from "@/lib/saturation"

describe("computeSaturationMetrics — parity with saturation_utils.py", () => {
  it("matches the Python reference for a tightly clustered top 5 (moderate saturation)", () => {
    const m = computeSaturationMetrics([0.95, 0.94, 0.93, 0.92, 0.91], 1000, 5)
    expect(m.s1).toBeCloseTo(0.95, 10)
    expect(m.sN).toBeCloseTo(0.91, 10)
    expect(m.scoreRange).toBeCloseTo(0.04, 10)
    expect(m.meanScore).toBeCloseTo(0.93, 10)
    expect(m.nEff).toBeCloseTo(31.622776601683793, 6)
    expect(m.seDelta).toBeCloseTo(0.06396864303905378, 6)
    expect(m.rNorm).toBeCloseTo(0.6253063704287013, 6)
    expect(m.sIndex).toBeCloseTo(0.6763747065348314, 6)
    expect(m.category).toBe("moderate")
    expect(m.isStatisticallySimilar).toBe(true)
  })

  it("matches the Python reference for a widely spread top 5 (very_low saturation)", () => {
    const m = computeSaturationMetrics([0.99, 0.6, 0.55, 0.5, 0.4], 500, 5)
    expect(m.s1).toBeCloseTo(0.99, 10)
    expect(m.sN).toBeCloseTo(0.4, 10)
    expect(m.nEff).toBeCloseTo(22.360679774997898, 6)
    expect(m.seDelta).toBeCloseTo(0.10571597680362202, 6)
    expect(m.rNorm).toBeCloseTo(5.580991803121527, 4)
    expect(m.sIndex).toBeCloseTo(2.9704747704425746e-14, 16)
    expect(m.category).toBe("very_low")
    expect(m.isStatisticallySimilar).toBe(false)
  })

  it("generalises to a smaller top N when fewer models are reported", () => {
    const m = computeSaturationMetrics([0.9, 0.85, 0.8], 1000, 3)
    expect(m.s1).toBe(0.9)
    expect(m.sN).toBe(0.8)
  })

  it("throws when fewer scores than topN are supplied", () => {
    expect(() => computeSaturationMetrics([0.9, 0.8], 1000, 5)).toThrow()
  })

  it("returns 0 (max compression) when both compared scores sit at a 0/1 boundary", () => {
    const m = computeSaturationMetrics([1, 1, 1, 1, 1], 1000, 5)
    expect(m.seDelta).toBe(0)
    expect(m.rNorm).toBe(0)
    expect(m.sIndex).toBe(1)
    expect(m.category).toBe("very_high")
  })
})

// Expected values come from running the reference on the same inputs:
// compute_saturation_metrics(scores, n) in
// analyzer/src/metrics/dynamic/saturation_utils.py (evaleval/benchmark-saturation @ 6285e3d).
describe("computeSaturationMetrics, numeric parity with compute_saturation_metrics", () => {
  const cases = [
    {
      scores: [0.9, 0.85, 0.8, 0.75, 0.7], n: 400,
      meanScore: 0.8, nEff: 20.0, seDelta: 0.1224744871391589, rNorm: 1.6329931618554527,
      sIndex: 0.06948345122280139, category: "low", similar: true,
    },
    {
      scores: [0.71, 0.7, 0.69, 0.68, 0.62], n: 164,
      meanScore: 0.6799999999999999, nEff: 12.806248474865697, seDelta: 0.1856754101568374, rNorm: 0.4847168503571811,
      sIndex: 0.7906100431341481, category: "high", similar: true,
    },
    {
      scores: [0.882, 0.879, 0.875, 0.861, 0.85], n: 1319,
      meanScore: 0.8694, nEff: 36.318039594669756, seDelta: 0.07985195901153405, rNorm: 0.40074157724017584,
      sIndex: 0.8516379261980636, category: "high", similar: true,
    },
    {
      scores: [0.3, 0.25, 0.21, 0.2, 0.12], n: 12032,
      meanScore: 0.21600000000000003, nEff: 109.6904736064167, seDelta: 0.05363941607899894, rNorm: 3.355741228332911,
      sIndex: 1.2865011844776138e-5, category: "very_low", similar: false,
    },
    {
      scores: [1, 0.9, 0.8, 0.7, 0.6], n: 100,
      meanScore: 0.8, nEff: 10.0, seDelta: 0.15491933384829668, rNorm: 2.581988897471611,
      sIndex: 0.001272633801339809, category: "very_low", similar: false,
    },
    {
      scores: [0.95, 0.94, 0.93, 0.92, 0.91], n: 2000,
      meanScore: 0.93, nEff: 44.721359549995796, seDelta: 0.053791002620184804, rNorm: 0.7436187847703386,
      sIndex: 0.5752394459869926, category: "moderate", similar: true,
    },
  ]

  it.each(cases)("matches the reference for $scores, n = $n", (c) => {
    const m = computeSaturationMetrics(c.scores, c.n, 5)
    expect(m.meanScore).toBeCloseTo(c.meanScore, 12)
    expect(m.nEff).toBeCloseTo(c.nEff, 10)
    expect(m.seDelta).toBeCloseTo(c.seDelta, 12)
    expect(m.rNorm).toBeCloseTo(c.rNorm, 10)
    expect(m.sIndex).toBeCloseTo(c.sIndex, 12)
    expect(m.category).toBe(c.category)
    expect(m.isStatisticallySimilar).toBe(c.similar)
  })

  it("departs from the reference when the standard error is zero and the scores differ", () => {
    // compute_saturation_metrics([1, 0.5, 0.5, 0.5, 0], 1000) -> r_norm 0.0, s_index 1.0, "very_high";
    // scripts/calc_saturation_metrics.py leaves R_norm and the index empty for the same input.
    const m = computeSaturationMetrics([1, 0.5, 0.5, 0.5, 0], 1000, 5)
    expect(m.seDelta).toBe(0)
    expect(m.rNorm).toBe(Number.POSITIVE_INFINITY)
    expect(m.sIndex).toBe(0)
    expect(m.category).toBe("very_low")
  })
})

describe("computeNEff / computeSaturationIndex / categorizeSaturation", () => {
  it("computes n_eff = sqrt(n) at the default alpha", () => {
    expect(computeNEff(100)).toBeCloseTo(10, 10)
  })

  it("categorizes the documented S_index bands", () => {
    expect(categorizeSaturation(0.005)).toBe("very_low")
    expect(categorizeSaturation(0.1)).toBe("low")
    expect(categorizeSaturation(0.5)).toBe("moderate")
    expect(categorizeSaturation(0.8)).toBe("high")
    expect(categorizeSaturation(0.95)).toBe("very_high")
  })

  it("S_index approaches 1 as R_norm approaches 0", () => {
    expect(computeSaturationIndex(0)).toBe(1)
  })
})
