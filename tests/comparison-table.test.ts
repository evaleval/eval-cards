import { gunzipSync } from "node:zlib"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { ComparisonIndex, EvalHierarchy } from "@/lib/backend-artifacts"
import type { BenchmarkEvalSummary, ModelEvaluationSummary } from "@/lib/eval-processing"
import { sliceIndexForEvals, sliceIndexForModel } from "@/lib/comparison-slice"
import { parseJsonWithBounds, stringifyJsonWithBounds } from "@/lib/json-bounds"

import { fixtureIndex, fixtureRawHierarchy, identityKeysOf, useSnapshot } from "./comparison-fixture"

// The comparison tables against the producer's comparison-index.json, on a
// real exported subset. Every consumer that reads the index must produce the
// same output from the per-page slice as from the whole file.

let restore: () => void
let table: typeof import("@/lib/comparison-table")
let fullComparisonIndex: typeof import("../scripts/comparison-full-index").fullComparisonIndex
let full: ComparisonIndex
let hierarchy: EvalHierarchy
let summaries: ModelEvaluationSummary[]

beforeAll(async () => {
  restore = useSnapshot()
  table = await import("@/lib/comparison-table")
  ;({ fullComparisonIndex } = await import("../scripts/comparison-full-index"))
  full = fixtureIndex()
  const { cleanHierarchy } = await import("@/lib/clean-hierarchy")
  const { decorateHierarchyDerivedTags } = await import("@/lib/benchmark-tags")
  hierarchy = decorateHierarchyDerivedTags(cleanHierarchy(fixtureRawHierarchy(), full))
  const backend = await import("@/lib/data-backend")
  summaries = []
  for (const routeId of Object.keys(full.by_model ?? {})) {
    const summary = await backend.getModelSummaryById(routeId)
    if (summary) summaries.push(summary as ModelEvaluationSummary)
  }
})

afterAll(() => restore?.())

const routeIds = () => Object.keys(full.by_model ?? {})

describe("reconstruction from the tables", () => {
  it("rebuilds the producer's index exactly, key order and wire form included", async () => {
    const rebuilt = await fullComparisonIndex()
    expect(rebuilt).toStrictEqual(full)
    expect(stringifyJsonWithBounds(rebuilt)).toBe(stringifyJsonWithBounds(full))
  })

  it("keeps the values the JSON hop could lose", async () => {
    const rebuilt = (await fullComparisonIndex())!
    const metrics = Object.values(rebuilt.evals).flatMap((e) => e.metrics)
    const rows = metrics.flatMap((m) => m.scores)
    expect(metrics.some((m) => m.canonical_max_score === Number.POSITIVE_INFINITY)).toBe(true)
    expect(metrics.some((m) => m.canonical_min_score === Number.NEGATIVE_INFINITY)).toBe(true)
    expect(metrics.some((m) => m.canonical_min_score === 0)).toBe(true)
    expect(rows.some((r) => r.temperature === null)).toBe(true)
    expect(rows.some((r) => typeof r.max_tokens === "number")).toBe(true)
    expect(rows.some((r) => !Number.isInteger(r.score) && String(r.score).length >= 17)).toBe(true)
    for (const row of rows) {
      expect(typeof row.rank).toBe("number")
      expect(typeof row.total).toBe("number")
      expect(typeof row.submission_count).toBe("number")
    }
    expect(rows.some((r) => (r.submission_axis as string) === "protocol")).toBe(true)
    expect(typeof rebuilt.generated_at).toBe("string")
    expect(rebuilt.generated_at).toBe(full.generated_at)
  })

  it("carries each cell kind's keys only", async () => {
    const rebuilt = (await fullComparisonIndex())!
    for (const entry of Object.values(rebuilt.evals)) {
      const merged = entry.is_merged === true
      expect("is_merged" in entry).toBe(merged)
      for (const row of entry.metrics.flatMap((m) => m.scores)) {
        expect("source_composite_slug" in row).toBe(merged)
        expect("score_canonical" in row).toBe(!merged)
        expect("scale_conversion" in row).toBe(!merged)
        expect("split" in row).toBe(!merged)
      }
    }
    expect(Object.values(rebuilt.evals).some((e) => e.is_merged)).toBe(true)
  })
})

describe("model slices", () => {
  it("covers a model with many evals and models with one", () => {
    const counts = routeIds().map((r) => Object.keys(full.by_model![r]).length)
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(5)
    expect(counts.filter((n) => n === 1).length).toBeGreaterThan(0)
    expect(summaries.length).toBe(routeIds().length)
  })

  it("has every eval and metric field, full rows on FULL evals and none elsewhere", async () => {
    for (const routeId of routeIds()) {
      const slice = (await table.sliceForModel(routeId))!
      expect(slice).toStrictEqual(sliceIndexForModel(full, routeId))
      const ownEvals = new Set(Object.keys(full.by_model![routeId]))
      const benchmarks = new Set([...ownEvals].map((id) => full.evals[id].benchmark_id))
      expect(Object.keys(slice.evals)).toEqual(Object.keys(full.evals))
      expect(slice.by_model).toStrictEqual({ [routeId]: full.by_model![routeId] })
      for (const [evalId, entry] of Object.entries(full.evals)) {
        const isFull =
          ownEvals.has(evalId) || (!entry.is_merged && benchmarks.has(entry.benchmark_id))
        const expected = {
          ...entry,
          metrics: entry.metrics.map((m) => ({ ...m, scores: isFull ? m.scores : [] })),
        }
        expect(slice.evals[evalId]).toStrictEqual(expected)
        if (!isFull) {
          expect(entry.metrics.flatMap((m) => m.scores).some((s) => s.model_route_id === routeId)).toBe(false)
        }
      }
    }
  })

  it("gives every model-page consumer the same output as the whole index", async () => {
    const { buildBenchmarkHistograms, comparisonRouteIdOf } = await import("@/components/benchmark-detail")
    const { buildBenchmarkEntryIndex, collectPeerObservationsFrom } = await import("@/lib/split-peers")
    const { buildOverlapRows } = await import("@/lib/overlaps")
    const familyDisplayByKey = new Map(hierarchy.families.map((f) => [f.key, f.display_name]))
    const allEvalIds = new Set(Object.keys(full.evals))
    let splitAwareHistograms = 0
    let overlapRows = 0

    for (const summary of summaries) {
      const routeId = comparisonRouteIdOf(summary)
      const slice = (await table.sliceForModel(routeId))!
      const keys = identityKeysOf(summary)

      const histograms = (index: ComparisonIndex) => [
        ...buildBenchmarkHistograms({
          comparisonIndex: index,
          wantedEvalIds: allEvalIds,
          currentModelIdentityKeys: keys,
          currentModelRouteId: routeId,
          currentModelName: summary.model_info.name,
          extraModelsByBenchmark: {},
        }),
      ]
      const fromFull = histograms(full)
      expect(histograms(slice)).toStrictEqual(fromFull)
      splitAwareHistograms += fromFull.filter(([, h]) => h.caption != null).length

      const peers = (index: ComparisonIndex) => {
        const byBenchmark = buildBenchmarkEntryIndex(index)
        return Object.keys(full.by_model![routeId] ?? {}).flatMap((evalId) =>
          full.evals[evalId].metrics.map((m) =>
            collectPeerObservationsFrom(
              byBenchmark,
              full.evals[evalId].benchmark_id ?? "",
              m.metric_id ?? "",
              Boolean(m.lower_is_better),
              keys,
            ),
          ),
        )
      }
      expect(peers(slice)).toStrictEqual(peers(full))

      const overlaps = (index: ComparisonIndex) =>
        buildOverlapRows({
          benchmarkIndex: hierarchy.benchmark_index,
          comparisonIndex: index,
          currentModelRouteId: routeId,
          currentModelIdentityKeys: keys,
          familyDisplayByKey,
        })
      const overlapsFromFull = overlaps(full)
      expect(overlaps(slice)).toStrictEqual(overlapsFromFull)
      overlapRows += overlapsFromFull.length
    }
    expect(splitAwareHistograms).toBeGreaterThan(0)
    expect(overlapRows).toBeGreaterThan(0)
  })
})

describe("eval slices", () => {
  it("gives the signals strip the same cross-suite aggregate as the whole index", async () => {
    const { buildCrossSuiteAggregate, crossSuiteSiblingEvalIds } = await import(
      "@/components/signals/benchmark-signals-strip"
    )
    const backend = await import("@/lib/data-backend")
    const { isMergedBenchmarkSummary, mergedSummaryToEvalSummary } = await import("@/lib/merged-adapter")
    let compared = 0
    for (const evalId of Object.keys(full.evals)) {
      let summary: BenchmarkEvalSummary | null
      if (full.evals[evalId].is_merged) {
        const merged = await backend.getMergedBenchmarkSummary(evalId)
        summary = isMergedBenchmarkSummary(merged) ? mergedSummaryToEvalSummary(merged) : null
      } else {
        summary = await backend.getEvalSummaryById(evalId)
      }
      expect(summary, evalId).not.toBeNull()
      const siblings = crossSuiteSiblingEvalIds(summary!, hierarchy)
      const slice = (await table.sliceForEvals(siblings))!
      expect(slice).toStrictEqual(sliceIndexForEvals(full, siblings))
      expect(Object.keys(slice.evals).sort()).toEqual(siblings.filter((id) => full.evals[id]).sort())
      expect(slice.by_model).toBeUndefined()
      for (const id of Object.keys(slice.evals)) expect(slice.evals[id]).toStrictEqual(full.evals[id])
      const aggregate = buildCrossSuiteAggregate(summary!, hierarchy, full)
      expect(buildCrossSuiteAggregate(summary!, hierarchy, slice)).toStrictEqual(aggregate)
      if (aggregate) compared += 1
    }
    expect(compared).toBeGreaterThan(0)
  })
})

describe("hierarchy cleaner input", () => {
  it("is the index reduced to metric order, model and score", async () => {
    const projected = Object.fromEntries(
      Object.entries(full.evals).map(([evalId, entry]) => [
        evalId,
        {
          metrics: entry.metrics.map((m) => ({
            metric_summary_id: m.metric_summary_id,
            metric_name: m.metric_name,
            scores: m.scores.map((s) => ({ model_route_id: s.model_route_id, score: s.score })),
          })),
        },
      ]),
    )
    expect(await table.cleanerInput()).toStrictEqual({ evals: projected })
  })

  it("cleans the hierarchy exactly as the whole index does, dedup and coverage included", async () => {
    const { cleanHierarchy } = await import("@/lib/clean-hierarchy")
    const input = await table.cleanerInput()
    const fromTables = cleanHierarchy(fixtureRawHierarchy(), input)
    const fromIndex = cleanHierarchy(fixtureRawHierarchy(), full)
    expect(fromTables).toStrictEqual(fromIndex)
    expect(Object.keys(fromIndex._modelCoverageMap ?? {}).length).toBeGreaterThan(0)

    const benchKeys = (h: EvalHierarchy, familyKey: string) =>
      (h.families.find((f) => f.key === familyKey)?.benchmarks ?? []).map((b) => b.key)
    const withoutIndex = cleanHierarchy(fixtureRawHierarchy(), null)
    expect(benchKeys(withoutIndex, "llm-stats")).toContain("terminal-bench-2")
    expect(benchKeys(fromTables, "llm-stats")).not.toContain("terminal-bench-2")
  })
})

describe("GET /api/comparison-index", () => {
  const request = (query: string, headers: Record<string, string> = {}) =>
    new Request(`http://localhost/api/comparison-index${query}`, { headers })
  const body = async (response: Response) =>
    parseJsonWithBounds<ComparisonIndex>(gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8"))

  it("requires exactly one of model or evals", async () => {
    const { GET } = await import("@/app/api/comparison-index/route")
    expect((await GET(request(""))).status).toBe(400)
    expect((await GET(request("?model=a&evals=b"))).status).toBe(400)
    expect((await GET(request("?evals="))).status).toBe(400)
    expect((await GET(request("?evals=,,"))).status).toBe(400)
  })

  it("caps the number of eval ids after de-duplication", async () => {
    const { GET } = await import("@/app/api/comparison-index/route")
    const ids = Array.from({ length: table.MAX_EVAL_IDS }, (_, i) => `x${i}`)
    expect((await GET(request(`?evals=${[...ids, ...ids].join(",")}`))).status).toBe(200)
    expect((await GET(request(`?evals=${[...ids, "one-more"].join(",")}`))).status).toBe(400)
  })

  it("serves the model slice for the id the client encodes, gzipped with an ETag", async () => {
    const { GET } = await import("@/app/api/comparison-index/route")
    const routeId = routeIds().find((r) => r.includes("%2F"))!
    const response = await GET(
      request(`?model=${encodeURIComponent(routeId)}`, { "accept-encoding": "gzip" }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-encoding")).toBe("gzip")
    expect(await body(response)).toStrictEqual(await table.sliceForModel(routeId))
    const etag = response.headers.get("etag")!
    expect(etag).toBeTruthy()

    const revalidated = await GET(request(`?model=${encodeURIComponent(routeId)}`, { "if-none-match": etag }))
    expect(revalidated.status).toBe(304)
    const other = await GET(request(`?model=${encodeURIComponent(routeIds().find((r) => r !== routeId)!)}`))
    expect(other.headers.get("etag")).not.toBe(etag)
  })

  it("serves full leaderboards for the requested evals", async () => {
    const { GET } = await import("@/app/api/comparison-index/route")
    const ids = Object.keys(full.evals).slice(0, 3)
    const response = await GET(
      request(`?evals=${ids.map(encodeURIComponent).join(",")}`, { "accept-encoding": "gzip" }),
    )
    expect(response.status).toBe(200)
    const slice = await body(response)
    expect(Object.keys(slice.evals)).toEqual(ids)
    for (const id of ids) expect(slice.evals[id]).toStrictEqual(full.evals[id])
  })

  it("decodes the ids the client sends back to the stored ids", async () => {
    const { GET } = await import("@/app/api/comparison-index/route")
    const client = await import("@/lib/dashboard-data-client")
    const realFetch = globalThis.fetch
    globalThis.fetch = ((url: string) => GET(request(url.replace("/api/comparison-index", "")))) as typeof fetch
    try {
      const routeId = routeIds().find((r) => r.includes("%2F"))!
      expect(await client.fetchComparisonIndexForModel(routeId)).toStrictEqual(await table.sliceForModel(routeId))
      const ids = Object.keys(full.evals).filter((id) => id.includes("%2F")).slice(0, 4)
      expect(await client.fetchComparisonIndexForEvals([...ids, ids[0]])).toStrictEqual(await table.sliceForEvals(ids))
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
