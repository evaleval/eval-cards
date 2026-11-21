import { getMetricChipLabel } from "@/lib/metric-labels"
import { primaryMetricColumnKey, type BenchmarkEvalSummary } from "@/lib/eval-processing"

/**
 * Series-building logic for the score-distribution embed
 * (`app/embed/eval/distribution/[...id]/page.tsx`), extracted as pure
 * functions so the chip-selection rules can be unit-tested against real
 * eval-summary payloads without spinning up the React page.
 */

export type DistributionPoint = {
  score: number
  releaseDate: string | null
  modelName: string
}

export type DistributionSeries = {
  key: string
  label: string
  values: number[]
  unit?: string
  /** The metric's own direction; null when it reports none. */
  lowerIsBetter: boolean | null
  points: DistributionPoint[]
}

export type DistributionSliceAxis = {
  primaryColumn: string
  primaryLabel: string
  unit?: string
  lowerIsBetter: boolean | null
  slices: Array<{ key: string; label: string }>
}

/**
 * A slice axis exists only when the eval carries MORE THAN ONE distinct
 * subtask slice sharing its `primary_metric_id` root metric (e.g. Global MMLU's per-language
 * splits). A lone self-slice (one subtask key that just echoes the eval) does
 * NOT qualify — it falls through to the non-slice path where it is dropped as a
 * redundant twin of the root metric.
 */
export function buildDistributionSliceAxis(
  summary: BenchmarkEvalSummary,
): DistributionSliceAxis | null {
  const metrics = summary.leaderboard_metrics ?? []
  const primaryColumn = primaryMetricColumnKey(metrics, summary.primary_metric_id)
  const primary = metrics.find((m) => m.column_key === primaryColumn)
  if (!primary) return null
  const seen = new Map<string, string>()
  for (const m of metrics) {
    if (m.scope === "subtask" && m.subtask_key && !seen.has(m.subtask_key)) {
      seen.set(m.subtask_key, m.subtask_name ?? m.subtask_key)
    }
  }
  if (seen.size <= 1) return null
  return {
    primaryColumn: primary.column_key,
    primaryLabel: getMetricChipLabel(primary),
    unit: primary.unit ?? undefined,
    lowerIsBetter: primary.lower_is_better ?? null,
    slices: Array.from(seen, ([key, label]) => ({ key, label })),
  }
}

function pointsForColumn(
  rows: BenchmarkEvalSummary["leaderboard_rows"],
  columnKey: string,
): DistributionPoint[] {
  const points: DistributionPoint[] = []
  for (const row of rows ?? []) {
    const raw = (row.values as Record<string, unknown> | undefined)?.[columnKey]
    const numeric = typeof raw === "number" ? raw : Number(raw)
    if (!Number.isFinite(numeric)) continue
    const modelInfo = (row as { model_info?: { name?: string; release_date?: string | null } }).model_info
    points.push({
      score: numeric,
      modelName: modelInfo?.name ?? "",
      releaseDate: modelInfo?.release_date ?? null,
    })
  }
  return points
}

/**
 * Build the score-distribution series for the embed. Returns null when there
 * is nothing renderable (fewer than 3 data points everywhere).
 */
export function buildDistributionSeries(
  summary: BenchmarkEvalSummary,
  sliceAxis: DistributionSliceAxis | null,
  activeSlice: string,
  allSliceKey: string,
): DistributionSeries[] | null {
  const rows = summary.leaderboard_rows ?? []

  // Slice-axis path: render one series for the active slice (Overall or a
  // specific subtask). Drives the SPLIT dropdown UX.
  if (sliceAxis) {
    const columnKey =
      activeSlice === allSliceKey
        ? sliceAxis.primaryColumn
        : `${sliceAxis.primaryColumn}::${activeSlice}`
    const points = pointsForColumn(rows, columnKey)
    if (points.length < 3) return null
    const sliceLabel =
      activeSlice === allSliceKey
        ? "Overall"
        : sliceAxis.slices.find((s) => s.key === activeSlice)?.label ?? activeSlice
    return [
      {
        key: `${sliceAxis.primaryColumn}::${activeSlice}`,
        label: `${sliceAxis.primaryLabel} · ${sliceLabel}`,
        values: points.map((p) => p.score),
        unit: sliceAxis.unit,
        lowerIsBetter: sliceAxis.lowerIsBetter,
        points,
      },
    ]
  }

  // Non-slice path: one series per ROOT metric (e.g. agentharm's multi-metric
  // histogram). ScoreDistribution surfaces a metric chip picker. We mirror the
  // full eval page (eval-detail.tsx) which builds chips only from root-scope
  // metrics: the producer also emits a redundant self-slice subtask for some
  // evals — a metric whose subtask_key is just the slugified eval (e.g.
  // vals-ai/math-500 carries both root `accuracy` and subtask
  // `accuracy::vals ai math500`, same metric_summary_id and label). Multi-slice
  // evals (distinct subtask keys) are handled by the sliceAxis path above, so
  // the only subtasks reaching here are these redundant twins; rendering them
  // would duplicate the chip (two identical "Accuracy" buttons). Fall back to
  // the full set only if an eval somehow carries no root metric, so a
  // subtask-only eval still renders rather than going blank.
  const allMetrics = summary.leaderboard_metrics ?? []
  const rootMetrics = allMetrics.filter((m) => m.scope !== "subtask")
  const metrics = rootMetrics.length > 0 ? rootMetrics : allMetrics
  // Primary metric first, so a consumer opening on the first series opens
  // on `primary_metric_id`, as the eval page does.
  const primaryColumn = primaryMetricColumnKey(allMetrics, summary.primary_metric_id)
  const ordered = [
    ...metrics.filter((m) => m.column_key === primaryColumn),
    ...metrics.filter((m) => m.column_key !== primaryColumn),
  ]
  const built = ordered
    .map((metric) => {
      const columnKey = metric.column_key ?? metric.metric_summary_id
      if (!columnKey) return null
      const points = pointsForColumn(rows, columnKey)
      if (points.length < 3) return null
      return {
        key: columnKey,
        label: getMetricChipLabel(metric),
        values: points.map((p) => p.score),
        unit: metric.unit ?? undefined,
        lowerIsBetter: metric.lower_is_better ?? null,
        points,
      }
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
  return built.length > 0 ? built : null
}
