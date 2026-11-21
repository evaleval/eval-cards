import type {
  ComparabilityStatus,
  DifferingSetupField,
  ReportingCompleteness,
  RowAnnotations,
} from "@/lib/backend-artifacts"
import type {
  BenchmarkLeaderboardMetric,
  BenchmarkLeaderboardRow,
  ModelResultForBenchmark,
} from "@/lib/eval-processing"

const FIELD_PREFIXES = [
  "autobenchmarkcard.",
  "eee_eval.",
  "evalcards.",
]

const TOKEN_OVERRIDES: Record<string, string> = {
  api: "API",
  ai: "AI",
  eee: "EEE",
  hf: "HF",
  id: "ID",
  llm: "LLM",
  url: "URL",
}

function titleCaseSegment(segment: string) {
  return segment
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((token) => TOKEN_OVERRIDES[token.toLowerCase()] ?? `${token.charAt(0).toUpperCase()}${token.slice(1).toLowerCase()}`)
    .join(" ")
}

export function formatPercent(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(value)) {
    return "N/A"
  }

  return `${(value * 100).toFixed(digits)}%`
}

export function formatSignalNumber(value: number | null | undefined, digits = 3) {
  if (value == null || !Number.isFinite(value)) {
    return "N/A"
  }

  if (Math.abs(value) >= 100) {
    return value.toFixed(1).replace(/\.0$/, "")
  }

  return value.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "")
}

export function formatFieldLabel(path: string) {
  let next = path
  for (const prefix of FIELD_PREFIXES) {
    if (next.startsWith(prefix)) {
      next = next.slice(prefix.length)
      break
    }
  }

  return next
    .split(".")
    .filter(Boolean)
    .map(titleCaseSegment)
    .join(" / ")
}

export function formatMissingField(field: string) {
  return titleCaseSegment(field)
}

export function formatSignalValue(value: unknown) {
  if (value == null) {
    return "(unspecified)"
  }

  if (typeof value === "string") {
    return value
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function formatDifferingFields(fields: DifferingSetupField[], limit = 2) {
  if (fields.length === 0) {
    return "setup fields"
  }

  const labels = fields.slice(0, limit).map((item) => formatMissingField(item.field))
  const remainder = fields.length - labels.length
  return remainder > 0 ? `${labels.join(", ")} +${remainder}` : labels.join(", ")
}

export function getCompletenessPopulatedCount(completeness: ReportingCompleteness) {
  if (completeness.field_scores.length === 0) {
    return Math.round(completeness.completeness_score * completeness.total_fields_evaluated)
  }

  return Math.round(
    completeness.field_scores.reduce((sum, field) => sum + field.score, 0)
  )
}

/**
 * A row whose comparability group was never assessed — it mixed
 * scales or declared no bounds, so the divergence flags are NULL, not
 * FALSE. Callers must render "not assessable" for these rather than the
 * silence that means "checked, nothing found".
 *
 * The verdict is read from the row's `comparability_status` first — that
 * is the producer's own answer and it settles the question either way.
 * Only when the snapshot carries no status does a NULL flag decide, and
 * then only on a row that DECLARES the flag: a snapshot whose annotation
 * struct has no verdict field at all tells us nothing, and its flat FALSE
 * means "checked, no divergence", not "never assessed".
 */
export function isNotAssessable(
  annotations: RowAnnotations | null | undefined,
  status?: ComparabilityStatus | null,
): boolean {
  const rowStatus = status ?? annotations?.comparability_status
  if (rowStatus === "mixed_scale" || rowStatus === "no_bounds") return true
  if (rowStatus === "ok") return false
  const variant = annotations?.variant_divergence
  const crossParty = annotations?.cross_party_divergence
  return (
    (variant != null &&
      "has_variant_divergence" in variant &&
      variant.has_variant_divergence == null) ||
    (crossParty != null &&
      "has_cross_party_divergence" in crossParty &&
      crossParty.has_cross_party_divergence == null)
  )
}

export type NotAssessableKind = "no_bounds" | "mixed_scale" | "unknown"

export function resolveNotAssessableKind(
  annotations: RowAnnotations | null | undefined,
  status?: ComparabilityStatus | null,
): NotAssessableKind | null {
  if (!isNotAssessable(annotations, status)) return null
  const rowStatus = status ?? annotations?.comparability_status
  if (rowStatus === "no_bounds") return "no_bounds"
  if (rowStatus === "mixed_scale") return "mixed_scale"
  return "unknown"
}

export function formatNotAssessableReason(kind: NotAssessableKind): string {
  if (kind === "no_bounds") return "no declared bounds"
  if (kind === "mixed_scale") return "mixed scales"
  return "no common scale"
}

export function formatNotAssessableTooltip(
  kind: NotAssessableKind,
  mode: "research" | "policy" = "research",
): string {
  const clause =
    kind === "mixed_scale"
      ? "the numbers in its comparison group sit on mixed scales"
      : kind === "no_bounds"
        ? "the metric declares no bounds to compare against"
        : "its comparison group could not be placed on a common scale"
  return mode === "research"
    ? `Divergence was not assessed for this row: ${clause}.`
    : `This score could not be cross-checked, because ${clause}.`
}

export interface NotAssessableModelEntry {
  modelRouteId: string | null
  modelName: string
  kind: NotAssessableKind
}

export interface MetricComparabilityStatus {
  columnKey: string
  label: string
  totalModels: number
  assessedModels: number
  noBoundsCount: number
  mixedScaleCount: number
  otherNotAssessableCount: number
  notAssessableCount: number
  allNotAssessable: boolean
  affectedModels: NotAssessableModelEntry[]
}

export interface NotAssessableSummary {
  isMultiMetric: boolean
  metrics: MetricComparabilityStatus[]
  fullyUnassessableMetrics: MetricComparabilityStatus[]
  partiallyUnassessableMetrics: MetricComparabilityStatus[]
  affectedModelCount: number
  /** Distinct models affected within `partiallyUnassessableMetrics` only. */
  partialAffectedModelCount: number
  noBoundsMetricCount: number
  mixedScaleModelCount: number
  hasAnyNotAssessable: boolean
}

function metricDisplayLabel(
  metric: BenchmarkLeaderboardMetric,
  duplicateLabels: Set<string>,
): string {
  const base =
    metric.canonical_display_name?.trim() ||
    metric.display_name?.trim() ||
    metric.metric_name?.trim() ||
    metric.column_key
  if (duplicateLabels.has(base)) {
    if (metric.subtask_name) return `${base} (${metric.subtask_name})`
    if (metric.column_key !== base) return `${base} (${metric.column_key})`
  }
  return base
}

/**
 * Summarize `not assessable` comparability verdicts across either a
 * multi-metric matrix (`leaderboard_metrics` + `leaderboard_rows`) or a
 * single-metric `model_results` list. Shared by the Comparability (X) signal
 * tile/dialog and `ComparabilityPanel` so both surfaces report identical
 * metric and model counts.
 */
export function summarizeNotAssessable(input: {
  leaderboardMetrics?: readonly BenchmarkLeaderboardMetric[] | null
  leaderboardRows?: readonly BenchmarkLeaderboardRow[] | null
  modelResults?: readonly ModelResultForBenchmark[] | null
  metricLabel?: string | null
}): NotAssessableSummary {
  const rawMetrics = input.leaderboardMetrics ?? []
  // Match EvalDetail's root-metric rule: subtask-scope entries are slices of
  // one root metric (e.g. Global MMLU's 19 language splits), not separate
  // metrics. Only inspect subtask columns when a page has no root metrics.
  const rootMetrics = rawMetrics.filter((m) => m.scope !== "subtask")
  const lbMetrics = rootMetrics.length > 0 ? rootMetrics : rawMetrics
  const lbRows = input.leaderboardRows ?? []
  const modelResults = input.modelResults ?? []

  if (lbMetrics.length > 0 && lbRows.length > 0) {
    const labelCounts = new Map<string, number>()
    for (const m of lbMetrics) {
      const base =
        m.canonical_display_name?.trim() ||
        m.display_name?.trim() ||
        m.metric_name?.trim() ||
        m.column_key
      labelCounts.set(base, (labelCounts.get(base) ?? 0) + 1)
    }
    const duplicateLabels = new Set(
      [...labelCounts.entries()].filter(([, n]) => n > 1).map(([k]) => k),
    )

    const metrics: MetricComparabilityStatus[] = []
    const allAffectedModelKeys = new Set<string>()
    const mixedScaleModelKeys = new Set<string>()

    for (const metric of lbMetrics) {
      const seen = new Set<string>()
      let totalModels = 0
      let noBoundsCount = 0
      let mixedScaleCount = 0
      let otherNotAssessableCount = 0
      const affectedModels: NotAssessableModelEntry[] = []

      for (const row of lbRows) {
        const val = row.values[metric.column_key]
        const status = row.comparability_status_by_metric?.[metric.column_key]
        const ann = row.annotations_by_metric?.[metric.column_key]
        const hasScore = typeof val === "number" && Number.isFinite(val)
        if (!hasScore && status == null && ann == null) continue

        const routeId = row.model_route_id ?? null
        const name = row.model_info?.name ?? row.model_info?.id ?? routeId ?? "Unknown model"
        const modelKey = routeId ?? row.model_info?.id ?? name
        if (seen.has(modelKey)) continue
        seen.add(modelKey)
        totalModels += 1

        const kind = resolveNotAssessableKind(ann, status)
        if (!kind) continue
        allAffectedModelKeys.add(modelKey)
        if (kind === "no_bounds") noBoundsCount += 1
        else if (kind === "mixed_scale") {
          mixedScaleCount += 1
          mixedScaleModelKeys.add(modelKey)
        } else otherNotAssessableCount += 1
        affectedModels.push({ modelRouteId: routeId, modelName: name, kind })
      }

      const notAssessableCount = noBoundsCount + mixedScaleCount + otherNotAssessableCount
      metrics.push({
        columnKey: metric.column_key,
        label: metricDisplayLabel(metric, duplicateLabels),
        totalModels,
        assessedModels: Math.max(0, totalModels - notAssessableCount),
        noBoundsCount,
        mixedScaleCount,
        otherNotAssessableCount,
        notAssessableCount,
        allNotAssessable: totalModels > 0 && notAssessableCount === totalModels,
        affectedModels,
      })
    }

    const hasMatrixNotAssessable = metrics.some((m) => m.notAssessableCount > 0)
    // Fall back to `modelResults` if the matrix payload omitted per-column
    // comparability metadata while `model_results` carries it.
    const modelResultsHasAny =
      !hasMatrixNotAssessable &&
      modelResults.some(
        (r) =>
          r.is_headline !== false &&
          isNotAssessable(r.result?.evalcards?.annotations, r.comparability_status),
      )

    if (!modelResultsHasAny) {
      const fullyUnassessableMetrics = metrics.filter((m) => m.allNotAssessable)
      const partiallyUnassessableMetrics = metrics.filter(
        (m) => m.notAssessableCount > 0 && !m.allNotAssessable,
      )
      const partialModelKeys = new Set<string>()
      for (const m of partiallyUnassessableMetrics) {
        for (const entry of m.affectedModels) {
          partialModelKeys.add(entry.modelRouteId ?? entry.modelName)
        }
      }
      return {
        isMultiMetric: metrics.length > 1,
        metrics,
        fullyUnassessableMetrics,
        partiallyUnassessableMetrics,
        affectedModelCount: allAffectedModelKeys.size,
        partialAffectedModelCount: partialModelKeys.size,
        noBoundsMetricCount: fullyUnassessableMetrics.filter(
          (m) => m.noBoundsCount === m.notAssessableCount,
        ).length,
        mixedScaleModelCount: mixedScaleModelKeys.size,
        hasAnyNotAssessable: hasMatrixNotAssessable,
      }
    }
  }

  // Single-metric path (headline rows only, matching BenchmarkSignalsStrip).
  const seen = new Set<string>()
  let totalModels = 0
  let noBoundsCount = 0
  let mixedScaleCount = 0
  let otherNotAssessableCount = 0
  const affectedModels: NotAssessableModelEntry[] = []

  for (const r of modelResults) {
    if (r.is_headline === false) continue
    const routeId = r.model_route_id ?? null
    const name = r.model_info?.name ?? r.model_info?.id ?? routeId ?? "Unknown model"
    const key = routeId ?? r.model_info?.id ?? name
    if (seen.has(key)) continue
    seen.add(key)
    totalModels += 1

    const kind = resolveNotAssessableKind(r.result?.evalcards?.annotations, r.comparability_status)
    if (!kind) continue
    if (kind === "no_bounds") noBoundsCount += 1
    else if (kind === "mixed_scale") mixedScaleCount += 1
    else otherNotAssessableCount += 1
    affectedModels.push({ modelRouteId: routeId, modelName: name, kind })
  }

  const notAssessableCount = noBoundsCount + mixedScaleCount + otherNotAssessableCount
  const singleMetric: MetricComparabilityStatus = {
    columnKey: "primary",
    label: input.metricLabel?.trim() || "Primary metric",
    totalModels,
    assessedModels: Math.max(0, totalModels - notAssessableCount),
    noBoundsCount,
    mixedScaleCount,
    otherNotAssessableCount,
    notAssessableCount,
    allNotAssessable: totalModels > 0 && notAssessableCount === totalModels,
    affectedModels,
  }
  const metrics = totalModels > 0 ? [singleMetric] : []
  const fullyUnassessableMetrics = singleMetric.allNotAssessable ? [singleMetric] : []
  const partiallyUnassessableMetrics =
    singleMetric.notAssessableCount > 0 && !singleMetric.allNotAssessable ? [singleMetric] : []

  return {
    isMultiMetric: false,
    metrics,
    fullyUnassessableMetrics,
    partiallyUnassessableMetrics,
    affectedModelCount: notAssessableCount,
    partialAffectedModelCount: partiallyUnassessableMetrics.length > 0 ? notAssessableCount : 0,
    noBoundsMetricCount:
      singleMetric.allNotAssessable && noBoundsCount === notAssessableCount ? 1 : 0,
    mixedScaleModelCount: mixedScaleCount,
    hasAnyNotAssessable: notAssessableCount > 0,
  }
}
