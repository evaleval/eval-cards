import { describe, expect, it } from "vitest"

import {
  buildCollectionAttachment,
  buildScaffoldContext,
  chooseComputeAxis,
  chooseProtocolColumns,
  feedbackConditionOf,
  formatProtocolValue,
  type CollectionContextSidecar,
  type ScaffoldContextEntry,
  type ScaffoldContextSummaryInput,
} from "@/lib/collections"

import contextFixture from "./fixtures/collection_context.json"

const cond = (fields: Record<string, unknown>) => JSON.stringify(fields)

describe("feedbackConditionOf", () => {
  it("classifies the three feedback conditions and keeps unknown unknown", () => {
    expect(feedbackConditionOf(cond({ feedback: "none" }))).toBe("none")
    expect(feedbackConditionOf(cond({ feedback: "answer_feedback" }))).toBe("answer_feedback")
    expect(feedbackConditionOf(cond({ feedback: "unknown" }))).toBe("unknown")
    // Missing/unparseable never promotes to a clean condition.
    expect(feedbackConditionOf(cond({ token_limit: 5 }))).toBe("unknown")
    expect(feedbackConditionOf("not json")).toBe("unknown")
    expect(feedbackConditionOf(null)).toBe("unknown")
  })
})

describe("chooseComputeAxis (R1 axis selection)", () => {
  it("prefers token_limit when it varies within a condition", () => {
    const axis = chooseComputeAxis([
      cond({ feedback: "none", token_limit: 2_000_000, reasoning_tokens: 16000 }),
      cond({ feedback: "none", token_limit: 5_000_000, reasoning_tokens: 32000 }),
    ])
    expect(axis?.key).toBe("token_limit")
    expect(axis?.label).toBe("token budget (limit)")
  })

  it("falls back to reasoning_tokens when token_limit is constant within every condition", () => {
    const axis = chooseComputeAxis([
      cond({ feedback: "none", token_limit: 5_000_000, reasoning_tokens: 16000 }),
      cond({ feedback: "none", token_limit: 5_000_000, reasoning_tokens: 32000 }),
      cond({ feedback: "answer_feedback", token_limit: 5_000_000, reasoning_tokens: 32000 }),
    ])
    expect(axis?.key).toBe("reasoning_tokens")
    expect(axis?.label).toBe("reasoning-token allowance")
  })

  it("ignores cross-condition variation: within-condition cardinality only", () => {
    // token_limit differs BETWEEN conditions but is constant within each —
    // plotting that would assert an unmatched-budget comparison.
    const axis = chooseComputeAxis([
      cond({ feedback: "none", token_limit: 2_000_000 }),
      cond({ feedback: "answer_feedback", token_limit: 5_000_000 }),
    ])
    expect(axis).toBeNull()
  })

  it("returns null when nothing numeric varies within a condition (frontiermath)", () => {
    const axis = chooseComputeAxis([
      cond({ feedback: "none", compaction: false, token_limit: null, reasoning_tokens: null }),
      cond({ feedback: "answer_feedback", compaction: true, token_limit: null, reasoning_tokens: null }),
    ])
    expect(axis).toBeNull()
  })
})

describe("buildCollectionAttachment (R1.2)", () => {
  const entry = {
    curated: true,
    display_name: "How Inference Compute Shapes Frontier LLM Evaluation",
    url: "https://example.test/paper",
    has_trajectories: true,
    outcome_type: { swebenchpro: "binary", terminalbench: "binary", healthbench: "graded" },
  }
  const conditions = [
    cond({ feedback: "none", token_limit: 2_000_000 }),
    cond({ feedback: "none", token_limit: 5_000_000 }),
  ]

  it("attaches curated entries with the chosen axis", () => {
    const attachment = buildCollectionAttachment("uk-x", entry, "swe-bench-pro", conditions)
    expect(attachment).toMatchObject({
      collection_id: "uk-x",
      curated: true,
      has_trajectories: true,
      compute_axis: { key: "token_limit" },
      // Separator-stripped match: swe-bench-pro → swebenchpro.
      outcome_type: "binary",
    })
  })

  it("never attaches uncurated or missing entries", () => {
    expect(buildCollectionAttachment("c", { curated: false, display_name: "X" }, "b", [])).toBeNull()
    expect(buildCollectionAttachment("c", undefined, "b", [])).toBeNull()
  })

  it("leaves outcome_type absent rather than guessing a near-miss key", () => {
    // terminal-bench-2 normalizes to terminalbench2, which is NOT the
    // sidecar's terminalbench key — declared absence, not a guess.
    const attachment = buildCollectionAttachment("uk-x", entry, "terminal-bench-2", conditions)
    expect(attachment?.outcome_type).toBeUndefined()
  })
})

describe("buildScaffoldContext (Context view payload, finding I1)", () => {
  const sidecar = contextFixture as unknown as CollectionContextSidecar
  const entry = sidecar["uk-aisi-inference-scaling"]["terminal-bench-2"]

  // The terminal-bench-2 conditions the page's ranked list actually shows,
  // verbatim from eval_results_view.
  const AISI = {
    opus45Fullest:
      '{"compaction":false,"feedback":"none","reasoning_effort":"xhigh","reasoning_tokens":64000,"scaffold":"S-adaptive","token_limit":10000000}',
    opus46Fullest:
      '{"compaction":false,"feedback":"none","reasoning_effort":null,"reasoning_tokens":null,"scaffold":"S-adaptive","token_limit":10000000}',
    opus46Best:
      '{"compaction":false,"feedback":"none","reasoning_effort":"high","reasoning_tokens":32000,"scaffold":"S-adaptive","token_limit":10000000}',
    gpt5Fullest:
      '{"compaction":false,"feedback":"none","reasoning_effort":"high","reasoning_tokens":64000,"scaffold":"S-adaptive","token_limit":10000000}',
    gpt52Best:
      '{"compaction":false,"feedback":"none","reasoning_effort":"high","reasoning_tokens":32000,"scaffold":"S-adaptive","token_limit":10000000}',
    gpt52Fullest:
      '{"compaction":false,"feedback":"none","reasoning_effort":"high","reasoning_tokens":null,"scaffold":"S-adaptive","token_limit":10000000}',
    assisted:
      '{"compaction":true,"feedback":"answer_feedback","reasoning_effort":"high","reasoning_tokens":16000,"scaffold":"S-adaptive","token_limit":10000000}',
  }

  const modelRow = (
    id: string,
    name: string,
    score: number,
    condition: string,
  ): ScaffoldContextSummaryInput["model_results"][number] => ({
    score,
    protocol_condition: condition,
    model_route_id: id.replace("/", "%2F"),
    model_group_id: id,
    model_info: { name, id },
  })

  // The page as it really is: opus-4.5 and gpt-5 have exactly one
  // no-feedback row (the one the sidecar shows), opus-4.6 and gpt-5.2
  // have a higher-scoring one at a different condition.
  const summary: ScaffoldContextSummaryInput = {
    evaluation_name: "Terminal-Bench 2.0",
    canonical_display_name: "Terminal-Bench 2.0",
    collection: { display_name: "UK AISI inference scaling" },
    model_results: [
      modelRow("anthropic/claude-opus-4.5", "Claude Opus 4.5", 0.563258, AISI.opus45Fullest),
      modelRow("anthropic/claude-opus-4.6", "Claude Opus 4.6", 0.9286, AISI.opus46Best),
      modelRow("anthropic/claude-opus-4.6", "Claude Opus 4.6", 0.666667, AISI.opus46Fullest),
      modelRow("openai/gpt-5", "GPT-5", 0.496717, AISI.gpt5Fullest),
      modelRow("openai/gpt-5.2", "GPT-5.2", 0.6875, AISI.gpt52Best),
      modelRow("openai/gpt-5.2", "GPT-5.2", 0.604457, AISI.gpt52Fullest),
      // An assisted row scoring higher than every clean row must never
      // become the caption-3 comparison target.
      modelRow("anthropic/claude-opus-4.5", "Claude Opus 4.5", 0.98, AISI.assisted),
    ],
  }

  it("fires caption 3 only for models whose fullest condition is not their best-scoring one", () => {
    const payload = buildScaffoldContext(entry, summary)
    expect(payload).not.toBeNull()
    const fires = Object.fromEntries(
      payload!.models.map((m) => [m.key, m.conditionDiffersFromBestScoring]),
    )
    expect(fires).toEqual({
      // Single no-feedback condition: the sidecar string IS the best row.
      "anthropic/claude-opus-4.5": false,
      "openai/gpt-5": false,
      // Fullest-coverage condition scores below the best-scoring one.
      "anthropic/claude-opus-4.6": true,
      "openai/gpt-5.2": true,
    })
  })

  it("never fires caption 3 from a row the page does not carry", () => {
    // No matching model row at all — we cannot see a difference, so we
    // must not assert one.
    const payload = buildScaffoldContext(entry, { ...summary, model_results: [] })
    expect(payload!.models.every((m) => m.conditionDiffersFromBestScoring)).toBe(false)
  })

  it("resolves display names from the sidecar and carries the caption inputs", () => {
    const payload = buildScaffoldContext(entry, summary)!
    expect(payload.models.map((m) => m.displayName)).toEqual([
      "Claude Opus 4.5",
      "Claude Opus 4.6",
      "GPT-5",
      "GPT-5.2",
    ])
    expect(payload).toMatchObject({
      harvestedAt: "2026-08-23T00:00:00Z",
      officialTaskCount: 89,
      // Caption 1 names the producer-resolved display string, never an id.
      contextSourceDisplay: "Terminal-Bench 2.0",
      contextSources: [{ id: "terminal-bench-2-0", display_name: "Terminal-Bench 2.0" }],
      // Producer-computed, never derived from a client-side join.
      modelsWithoutContext: ["Claude Opus 4", "GPT-5.4"],
      benchmarkLabel: "Terminal-Bench 2.0",
      collectionLabel: "UK AISI inference scaling",
      hiddenTotal: 0,
    })
    const opus46 = payload.models.find((m) => m.key === "anthropic/claude-opus-4.6")!
    expect(opus46).toMatchObject({
      score: 0.666667,
      nTasks: 86,
      bandRuns: 5,
      attemptsMin: 1,
      attemptsMax: 4,
      hiddenCount: 0,
    })
    expect(opus46.points).toHaveLength(10)
    expect(opus46.points[0]).toEqual({
      scaffold: "Meta-Harness",
      source: null,
      score: 0.764,
      scoreSe: 0.024,
      runDate: "2026-05-14",
    })
    // Old-schema sidecar: no published SE on the model entry, so the
    // diamond renders without a whisker.
    expect(opus46.scoreSe).toBeNull()
    // Caption 2's attempts range spans the strips: 1 (opus-4.6, gpt-5.2)
    // through 10 (opus-4.5, gpt-5).
    expect(Math.min(...payload.models.map((m) => m.attemptsMin))).toBe(1)
    expect(Math.max(...payload.models.map((m) => m.attemptsMax))).toBe(10)
  })

  it("carries scaffold-less measurements and their source through to the points", () => {
    // New-schema sidecar: a provenance-unknown point (scaffold null) from a
    // named source alongside an old-schema point without a source field.
    const mixed: ScaffoldContextEntry = {
      ...entry,
      models: {
        "openai/gpt-5": {
          ...entry.models["openai/gpt-5"],
          score_se: 0.045,
          external: [
            { scaffold: null, source: "LLM Stats", score: 0.751, score_se: null, run_date: null },
            { scaffold: "Terminus 2", score: 0.462, score_se: 0.024, run_date: "2025-11-22" },
          ],
        },
      },
    }
    const built = buildScaffoldContext(mixed, summary)!.models[0]
    expect(built.points).toEqual([
      { scaffold: null, source: "LLM Stats", score: 0.751, scoreSe: null, runDate: null },
      { scaffold: "Terminus 2", source: null, score: 0.462, scoreSe: 0.024, runDate: "2025-11-22" },
    ])
    // New-schema model entry: the study's published SE feeds the whisker.
    expect(built.scoreSe).toBe(0.045)
  })

  it("threads the assisted companion cell and its gate list; old sidecars stay null", () => {
    // Old bake: no assisted field anywhere in the entry.
    const old = buildScaffoldContext(entry, summary)!
    expect(old.models.every((m) => m.assisted === null)).toBe(true)
    expect(old.modelsWithoutAssisted).toEqual([])

    const withAssisted: ScaffoldContextEntry = {
      ...entry,
      models_without_assisted: [{ display_name: "GPT-5", n_tasks: 76 }],
      models: {
        "openai/gpt-5.2": {
          ...entry.models["openai/gpt-5.2"],
          assisted: {
            score: 0.764902,
            score_se: 0.040599,
            n_tasks: 85,
            protocol_condition: AISI.assisted,
          },
        },
      },
    }
    const built = buildScaffoldContext(withAssisted, summary)!
    expect(built.models[0].assisted).toEqual({
      score: 0.764902,
      scoreSe: 0.040599,
      nTasks: 85,
      protocolCondition: AISI.assisted,
    })
    expect(built.modelsWithoutAssisted).toEqual([{ displayName: "GPT-5", nTasks: 76 }])
  })

  it("falls back to the aggregation key when the sidecar carries no display name", () => {
    const nameless: ScaffoldContextEntry = {
      ...entry,
      models: {
        "openai/gpt-5": { ...entry.models["openai/gpt-5"], display_name: "  " },
      },
    }
    expect(buildScaffoldContext(nameless, summary)!.models[0].displayName).toBe("openai/gpt-5")
  })

  it("keeps both extremes when the >30 rule fires and reports the hidden count", () => {
    // 41 points; the min and the max are the two the finding is about.
    const external = Array.from({ length: 41 }, (_, i) => ({
      scaffold: `scaffold-${String(i).padStart(2, "0")}`,
      score: 0.30 + i * 0.01,
      score_se: null,
      run_date: "2026-01-01",
    }))
    const wide: ScaffoldContextEntry = {
      ...entry,
      models: {
        "openai/gpt-5": { ...entry.models["openai/gpt-5"], external: external.slice().reverse() },
      },
    }
    const model = buildScaffoldContext(wide, summary)!.models[0]
    expect(model.points).toHaveLength(30)
    expect(model.hiddenCount).toBe(11)
    const scores = model.points.map((p) => p.score)
    expect(Math.min(...scores)).toBeCloseTo(0.3, 10)
    expect(Math.max(...scores)).toBeCloseTo(0.7, 10)
    // Producer emit order (score desc) is preserved among the survivors.
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })

  it("returns null when the sidecar has no entry or the entry has no models", () => {
    expect(buildScaffoldContext(undefined, summary)).toBeNull()
    expect(buildScaffoldContext(null, summary)).toBeNull()
    expect(buildScaffoldContext({ ...entry, models: {} }, summary)).toBeNull()
  })
})


describe("chooseProtocolColumns", () => {
  const axes = [
    { key: "scaffold", type: "categorical" },
    { key: "compaction", type: "boolean" },
    { key: "feedback", type: "categorical" },
    { key: "token_limit", type: "int", unit: "tokens" },
    { key: "reasoning_tokens", type: "int", unit: "tokens" },
    { key: "reasoning_effort", type: "categorical" },
  ]

  it("keeps only the axes that vary across the page's rows", () => {
    // The AISI shape: one scaffold everywhere, effort and thinking
    // tokens are what separate the runs.
    const columns = chooseProtocolColumns(
      [
        cond({ scaffold: "S-adaptive", feedback: "none", reasoning_effort: "high", reasoning_tokens: 32000 }),
        cond({ scaffold: "S-adaptive", feedback: "none", reasoning_effort: "xhigh", reasoning_tokens: 32000 }),
        cond({ scaffold: "S-adaptive", feedback: "none", reasoning_effort: "xhigh", reasoning_tokens: 64000 }),
      ],
      axes,
    )
    expect(columns.map((c) => c.key)).toEqual(["reasoning_tokens", "reasoning_effort"])
    // Declared order is the study's, and the labels are readable.
    // Feedback is constant here, so it earns no column.
    expect(columns.map((c) => c.label)).toEqual(["Thinking tokens", "Effort"])
  })

  it("includes feedback — nothing else on the page records the answer oracle", () => {
    const columns = chooseProtocolColumns(
      [cond({ feedback: "none" }), cond({ feedback: "answer_feedback" })],
      axes,
    )
    expect(columns.map((c) => c.key)).toEqual(["feedback"])
    expect(columns[0].label).toBe("Feedback")
  })

  it("treats a missing key and an explicit null as one reading", () => {
    // Otherwise "absent" and "null" would look like two values and
    // conjure a column that explains nothing.
    const columns = chooseProtocolColumns(
      [
        cond({ scaffold: "S-adaptive", reasoning_effort: null }),
        cond({ scaffold: "S-adaptive" }),
      ],
      axes,
    )
    expect(columns).toEqual([])
  })

  it("surfaces an axis the sidecar never declared", () => {
    const columns = chooseProtocolColumns(
      [cond({ retries: 1 }), cond({ retries: 3 })],
      axes,
    )
    expect(columns.map((c) => c.key)).toEqual(["retries"])
    expect(columns[0].label).toBe("Retries")
  })

  it("returns nothing when there is only one protocol row to explain", () => {
    expect(chooseProtocolColumns([cond({ reasoning_effort: "high" })], axes)).toEqual([])
    expect(chooseProtocolColumns([null, undefined], axes)).toEqual([])
  })

  it("caps the columns so the table stays readable", () => {
    const many = chooseProtocolColumns(
      [
        cond({ a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1, h: 1 }),
        cond({ a: 2, b: 2, c: 2, d: 2, e: 2, f: 2, g: 2, h: 2 }),
      ],
      [],
    )
    expect(many).toHaveLength(6)
  })
})

describe("formatProtocolValue", () => {
  const column = (over: Record<string, unknown> = {}) => ({
    key: "reasoning_tokens",
    label: "Thinking tokens",
    type: "int",
    unit: "tokens",
    ...over,
  }) as Parameters<typeof formatProtocolValue>[1]

  it("renders token counts compactly", () => {
    expect(formatProtocolValue(cond({ reasoning_tokens: 32000 }), column())).toBe("32k")
    expect(formatProtocolValue(cond({ reasoning_tokens: 10_000_000 }), column())).toBe("10M")
    expect(formatProtocolValue(cond({ reasoning_tokens: 1500 }), column())).toBe("1.5k")
  })

  it("renders booleans, strings and unset values", () => {
    const compaction = column({ key: "compaction", label: "Compaction", type: "boolean", unit: null })
    expect(formatProtocolValue(cond({ compaction: true }), compaction)).toBe("on")
    expect(formatProtocolValue(cond({ compaction: false }), compaction)).toBe("off")
    const effort = column({ key: "reasoning_effort", label: "Effort", type: "categorical", unit: null })
    expect(formatProtocolValue(cond({ reasoning_effort: "xhigh" }), effort)).toBe("xhigh")
    // Null and absent are "the study did not set it here", not a value.
    expect(formatProtocolValue(cond({ reasoning_effort: null }), effort)).toBeNull()
    expect(formatProtocolValue(cond({}), effort)).toBeNull()
    expect(formatProtocolValue(null, effort)).toBeNull()
  })

  it("leaves a plain number alone when the axis is not a count", () => {
    const temp = column({ key: "temperature", label: "Temperature", type: "unknown", unit: null })
    expect(formatProtocolValue(cond({ temperature: 2000 }), temp)).toBe("2000")
  })
})
