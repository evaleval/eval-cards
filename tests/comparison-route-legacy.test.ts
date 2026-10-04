import { copyFile, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gunzipSync } from "node:zlib"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import type { ComparisonIndex, EvalHierarchy } from "@/lib/backend-artifacts"
import type { BenchmarkEvalSummary, ModelEvaluationSummary } from "@/lib/eval-processing"
import { parseJsonWithBounds } from "@/lib/json-bounds"

import { FIXTURE_DIR, fixtureIndex, fixtureRawHierarchy, identityKeysOf, useSnapshot } from "./comparison-fixture"

// The legacy (non-v2) data backend publishes only the whole comparison index.
// The route keeps loading it the way it always did and serves it sliced. The
// oracle is the consumers themselves: every reader of a model or eval page
// must get from the route body what it gets from the whole fixture index.

let cacheDir: string
let full: ComparisonIndex
let hierarchy: EvalHierarchy
let summaries: ModelEvaluationSummary[]
let evalSummaries: Map<string, BenchmarkEvalSummary>
let detail: typeof import("@/components/benchmark-detail")
let splitPeers: typeof import("@/lib/split-peers")
let overlaps: typeof import("@/lib/overlaps")
let signals: typeof import("@/components/signals/benchmark-signals-strip")
let GET: typeof import("@/app/api/comparison-index/route").GET

const previous = {
  DATA_BACKEND: process.env.DATA_BACKEND,
  SNAPSHOT_URL: process.env.SNAPSHOT_URL,
  HF_DATA_LOCAL_DIR: process.env.HF_DATA_LOCAL_DIR,
  HF_DATA_OFFLINE: process.env.HF_DATA_OFFLINE,
}

beforeAll(async () => {
  // Summaries and hierarchy come from the v2 fixture; the route then runs on
  // the legacy backend with only the whole index on disk.
  const restoreSnapshot = useSnapshot()
  try {
    full = fixtureIndex()
    const { cleanHierarchy } = await import("@/lib/clean-hierarchy")
    const { decorateHierarchyDerivedTags } = await import("@/lib/benchmark-tags")
    hierarchy = decorateHierarchyDerivedTags(cleanHierarchy(fixtureRawHierarchy(), full))
    const backend = await import("@/lib/data-backend")
    const { isMergedBenchmarkSummary, mergedSummaryToEvalSummary } = await import("@/lib/merged-adapter")
    summaries = []
    for (const routeId of Object.keys(full.by_model ?? {})) {
      const summary = await backend.getModelSummaryById(routeId)
      if (summary) summaries.push(summary as ModelEvaluationSummary)
    }
    evalSummaries = new Map()
    for (const evalId of Object.keys(full.evals)) {
      if (full.evals[evalId].is_merged) {
        const merged = await backend.getMergedBenchmarkSummary(evalId)
        if (isMergedBenchmarkSummary(merged)) evalSummaries.set(evalId, mergedSummaryToEvalSummary(merged))
      } else {
        const summary = await backend.getEvalSummaryById(evalId)
        if (summary) evalSummaries.set(evalId, summary)
      }
    }
    detail = await import("@/components/benchmark-detail")
    splitPeers = await import("@/lib/split-peers")
    overlaps = await import("@/lib/overlaps")
    signals = await import("@/components/signals/benchmark-signals-strip")
  } finally {
    restoreSnapshot()
  }

  cacheDir = await mkdtemp(path.join(os.tmpdir(), "eval-card-legacy-"))
  await copyFile(path.join(FIXTURE_DIR, "comparison-index.json"), path.join(cacheDir, "comparison-index.json"))
  delete process.env.DATA_BACKEND
  delete process.env.SNAPSHOT_URL
  process.env.HF_DATA_LOCAL_DIR = cacheDir
  process.env.HF_DATA_OFFLINE = "1"
  vi.resetModules()
  ;({ GET } = await import("@/app/api/comparison-index/route"))
})

afterAll(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true })
})

async function routeBody(query: string) {
  const response = await GET(
    new Request(`http://localhost/api/comparison-index?${query}`, { headers: { "accept-encoding": "gzip" } }),
  )
  expect(response.status, query).toBe(200)
  return parseJsonWithBounds<ComparisonIndex>(gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8"))
}

const rowCount = (index: ComparisonIndex) =>
  Object.values(index.evals).reduce((n, e) => n + e.metrics.reduce((m, metric) => m + metric.scores.length, 0), 0)

/** Every model-page reader of the index: histograms, split peers, overlaps. */
function modelConsumers(index: ComparisonIndex, summary: ModelEvaluationSummary) {
  const routeId = detail.comparisonRouteIdOf(summary)
  const keys = identityKeysOf(summary)
  const histograms = [
    ...detail.buildBenchmarkHistograms({
      comparisonIndex: index,
      wantedEvalIds: new Set(Object.keys(full.evals)),
      currentModelIdentityKeys: keys,
      currentModelRouteId: routeId,
      currentModelName: summary.model_info.name,
      extraModelsByBenchmark: {},
    }),
  ]
  const byBenchmark = splitPeers.buildBenchmarkEntryIndex(index)
  const peers = Object.keys(full.by_model?.[routeId] ?? {}).flatMap((evalId) =>
    full.evals[evalId].metrics.map((m) =>
      splitPeers.collectPeerObservationsFrom(
        byBenchmark,
        full.evals[evalId].benchmark_id ?? "",
        m.metric_id ?? "",
        Boolean(m.lower_is_better),
        keys,
      ),
    ),
  )
  const overlapRows = overlaps.buildOverlapRows({
    benchmarkIndex: hierarchy.benchmark_index,
    comparisonIndex: index,
    currentModelRouteId: routeId,
    currentModelIdentityKeys: keys,
    familyDisplayByKey: new Map(hierarchy.families.map((f) => [f.key, f.display_name])),
  })
  return { histograms, peers, overlapRows }
}

describe("GET /api/comparison-index on the legacy data backend", () => {
  it("gives every model-page consumer what the whole index gives it, for every fixture model", async () => {
    expect(summaries.length).toBe(Object.keys(full.by_model ?? {}).length)
    let caption = 0
    let overlapRows = 0
    let narrower = 0
    for (const summary of summaries) {
      const routeId = detail.comparisonRouteIdOf(summary)
      const body = await routeBody(`model=${encodeURIComponent(routeId)}`)
      const fromFull = modelConsumers(full, summary)
      expect(modelConsumers(body, summary), routeId).toStrictEqual(fromFull)
      expect(Object.keys(body.by_model ?? {}), routeId).toEqual([routeId])
      expect(body.by_model![routeId]).toStrictEqual(full.by_model![routeId])
      if (rowCount(body) < rowCount(full)) narrower += 1
      caption += fromFull.histograms.filter(([, h]) => h.caption != null).length
      overlapRows += fromFull.overlapRows.length
    }
    expect(caption).toBeGreaterThan(0)
    expect(overlapRows).toBeGreaterThan(0)
    expect(narrower).toBeGreaterThan(0)
  })

  it("gives the signals strip the cross-suite aggregate the whole index gives it, for every fixture eval", async () => {
    expect([...evalSummaries.keys()].sort()).toEqual(Object.keys(full.evals).sort())
    let aggregates = 0
    for (const [evalId, summary] of evalSummaries) {
      const siblings = signals.crossSuiteSiblingEvalIds(summary, hierarchy)
      if (siblings.length === 0) {
        // The page requests nothing; the strip must not need the index.
        expect(signals.buildCrossSuiteAggregate(summary, hierarchy, full), evalId).toBeNull()
        continue
      }
      const body = await routeBody(`evals=${siblings.map(encodeURIComponent).join(",")}`)
      const aggregate = signals.buildCrossSuiteAggregate(summary, hierarchy, full)
      expect(signals.buildCrossSuiteAggregate(summary, hierarchy, body), evalId).toStrictEqual(aggregate)
      expect(Object.keys(body.evals).sort(), evalId).toEqual(siblings.filter((id) => full.evals[id]).sort())
      expect(body.by_model).toBeUndefined()
      if (aggregate) aggregates += 1
    }
    expect(aggregates).toBeGreaterThan(0)
  })
})
