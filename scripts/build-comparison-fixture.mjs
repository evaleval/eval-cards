#!/usr/bin/env node
// Export the committed comparison-table fixture from a real warehouse snapshot.
//
// Usage:
//   node scripts/build-comparison-fixture.mjs <snapshot-dir>
//
// <snapshot-dir> must hold the three comparison tables, the producer's
// comparison-index.json and hierarchy.json. Writes tests/fixtures/comparison-slices/:
//   - comparison_{evals,metrics,scores}.parquet filtered to the evals below,
//   - comparison-index.json: the producer's index for the same evals and rows,
//   - hierarchy.json: the families, benchmarks and benchmark_index entries
//     that reference those evals,
//   - models_view, evals_view, eval_results_view and merged_evals_view rows for
//     those evals and the models scored on them, so model and eval summaries
//     can be built from the same world.
//
// The evals cover: merged entries, slices with a parent, multi-metric evals
// whose first metric differs from name order, infinite registry bounds, split
// peers across three sources, protocol submission axes, and a model with many
// evals next to models with one.
//
// One row trim: the cleaner drops an llm-stats benchmark when its scores equal
// another source's for every shared model, which no eval pair in a full
// snapshot satisfies. The two terminal-bench-2 evals below keep only the
// models on which llm-stats and Papers with Code report the same score, so the
// fixture exercises that path. Both the tables and the JSON get the same trim.

import fs from "node:fs"
import path from "node:path"
import { DuckDBConnection } from "@duckdb/node-api"

const ROOT = path.resolve(import.meta.dirname, "..")
const OUT = path.join(ROOT, "tests", "fixtures", "comparison-slices")

const EVAL_IDS = [
  // wmdp: three per-source evals (one with labelled splits) and the merged entry.
  "wmdp",
  "llm-stats%2Fwmdp",
  "swissai-apertus-evals%2Fwmdp",
  "benchpress%2Fwmdp",
  // swe-polybench: the parent, four slices and the merged entry.
  "swe-polybench",
  "swe-polybench-leaderboard%2Fswe-polybench",
  "swe-polybench-leaderboard%2Fswe-polybench-java",
  "swe-polybench-leaderboard%2Fswe-polybench-javascript",
  "swe-polybench-leaderboard%2Fswe-polybench-python",
  "swe-polybench-leaderboard%2Fswe-polybench-typescript",
  // arc-agi-2: two-metric evals whose first metric is not the first by name.
  "arc-agi%2Farc-agi-2",
  "arc-agi%2Farc-agi-v2-private-eval",
  "llm-stats%2Farc-agi-2",
  // eq-bench: bounds infinite on both sides.
  "eq-bench",
  "llm-stats%2Feq-bench",
  // terminal-bench-2: protocol submission axis, and the trimmed dedup pair.
  "aisi-inference-scaling%2Fterminal-bench-2",
  "llm-stats%2Fterminal-bench-2",
  "paperswithcode%2Fterminal-bench-2",
]
const DEDUP_PAIR = ["llm-stats%2Fterminal-bench-2", "paperswithcode%2Fterminal-bench-2"]

const snapshotDir = process.argv[2]
if (!snapshotDir) {
  console.error("usage: node scripts/build-comparison-fixture.mjs <snapshot-dir>")
  process.exit(2)
}
const source = (name) => path.join(path.resolve(snapshotDir), name)
const sql = (value) => `'${String(value).replace(/'/g, "''")}'`

const index = JSON.parse(fs.readFileSync(source("comparison-index.json"), "utf8"))
for (const id of EVAL_IDS) {
  if (!index.evals[id]) throw new Error(`eval ${id} is not in ${snapshotDir}`)
}

// Models on which both dedup-pair evals report the same score.
const scoresOf = (evalId) =>
  new Map(index.evals[evalId].metrics[0].scores.map((row) => [row.model_route_id, row.score]))
const [aggScores, peerScores] = DEDUP_PAIR.map(scoresOf)
const dedupModels = [...aggScores].filter(
  ([model, score]) => peerScores.has(model) && Math.abs(peerScores.get(model) - score) <= 1e-9,
).map(([model]) => model)
if (dedupModels.length < 3) throw new Error(`dedup pair shares only ${dedupModels.length} equal scores`)
const keepRow = (evalId, row) => !DEDUP_PAIR.includes(evalId) || dedupModels.includes(row.model_route_id)

const evals = {}
for (const id of [...EVAL_IDS].sort()) {
  const entry = index.evals[id]
  evals[id] = {
    ...entry,
    metrics: entry.metrics.map((metric) => ({
      ...metric,
      scores: metric.scores.filter((row) => keepRow(id, row)),
    })),
  }
}
const kept = new Set()
for (const [id, entry] of Object.entries(evals)) {
  for (const metric of entry.metrics) {
    for (const row of metric.scores) kept.add(`${row.model_route_id}|${id}|${metric.metric_summary_id}`)
  }
}
const byModel = {}
for (const [routeId, cellsByEval] of Object.entries(index.by_model)) {
  for (const [evalId, cells] of Object.entries(cellsByEval)) {
    for (const [metricId, cell] of Object.entries(cells)) {
      if (!kept.has(`${routeId}|${evalId}|${metricId}`)) continue
      ;((byModel[routeId] ??= {})[evalId] ??= {})[metricId] = cell
    }
  }
}
const subset = Object.fromEntries(
  Object.entries({ ...index, by_model: byModel, evals }).sort(([a], [b]) => (a < b ? -1 : 1)),
)

const chosen = new Set(EVAL_IDS)
const pickIds = (ids) => (ids ?? []).filter((id) => chosen.has(id))
const pickBenchmarks = (benchmarks) =>
  benchmarks
    ?.filter((b) => pickIds(b.constituent_evaluation_ids).length > 0)
    .map((b) => ({ ...b, constituent_evaluation_ids: pickIds(b.constituent_evaluation_ids) }))
const hierarchy = JSON.parse(fs.readFileSync(source("hierarchy.json"), "utf8"))
const families = []
for (const family of hierarchy.families ?? []) {
  const picked = { ...family }
  if (family.benchmarks) picked.benchmarks = pickBenchmarks(family.benchmarks)
  if (family.standalone_benchmarks) picked.standalone_benchmarks = pickBenchmarks(family.standalone_benchmarks)
  if (family.composites) {
    picked.composites = family.composites
      .map((c) => ({ ...c, benchmarks: pickBenchmarks(c.benchmarks) ?? [] }))
      .filter((c) => c.benchmarks.length > 0)
  }
  if (family.constituent_evaluation_ids) {
    picked.constituent_evaluation_ids = pickIds(family.constituent_evaluation_ids)
  }
  const count =
    (picked.benchmarks?.length ?? 0) + (picked.standalone_benchmarks?.length ?? 0) + (picked.composites?.length ?? 0)
  if (count > 0) families.push(picked)
}
const benchmarkIndex = (hierarchy.benchmark_index ?? [])
  .map((entry) => ({
    ...entry,
    appearances: (entry.appearances ?? [])
      .map((a) => ({ ...a, constituent_evaluation_ids: pickIds(a.constituent_evaluation_ids) }))
      .filter((a) => a.constituent_evaluation_ids.length > 0),
  }))
  .filter((entry) => entry.appearances.length > 0)

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, "comparison-index.json"), JSON.stringify(subset))
fs.writeFileSync(
  path.join(OUT, "hierarchy.json"),
  JSON.stringify({ ...hierarchy, families, benchmark_index: benchmarkIndex }),
)

const connection = await DuckDBConnection.create()
const idList = EVAL_IDS.map(sql).join(", ")
const pairList = DEDUP_PAIR.map(sql).join(", ")
const modelList = dedupModels.map(sql).join(", ")
const copy = async (query, name) => {
  await connection.run(`COPY (${query}) TO ${sql(path.join(OUT, name))} (FORMAT parquet, COMPRESSION zstd)`)
}
await copy(
  `SELECT * FROM read_parquet(${sql(source("comparison_evals.parquet"))})
   WHERE evaluation_id IN (${idList}) ORDER BY evaluation_id`,
  "comparison_evals.parquet",
)
await copy(
  `SELECT * FROM read_parquet(${sql(source("comparison_metrics.parquet"))})
   WHERE evaluation_id IN (${idList}) ORDER BY evaluation_id, metric_ord`,
  "comparison_metrics.parquet",
)
await copy(
  `SELECT * REPLACE (
     CAST(row_number() OVER (PARTITION BY evaluation_id, metric_summary_id ORDER BY row_ord) - 1 AS INTEGER) AS row_ord
   )
   FROM read_parquet(${sql(source("comparison_scores.parquet"))})
   WHERE evaluation_id IN (${idList})
     AND (evaluation_id NOT IN (${pairList}) OR model_route_id IN (${modelList}))
   ORDER BY evaluation_id, metric_summary_id, row_ord`,
  "comparison_scores.parquet",
)
const routeList = Object.keys(byModel).map(sql).join(", ")
await copy(
  `SELECT * FROM read_parquet(${sql(source("models_view.parquet"))})
   WHERE route_id IN (${routeList}) OR model_route_id IN (${routeList})`,
  "models_view.parquet",
)
await copy(
  `SELECT * FROM read_parquet(${sql(source("evals_view.parquet"))}) WHERE evaluation_id IN (${idList})`,
  "evals_view.parquet",
)
await copy(
  `SELECT * FROM read_parquet(${sql(source("eval_results_view.parquet"))})
   WHERE evaluation_id IN (${idList}) AND model_route_id IN (${routeList})`,
  "eval_results_view.parquet",
)
await copy(
  `SELECT * FROM read_parquet(${sql(source("merged_evals_view.parquet"))}) WHERE benchmark_id IN (${idList})`,
  "merged_evals_view.parquet",
)

for (const name of fs.readdirSync(OUT).sort()) {
  console.log(`${name}\t${fs.statSync(path.join(OUT, name)).size} B`)
}
