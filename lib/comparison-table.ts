import "server-only"

import type { DuckDBConnection } from "@duckdb/node-api"

import type {
  ComparisonByModelEntry,
  ComparisonEvalEntry,
  ComparisonIndex,
  ComparisonMetricEntry,
  ComparisonScoreEntry,
  MetricGroup,
} from "@/lib/backend-artifacts"
import type { ComparisonIndexLike } from "@/lib/clean-hierarchy"
import { COMPARISON_TABLES, COMPARISON_TOP_LEVEL_TABLE, getConnection, serialized } from "@/lib/duckdb"

// Rebuilds `ComparisonIndex`-shaped objects from the three comparison tables,
// sliced to what one page reads, so no path has to hold every leaderboard.
//
// The objects match what parsing the producer's comparison-index.json gave:
// same keys in the same order, a key present exactly when the JSON carries it
// (merged evals carry `is_merged` and their cells `source_composite_slug`;
// per-source cells carry `score_canonical`, `scale_conversion` and `split`),
// infinite registry bounds as infinite numbers, evals and `by_model` keys in
// sorted order, metrics and score rows in the producer's order.
//
// Every reader returns null when the snapshot has no comparison tables, the
// state callers already handle for a comparison index that failed to load.

type Row = Record<string, any>

/** Upper bound on one eval-slice request. The largest cross-suite sibling set
 *  in the cleaned hierarchy is 16 evals. */
export const MAX_EVAL_IDS = 64

const SCORE_COLUMNS = `
  evaluation_id,
  metric_summary_id,
  model_route_id,
  model_family_id,
  model_family_name,
  developer,
  variant_key,
  score,
  score_canonical,
  scale_conversion,
  CAST(rank AS INTEGER) AS rank,
  CAST(total AS INTEGER) AS total,
  split,
  CAST(submission_count AS INTEGER) AS submission_count,
  submission_axis,
  temperature,
  CAST(max_tokens AS DOUBLE) AS max_tokens,
  source_composite_slug
`

const EVAL_COLUMNS = `
  evaluation_id,
  benchmark_id,
  composite_display_name,
  composite_slug,
  derived_tags,
  display_name,
  family_display_name,
  family_id,
  coalesce(is_merged, false) AS is_merged,
  is_slice,
  is_summary_score,
  parent_benchmark_id,
  summary_score_for
`

const METRIC_COLUMNS = `
  evaluation_id,
  metric_summary_id,
  metric_name,
  metric_id,
  metric_key,
  "group",
  CAST(group_order AS INTEGER) AS group_order,
  lower_is_better,
  unit,
  canonical_min_score,
  canonical_max_score
`

// The FULL set of a model slice: every eval the model has a cell in, plus every
// per-source eval sharing a benchmark_id with one of those (the split-aware
// peer pool reads their whole leaderboards).
const MODEL_FULL_EVALS = `
  WITH own AS (
    SELECT DISTINCT evaluation_id FROM comparison_scores WHERE model_route_id = ?
  )
  SELECT evaluation_id FROM own
  UNION
  SELECT evaluation_id FROM comparison_evals
  WHERE NOT coalesce(is_merged, false)
    AND benchmark_id IN (
      SELECT benchmark_id FROM comparison_evals WHERE evaluation_id IN (SELECT evaluation_id FROM own)
    )
`

type Read = (sql: string, params?: string[]) => Promise<Row[]>

/** Runs one operation's DuckDB reads as one turn of the shared queue. Callers
 *  group and assemble the rows after it returns, so the queue is free for
 *  other readers meanwhile (the tables never change after load). */
function fetchRows<T>(reads: (read: Read) => Promise<T>): Promise<T> {
  return serialized(async () => {
    const connection = await getConnection()
    return reads((sql, params = []) => readRows(connection, sql, params))
  })
}

function compareKeys(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

function placeholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ")
}

async function readRows(connection: DuckDBConnection, sql: string, params: string[] = []): Promise<Row[]> {
  const reader =
    params.length > 0 ? await connection.runAndReadAll(sql, params) : await connection.runAndReadAll(sql)
  return reader.getRowObjectsJS() as Row[]
}

async function tablesAvailable(read: Read): Promise<boolean> {
  const names = Object.keys(COMPARISON_TABLES)
  const [row] = await read(
    `SELECT CAST(count(*) AS INTEGER) AS n FROM duckdb_tables() WHERE table_name IN (${placeholders(names.length)})`,
    names,
  )
  return row?.n === names.length
}

interface IndexMeta {
  comparison_index_version: number
  config_version: number
  generated_at: string
  metric_group_order: MetricGroup[]
}

async function readMeta(read: Read): Promise<IndexMeta> {
  const [row] = await read(
    `SELECT
       CAST(comparison_index_version AS INTEGER) AS comparison_index_version,
       CAST(config_version AS INTEGER) AS config_version,
       generated_at,
       metric_group_order
     FROM comparison_evals
     LIMIT 1`,
  )
  if (!row) {
    // No evals: the values come from the file metadata kept at load.
    const [stored] = await read(`SELECT top_level FROM ${COMPARISON_TOP_LEVEL_TABLE}`)
    const topLevel = JSON.parse(stored.top_level)
    return {
      comparison_index_version: topLevel.comparison_index_version,
      config_version: topLevel.config_version,
      generated_at: topLevel.generated_at,
      metric_group_order: topLevel.metric_group_order,
    }
  }
  return {
    comparison_index_version: row.comparison_index_version,
    config_version: row.config_version,
    generated_at: row.generated_at,
    metric_group_order: row.metric_group_order,
  }
}

function scoreEntry(row: Row, merged: boolean): ComparisonScoreEntry {
  if (merged) {
    return {
      developer: row.developer,
      max_tokens: row.max_tokens,
      model_family_id: row.model_family_id,
      model_family_name: row.model_family_name,
      model_route_id: row.model_route_id,
      rank: row.rank,
      score: row.score,
      source_composite_slug: row.source_composite_slug,
      submission_axis: row.submission_axis,
      submission_count: row.submission_count,
      temperature: row.temperature,
      total: row.total,
      variant_key: row.variant_key,
    } as unknown as ComparisonScoreEntry
  }
  return {
    developer: row.developer,
    max_tokens: row.max_tokens,
    model_family_id: row.model_family_id,
    model_family_name: row.model_family_name,
    model_route_id: row.model_route_id,
    rank: row.rank,
    scale_conversion: row.scale_conversion,
    score: row.score,
    score_canonical: row.score_canonical,
    split: row.split,
    submission_axis: row.submission_axis,
    submission_count: row.submission_count,
    temperature: row.temperature,
    total: row.total,
    variant_key: row.variant_key,
  } as unknown as ComparisonScoreEntry
}

function byModelCell(row: Row, merged: boolean): ComparisonByModelEntry {
  if (merged) {
    return {
      max_tokens: row.max_tokens,
      rank: row.rank,
      score: row.score,
      submission_axis: row.submission_axis,
      submission_count: row.submission_count,
      temperature: row.temperature,
      total: row.total,
    } as unknown as ComparisonByModelEntry
  }
  return {
    max_tokens: row.max_tokens,
    rank: row.rank,
    scale_conversion: row.scale_conversion,
    score: row.score,
    score_canonical: row.score_canonical,
    submission_axis: row.submission_axis,
    submission_count: row.submission_count,
    temperature: row.temperature,
    total: row.total,
  } as unknown as ComparisonByModelEntry
}

function metricKey(evaluationId: string, metricSummaryId: string) {
  return `${evaluationId}\u0000${metricSummaryId}`
}

function groupScores(scoreRows: Row[]): Map<string, Row[]> {
  const byMetric = new Map<string, Row[]>()
  for (const row of scoreRows) {
    const key = metricKey(row.evaluation_id, row.metric_summary_id)
    const rows = byMetric.get(key)
    if (rows) rows.push(row)
    else byMetric.set(key, [row])
  }
  return byMetric
}

function groupMetrics(metricRows: Row[]): Map<string, Row[]> {
  const byEval = new Map<string, Row[]>()
  for (const row of metricRows) {
    const rows = byEval.get(row.evaluation_id)
    if (rows) rows.push(row)
    else byEval.set(row.evaluation_id, [row])
  }
  return byEval
}

function buildEvals(
  evalRows: Row[],
  metricRows: Row[],
  scoreRows: Row[],
): Record<string, ComparisonEvalEntry> {
  const metricsByEval = groupMetrics(metricRows)
  const scoresByMetric = groupScores(scoreRows)
  const evals: Record<string, ComparisonEvalEntry> = {}
  for (const row of [...evalRows].sort((a, b) => compareKeys(a.evaluation_id, b.evaluation_id))) {
    const merged = row.is_merged === true
    const metrics: ComparisonMetricEntry[] = (metricsByEval.get(row.evaluation_id) ?? []).map((metric) => ({
      canonical_max_score: metric.canonical_max_score,
      canonical_min_score: metric.canonical_min_score,
      group: metric.group,
      group_order: metric.group_order,
      lower_is_better: metric.lower_is_better,
      metric_id: metric.metric_id,
      metric_key: metric.metric_key,
      metric_name: metric.metric_name,
      metric_summary_id: metric.metric_summary_id,
      scores: (scoresByMetric.get(metricKey(row.evaluation_id, metric.metric_summary_id)) ?? []).map(
        (score) => scoreEntry(score, merged),
      ),
      unit: metric.unit,
    }))
    evals[row.evaluation_id] = {
      benchmark_id: row.benchmark_id,
      composite_display_name: row.composite_display_name,
      composite_slug: row.composite_slug,
      derived_tags: row.derived_tags,
      display_name: row.display_name,
      evaluation_id: row.evaluation_id,
      family_display_name: row.family_display_name,
      family_id: row.family_id,
      ...(merged ? { is_merged: true } : {}),
      is_slice: row.is_slice,
      is_summary_score: row.is_summary_score,
      metrics,
      parent_benchmark_id: row.parent_benchmark_id,
      summary_score_for: row.summary_score_for,
    } as unknown as ComparisonEvalEntry
  }
  return evals
}

function buildByModel(
  scoreRows: Row[],
  evals: Record<string, ComparisonEvalEntry>,
): NonNullable<ComparisonIndex["by_model"]> {
  const cells = new Map<string, Map<string, Map<string, ComparisonByModelEntry>>>()
  for (const row of scoreRows) {
    const merged = evals[row.evaluation_id]?.is_merged === true
    let byEval = cells.get(row.model_route_id)
    if (!byEval) cells.set(row.model_route_id, (byEval = new Map()))
    let byMetric = byEval.get(row.evaluation_id)
    if (!byMetric) byEval.set(row.evaluation_id, (byMetric = new Map()))
    byMetric.set(row.metric_summary_id, byModelCell(row, merged))
  }
  const byModel: NonNullable<ComparisonIndex["by_model"]> = {}
  for (const routeId of [...cells.keys()].sort(compareKeys)) {
    const byEval = cells.get(routeId)!
    const evalCells: Record<string, Record<string, ComparisonByModelEntry>> = {}
    for (const evalId of [...byEval.keys()].sort(compareKeys)) {
      const byMetric = byEval.get(evalId)!
      const metricCells: Record<string, ComparisonByModelEntry> = {}
      for (const metricSummaryId of [...byMetric.keys()].sort(compareKeys)) {
        metricCells[metricSummaryId] = byMetric.get(metricSummaryId)!
      }
      evalCells[evalId] = metricCells
    }
    byModel[routeId] = evalCells
  }
  return byModel
}

function assemble(
  meta: IndexMeta,
  evals: Record<string, ComparisonEvalEntry>,
  byModel?: NonNullable<ComparisonIndex["by_model"]>,
): ComparisonIndex {
  return {
    ...(byModel ? { by_model: byModel } : {}),
    comparison_index_version: meta.comparison_index_version,
    config_version: meta.config_version,
    evals,
    generated_at: meta.generated_at,
    metric_group_order: meta.metric_group_order,
  }
}

/**
 * Everything one model page (and its embeds) reads. FULL entries, every
 * metric and every score row, for the evals the model has a cell in and for
 * the per-source evals sharing a benchmark_id with them. Every other eval is a
 * LIGHT entry: all eval and metric fields, no score rows (the model has none
 * there). `by_model` carries this model only.
 */
export async function sliceForModel(modelRouteId: string): Promise<ComparisonIndex | null> {
  const rows = await fetchRows(async (read) => {
    if (!(await tablesAvailable(read))) return null
    return {
      meta: await readMeta(read),
      evalRows: await read(`SELECT ${EVAL_COLUMNS} FROM comparison_evals`),
      metricRows: await read(`SELECT ${METRIC_COLUMNS} FROM comparison_metrics ORDER BY evaluation_id, metric_ord`),
      scoreRows: await read(
        `SELECT ${SCORE_COLUMNS} FROM comparison_scores
         WHERE evaluation_id IN (${MODEL_FULL_EVALS})
         ORDER BY evaluation_id, metric_summary_id, row_ord`,
        [modelRouteId],
      ),
    }
  })
  if (!rows) return null
  const evals = buildEvals(rows.evalRows, rows.metricRows, rows.scoreRows)
  const ownRows = rows.scoreRows.filter((row) => row.model_route_id === modelRouteId)
  return assemble(rows.meta, evals, buildByModel(ownRows, evals))
}

/** FULL entries for exactly these evaluation ids (unknown ids are skipped),
 *  without `by_model`. */
export async function sliceForEvals(evaluationIds: string[]): Promise<ComparisonIndex | null> {
  const ids = [...new Set(evaluationIds)]
  const filter = `WHERE evaluation_id IN (${placeholders(ids.length)})`
  const rows = await fetchRows(async (read) => {
    if (!(await tablesAvailable(read))) return null
    const meta = await readMeta(read)
    if (ids.length === 0) return { meta, evalRows: [], metricRows: [], scoreRows: [] }
    return {
      meta,
      evalRows: await read(`SELECT ${EVAL_COLUMNS} FROM comparison_evals ${filter}`, ids),
      metricRows: await read(
        `SELECT ${METRIC_COLUMNS} FROM comparison_metrics ${filter} ORDER BY evaluation_id, metric_ord`,
        ids,
      ),
      scoreRows: await read(
        `SELECT ${SCORE_COLUMNS} FROM comparison_scores ${filter} ORDER BY evaluation_id, metric_summary_id, row_ord`,
        ids,
      ),
    }
  })
  if (!rows) return null
  return assemble(rows.meta, buildEvals(rows.evalRows, rows.metricRows, rows.scoreRows))
}

/** The structural subset the hierarchy cleaner reads: every eval, its metrics
 *  in order, and each score row reduced to its model and score. */
export async function cleanerInput(): Promise<ComparisonIndexLike | null> {
  const rows = await fetchRows(async (read) => {
    if (!(await tablesAvailable(read))) return null
    return {
      evalRows: await read(`SELECT evaluation_id FROM comparison_evals`),
      metricRows: await read(
        `SELECT evaluation_id, metric_summary_id, metric_name FROM comparison_metrics ORDER BY evaluation_id, metric_ord`,
      ),
      scoreRows: await read(
        `SELECT evaluation_id, metric_summary_id, model_route_id, score FROM comparison_scores
         ORDER BY evaluation_id, metric_summary_id, row_ord`,
      ),
    }
  })
  if (!rows) return null
  const { evalRows, metricRows, scoreRows } = rows
  const metricsByEval = groupMetrics(metricRows)
  const scoresByMetric = groupScores(scoreRows)
  const evals: ComparisonIndexLike["evals"] = {}
  for (const row of [...evalRows].sort((a, b) => compareKeys(a.evaluation_id, b.evaluation_id))) {
    evals[row.evaluation_id] = {
      metrics: (metricsByEval.get(row.evaluation_id) ?? []).map((metric) => ({
        metric_summary_id: metric.metric_summary_id,
        metric_name: metric.metric_name,
        scores: (scoresByMetric.get(metricKey(row.evaluation_id, metric.metric_summary_id)) ?? []).map(
          (score) => ({ model_route_id: score.model_route_id, score: score.score }),
        ),
      })),
    }
  }
  return { evals }
}

/** The building blocks, for the verification-only whole-index rebuild in
 *  scripts/comparison-full-index.ts. */
export const comparisonTableInternals = {
  fetchRows,
  tablesAvailable,
  readMeta,
  buildEvals,
  buildByModel,
  assemble,
  EVAL_COLUMNS,
  METRIC_COLUMNS,
  SCORE_COLUMNS,
}
