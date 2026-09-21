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
