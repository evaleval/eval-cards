// Leaderboard-parity gate — proves the runtime DuckDB leaderboard query reproduces
// the producer's leaderboards in comparison_metrics / comparison_scores (rows in
// row_ord order) BYTE-FOR-BYTE, on the prod-pinned binding, over the live snapshot.
// This is the core regression gate for the comparison-index migration: if the scoped
// query ever diverges from what the producer ships (rank semantics, ordering, identity
// column, membership), this fails.
//
// Run on linux/amd64 via scripts/migration-gate.sh. SNAPSHOT_URL selects the snapshot
// (default = pinned prod; override to re-verify against a post-rebaseline snapshot).
//
// NOTE this is a MIGRATION-phase gate (it diffs against the producer's comparison
// tables). If those are ever dropped it converts to a golden-fixture test.
import { DuckDBConnection } from "@duckdb/node-api"

const SNAP = (process.env.SNAPSHOT_URL || "").replace(/\/+$/, "")
if (!SNAP) { console.error("parity: SNAPSHOT_URL required"); process.exit(2) }

const c = await DuckDBConnection.create()
for (const [v, f] of [["models_view", "models_view.parquet"], ["evals_view", "evals_view.parquet"], ["eval_results_view", "eval_results_view.parquet"]])
  await c.run(`CREATE OR REPLACE TABLE ${v} AS SELECT * FROM read_parquet('${SNAP}/${f}')`)

const rows = async (sql) => { const r = await c.runAndRead(sql); await r.readAll(); return r.getRowObjectsJson() }
const num = (x) => (typeof x === "bigint" || typeof x === "string") ? Number(x) : x

// Group-key column resolution: scores[].model_family_id is fed the
// GROUP KEY. On the current pre-split snapshot that lives under `model_family_id`; on a
// post-rebaseline snapshot it's `model_group_id` (and `model_family_id` becomes the
// distinct structural id). Detect and use whichever carries the group key.
const cols = new Set((await rows(`DESCRIBE models_view`)).map((r) => r.column_name))
const GROUP_KEY = cols.has("model_group_id") ? "model_group_id" : "model_family_id"
console.log(`parity: group-key column = mv.${GROUP_KEY}`)

const SQL = `
WITH src AS (
  SELECT erv.evaluation_id, erv.metric_summary_id, erv.score, erv.model_route_id,
         mv.${GROUP_KEY} AS model_family_id, COALESCE(mv.model_family_name,'') AS model_family_name,
         COALESCE(mv.developer,'') AS developer, erv.lower_is_better
  FROM eval_results_view erv LEFT JOIN models_view mv ON mv.model_key = erv.model_key
  WHERE erv.score IS NOT NULL AND erv.evaluation_id IS NOT NULL
    AND erv.metric_summary_id IS NOT NULL AND erv.model_route_id IS NOT NULL )
SELECT evaluation_id, metric_summary_id, model_route_id, model_family_id, score,
  RANK()   OVER (PARTITION BY evaluation_id, metric_summary_id
                 ORDER BY (CASE WHEN lower_is_better THEN score ELSE -score END) ASC) AS rank,
  COUNT(*) OVER (PARTITION BY evaluation_id, metric_summary_id) AS total
FROM src
ORDER BY evaluation_id, metric_summary_id,
  (CASE WHEN lower_is_better THEN score ELSE -score END) ASC, model_route_id ASC`
const cand = new Map()
for (const r of await rows(SQL)) { const k = r.evaluation_id + "|" + r.metric_summary_id; (cand.get(k) ?? cand.set(k, []).get(k)).push(r) }

// The producer's leaderboards, as the comparison tables carry them (the same
// rows, in the same order, as comparison-index.json's evals[].metrics[].scores[]).
const live = new Map()
for (const m of await rows(`SELECT evaluation_id, metric_summary_id FROM read_parquet('${SNAP}/comparison_metrics.parquet')`))
  live.set(m.evaluation_id + "|" + m.metric_summary_id, [])
for (const r of await rows(`SELECT evaluation_id, metric_summary_id, model_route_id, model_family_id, score, rank, total
  FROM read_parquet('${SNAP}/comparison_scores.parquet') ORDER BY evaluation_id, metric_summary_id, row_ord`))
  live.get(r.evaluation_id + "|" + r.metric_summary_id).push(r)

let exact = 0, lenDiff = 0, orderDiff = 0, rankDiff = 0, totalDiff = 0, scoreDiff = 0, famDiff = 0
const onlyLive = [...live.keys()].filter((k) => !cand.has(k))
const onlyCand = [...cand.keys()].filter((k) => !live.has(k))
const samples = []
for (const [k, L] of live) {
  const C = cand.get(k); if (!C) continue
  if (C.length !== L.length) { lenDiff++; if (samples.length < 8) samples.push(`LEN ${k}: live=${L.length} cand=${C.length}`); continue }
  let ok = true
  for (let i = 0; i < L.length; i++) {
    const a = L[i], b = C[i]
    if (a.model_route_id !== b.model_route_id) { orderDiff++; ok = false; if (samples.length < 8) samples.push(`ORDER ${k}[${i}] live=${a.model_route_id} cand=${b.model_route_id}`); break }
    if (num(a.rank) !== num(b.rank)) { rankDiff++; ok = false }
    if (num(a.total) !== num(b.total)) { totalDiff++; ok = false }
    if (Math.abs(num(a.score) - num(b.score)) > 1e-9) { scoreDiff++; ok = false }
    if ((a.model_family_id ?? null) !== (b.model_family_id ?? null)) { famDiff++; ok = false }
  }
  if (ok) exact++
}
console.log(`parity: live=${live.size} candidate=${cand.size} | onlyLive=${onlyLive.length} onlyCand=${onlyCand.length} | exact=${exact}`)
console.log(`parity diffs -> length:${lenDiff} order:${orderDiff} rank:${rankDiff} total:${totalDiff} score:${scoreDiff} familyId:${famDiff}`)
if (samples.length) console.log("  " + samples.join("\n  "))
const PASS = onlyLive.length === 0 && onlyCand.length === 0 && lenDiff === 0 && orderDiff === 0 && rankDiff === 0 && totalDiff === 0 && scoreDiff === 0 && famDiff === 0
console.log(PASS ? "LEADERBOARD PARITY: PASS" : "LEADERBOARD PARITY: FAIL")
process.exit(PASS ? 0 : 1)
