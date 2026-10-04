// Full-snapshot check that the comparison tables serve every page exactly
// what the producer's comparison-index.json served. Local only (needs a
// snapshot directory holding both the tables and the JSON); not run in CI.
//
// Usage:
//   node --max-old-space-size=8192 --require ./scripts/server_only_hook.cjs --import tsx \
//     scripts/verify-comparison-slices.mts <snapshot-dir> [--models=N]
//
// Checks, all through the real DuckDB loading and query path:
//   a. the whole index rebuilt from the tables equals the parsed JSON (bounds
//      revived as the sidecar loader did), byte for byte once re-serialised;
//   b. for every model, its slice is structurally right (every eval and metric
//      field, full leaderboards on FULL evals, none elsewhere, by_model of the
//      model only) and gives the same histograms, split-peer pools and overlap
//      rows as the whole index, with the model's identity keys taken from
//      models_view and every eval the model could match;
//   c. for every eval, the sibling slice gives the same cross-suite aggregate;
//   d. the hierarchy cleaner gives the same result from cleanerInput() as from
//      the whole index, _modelCoverageMap included.
// It also reports slice sizes and build times. --models=N checks a
// deterministic sample of N models plus the extremes instead of all;
// --shard=i/n checks every n-th model from the i-th, so n processes can split
// the run (only shard 0 runs the per-eval check).

import { readFileSync } from "node:fs"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { gzipSync } from "node:zlib"

import type { ComparisonEvalEntry, ComparisonIndex, EvalHierarchy } from "../lib/backend-artifacts"
import type { BenchmarkEvalSummary } from "../lib/eval-processing"

const args = process.argv.slice(2)
const snapshotDir = path.resolve(args.find((a) => !a.startsWith("--")) ?? "")
const modelLimit = Number(args.find((a) => a.startsWith("--models="))?.split("=")[1] ?? "0")
const [shard, shardCount] = (args.find((a) => a.startsWith("--shard="))?.split("=")[1] ?? "0/1").split("/").map(Number)
if (!snapshotDir) {
  console.error("usage: verify-comparison-slices.mts <snapshot-dir> [--models=N]")
  process.exit(2)
}
process.env.DATA_BACKEND = "v2"
process.env.SNAPSHOT_URL = `file://${snapshotDir}`

const table = await import("../lib/comparison-table")
const { fullComparisonIndex } = await import("./comparison-full-index")
const { parseJsonWithBounds, stringifyJsonWithBounds } = await import("../lib/json-bounds")
const { cleanHierarchy } = await import("../lib/clean-hierarchy")
const { decorateHierarchyDerivedTags } = await import("../lib/benchmark-tags")
const { buildBenchmarkHistograms } = await import("../components/benchmark-detail")
const { buildBenchmarkEntryIndex, collectPeerObservationsFrom } = await import("../lib/split-peers")
const { buildOverlapRows } = await import("../lib/overlaps")
const { buildCrossSuiteAggregate, crossSuiteSiblingEvalIds } = await import(
  "../components/signals/benchmark-signals-strip"
)
const { getConnection } = await import("../lib/duckdb")

const failures: string[] = []
const fail = (message: string) => {
  failures.push(message)
  if (failures.length <= 20) console.error(`FAIL ${message}`)
}
const started = Date.now()
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`

// a. reconstruction
const full = parseJsonWithBounds<ComparisonIndex>(readFileSync(path.join(snapshotDir, "comparison-index.json"), "utf8"))
let t0 = Date.now()
const rebuilt = await fullComparisonIndex()
const rebuildMs = Date.now() - t0
const reconstructionEqual = isDeepStrictEqual(rebuilt, full)
const reconstructionBytesEqual = stringifyJsonWithBounds(rebuilt) === stringifyJsonWithBounds(full)
if (!reconstructionEqual) fail("a: rebuilt index differs from comparison-index.json")
if (!reconstructionBytesEqual) fail("a: rebuilt index serialises differently")
console.log(`[${elapsed()}] a. reconstruction: deep-equal=${reconstructionEqual} bytes-equal=${reconstructionBytesEqual} (${rebuildMs} ms)`)

// d. cleaner
const rawText = readFileSync(path.join(snapshotDir, "hierarchy.json"), "utf8")
const fromIndex = cleanHierarchy(JSON.parse(rawText) as EvalHierarchy, full)
const fromTables = cleanHierarchy(JSON.parse(rawText) as EvalHierarchy, await table.cleanerInput())
const cleanerEqual = isDeepStrictEqual(fromTables, fromIndex)
if (!cleanerEqual) fail("d: cleaned hierarchy differs")
console.log(
  `[${elapsed()}] d. cleaner: deep-equal=${cleanerEqual} coverage entries=${Object.keys(fromIndex._modelCoverageMap ?? {}).length}`,
)
const hierarchy = decorateHierarchyDerivedTags(fromIndex)
const familyDisplayByKey = new Map(hierarchy.families.map((f) => [f.key, f.display_name]))

// Identity keys per model, from every models_view field the model page's
// summary (or any of its variants) can carry.
const connection = await getConnection()
const modelRows = (
  await connection.runAndReadAll(
    `SELECT route_id, model_route_id, model_key, model_id, id, model_group_id, raw_model_ids,
            [v.variant_key FOR v IN coalesce(variants, [])] AS variant_keys,
            flatten([coalesce(v.raw_model_ids, []) FOR v IN coalesce(variants, [])]) AS variant_raw_ids,
            [v.family_id FOR v IN coalesce(variants, [])] AS variant_family_ids
     FROM models_view`,
  )
).getRowObjectsJS() as Array<Record<string, any>>
const modelRowByRoute = new Map(modelRows.map((row) => [row.route_id as string, row]))
const identityKeysFor = (routeId: string): Set<string> => {
  const row = modelRowByRoute.get(routeId) ?? {}
  const plain = [row.model_key, row.model_id, row.id, row.model_group_id].filter(Boolean) as string[]
  return new Set(
    [
      routeId,
      row.model_route_id,
      ...plain,
      ...plain.map((id) => encodeURIComponent(id)),
      ...(row.raw_model_ids ?? []),
      ...(row.variant_keys ?? []),
      ...(row.variant_raw_ids ?? []),
      ...(row.variant_family_ids ?? []),
    ].filter(Boolean) as string[],
  )
}

// Every eval holding a row that matches a given identifier, so each model is
// checked on every eval where it could find a "current" row, not only its own.
const evalsByIdentity = new Map<string, Set<string>>()
for (const [evalId, entry] of Object.entries(full.evals)) {
  for (const metric of entry.metrics) {
    for (const row of metric.scores) {
      for (const id of [row.model_route_id, row.model_family_id]) {
        if (!id) continue
        const set = evalsByIdentity.get(id) ?? new Set<string>()
        set.add(evalId)
        evalsByIdentity.set(id, set)
      }
    }
  }
}

const evalKeys = (entry: ComparisonEvalEntry) => Object.keys(entry).join(",")
const metricFieldsEqual = (a: ComparisonEvalEntry, b: ComparisonEvalEntry, fullRows: boolean) => {
  if (evalKeys(a) !== evalKeys(b) || a.metrics.length !== b.metrics.length) return false
  for (const key of Object.keys(b) as Array<keyof ComparisonEvalEntry>) {
    if (key === "metrics") continue
    if (!isDeepStrictEqual(a[key], b[key])) return false
  }
  for (let i = 0; i < b.metrics.length; i++) {
    const [ma, mb] = [a.metrics[i], b.metrics[i]]
    if (Object.keys(ma).join(",") !== Object.keys(mb).join(",")) return false
    for (const key of Object.keys(mb) as Array<keyof typeof mb>) {
      if (key === "scores") continue
      if (!Object.is(ma[key], mb[key])) return false
    }
    if (fullRows ? !isDeepStrictEqual(ma.scores, mb.scores) : ma.scores.length !== 0) return false
  }
  return true
}

// b. every model
const allRoutes = Object.keys(full.by_model ?? {})
const evalCount = (routeId: string) => Object.keys(full.by_model![routeId]).length
let routes = allRoutes
if (modelLimit > 0 && modelLimit < allRoutes.length) {
  const byCount = [...allRoutes].sort((a, b) => evalCount(a) - evalCount(b) || (a < b ? -1 : 1))
  const step = allRoutes.length / modelLimit
  const sample = new Set(Array.from({ length: modelLimit }, (_, i) => byCount[Math.floor(i * step)]))
  for (const pick of [byCount[0], byCount[Math.floor(byCount.length / 2)], byCount[byCount.length - 1]]) sample.add(pick)
  routes = [...sample]
}
routes = routes.filter((_, i) => i % shardCount === shard)
console.log(`[${elapsed()}] b. checking ${routes.length} of ${allRoutes.length} models`)

const sizes: Array<{ routeId: string; evals: number; bytes: number; ms: number }> = []
let identityMatchesOutsideOwnEvals = 0
let histogramsCompared = 0
let overlapRowsCompared = 0
let checked = 0
for (const routeId of routes) {
  t0 = Date.now()
  const slice = (await table.sliceForModel(routeId))!
  const ms = Date.now() - t0
  sizes.push({ routeId, evals: evalCount(routeId), bytes: Buffer.byteLength(stringifyJsonWithBounds(slice)), ms })

  const own = new Set(Object.keys(full.by_model![routeId]))
  const benchmarks = new Set([...own].map((id) => full.evals[id].benchmark_id))
  if (Object.keys(slice.evals).join() !== Object.keys(full.evals).join()) fail(`b: ${routeId} eval set/order`)
  if (!isDeepStrictEqual(slice.by_model, { [routeId]: full.by_model![routeId] })) fail(`b: ${routeId} by_model`)
  for (const [evalId, entry] of Object.entries(full.evals)) {
    const isFull = own.has(evalId) || (!entry.is_merged && benchmarks.has(entry.benchmark_id))
    if (!metricFieldsEqual(slice.evals[evalId], entry, isFull)) {
      fail(`b: ${routeId} structural mismatch on ${evalId}`)
      break
    }
  }

  const keys = identityKeysFor(routeId)
  const wanted = new Set<string>(own)
  for (const key of keys) for (const evalId of evalsByIdentity.get(key) ?? []) wanted.add(evalId)
  for (const evalId of wanted) if (!own.has(evalId)) identityMatchesOutsideOwnEvals += 1

  const histograms = (index: ComparisonIndex) => [
    ...buildBenchmarkHistograms({
      comparisonIndex: index,
      wantedEvalIds: wanted,
      currentModelIdentityKeys: keys,
      currentModelRouteId: routeId,
      currentModelName: routeId,
      extraModelsByBenchmark: {},
    }),
  ]
  const histogramsFull = histograms(full)
  if (!isDeepStrictEqual(histograms(slice), histogramsFull)) fail(`b: ${routeId} histograms`)
  histogramsCompared += histogramsFull.length

  const peers = (index: ComparisonIndex) => {
    const byBenchmark = buildBenchmarkEntryIndex(index)
    return [...wanted].flatMap((evalId) =>
      full.evals[evalId].metrics.map((m) =>
        collectPeerObservationsFrom(byBenchmark, full.evals[evalId].benchmark_id ?? "", m.metric_id ?? "", Boolean(m.lower_is_better), keys),
      ),
    )
  }
  if (!isDeepStrictEqual(peers(slice), peers(full))) fail(`b: ${routeId} split peers`)

  const overlaps = (index: ComparisonIndex) =>
    buildOverlapRows({
      benchmarkIndex: hierarchy.benchmark_index,
      comparisonIndex: index,
      currentModelRouteId: routeId,
      currentModelIdentityKeys: keys,
      familyDisplayByKey,
    })
  const overlapsFull = overlaps(full)
  if (!isDeepStrictEqual(overlaps(slice), overlapsFull)) fail(`b: ${routeId} overlaps`)
  overlapRowsCompared += overlapsFull.length

  checked += 1
  if (checked % 500 === 0) console.log(`[${elapsed()}]    ${checked}/${routes.length} models`)
}
console.log(
  `[${elapsed()}] b. models checked=${checked} histograms compared=${histogramsCompared} overlap rows compared=${overlapRowsCompared} ` +
    `identity matches outside own evals=${identityMatchesOutsideOwnEvals}`,
)

// c. every eval
const backend = await import("../lib/data-backend")
const { isMergedBenchmarkSummary, mergedSummaryToEvalSummary } = await import("../lib/merged-adapter")
let aggregatesCompared = 0
let largestSiblingSet = 0
let evalsChecked = 0
for (const [evalId, entry] of shard === 0 ? Object.entries(full.evals) : []) {
  let summary: BenchmarkEvalSummary | null = null
  if (entry.is_merged) {
    const merged = await backend.getMergedBenchmarkSummary(evalId)
    summary = isMergedBenchmarkSummary(merged) ? mergedSummaryToEvalSummary(merged) : null
  } else {
    summary = await backend.getEvalSummaryById(evalId)
  }
  if (!summary) {
    fail(`c: no summary for ${evalId}`)
    continue
  }
  const siblings = crossSuiteSiblingEvalIds(summary, hierarchy)
  largestSiblingSet = Math.max(largestSiblingSet, siblings.length)
  const slice = (await table.sliceForEvals(siblings))!
  const aggregate = buildCrossSuiteAggregate(summary, hierarchy, full)
  if (!isDeepStrictEqual(buildCrossSuiteAggregate(summary, hierarchy, slice), aggregate)) fail(`c: ${evalId} aggregate`)
  if (aggregate) aggregatesCompared += 1
  evalsChecked += 1
}
console.log(
  `[${elapsed()}] c. evals checked=${evalsChecked} non-null aggregates=${aggregatesCompared} largest sibling set=${largestSiblingSet}`,
)

// Slice sizes
const bySize = [...sizes].sort((a, b) => a.bytes - b.bytes)
for (const [label, s] of [
  ["largest", bySize[bySize.length - 1]],
  ["median", bySize[Math.floor(bySize.length / 2)]],
] as const) {
  const slice = await table.sliceForModel(s.routeId)
  const raw = Buffer.from(stringifyJsonWithBounds(slice))
  console.log(
    `slice ${label}: ${s.routeId} (${s.evals} own evals) ${raw.length} B raw, ${gzipSync(raw).length} B gzip, built in ${s.ms} ms`,
  )
}
const times = sizes.map((s) => s.ms).sort((a, b) => a - b)
console.log(`slice build ms: median ${times[Math.floor(times.length / 2)]}, max ${times[times.length - 1]}`)

console.log(`[${elapsed()}] ${failures.length === 0 ? "PASS" : `FAIL (${failures.length} failures)`}`)
process.exit(failures.length === 0 ? 0 : 1)
