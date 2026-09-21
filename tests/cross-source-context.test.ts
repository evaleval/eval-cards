import { describe, expect, it } from "vitest"

import { buildCrossSourceContext, type CrossSourceRow } from "@/lib/cross-source-context"

// The context strip places one source's score among the other sources'
// measurements of the same (model, benchmark). The curated study sidecar
// covers exactly one page; this builds the same shape for the ~250
// benchmarks that have a second source and no sidecar entry.

const row = (over: Partial<CrossSourceRow> & Pick<CrossSourceRow, "modelKey" | "score" | "sourceSlug">): CrossSourceRow => ({
  displayName: over.modelKey,
  sourceLabel: over.sourceSlug,
  ...over,
})

describe("buildCrossSourceContext", () => {
  it("makes the subject source the mark and the others the points", () => {
    const payload = buildCrossSourceContext(
      [
        row({ modelKey: "m1", displayName: "Model One", score: 0.5, sourceSlug: "vals-ai", sourceLabel: "Vals.ai" }),
        row({ modelKey: "m1", score: 0.41, sourceSlug: "llm-stats", sourceLabel: "LLM Stats" }),
        row({ modelKey: "m1", score: 0.62, sourceSlug: "third", sourceLabel: "Third" }),
      ],
      { subjectSourceSlug: "vals-ai", subjectLabel: "This source" },
    )!
    const model = payload.models[0]
    expect(model.score).toBe(0.5)
    expect(model.points.map((p) => p.source)).toEqual(["LLM Stats", "Third"])
    // Points ascend so the strip reads left to right.
    expect(model.points.map((p) => p.score)).toEqual([0.41, 0.62])
    expect(payload.subjectLabel).toBe("This source")
  })

  it("drops models with nobody to compare against, and names them", () => {
    // A strip with a single mark implies a comparison that was never made.
    const payload = buildCrossSourceContext(
      [
        row({ modelKey: "paired", score: 0.5, sourceSlug: "a" }),
        row({ modelKey: "paired", score: 0.4, sourceSlug: "b" }),
        row({ modelKey: "lonely", displayName: "Lonely", score: 0.9, sourceSlug: "a" }),
      ],
      { subjectSourceSlug: "a" },
    )!
    expect(payload.models.map((m) => m.key)).toEqual(["paired"])
    expect(payload.modelsWithoutContext).toEqual(["Lonely"])
  })

  it("returns null when no model has a second source", () => {
    expect(
      buildCrossSourceContext([
        row({ modelKey: "m1", score: 0.5, sourceSlug: "a" }),
        row({ modelKey: "m2", score: 0.6, sourceSlug: "a" }),
      ]),
    ).toBeNull()
    expect(buildCrossSourceContext([])).toBeNull()
  })

  it("anchors a merged page on the widest-coverage source", () => {
    // No source is "this" one there, so every strip needs the same anchor
    // or they cannot be read down the column.
    const payload = buildCrossSourceContext([
      row({ modelKey: "m1", score: 0.5, sourceSlug: "wide" }),
      row({ modelKey: "m1", score: 0.4, sourceSlug: "narrow" }),
      row({ modelKey: "m2", score: 0.7, sourceSlug: "wide" }),
      row({ modelKey: "m2", score: 0.6, sourceSlug: "narrow" }),
      row({ modelKey: "m3", score: 0.3, sourceSlug: "wide" }),
    ])!
    for (const model of payload.models) {
      expect(model.points.map((p) => p.source)).toEqual(["narrow"])
    }
  })

  it("carries no study instrumentation it does not have", () => {
    // Bands, attempt counts and a with-oracle companion are things only a
    // study records; inventing them would draw marks nobody measured.
    const payload = buildCrossSourceContext([
      row({ modelKey: "m1", score: 0.5, sourceSlug: "a" }),
      row({ modelKey: "m1", score: 0.4, sourceSlug: "b" }),
    ])!
    const model = payload.models[0]
    expect(model.assisted).toBeNull()
    expect(model.attemptsMin).toBe(0)
    expect(model.attemptsMax).toBe(0)
    expect(model.hiddenCount).toBe(0)
    expect(payload.modelsWithoutAssisted).toEqual([])
  })

  it("skips rows with no usable score", () => {
    const payload = buildCrossSourceContext([
      row({ modelKey: "m1", score: 0.5, sourceSlug: "a" }),
      row({ modelKey: "m1", score: Number.NaN, sourceSlug: "b" }),
      row({ modelKey: "m1", score: 0.4, sourceSlug: "c" }),
    ])!
    expect(payload.models[0].points).toHaveLength(1)
  })

  it("orders best-covered models first", () => {
    const payload = buildCrossSourceContext([
      row({ modelKey: "thin", score: 0.5, sourceSlug: "a" }),
      row({ modelKey: "thin", score: 0.4, sourceSlug: "b" }),
      row({ modelKey: "thick", score: 0.5, sourceSlug: "a" }),
      row({ modelKey: "thick", score: 0.4, sourceSlug: "b" }),
      row({ modelKey: "thick", score: 0.3, sourceSlug: "c" }),
    ])!
    expect(payload.models.map((m) => m.key)).toEqual(["thick", "thin"])
  })
})
