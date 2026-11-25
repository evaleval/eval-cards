import type { ComparisonMetricEntry } from "./backend-artifacts"
import type { BenchmarkEvaluation, EvaluationResult } from "./benchmark-schema"
import { scoreStandings } from "./eval-processing"

const TOKEN_DISPLAY_OVERRIDES: Record<string, string> = {
  acc: "Accuracy",
  asr: "ASR",
  ast: "AST",
  auroc: "AUROC",
  avg: "Avg",
  bleu: "BLEU",
  bleurt: "BLEURT",
  cider: "CIDEr",
  ci: "CI",
  cot: "CoT",
  crps: "CRPS",
  elo: "Elo",
  em: "EM",
  err: "Error",
  f1: "F1",
  fid: "FID",
  fpr: "FPR",
  if: "IF",
  inst: "Instruction",
  iou: "IoU",
  kl: "KL",
  lpips: "LPIPS",
  mae: "MAE",
  map: "mAP",
  mase: "MASE",
  mc: "MC",
  miou: "mIoU",
  mse: "MSE",
  psnr: "PSNR",
  qa: "QA",
  rmse: "RMSE",
  rouge: "ROUGE",
  rtfx: "RTFx",
  ses: "SES",
  ssim: "SSIM",
  std: "Std",
  stderr: "Stderr",
  tts: "TTS",
  usd: "USD",
  wer: "WER",
}

const STDERR_METRIC_SUFFIX = /_(stderr|std_err|standard_error)$/i
const SCORE_METRIC_SUFFIX = /_(acc|accuracy|score|value|result)$/i

export function isStderrMetricSummaryId(id: string | null | undefined): boolean {
  if (!id) return false
  const parts = id.split(/%3A|:/i)
  const local = parts[parts.length - 1] ?? id
  return STDERR_METRIC_SUFFIX.test(local)
}

export function metricStderrPairKey(id: string | null | undefined): string | null {
  if (!id) return null
  const trimmed = id.replace(STDERR_METRIC_SUFFIX, "").replace(SCORE_METRIC_SUFFIX, "")
  return trimmed.length > 0 ? trimmed : id
}

function humanizeToken(token: string): string {
  if (!token) return ""
  const lower = token.toLowerCase()
  const mapped = TOKEN_DISPLAY_OVERRIDES[lower]
  if (mapped) return mapped
  if (/^\d/.test(token)) return token
  if (/[A-Z]/.test(token.slice(1))) return token
  return token.charAt(0).toUpperCase() + token.slice(1)
}

/**
 * Turns a raw metric identifier (`amb_bias_score_Sexual_orientation`,
 * `accuracy::disamb`, `pass-at-10`) into a readable label without inventing
 * meaning.
 */
export function humanizeMetricIdentifier(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim()
  if (!trimmed) return ""
  let decoded = trimmed
  try {
    decoded = decodeURIComponent(trimmed)
  } catch {
    decoded = trimmed
  }
  const passAtMatch = decoded.match(/^pass[-_@]?at[-_@]?(\d+)$/i)
  if (passAtMatch) return `Pass@${passAtMatch[1]}`

  if (decoded.includes("::")) {
    const [head, ...rest] = decoded.split("::")
    const headText = humanizeMetricIdentifier(head)
    const tailText = rest
      .map((part) =>
        part
          .split(/[-_\s]+/)
          .filter(Boolean)
          .map((tok) => TOKEN_DISPLAY_OVERRIDES[tok.toLowerCase()] ?? tok)
          .join(" "),
      )
      .filter(Boolean)
      .join(" · ")
    return tailText ? `${headText} (${tailText})` : headText
  }

  return decoded
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(humanizeToken)
    .join(" ")
}

/**
 * A reading's own metric label. Never falls back to `result.evaluation_name`,
 * which carries the benchmark's name when the registry has not named the metric.
 */
export function getReadingMetricLabel(
  result: Pick<EvaluationResult, "display_name" | "canonical_display_name" | "metric_key">,
): string {
  const explicit = result.display_name?.trim() || result.canonical_display_name?.trim()
  if (explicit) return explicit
  const fromKey = humanizeMetricIdentifier(result.metric_key)
  return fromKey || "Metric"
}

export function getComparisonMetricKey(
  metric: Pick<ComparisonMetricEntry, "metric_id" | "metric_key" | "metric_summary_id">,
): string | null {
  const direct = metric.metric_id?.trim() || metric.metric_key?.trim()
  if (direct) return direct
  const summaryId = metric.metric_summary_id?.trim() ?? ""
  if (!summaryId) return null
  const parts = summaryId.split(/%3A|:/i)
  const local = parts[parts.length - 1]?.trim() ?? ""
  if (!local) return null
  try {
    return decodeURIComponent(local)
  } catch {
    return local
  }
}

export function isDefaultLeadReading(
  result: Pick<EvaluationResult, "is_lead_metric" | "metric_key">,
  primaryMetricId?: string | null,
): boolean {
  if (result.is_lead_metric != null) return Boolean(result.is_lead_metric)
  return Boolean(primaryMetricId && result.metric_key === primaryMetricId)
}

/**
 * True when an eval declares a primary/lead metric and this reading sits on a
 * different metric with no unit of its own (`unit == null`). Such readings
 * (signed bias scores, word counts, RTFx) are raw numbers and must never be
 * heuristically formatted as percentages.
 */
export function isStatedUnitlessReading(
  result: Pick<EvaluationResult, "metric_key" | "is_lead_metric" | "metric_config">,
  evaluation?: Pick<BenchmarkEvaluation, "primary_metric_id" | "evaluation_results"> | null,
): boolean {
  if (result.metric_config.unit) return false
  const primaryId = evaluation?.primary_metric_id?.trim()
  if (primaryId && result.metric_key && result.metric_key !== primaryId) return true
  const originalLead = evaluation?.evaluation_results?.find((r) => r.is_lead_metric)
  if (originalLead?.metric_key && result.metric_key && result.metric_key !== originalLead.metric_key) {
    return true
  }
  return result.is_lead_metric === false
}

/**
 * Matches `buildBenchmarkGroups`'s group-key folding so option counts align
 * 1-to-1 with the benchmark groups shown on the model card.
 */
export function resolveModelGroupKey(
  evaluation: Pick<
    BenchmarkEvaluation,
    "is_slice" | "parent_benchmark_id" | "eval_summary_id" | "family_id" | "evaluation_id"
  >,
): string {
  if (evaluation.is_slice && evaluation.parent_benchmark_id) {
    const evalId = evaluation.eval_summary_id ?? ""
    const sourcePrefix = evalId.includes("%2F") ? evalId.split("%2F")[0] : null
    if (sourcePrefix) return `${sourcePrefix}%2F${evaluation.parent_benchmark_id}`
  }
  return (
    evaluation.eval_summary_id ??
    evaluation.parent_benchmark_id ??
    evaluation.family_id ??
    evaluation.evaluation_id ??
    "benchmark"
  )
}

export interface ModelMetricFilterOption {
  metricKey: string
  label: string
  /** Distinct benchmark groups carrying a finite reading on this metric. */
  evalCount: number
  /** Distinct benchmark groups where this metric is already the default lead metric. */
  leadEvalCount: number
  /** Distinct benchmark groups where this metric is hidden under Main metric. */
  nonLeadEvalCount: number
  direction: "higher" | "lower" | "mixed" | null
}

/**
 * Builds deduplicated page-level metric filter options across a model's
 * reported results. Multi-tag buckets in `evaluations_by_tag` are deduplicated
 * by `(groupKey, metricKey)` so counts match rendered benchmark groups.
 */
export function buildModelMetricFilterOptions(
  entries: ReadonlyArray<{ evaluation: BenchmarkEvaluation; result: EvaluationResult }>,
): ModelMetricFilterOption[] {
  const buckets = new Map<
    string,
    {
      groupKeys: Set<string>
      leadGroupKeys: Set<string>
      labelCounts: Map<string, number>
      sawHigher: boolean
      sawLower: boolean
    }
  >()

  for (const { evaluation, result } of entries) {
    if (isStderrMetricSummaryId(result.metric_summary_id)) continue
    const metricKey = result.metric_key?.trim()
    if (!metricKey) continue
    if (!Number.isFinite(result.score_details.score)) continue

    const groupKey = resolveModelGroupKey(evaluation)
    let bucket = buckets.get(metricKey)
    if (!bucket) {
      bucket = {
        groupKeys: new Set<string>(),
        leadGroupKeys: new Set<string>(),
        labelCounts: new Map<string, number>(),
        sawHigher: false,
        sawLower: false,
      }
      buckets.set(metricKey, bucket)
    }

    const isFirstForGroup = !bucket.groupKeys.has(groupKey)
    bucket.groupKeys.add(groupKey)
    if (isDefaultLeadReading(result, evaluation.primary_metric_id)) {
      bucket.leadGroupKeys.add(groupKey)
    }
    if (isFirstForGroup) {
      const label = getReadingMetricLabel(result)
      bucket.labelCounts.set(label, (bucket.labelCounts.get(label) ?? 0) + 1)
    }
    if (result.metric_config.lower_is_better === true) {
      bucket.sawLower = true
    } else if (result.metric_config.lower_is_better === false) {
      bucket.sawHigher = true
    }
  }

  const rawOptions: ModelMetricFilterOption[] = []
  for (const [metricKey, bucket] of buckets.entries()) {
    let bestLabel = humanizeMetricIdentifier(metricKey) || "Metric"
    let bestCount = -1
    for (const [candidate, count] of bucket.labelCounts.entries()) {
      if (count > bestCount) {
        bestLabel = candidate
        bestCount = count
      }
    }
    const evalCount = bucket.groupKeys.size
    const leadEvalCount = bucket.leadGroupKeys.size
    const direction: ModelMetricFilterOption["direction"] =
      bucket.sawHigher && bucket.sawLower
        ? "mixed"
        : bucket.sawLower
          ? "lower"
          : bucket.sawHigher
            ? "higher"
            : null

    rawOptions.push({
      metricKey,
      label: bestLabel,
      evalCount,
      leadEvalCount,
      nonLeadEvalCount: Math.max(0, evalCount - leadEvalCount),
      direction,
    })
  }

  const labelTotals = new Map<string, number>()
  for (const opt of rawOptions) {
    labelTotals.set(opt.label, (labelTotals.get(opt.label) ?? 0) + 1)
  }

  return rawOptions
    .map((opt) =>
      (labelTotals.get(opt.label) ?? 0) > 1
        ? { ...opt, label: `${opt.label} (${opt.metricKey})` }
        : opt,
    )
    .sort(
      (a, b) =>
        b.evalCount - a.evalCount ||
        b.nonLeadEvalCount - a.nonLeadEvalCount ||
        a.label.localeCompare(b.label),
    )
}

function readingSetupIdentity(evaluation: BenchmarkEvaluation, result: EvaluationResult): string {
  return `${evaluation.evaluation_id}::${result.metric_summary_id ?? ""}::${result.evaluation_name}`
}

/**
 * Filters a model's `(evaluation, result)` entries to a single `selectedMetricKey`.
 *
 * - Returns `entries` unchanged when `selectedMetricKey` is null/empty.
 * - Marks at most ONE setup run per `eval_summary_id` as `is_lead_metric: true`
 *   (preferring the producer's original lead run, else the first matching run),
 *   while keeping identical tag-bucket duplicates consistent so downstream
 *   variant deduplication preserves the lead flag.
 * - Retains paired `_stderr` companion entries so Plotbox stderr whiskers stay intact.
 */
export function filterModelEntriesByMetric<
  T extends { evaluation: BenchmarkEvaluation; result: EvaluationResult },
>(entries: readonly T[], selectedMetricKey: string | null | undefined): T[] {
  const key = selectedMetricKey?.trim()
  if (!key) return entries as T[]

  const winnerSetupByEvalKey = new Map<string, { identity: string; wasOriginalLead: boolean }>()
  const wantedStderrPairs = new Set<string>()

  for (const entry of entries) {
    const { evaluation, result } = entry
    if (isStderrMetricSummaryId(result.metric_summary_id)) continue
    if (result.metric_key?.trim() !== key) continue
    if (!Number.isFinite(result.score_details.score)) continue

    const evalKey = evaluation.eval_summary_id || evaluation.evaluation_id
    const identity = readingSetupIdentity(evaluation, result)
    const wasOriginalLead = isDefaultLeadReading(result, evaluation.primary_metric_id)
    const prev = winnerSetupByEvalKey.get(evalKey)
    if (!prev || (!prev.wasOriginalLead && wasOriginalLead)) {
      winnerSetupByEvalKey.set(evalKey, { identity, wasOriginalLead })
    }

    const groupKey = resolveModelGroupKey(evaluation)
    const pairKey = metricStderrPairKey(result.metric_summary_id)
    if (pairKey) {
      wantedStderrPairs.add(`${groupKey}::${pairKey}`)
    }
  }

  const out: T[] = []
  for (const entry of entries) {
    const { evaluation, result } = entry
    if (isStderrMetricSummaryId(result.metric_summary_id)) {
      const groupKey = resolveModelGroupKey(evaluation)
      const pairKey = metricStderrPairKey(result.metric_summary_id)
      if (pairKey && wantedStderrPairs.has(`${groupKey}::${pairKey}`)) {
        out.push(entry)
      }
      continue
    }

    if (result.metric_key?.trim() !== key) continue
    if (!Number.isFinite(result.score_details.score)) continue

    const evalKey = evaluation.eval_summary_id || evaluation.evaluation_id
    const winner = winnerSetupByEvalKey.get(evalKey)
    const isWinner = winner?.identity === readingSetupIdentity(evaluation, result)
    out.push({
      ...entry,
      result: {
        ...result,
        is_lead_metric: isWinner,
      },
    })
  }

  return out
}

export interface EvalMetricFilterOption {
  columnKey: string
  metricId: string
  label: string
  modelCount: number
  lowerIsBetter: boolean | null
  unit: string | null
  isPrimary: boolean
}

export function buildEvalMetricFilterOptions<
  M extends {
    column_key: string
    metric_id?: string | null
    display_name?: string | null
    metric_name?: string | null
    lower_is_better?: boolean | null
    unit?: string | null
    scope?: string | null
  },
>(params: {
  metrics: readonly M[]
  rows: ReadonlyArray<{ values: Record<string, number | null | undefined> }>
  primaryColumnKey?: string
  duplicateColumnKeys?: ReadonlySet<string>
  getLabel: (metric: M) => string
}): EvalMetricFilterOption[] {
  const { metrics, rows, primaryColumnKey, duplicateColumnKeys, getLabel } = params
  const raw: EvalMetricFilterOption[] = []

  for (const metric of metrics) {
    if (metric.scope === "subtask") continue
    if (duplicateColumnKeys?.has(metric.column_key)) continue

    let modelCount = 0
    for (const row of rows) {
      const val = row.values[metric.column_key]
      if (typeof val === "number" && Number.isFinite(val)) {
        modelCount += 1
      }
    }
    const isPrimary = Boolean(primaryColumnKey && metric.column_key === primaryColumnKey)
    if (modelCount === 0 && !isPrimary) continue

    raw.push({
      columnKey: metric.column_key,
      metricId: metric.metric_id?.trim() || metric.column_key,
      label: getLabel(metric),
      modelCount,
      lowerIsBetter: metric.lower_is_better ?? null,
      unit: metric.unit ?? null,
      isPrimary,
    })
  }

  const labelCounts = new Map<string, number>()
  for (const item of raw) {
    labelCounts.set(item.label, (labelCounts.get(item.label) ?? 0) + 1)
  }

  return raw
    .map((item) =>
      (labelCounts.get(item.label) ?? 0) > 1
        ? { ...item, label: `${item.label} (${item.columnKey})` }
        : item,
    )
    .sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1
      if (a.modelCount !== b.modelCount) return b.modelCount - a.modelCount
      return a.label.localeCompare(b.label)
    })
}

/**
 * Computes competition standings (`1, 1, 3`) on a single metric column in its
 * natural direction, independent of current table sort order. Returns an empty
 * map when `lowerIsBetter == null` (unknown direction takes no rank).
 */
export function computeMetricStandings<T>(
  rows: readonly T[],
  getScore: (row: T) => number | null | undefined,
  getId: (row: T) => string,
  lowerIsBetter: boolean | null | undefined,
): Map<string, number> {
  const rankMap = new Map<string, number>()
  if (lowerIsBetter == null) return rankMap

  const scored = rows
    .map((row) => ({ id: getId(row), score: getScore(row) }))
    .filter((entry): entry is { id: string; score: number } =>
      Boolean(entry.id) && typeof entry.score === "number" && Number.isFinite(entry.score),
    )
    .sort((a, b) => (lowerIsBetter ? a.score - b.score : b.score - a.score))

  const standings = scoreStandings(scored, (entry) => entry.score, () => true)
  scored.forEach((entry, idx) => {
    rankMap.set(entry.id, standings[idx] ?? 0)
  })
  return rankMap
}

/**
 * Updates a single URL query parameter in place without triggering a Next.js
 * App Router RSC navigation round-trip or scroll reset.
 *
 * Next.js 15 patches `window.history.replaceState` so `useSearchParams()` stays
 * synchronously in sync on the client while avoiding the network/render flash
 * caused by `router.replace`.
 */
export function replaceUrlQueryParam(
  pathname: string,
  fallbackSearchParams: { toString(): string },
  key: string,
  value: string | null,
): string {
  const onSamePath =
    typeof window !== "undefined" && window.location.pathname === pathname
  const currentSearch = onSamePath
    ? window.location.search
    : fallbackSearchParams.toString()
  const nextParams = new URLSearchParams(currentSearch)
  if (value) {
    nextParams.set(key, value)
  } else {
    nextParams.delete(key)
  }
  const qs = nextParams.toString()
  const hash = onSamePath ? window.location.hash : ""
  const nextUrl = `${qs ? `${pathname}?${qs}` : pathname}${hash}`
  if (typeof window !== "undefined") {
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (currentUrl !== nextUrl) {
      // Pass `null` (not `window.history.state`): Next.js 15's patched
      // `replaceState` skips router/useSearchParams sync when `data.__NA` is
      // present, and copies its internal tree markers automatically for `null`.
      window.history.replaceState(null, "", nextUrl)
    }
  }
  return nextUrl
}
