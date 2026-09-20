import { describe, expect, it } from "vitest"

import {
  MODEL_OPENNESS_ORDER,
  matchesOpenness,
  modelOpenness,
  type ModelOpenness,
} from "../lib/model-openness"

describe("modelOpenness", () => {
  it("buckets a real boolean", () => {
    expect(modelOpenness(true)).toBe("open")
    expect(modelOpenness(false)).toBe("closed")
  })

  it("buckets the shapes a JSON round-trip produces", () => {
    // DuckDB booleans survive as booleans, but the column also travels
    // through JSON in the route payloads.
    expect(modelOpenness("true")).toBe("open")
    expect(modelOpenness("false")).toBe("closed")
    expect(modelOpenness(1)).toBe("open")
    expect(modelOpenness(0)).toBe("closed")
  })

  it("treats an absent verdict as unknown, never as closed", () => {
    // This is the whole point of the third category: NULL is the largest
    // bucket in the corpus and folding it into `closed` would assert a
    // verdict about half the models that nothing supports.
    expect(modelOpenness(null)).toBe("unknown")
    expect(modelOpenness(undefined)).toBe("unknown")
    expect(modelOpenness("")).toBe("unknown")
    expect(modelOpenness("maybe")).toBe("unknown")
  })
})

describe("matchesOpenness", () => {
  const all = [...MODEL_OPENNESS_ORDER]

  it("passes everything when all three are selected", () => {
    for (const value of [true, false, null, undefined]) {
      expect(matchesOpenness(value, all)).toBe(true)
    }
  })

  it("narrows to the selected buckets", () => {
    expect(matchesOpenness(true, ["open"])).toBe(true)
    expect(matchesOpenness(false, ["open"])).toBe(false)
    expect(matchesOpenness(null, ["open"])).toBe(false)
  })

  it("does not let an unknown model through a closed-only filter", () => {
    expect(matchesOpenness(null, ["closed"])).toBe(false)
    expect(matchesOpenness(undefined, ["closed"])).toBe(false)
  })

  it("selects unknown models on their own", () => {
    expect(matchesOpenness(null, ["unknown"])).toBe(true)
    expect(matchesOpenness(true, ["unknown"])).toBe(false)
  })

  it("shows nothing when no category is selected", () => {
    const none: ModelOpenness[] = []
    for (const value of [true, false, null]) {
      expect(matchesOpenness(value, none)).toBe(false)
    }
  })
})

describe("category set", () => {
  it("is exactly the three documented buckets, in display order", () => {
    expect([...MODEL_OPENNESS_ORDER]).toEqual(["open", "closed", "unknown"])
  })

  it("covers every value modelOpenness can return", () => {
    const produced = new Set(
      [true, false, null, undefined, 1, 0, "true", "false", "junk"].map(modelOpenness)
    )
    for (const bucket of produced) {
      expect(MODEL_OPENNESS_ORDER).toContain(bucket)
    }
  })
})
