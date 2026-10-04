import type { ComparisonEvalEntry, ComparisonIndex } from "@/lib/backend-artifacts"

// The per-page slices of a whole comparison index, cut in memory. The table
// queries in lib/comparison-table.ts return exactly these objects; this is the
// reference they are tested against, and how a legacy dataset (which only
// publishes the whole index) is sliced.

function withScalars(
  index: ComparisonIndex,
  evals: Record<string, ComparisonEvalEntry>,
  byModel?: NonNullable<ComparisonIndex["by_model"]>,
): ComparisonIndex {
  return {
    ...(byModel ? { by_model: byModel } : {}),
    comparison_index_version: index.comparison_index_version,
    config_version: index.config_version,
    evals,
    generated_at: index.generated_at,
    metric_group_order: index.metric_group_order,
  }
}

/** Full leaderboards for the evals the model has a cell in and for the
 *  per-source evals sharing a benchmark_id with them; every other eval keeps
 *  its eval and metric fields with no score rows. `by_model` holds this model
 *  only. */
export function sliceIndexForModel(index: ComparisonIndex, modelRouteId: string): ComparisonIndex {
  const own = new Set<string>()
  for (const [evalId, entry] of Object.entries(index.evals)) {
    if (entry.metrics.some((m) => m.scores.some((s) => s.model_route_id === modelRouteId))) own.add(evalId)
  }
  const benchmarks = new Set([...own].map((evalId) => index.evals[evalId].benchmark_id))
  const evals: Record<string, ComparisonEvalEntry> = {}
  for (const [evalId, entry] of Object.entries(index.evals)) {
    const full = own.has(evalId) || (!entry.is_merged && entry.benchmark_id != null && benchmarks.has(entry.benchmark_id))
    evals[evalId] = full ? entry : { ...entry, metrics: entry.metrics.map((m) => ({ ...m, scores: [] })) }
  }
  const cells = index.by_model?.[modelRouteId]
  return withScalars(index, evals, cells ? { [modelRouteId]: cells } : {})
}

/** Full leaderboards for exactly these evals (unknown ids are skipped). */
export function sliceIndexForEvals(index: ComparisonIndex, evaluationIds: string[]): ComparisonIndex {
  const ids = new Set(evaluationIds)
  return withScalars(
    index,
    Object.fromEntries(Object.entries(index.evals).filter(([evalId]) => ids.has(evalId))),
  )
}
