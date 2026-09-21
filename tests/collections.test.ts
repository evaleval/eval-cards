import { describe, expect, it } from "vitest"

import {
  buildCollectionAttachment,
  buildScaffoldContext,
  chooseComputeAxis,
  chooseProtocolColumns,
  compareProtocolReadings,
  compareProtocolRows,
  compareProtocolTuples,
  feedbackConditionOf,
  formatProtocolValue,
  protocolFilterOptions,
  protocolValueId,
  protocolValueTitle,
  readProtocolAxis,
  type CollectionContextSidecar,
  type ProtocolAxisReading,
  type ProtocolColumn,
  type ScaffoldContextEntry,
  type ScaffoldContextSummaryInput,
} from "@/lib/collections"

import contextFixture from "./fixtures/collection_context.json"

const cond = (fields: Record<string, unknown>) => JSON.stringify(fields)

const protocolColumn = (over: Partial<ProtocolColumn> & { key: string }): ProtocolColumn => ({
  label: over.key,
  type: "int",
  unit: "tokens",
  values: null,
  quantitative: over.unit === null ? false : true,
  ...over,
})

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

  it("keeps the declared budgets and the axes that vary", () => {
    // The AISI shape: one scaffold everywhere, effort and thinking
    // tokens separate the runs, and both token budgets stay on the row
    // because a score cannot be read without them.
    const columns = chooseProtocolColumns(
      [
        cond({ scaffold: "S-adaptive", feedback: "none", token_limit: 10_000_000, reasoning_effort: "high", reasoning_tokens: 32000 }),
        cond({ scaffold: "S-adaptive", feedback: "none", token_limit: 10_000_000, reasoning_effort: "xhigh", reasoning_tokens: 32000 }),
        cond({ scaffold: "S-adaptive", feedback: "none", token_limit: 10_000_000, reasoning_effort: "xhigh", reasoning_tokens: 64000 }),
      ],
      axes,
    )
    expect(columns.map((c) => c.key)).toEqual([
      "token_limit",
      "reasoning_tokens",
      "reasoning_effort",
    ])
    // Declared order is the study's, and the labels are readable.
    expect(columns.map((c) => c.label)).toEqual([
      "Token budget",
      "Thinking tokens",
      "Effort",
    ])
    // A constant scaffold explains nothing and stays out.
    expect(columns.map((c) => c.key)).not.toContain("scaffold")
  })

  it("shows a unit-bearing axis that is null on every row", () => {
    // The cyber shape: the run cap varies, thinking tokens are never
    // reported. Dropping the column would read as "the study didn't use
    // one", which is a different claim from "it did not say".
    const columns = chooseProtocolColumns(
      [
        cond({ scaffold: "ReAct", compaction: true, feedback: "none", token_limit: 50_000_000, reasoning_tokens: null, reasoning_effort: null }),
        cond({ scaffold: "ReAct", compaction: true, feedback: "none", token_limit: 100_000_000, reasoning_tokens: null, reasoning_effort: null }),
      ],
      axes,
    )
    expect(columns.map((c) => c.key)).toEqual(["token_limit", "reasoning_tokens"])
    expect(columns.every((c) => c.quantitative)).toBe(true)
  })

  it("shows the declared budgets on a single-row page", () => {
    const columns = chooseProtocolColumns(
      [cond({ scaffold: "ReAct", token_limit: 100_000_000, reasoning_tokens: null })],
      axes,
    )
    expect(columns.map((c) => c.key)).toEqual(["token_limit", "reasoning_tokens"])
  })

  it("never adds a feedback column \u2014 the assisted badge already says it", () => {
    const columns = chooseProtocolColumns(
      [cond({ feedback: "none" }), cond({ feedback: "answer_feedback" })],
      axes.filter((axis) => !axis.unit),
    )
    expect(columns).toEqual([])
  })

  it("treats a missing key and an explicit null as one reading", () => {
    // Otherwise "absent" and "null" would look like two values and
    // conjure a column that explains nothing.
    const columns = chooseProtocolColumns(
      [
        cond({ scaffold: "S-adaptive", reasoning_effort: null }),
        cond({ scaffold: "S-adaptive" }),
      ],
      axes.filter((axis) => !axis.unit),
    )
    expect(columns).toEqual([])
  })

  it("surfaces an axis the sidecar never declared", () => {
    const columns = chooseProtocolColumns(
      [cond({ retries: 1 }), cond({ retries: 3 })],
      axes.filter((axis) => !axis.unit),
    )
    expect(columns.map((c) => c.key)).toEqual(["retries"])
    expect(columns[0].label).toBe("Retries")
  })

  it("keeps the declared budgets when no row carries a protocol condition", () => {
    // A budget that disappears reads as an axis that never applied. The
    // study declared it, so the column stays and every cell says the
    // study did not report it.
    const columns = chooseProtocolColumns([null, undefined], axes)
    expect(columns.map((c) => c.key)).toEqual(["token_limit", "reasoning_tokens"])
    expect(columns.every((c) => c.quantitative)).toBe(true)
  })

  it("adds no columns to a page that declares nothing and reports nothing", () => {
    expect(chooseProtocolColumns([null, undefined])).toEqual([])
    expect(chooseProtocolColumns([null, undefined], [])).toEqual([])
  })

  it("keeps every eligible axis rather than dropping the last ones", () => {
    // A wide table scrolls; a silently truncated one hides a setting.
    const many = chooseProtocolColumns(
      [
        cond({ a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1, h: 1 }),
        cond({ a: 2, b: 2, c: 2, d: 2, e: 2, f: 2, g: 2, h: 2 }),
      ],
      [],
    )
    expect(many.map((c) => c.key)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"])
  })
})

describe("readProtocolAxis", () => {
  const tokenLimit = protocolColumn({ key: "token_limit", label: "Token budget" })

  it("separates a reported value, an unreported one and an inapplicable axis", () => {
    expect(readProtocolAxis(cond({ token_limit: 50_000_000 }), tokenLimit)).toEqual({
      state: "value",
      raw: 50_000_000,
    })
    expect(readProtocolAxis(cond({ token_limit: null }), tokenLimit).state).toBe("not_reported")
    // A row with a protocol of its own that simply omits the key still
    // belongs to a page where the axis applies.
    expect(readProtocolAxis(cond({ scaffold: "ReAct" }), tokenLimit).state).toBe("not_reported")
    // A row with no protocol at all, on a page that declares nothing for
    // its collection, never ran under this axis.
    expect(readProtocolAxis(null, tokenLimit).state).toBe("not_applicable")
    expect(readProtocolAxis(cond({ judge: "x" }), tokenLimit, new Set()).state).toBe(
      "not_applicable",
    )
    expect(
      readProtocolAxis(cond({ judge: "x" }), tokenLimit, new Set(["token_limit"])).state,
    ).toBe("not_reported")
  })
})

describe("formatProtocolValue", () => {
  const thinking = protocolColumn({ key: "reasoning_tokens", label: "Thinking tokens" })
  const read = (fields: Record<string, unknown>, column = thinking) =>
    readProtocolAxis(cond(fields), column)

  it("renders a declared token count compactly, with its unit", () => {
    expect(formatProtocolValue(read({ reasoning_tokens: 50_000_000 }), thinking)).toBe(
      "50M tokens",
    )
    expect(formatProtocolValue(read({ reasoning_tokens: 10_000_000 }), thinking)).toBe(
      "10M tokens",
    )
    expect(formatProtocolValue(read({ reasoning_tokens: 64_000 }), thinking)).toBe("64k tokens")
    expect(formatProtocolValue(read({ reasoning_tokens: 1500 }), thinking)).toBe("1.5k tokens")
    // The exact number stays available for the title.
    expect(protocolValueTitle(read({ reasoning_tokens: 50_000_000 }), thinking)).toBe(
      "50,000,000 tokens",
    )
  })

  it("covers the magnitudes either side of each unit boundary", () => {
    const shown = (value: unknown) => formatProtocolValue(read({ reasoning_tokens: value }), thinking)
    expect(shown(0)).toBe("0 tokens")
    expect(shown(999)).toBe("999 tokens")
    expect(shown(1_000)).toBe("1k tokens")
    // Rounding must not leave a thousand of the smaller unit on screen.
    expect(shown(999_999)).toBe("1M tokens")
    expect(shown(1_000_000)).toBe("1M tokens")
    expect(shown(-999_999)).toBe("-1M tokens")
    // Three significant digits, so neighbouring budgets stay apart.
    expect(shown(1_040_000)).toBe("1.04M tokens")
    expect(shown(1_049_000)).toBe("1.05M tokens")
    expect(shown(1.25)).toBe("1.25 tokens")
    // Past a billion there is still a unit to use.
    expect(shown(2_500_000_000)).toBe("2.5B tokens")
    // Nothing pathological renders as NaN or throws.
    expect(shown(1e21)).toMatch(/^[\d.e+-]+B tokens$/)
  })

  it("normalises a numeric string on an axis declared numeric", () => {
    // A source that wrote its budget as text still reads and sorts as a
    // number, because the descriptor says the axis is one.
    expect(read({ reasoning_tokens: "6000000" }).raw).toBe(6_000_000)
    expect(formatProtocolValue(read({ reasoning_tokens: "6000000" }), thinking)).toBe("6M tokens")
    // Text that is not a number keeps its own type rather than becoming NaN.
    expect(read({ reasoning_tokens: "unbounded" }).raw).toBe("unbounded")
    // A JSON literal too large to represent is not a budget.
    expect(read({ reasoning_tokens: 1e400 }).state).toBe("not_reported")
  })

  it("renders booleans as a state and categoricals humanised", () => {
    const compaction = protocolColumn({
      key: "compaction",
      label: "Compaction",
      type: "boolean",
      unit: null,
    })
    expect(formatProtocolValue(read({ compaction: true }, compaction), compaction)).toBe("On")
    expect(formatProtocolValue(read({ compaction: false }, compaction), compaction)).toBe("Off")

    const effort = protocolColumn({
      key: "reasoning_effort",
      label: "Effort",
      type: "categorical",
      unit: null,
      values: ["high", "xhigh"],
    })
    expect(formatProtocolValue(read({ reasoning_effort: "xhigh" }, effort), effort)).toBe(
      "X-high",
    )
    expect(formatProtocolValue(read({ reasoning_effort: "high" }, effort), effort)).toBe("High")
    // A name the study chose keeps its own spelling.
    const scaffold = protocolColumn({
      key: "scaffold",
      label: "Scaffold",
      type: "categorical",
      unit: null,
    })
    expect(formatProtocolValue(read({ scaffold: "S-adaptive" }, scaffold), scaffold)).toBe(
      "S-adaptive",
    )
    // Only the spellings the studies actually use are rewritten. An
    // unrelated value starting with x is not an effort level.
    for (const value of ["xlam", "xml"]) {
      expect(formatProtocolValue(read({ scaffold: value }, scaffold), scaffold)).toBe(value)
    }
  })

  it("says what is missing and never turns a null into no limit", () => {
    expect(formatProtocolValue({ state: "not_reported", raw: null }, thinking)).toBe(
      "Not reported",
    )
    expect(formatProtocolValue({ state: "not_applicable", raw: null }, thinking)).toBe(
      "Not applicable",
    )
    expect(formatProtocolValue(read({ reasoning_tokens: null }), thinking)).toBe("Not reported")
    expect(formatProtocolValue(read({}), thinking)).toBe("Not reported")
    for (const state of ["not_reported", "not_applicable"] as const) {
      expect(formatProtocolValue({ state, raw: null }, thinking)).not.toContain("limit")
    }
  })

  it("leaves a plain number alone when the axis declares no unit", () => {
    const temp = protocolColumn({
      key: "temperature",
      label: "Temperature",
      type: "unknown",
      unit: null,
    })
    expect(formatProtocolValue(read({ temperature: 2000 }, temp), temp)).toBe("2000")
  })
})

describe("compareProtocolReadings", () => {
  const tokenLimit = protocolColumn({ key: "token_limit", label: "Token budget" })
  const reading = (value: unknown) =>
    readProtocolAxis(cond({ token_limit: value }), tokenLimit)

  const order = (values: unknown[], dir: "asc" | "desc") =>
    values
      .map(reading)
      .sort((a, b) => compareProtocolReadings(a, b, tokenLimit, dir))
      .map((r) => r.raw)

  it("compares the raw numbers, not their labels", () => {
    // Lexically "10M tokens" precedes "6M tokens"; numerically it does not.
    expect(order([10_000_000, 6_000_000, 64_000], "asc")).toEqual([
      64_000,
      6_000_000,
      10_000_000,
    ])
    expect(order([6_000_000, 10_000_000, 64_000], "desc")).toEqual([
      10_000_000,
      6_000_000,
      64_000,
    ])
  })

  it("keeps unreported and inapplicable readings last in both directions", () => {
    expect(order([null, 10_000_000, 6_000_000], "asc")).toEqual([6_000_000, 10_000_000, null])
    expect(order([null, 10_000_000, 6_000_000], "desc")).toEqual([10_000_000, 6_000_000, null])
    const mixed = [
      { state: "not_applicable", raw: null } as const,
      reading(6_000_000),
    ]
    expect(
      [...mixed].sort((a, b) => compareProtocolReadings(a, b, tokenLimit, "desc"))[0].raw,
    ).toBe(6_000_000)
  })

  it("orders booleans Off then On and categoricals by the declared order", () => {
    const compaction = protocolColumn({
      key: "compaction",
      label: "Compaction",
      type: "boolean",
      unit: null,
    })
    const bools = [true, false]
      .map((value) => readProtocolAxis(cond({ compaction: value }), compaction))
      .sort((a, b) => compareProtocolReadings(a, b, compaction, "asc"))
      .map((r) => r.raw)
    expect(bools).toEqual([false, true])

    const effort = protocolColumn({
      key: "reasoning_effort",
      label: "Effort",
      type: "categorical",
      unit: null,
      values: ["high", "xhigh"],
    })
    const efforts = ["xhigh", "high", "medium"]
      .map((value) => readProtocolAxis(cond({ reasoning_effort: value }), effort))
      .sort((a, b) => compareProtocolReadings(a, b, effort, "asc"))
      .map((r) => r.raw)
    // Declared values first, in the study's order; undeclared follow.
    expect(efforts).toEqual(["high", "xhigh", "medium"])
  })
})

describe("protocolFilterOptions", () => {
  const tokenLimit = protocolColumn({ key: "token_limit", label: "Token budget" })

  it("offers each distinct raw value once, keyed typed and labelled formatted", () => {
    const readings = [50_000_000, 100_000_000, 50_000_000, null].map((value) =>
      readProtocolAxis(cond({ token_limit: value }), tokenLimit),
    )
    expect(protocolFilterOptions(readings, tokenLimit)).toEqual([
      { id: "number:50000000", label: "50M tokens", title: "50,000,000 tokens" },
      { id: "number:100000000", label: "100M tokens", title: "100,000,000 tokens" },
      { id: "missing:not_reported", label: "Not reported", title: "Not reported" },
    ])
  })

  it("keeps values apart that only look alike as text", () => {
    // Without the type tag an unreported budget and a categorical whose
    // value is literally "null" are one option, and the URL then selects
    // rows the reader never asked for.
    const free = protocolColumn({ key: "mode", label: "Mode", type: "categorical", unit: null })
    const pairs: Array<[ProtocolAxisReading, ProtocolAxisReading]> = [
      [{ state: "not_reported", raw: null }, { state: "value", raw: "null" }],
      [{ state: "not_applicable", raw: null }, { state: "value", raw: "not_applicable" }],
      [{ state: "not_reported", raw: null }, { state: "not_applicable", raw: null }],
      [{ state: "value", raw: 1 }, { state: "value", raw: "1" }],
      [{ state: "value", raw: true }, { state: "value", raw: "true" }],
    ]
    for (const [a, b] of pairs) {
      expect(protocolValueId(a)).not.toBe(protocolValueId(b))
      expect(protocolFilterOptions([a, b], free)).toHaveLength(2)
    }
  })

  it("gives every option the exact value as its title", () => {
    // Two budgets can round to the same short label; the title is what
    // tells them apart.
    const options = protocolFilterOptions(
      [1_040_000, 1_049_000].map((value) =>
        readProtocolAxis(cond({ token_limit: value }), tokenLimit),
      ),
      tokenLimit,
    )
    expect(options.map((option) => option.title)).toEqual([
      "1,040,000 tokens",
      "1,049,000 tokens",
    ])
  })

  it("never reads a published curve's thresholds as protocol values", () => {
    // The cyber records keep every curve point in score details; only the
    // run cap is a protocol value, and the option list must say so.
    const readings = [50_000_000, 100_000_000].map((value) =>
      readProtocolAxis(cond({ token_limit: value }), tokenLimit),
    )
    const ids = protocolFilterOptions(readings, tokenLimit).map((option) => option.id)
    for (const threshold of [500_000, 1_500_000, 5_000_000, 15_000_000]) {
      expect(ids).not.toContain(`number:${threshold}`)
    }
  })
})

describe("compareProtocolRows", () => {
  const tokenLimit = protocolColumn({ key: "token_limit", label: "Token budget" })
  const thinking = protocolColumn({ key: "reasoning_tokens", label: "Thinking tokens" })
  const readingFor = (row: { protocol_condition?: string | null }, column: ProtocolColumn) =>
    readProtocolAxis(row.protocol_condition, column)

  const run = (tokenLimitValue: number) => ({
    model_info: { name: "Claude Opus 4.6" },
    model_route_id: "anthropic%2Fclaude-opus-4.6",
    protocol_condition: cond({ token_limit: tokenLimitValue, reasoning_tokens: 64_000 }),
  })

  it("orders the same input the same way whatever order it arrives in", () => {
    // Two runs of one model share the sorted axis and differ only in
    // another; without the full tie-break tuple they swap when the
    // producer serves them the other way round.
    const forward = [run(6_000_000), run(10_000_000)]
    const reversed = [run(10_000_000), run(6_000_000)]
    const sorted = (rows: ReturnType<typeof run>[]) =>
      rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => compareProtocolRows(a, b, thinking, "asc", readingFor))
        .map(({ row }) => row.protocol_condition)
    expect(sorted(forward)).toEqual(sorted(reversed))
  })

  it("still sorts on the selected axis first", () => {
    const rows = [run(10_000_000), run(6_000_000)]
    const sorted = rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => compareProtocolRows(a, b, tokenLimit, "asc", readingFor))
      .map(({ row }) => readProtocolAxis(row.protocol_condition, tokenLimit).raw)
    expect(sorted).toEqual([6_000_000, 10_000_000])
  })
})

describe("compareProtocolTuples", () => {
  const columns = [
    protocolColumn({ key: "token_limit", label: "Token budget" }),
    protocolColumn({ key: "reasoning_tokens", label: "Thinking tokens" }),
  ]

  it("orders a model's extra runs by their declared tuple, nulls last", () => {
    const conditions = [
      cond({ token_limit: 10_000_000, reasoning_tokens: null }),
      cond({ token_limit: 6_000_000, reasoning_tokens: 64_000 }),
      cond({ token_limit: 10_000_000, reasoning_tokens: 16_000 }),
    ]
    const sorted = [...conditions].sort((a, b) => compareProtocolTuples(a, b, columns))
    expect(sorted.map((c) => JSON.parse(c).token_limit)).toEqual([
      6_000_000,
      10_000_000,
      10_000_000,
    ])
    expect(JSON.parse(sorted[2]).reasoning_tokens).toBeNull()
  })
})
