import { describe, it, expect } from "vitest"

import {
  buildEvaluatorSlugMap,
  groupEvalsByEvaluator,
  getEvalsForEvaluator,
  verifiedEvalIds,
  isRecognizedEvaluator,
} from "../lib/evaluators"
import type { BenchmarkEvalListItem } from "../lib/eval-processing"

// Minimal eval rows — only the fields the evaluator grouping reads. The
// cast keeps the fixtures terse without re-declaring the full view shape.
function evalRow(
  id: string,
  evaluators: string[],
  verified: string[] = [],
): BenchmarkEvalListItem {
  return {
    evaluation_id: id,
    evaluation_name: id,
    evaluator_names: evaluators,
    verified_evaluator_names: verified,
  } as unknown as BenchmarkEvalListItem
}

const corpus: BenchmarkEvalListItem[] = [
  evalRow("e1", ["Stanford CRFM"], ["Stanford CRFM"]),
  evalRow("e2", ["Stanford CRFM", "OpenAI"], ["Stanford CRFM"]),
  evalRow("e3", ["OpenAI"]),
  // Two junk org strings that must still slug cleanly + uniquely.
  evalRow("e4", ["CapArena (Cheng et al., 2025)"], ["CapArena (Cheng et al., 2025)"]),
  evalRow("e5", ["University of A, University of B, University of C and many others"]),
]

describe("groupEvalsByEvaluator", () => {
  it("groups by org and sorts by eval count desc", () => {
    const groups = groupEvalsByEvaluator(corpus)
    const byName = Object.fromEntries(groups.map((g) => [g.name, g]))
    expect(byName["Stanford CRFM"].evalCount).toBe(2)
    expect(byName["OpenAI"].evalCount).toBe(2)
    expect(byName["Stanford CRFM"].verifiedCount).toBe(2)
    expect(byName["Stanford CRFM"].isVerified).toBe(true)
    expect(byName["OpenAI"].verifiedCount).toBe(0)
    expect(byName["OpenAI"].isVerified).toBe(false)
    // descending eval count
    expect(groups[0].evalCount).toBeGreaterThanOrEqual(groups[groups.length - 1].evalCount)
  })

  it("verified-only collapses to verified runners with verified counts", () => {
    const groups = groupEvalsByEvaluator(corpus, { verifiedOnly: true })
    const names = groups.map((g) => g.name).sort()
    expect(names).toEqual(["CapArena (Cheng et al., 2025)", "Stanford CRFM"])
    const crfm = groups.find((g) => g.name === "Stanford CRFM")!
    expect(crfm.evalCount).toBe(2)
    // OpenAI never verified → absent
    expect(groups.find((g) => g.name === "OpenAI")).toBeUndefined()
  })

  it("verified-only also keeps recognized (grey-tier) sources", () => {
    // "Artificial Analysis" is a recognized source — grey badge, never in
    // verified_evaluator_names — so it must still surface under verified-only.
    const withGrey = [
      ...corpus,
      evalRow("g1", ["Artificial Analysis"]),
      evalRow("g2", ["Artificial Analysis", "OpenAI"]),
    ]
    const groups = groupEvalsByEvaluator(withGrey, { verifiedOnly: true })
    const aa = groups.find((g) => g.name === "Artificial Analysis")!
    expect(aa.evalCount).toBe(2)
    // Grey recognized tier counts toward verifiedCount (both g1 & g2), but the
    // org is not blue-verified so the badge tier stays grey.
    expect(aa.verifiedCount).toBe(2)
    expect(aa.isVerified).toBe(false)
    // OpenAI is neither verified nor recognized → still absent.
    expect(groups.find((g) => g.name === "OpenAI")).toBeUndefined()
  })
})

describe("buildEvaluatorSlugMap", () => {
  it("produces valid, non-empty, unique slugs for junk strings", () => {
    const { slugToName, nameToSlug } = buildEvaluatorSlugMap(corpus)
    const slugs = Array.from(slugToName.keys())
    // unique
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const s of slugs) {
      expect(s.length).toBeGreaterThan(0)
      expect(s).toMatch(/^[a-z0-9-]+$/)
    }
    // round-trips
    const cap = nameToSlug.get("CapArena (Cheng et al., 2025)")!
    expect(slugToName.get(cap)).toBe("CapArena (Cheng et al., 2025)")
  })

  it("disambiguates colliding base slugs with a numeric suffix", () => {
    const collide = [
      evalRow("a", ["Foo Bar!"]),
      evalRow("b", ["Foo  Bar"]),
    ]
    const { slugToName } = buildEvaluatorSlugMap(collide)
    const slugs = Array.from(slugToName.keys()).sort()
    expect(new Set(slugs).size).toBe(2)
    expect(slugs.some((s) => /-2$/.test(s))).toBe(true)
  })
})

describe("getEvalsForEvaluator", () => {
  it("resolves a slug to the org's evals", () => {
    const { nameToSlug } = buildEvaluatorSlugMap(corpus)
    const slug = nameToSlug.get("OpenAI")!
    const { name, evals, isVerified } = getEvalsForEvaluator(corpus, slug)
    expect(name).toBe("OpenAI")
    expect(evals.map((e) => e.evaluation_id).sort()).toEqual(["e2", "e3"])
    expect(isVerified).toBe(false)
  })

  it("restricts to verified evals when verifiedOnly", () => {
    const { nameToSlug } = buildEvaluatorSlugMap(corpus)
    const slug = nameToSlug.get("Stanford CRFM")!
    const { evals } = getEvalsForEvaluator(corpus, slug, { verifiedOnly: true })
    expect(evals.map((e) => e.evaluation_id).sort()).toEqual(["e1", "e2"])
  })

  it("returns null name for an unknown slug", () => {
    const { name, evals } = getEvalsForEvaluator(corpus, "does-not-exist")
    expect(name).toBeNull()
    expect(evals).toEqual([])
  })
})

describe("verifiedEvalIds", () => {
  it("collects ids with at least one verified evaluator", () => {
    const ids = verifiedEvalIds(corpus)
    expect(Array.from(ids).sort()).toEqual(["e1", "e2", "e4"])
  })
})

describe("isRecognizedEvaluator", () => {
  it("gives the grey tier to each ingested public leaderboard, in any case", () => {
    for (const name of ["Artificial Analysis", "LLM Stats", "Hugging Face", "kaggle", "Vals.ai", " vals.ai "]) {
      expect(isRecognizedEvaluator(name)).toBe(true)
    }
  })

  it("refuses other orgs, near-miss spellings, and empty names", () => {
    for (const name of ["OpenAI", "Vals AI", "vals", "Stanford CRFM", "", null, undefined]) {
      expect(isRecognizedEvaluator(name)).toBe(false)
    }
  })
})
