// Cross-suite overlaps data layer for the model detail page.
//
// Builds one row per canonical benchmark from two populations:
//   (a) `benchmark_index[]` entries (already pre-filtered by `cleanHierarchy`
//       to canonicals appearing in ≥2 distinct families), resolving this
//       model's score in each appearance via `comparisonIndex`;
//   (b) the model's own summary benchmark groups for benchmarks that have no
//       benchmark_index entry (single family globally), merged in as
//       one-appearance rows when not already represented.
// A benchmark gets one row per measurement: sources are combined only when
// their readings are averageable (lib/headline-readings), and a source whose
// reading is not gets a row of its own. A source that reports a benchmark
// only through its parts stands in one row of its own, with the parts'
// mean when they are averageable and no number otherwise.
// Rows aggregate per canonical with mean, SD, and 95% CI from Student's-t
// (df=N-1). N=2 widths are very wide on purpose: with two samples we
// genuinely don't know the spread, and surfacing that beats fake precision.
// Single-appearance rows carry degenerate stats (stddev 0, no CI).

import type {
  BenchmarkIndexEntry,
  ComparisonIndex,
  ComparisonMetricEntry,
  ComparisonScoreEntry,
  RowAnnotations,
  ScaleConversion,
} from "./backend-artifacts"
import { isPercentUnit, isPhysicalQuantityUnit, isPlainQuantityUnit } from "./score-scale"
import {
  averageable,
  averageReadings,
  formatReading,
  onOneScale,
  type AverageableReading,
} from "./headline-readings"
import { getComparisonMetricKey } from "./metric-selection"

export type OverlapSourceKind = "comparison-index" | "summary"

/** One part of a benchmark a source reports only through its parts. */
export interface OverlapPart {
  evalSummaryId: string
  name: string
  metricName: string
  score: number
  displayScore: string
  unit: string | null
  statedUnitless?: boolean
  /** The model's rank on the part's own lead reading. */
  rank: { position: number; total: number } | null
}

export interface OverlapAppearance {
  familyKey: string
  familyName: string
  /** Empty on an appearance made of parts; see `parts`. */
  evalSummaryId: string
  metricSummaryId: string
  metricName: string
  /** The reading's metric id and direction; null on parts that are not one metric. */
  metricKey: string | null
  lowerIsBetter: boolean
  split: string | null
  /** NaN when the appearance is made of parts that are not averageable. */
  score: number
  displayScore: string
  unit: string | null
  statedUnitless?: boolean
  /** Set when the source reports the benchmark only through its parts:
   *  `score` is their mean when they are averageable. */
  parts?: OverlapPart[]
  /** The benchmark's parts the source also reports beside its own eval:
   *  listed under the appearance, never in its number. */
  ownEvalParts?: OverlapPart[]
  temperature?: number | null
  maxTokens?: number | null
  /** The study this appearance was reported under, the run's own protocol
   *  settings, and the benchmark family the study's rows sit under.
   *  Distinct from `maxTokens`, which is the generic generation argument:
   *  a study's token budget is a different quantity and is read through
   *  the study's own declared axes. */
  collectionId?: string | null
  protocolCondition?: string | null
  studyFamilyKey?: string | null
  annotations?: RowAnnotations | null
  /** "comparison-index" appearances have a per-eval leaderboard to link to;
   *  "summary" appearances come from the model's own result rows and don't. */
  sourceKind: OverlapSourceKind
  /** Producer canonical-scale fields off the comparison-index score cell
   *  (spec F5); undefined on old snapshots and summary-sourced appearances. */
  scoreCanonical?: number | null
  scaleConversion?: ScaleConversion | null
  /** Registry bounds off the owning metric entry (the scale
   *  `scoreCanonical` sits on); undefined pre-stamp / summary-sourced. */
  canonicalMinScore?: number | null
  canonicalMaxScore?: number | null
}

export interface OverlapRow {
  /** Unique per row; a benchmark with several measurements has several rows. */
  rowKey: string
  canonicalKey: string
  canonicalDisplayName: string
  appearances: OverlapAppearance[]
  mean: number
  stddev: number
  min: number
  max: number
  ci95: { low: number; high: number } | null
  /** Tagged 0-1 (proportion) vs 0-100 (percent) — drives display. */
  isPercentScale: boolean
  /** Set when every appearance shares a plain-quantity unit (Elo points,
   *  latency, cost…): scores are raw quantities in that unit and must never
   *  be %-formatted or ×100-harmonised. Null → percent-family display. */
  plainUnit: string | null
  /** True when every appearance is a stated-unitless secondary metric (e.g.
   *  signed bias score, word count): display raw numbers, never %. */
  statedUnitless?: boolean
}

/** One of the current model's own result rows, keyed by eval_summary_id.
 *  Used to backfill generation params / annotations onto comparison-index
 *  appearances whose score cells don't carry them (pre-regen snapshots). */
export interface OverlapSummaryJoinRow {
  evalSummaryId: string
  temperature: number | null
  maxTokens: number | null
  collectionId?: string | null
  protocolCondition?: string | null
  studyFamilyKey?: string | null
  annotations: RowAnnotations | null
}

/** A benchmark group from the model's own summary payload — the merge input
 *  for benchmarks without a benchmark_index entry. Carries the group's
 *  number (its own eval's lead reading, or its parts) plus every variant
 *  eval_summary_id so the merge can skip anything already represented. */
export interface OverlapSummaryCandidate {
  groupKey: string
  displayName: string
  evalSummaryIds: string[]
  familyKey: string
  familyName: string
  /** NaN for parts that are not averageable. */
  score: number
  unit: string | null
  statedUnitless?: boolean
  metricSummaryId: string
  metricName: string
  metricKey: string | null
  lowerIsBetter: boolean
  split: string | null
  /** Set when the group has no eval of its own; `score` is their mean. */
  parts?: Array<Omit<OverlapPart, "displayScore">>
  /** The group's parts beside its own eval, listed under its reading. */
  ownEvalParts?: Array<Omit<OverlapPart, "displayScore">>
  temperature: number | null
  maxTokens: number | null
  collectionId?: string | null
  protocolCondition?: string | null
  studyFamilyKey?: string | null
  annotations: RowAnnotations | null
}

export interface BuildOverlapRowsInput {
  benchmarkIndex: BenchmarkIndexEntry[] | null | undefined
  comparisonIndex: ComparisonIndex | null | undefined
  currentModelRouteId: string
  currentModelIdentityKeys: Set<string>
  familyDisplayByKey: Map<string, string>
  /** eval_summary_id -> the reading the model's row for that eval leads
   *  with (`EvaluationResult.is_lead_metric`). An eval the model has no row
   *  on has no entry and contributes no appearance. */
  leadReadings: Map<string, OverlapLeadReading>
  summaryCandidates?: OverlapSummaryCandidate[]
  summaryJoinRows?: OverlapSummaryJoinRow[]
}

/** The model's lead reading on one eval, as the overlaps builder needs it. */
export interface OverlapLeadReading {
  metricSummaryId: string
  split: string | null
  rank: { position: number; total: number } | null
  statedUnitless?: boolean
}

const tCrit95: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
  6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
  15: 2.131, 20: 2.086, 29: 2.045,
}

function tFor(df: number): number {
  if (df <= 0) return 12.706
  if (df >= 30) return 2.0
  const known = [29, 20, 15, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
  for (const k of known) if (df >= k) return tCrit95[k]
  return 12.706
}

export function formatPlainUnitScore(score: number, unit: string): string {
  const a = Math.abs(score)
  const v =
    a >= 100
      ? score.toFixed(0)
      : a >= 10
        ? score.toFixed(1)
        : a >= 0.1 || a === 0
          ? score.toFixed(2)
          : // Sub-0.1 physical quantities (per-task USD costs) must not
            // floor to "0.00" — keep two significant digits instead.
            score.toPrecision(2)
  return `${v} ${unit}`
}

/** The plain-display decision for one (score, unit) pair — see the trust
 *  classes on isPhysicalQuantityUnit/isPlainQuantityUnit: physical units
 *  are trusted at any magnitude, ambiguous score-like units only when the
 *  value sits outside fraction range. Null → percent-family display. */
function plainUnitFor(score: number, unit: string | null): string | null {
  if (!unit) return null
  if (isPhysicalQuantityUnit(unit)) return unit
  if (isPlainQuantityUnit(unit) && Math.abs(score) > 1.5) return unit
  return null
}

function formatHeuristicPercent(score: number, unit: string | null): string {
  const plain = plainUnitFor(score, unit)
  if (plain) return formatPlainUnitScore(score, plain)
  return isPercentUnit(unit) || score > 1.5
    ? `${score.toFixed(1)}%`
    : `${(score * 100).toFixed(1)}%`
}

function formatScalePercent(score: number, isPercentScale: boolean): string {
  return isPercentScale ? `${score.toFixed(1)}%` : `${(score * 100).toFixed(1)}%`
}

function readingOf(c: OverlapAppearance): AverageableReading {
  return {
    metricKey: c.metricKey,
    lowerIsBetter: c.lowerIsBetter,
    split: c.split,
    unit: c.unit,
    score: c.score,
    scoreCanonical: c.scoreCanonical,
    scaleConversion: c.scaleConversion,
    canonicalMinScore: c.canonicalMinScore,
    canonicalMaxScore: c.canonicalMaxScore,
  }
}

/** The names of the metrics a set of parts is reported on, in order. */
function partsMetricName(parts: Array<{ metricName: string }>): string {
  return Array.from(new Set(parts.map((part) => part.metricName).filter(Boolean))).join(", ")
}

/**
 * One row from appearances that are one measurement: mean, SD, 95% CI and
 * range on one scale. A lone appearance made of parts carries its own
 * number (their mean, or NaN when they have none).
 */
function overlapRowFrom(
  rowKey: string,
  canonicalKey: string,
  canonicalDisplayName: string,
  collected: OverlapAppearance[],
): OverlapRow {
  // One scale for the row's values, the same conversion every model-page
  // average uses (`onOneScale`): the producer's canonical scale, else the
  // shared unit as reported, else percent scaled from each unit. No value
  // is rescaled by its magnitude. Null for an appearance of parts with no
  // number, which keeps its NaN.
  const scale = onOneScale(collected.map(readingOf))
  const sameUnit = new Set(collected.map((c) => (c.unit ?? "").trim().toLowerCase())).size === 1
  const allStatedUnitless =
    collected.length > 0 && collected.every((c) => Boolean(c.statedUnitless) && !c.unit)
  let scaled: OverlapAppearance[]
  let useHigh: boolean
  let plainUnit: string | null = null
  let statedUnitless = false
  if (allStatedUnitless) {
    // Stated-unitless secondary metrics (signed bias scores, word counts, RTFx)
    // must keep their raw reported numbers even when the producer stamped
    // score_canonical / scale_conversion ("none" or bounded [-1, 1]).
    useHigh = false
    statedUnitless = true
    scaled = collected.map((c) => ({
      ...c,
      displayScore: Number.isFinite(c.score) ? formatReading(c.score, null) : "",
    }))
  } else if (scale && (scale.canonical || !sameUnit)) {
    useHigh = scale.unit === "percent"
    scaled = collected.map((c, i) => ({
      ...c,
      score: scale.values[i],
      displayScore: formatScalePercent(scale.values[i], useHigh),
    }))
  } else {
    // One unit, values as reported. Plain quantities (Elo, latency, cost…)
    // display in their unit; anything else is a percent or a proportion,
    // which only the display decides (a stated percent unit, else most
    // values above 1.5).
    const unit = collected[0]?.unit ?? null
    plainUnit =
      unit != null && collected.every((c) => plainUnitFor(c.score, unit) !== null) ? unit : null
    if (plainUnit) {
      const shownUnit = plainUnit
      useHigh = false
      scaled = collected.map((c) => ({ ...c, displayScore: formatPlainUnitScore(c.score, shownUnit) }))
    } else {
      const highCount = collected.filter((c) => Math.abs(c.score) > 1.5).length
      useHigh = isPercentUnit(unit) || highCount >= collected.length - highCount
      scaled = [...collected]
    }
  }
  const scores = scaled.map((s) => s.score)
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length
  const variance = scores.length > 1
    ? scores.reduce((a, b) => a + (b - mean) ** 2, 0) / (scores.length - 1)
    : 0
  const stddev = Math.sqrt(variance)
  const ci95 = scores.length >= 2
    ? {
        low: mean - tFor(scores.length - 1) * (stddev / Math.sqrt(scores.length)),
        high: mean + tFor(scores.length - 1) * (stddev / Math.sqrt(scores.length)),
      }
    : null
  return {
    rowKey,
    canonicalKey,
    canonicalDisplayName,
    appearances: scaled.sort((a, b) => b.score - a.score),
    mean,
    stddev,
    min: Math.min(...scores),
    max: Math.max(...scores),
    ci95,
    isPercentScale: useHigh,
    plainUnit,
    ...(statedUnitless ? { statedUnitless: true } : {}),
  }
}

/** The fields an appearance made of parts takes from them. */
function partsAppearanceFields(
  parts: Array<Omit<OverlapPart, "displayScore">>,
  readings: AverageableReading[],
): Pick<
  OverlapAppearance,
  "metricKey" | "lowerIsBetter" | "split" | "score" | "unit" | "statedUnitless" | "displayScore" | "parts" | "metricName"
> {
  const allPartsStatedUnitless =
    parts.length > 0 && parts.every((p) => Boolean(p.statedUnitless) && !p.unit)
  const effectiveReadings = allPartsStatedUnitless
    ? readings.map((r) => ({
        ...r,
        unit: null,
        scoreCanonical: undefined,
        scaleConversion: undefined,
      }))
    : readings
  const average = averageReadings(effectiveReadings)
  const score = average?.mean ?? Number.NaN
  const statedUnitless = Boolean(average) && allPartsStatedUnitless
  const unit = statedUnitless ? null : (average?.unit ?? null)
  return {
    metricKey: average ? (readings[0].metricKey ?? null) : null,
    lowerIsBetter: average ? Boolean(readings[0].lowerIsBetter) : false,
    split: null,
    score,
    unit,
    ...(statedUnitless ? { statedUnitless: true } : {}),
    displayScore: average
      ? statedUnitless
        ? formatReading(score, null)
        : formatHeuristicPercent(score, unit)
      : "",
    metricName: partsMetricName(parts),
    parts: withDisplay(parts),
  }
}

function withDisplay(parts: Array<Omit<OverlapPart, "displayScore">>): OverlapPart[] {
  return parts.map((part) => ({
    ...part,
    displayScore:
      part.statedUnitless && !part.unit
        ? formatReading(part.score, null)
        : formatHeuristicPercent(part.score, part.unit),
  }))
}

export function buildOverlapRows(input: BuildOverlapRowsInput): OverlapRow[] {
  const {
    benchmarkIndex,
    comparisonIndex,
    currentModelRouteId,
    currentModelIdentityKeys,
    familyDisplayByKey,
    leadReadings,
    summaryCandidates = [],
    summaryJoinRows = [],
  } = input

  const joinRowsByEvalId = new Map<string, OverlapSummaryJoinRow[]>()
  for (const row of summaryJoinRows) {
    if (!row.evalSummaryId) continue
    const list = joinRowsByEvalId.get(row.evalSummaryId)
    if (list) list.push(row)
    else joinRowsByEvalId.set(row.evalSummaryId, [row])
  }
  // The backfill join is only safe when the eval id maps to exactly one of
  // the model's own result rows — pooled metrics make fuzzier joins
  // mis-attribute, and wrong attribution is worse than "not reported".
  const uniqueJoinRow = (evalSummaryId: string): OverlapSummaryJoinRow | null => {
    const rows = joinRowsByEvalId.get(evalSummaryId)
    return rows && rows.length === 1 ? rows[0] : null
  }

  const out: OverlapRow[] = []
  // Eval ids whose llm-stats copy the aggregator dedup dropped: the copy is
  // accounted for by the row that dropped it, so the summary merge below
  // must not bring it back as a row of its own.
  const droppedAggregatorEvalIds = new Set<string>()

  if (benchmarkIndex && comparisonIndex) {
    // `by_model` is an optional acceleration: lookups must keep working off
    // the per-metric `scores[]` identity scan when the field is absent.
    const byModel = comparisonIndex.by_model?.[currentModelRouteId] ?? {}
    const findOwnScoreRow = (
      metric: ComparisonMetricEntry,
    ): ComparisonScoreEntry | null => {
      for (const row of metric.scores) {
        if (
          (currentModelIdentityKeys.has(row.model_route_id) ||
            currentModelIdentityKeys.has(row.model_group_id)) &&
          Number.isFinite(row.score)
        ) {
          return row
        }
      }
      return null
    }
    // Returns the score plus the producer canonical-scale fields off
    // whichever cell supplied it (by_model preferred, then scores[]).
    const lookupModelScore = (
      evalId: string,
      ownScoreRow: ComparisonScoreEntry | null,
      metric: ComparisonMetricEntry,
    ): { score: number; scoreCanonical?: number | null; scaleConversion?: ScaleConversion | null } | null => {
      const cell = byModel[evalId]?.[metric.metric_summary_id]
      if (cell != null && Number.isFinite(cell.score)) {
        return {
          score: cell.score,
          scoreCanonical: cell.score_canonical,
          scaleConversion: cell.scale_conversion,
        }
      }
      return ownScoreRow
        ? {
            score: ownScoreRow.score,
            scoreCanonical: ownScoreRow.score_canonical,
            scaleConversion: ownScoreRow.scale_conversion,
          }
        : null
    }

    for (const entry of benchmarkIndex) {
      const bestPerFamily = new Map<string, OverlapAppearance>()
      for (const appearance of entry.appearances ?? []) {
        const familyKey = appearance.family_key
        if (bestPerFamily.has(familyKey)) continue
        const familyName = familyDisplayByKey.get(familyKey) ?? familyKey
        // The model's lead reading on each of the appearance's evals.
        const found: Array<{ evalId: string; appearance: OverlapAppearance; benchmarkId: string | null; parentId: string | null; displayName: string; rank: OverlapLeadReading["rank"] }> = []
        for (const evalId of appearance.constituent_evaluation_ids ?? []) {
          const evalEntry = comparisonIndex.evals[evalId]
          if (!evalEntry) continue
          const lead = leadReadings.get(evalId)
          if (!lead) continue
          const targetMetric = evalEntry.metrics.find(
            (m) => m.metric_summary_id === lead.metricSummaryId,
          )
          if (!targetMetric) continue
          const ownScoreRow = findOwnScoreRow(targetMetric)
          const cellInfo = lookupModelScore(evalId, ownScoreRow, targetMetric)
          if (cellInfo == null || !Number.isFinite(cellInfo.score)) continue
          const score = cellInfo.score
          const unit = targetMetric.unit ?? null
          const statedUnitless = Boolean(lead.statedUnitless && !unit)
          // Generation params prefer the score cell; absent fields (old
          // snapshots) fall back to the unique-row summary join. A null on
          // the cell is authoritative ("not reported"), not absence.
          const fallback = uniqueJoinRow(evalId)
          const temperature =
            ownScoreRow && ownScoreRow.temperature !== undefined
              ? ownScoreRow.temperature
              : fallback
                ? fallback.temperature
                : null
          const maxTokens =
            ownScoreRow && ownScoreRow.max_tokens !== undefined
              ? ownScoreRow.max_tokens
              : fallback
                ? fallback.maxTokens
                : null
          found.push({
            evalId,
            benchmarkId: evalEntry.benchmark_id,
            parentId: evalEntry.parent_benchmark_id,
            displayName: evalEntry.display_name ?? evalId,
            rank: lead.rank,
            appearance: {
              familyKey,
              familyName,
              evalSummaryId: evalId,
              metricSummaryId: targetMetric.metric_summary_id,
              metricName: targetMetric.metric_name ?? "",
              metricKey: getComparisonMetricKey(targetMetric),
              lowerIsBetter: Boolean(targetMetric.lower_is_better),
              split: lead.split,
              score,
              displayScore: statedUnitless ? formatReading(score, null) : formatHeuristicPercent(score, unit),
              unit,
              ...(statedUnitless ? { statedUnitless: true } : {}),
              temperature,
              maxTokens,
              collectionId: fallback?.collectionId ?? null,
              protocolCondition: fallback?.protocolCondition ?? null,
              studyFamilyKey: fallback?.studyFamilyKey ?? null,
              annotations: fallback ? fallback.annotations : null,
              sourceKind: "comparison-index",
              scoreCanonical: cellInfo.scoreCanonical,
              scaleConversion: cellInfo.scaleConversion,
              canonicalMinScore: targetMetric.canonical_min_score,
              canonicalMaxScore: targetMetric.canonical_max_score,
            },
          })
        }
        if (found.length === 0) continue
        // The benchmark's own eval when the source reports it; else the
        // parts of the benchmark it reports; else the one eval it lists.
        const own = found.find((f) => f.benchmarkId === entry.key)
        const parts = found.filter((f) => f.parentId === entry.key)
        const partOf = (m: (typeof found)[number]) => ({
          evalSummaryId: m.evalId,
          name: m.displayName,
          metricName: m.appearance.metricName,
          score: m.appearance.score,
          unit: m.appearance.unit,
          ...(m.appearance.statedUnitless ? { statedUnitless: true } : {}),
          rank: m.rank,
        })
        if (own) {
          bestPerFamily.set(
            familyKey,
            parts.length > 0 ? { ...own.appearance, ownEvalParts: withDisplay(parts.map(partOf)) } : own.appearance,
          )
        } else if (parts.length === 0 && found.length === 1) {
          bestPerFamily.set(familyKey, found[0].appearance)
        } else {
          const members = parts.length > 0 ? parts : found
          const first = members[0].appearance
          const shared = <K extends "temperature" | "maxTokens">(key: K) =>
            members.every((m) => m.appearance[key] === first[key]) ? first[key] : null
          bestPerFamily.set(familyKey, {
            ...first,
            temperature: shared("temperature"),
            maxTokens: shared("maxTokens"),
            annotations: null,
            evalSummaryId: "",
            metricSummaryId: "",
            scoreCanonical: undefined,
            scaleConversion: undefined,
            canonicalMinScore: undefined,
            canonicalMaxScore: undefined,
            ...partsAppearanceFields(
              members.map(partOf),
              members.map((m) => readingOf(m.appearance)),
            ),
          })
        }
      }
      // Two-stage dedup:
      //   1. Drop duplicate constituent_evaluation_ids — benchmark_index can list
      //      the same eval under multiple family_keys (e.g.
      //      `artificial-analysis-llms/mmlu-pro` is listed under both
      //      `artificial-analysis` and `mmlu`), but that's the same
      //      observation, not two independent reports.
      //   2. Aggregator-only score dedup — llm-stats republishes
      //      canonical sources' numbers, so when its score byte-equals
      //      an independent evaluator's on the same metric, split and
      //      unit we drop the llm-stats copy. Two independent evaluators that happen to
      //      arrive at the same number are KEPT — confirming signal, not
      //      duplicate data.
      const allRaw = Array.from(bestPerFamily.values())
      const isAggregator = (familyKey: string) => familyKey === "llm-stats"
      const seenEvalIds = new Set<string>()
      const distinctByEvalId: OverlapAppearance[] = []
      for (const c of allRaw) {
        const id = c.parts ? `parts:${c.parts.map((p) => p.evalSummaryId).join(",")}` : c.evalSummaryId
        if (seenEvalIds.has(id)) continue
        seenEvalIds.add(id)
        distinctByEvalId.push(c)
      }
      // Process non-aggregators first so their scores populate the
      // seen-set before any llm-stats appearance gets a chance to claim
      // the score.
      distinctByEvalId.sort((a, b) => {
        const aAgg = isAggregator(a.familyKey) ? 1 : 0
        const bAgg = isAggregator(b.familyKey) ? 1 : 0
        return aAgg - bAgg
      })
      const seenScores = new Set<string>()
      const collected: OverlapAppearance[] = []
      for (const c of distinctByEvalId) {
        // The same measurement: one metric, split, unit and value.
        const scoreKey = JSON.stringify([c.metricKey, c.split, (c.unit ?? "").trim().toLowerCase(), c.score])
        if (!c.parts && isAggregator(c.familyKey) && seenScores.has(scoreKey)) {
          droppedAggregatorEvalIds.add(c.evalSummaryId)
          continue
        }
        if (!c.parts) seenScores.add(scoreKey)
        collected.push(c)
      }
      if (collected.length < 1) continue

      // One row per measurement: a source joins the first row its reading
      // is averageable with; parts always stand alone.
      const measurements: OverlapAppearance[][] = []
      for (const c of collected) {
        const home = c.parts
          ? undefined
          : measurements.find(
              (m) => !m[0].parts && averageable([...m, c].map(readingOf)),
            )
        if (home) home.push(c)
        else measurements.push([c])
      }
      for (const m of measurements) {
        const named = measurements.length > 1
        out.push(
          overlapRowFrom(
            named ? `${entry.key}::${m[0].familyKey}` : entry.key,
            entry.key,
            named ? `${entry.display_name} · ${m[0].metricName}` : entry.display_name,
            m,
          ),
        )
      }
    }
  }

  // Merge population (b): benchmark groups with no benchmark_index entry.
  // Dedup key is eval_summary_id — a candidate is skipped when ANY of its
  // variant ids is already represented (group keys can be synthesized parent
  // ids for slice-folded groups, so they aren't reliable here).
  const representedEvalIds = new Set<string>(droppedAggregatorEvalIds)
  for (const row of out) {
    for (const a of row.appearances) {
      if (a.evalSummaryId) representedEvalIds.add(a.evalSummaryId)
      for (const part of [...(a.parts ?? []), ...(a.ownEvalParts ?? [])]) representedEvalIds.add(part.evalSummaryId)
    }
  }
  for (const c of summaryCandidates) {
    if (!c.parts && !Number.isFinite(c.score)) continue
    const ids = c.evalSummaryIds.filter(Boolean)
    if (ids.some((id) => representedEvalIds.has(id))) continue
    for (const id of ids) representedEvalIds.add(id)
    const partsFields = c.parts
      ? { evalSummaryId: "", parts: withDisplay(c.parts) }
      : {
          evalSummaryId: ids[0] ?? "",
          ...(c.ownEvalParts?.length ? { ownEvalParts: withDisplay(c.ownEvalParts) } : {}),
        }
    const statedUnitless = Boolean(c.statedUnitless && !c.unit)
    out.push(
      overlapRowFrom(c.groupKey, c.groupKey, c.displayName, [
        {
          familyKey: c.familyKey,
          familyName: c.familyName,
          metricSummaryId: c.metricSummaryId,
          metricName: c.metricName,
          metricKey: c.metricKey,
          lowerIsBetter: c.lowerIsBetter,
          split: c.split,
          score: c.score,
          displayScore: Number.isFinite(c.score)
            ? statedUnitless
              ? formatReading(c.score, null)
              : formatHeuristicPercent(c.score, c.unit)
            : "",
          unit: c.unit,
          ...(statedUnitless ? { statedUnitless: true } : {}),
          temperature: c.temperature,
          maxTokens: c.maxTokens,
          collectionId: c.collectionId ?? null,
          protocolCondition: c.protocolCondition ?? null,
          studyFamilyKey: c.studyFamilyKey ?? null,
          annotations: c.annotations,
          sourceKind: "summary",
          ...partsFields,
        },
      ]),
    )
  }

  // A single-appearance row whose eval already backs a multi-source row is
  // the same observation resurfacing through a subset-shaped benchmark_index
  // entry (e.g. aime-2024 listing one of aime's constituent evals) — keep
  // only the multi-source row.
  const multiRowEvalIds = new Set<string>()
  for (const row of out) {
    if (row.appearances.length < 2) continue
    for (const a of row.appearances) {
      if (a.evalSummaryId) multiRowEvalIds.add(a.evalSummaryId)
    }
  }
  const rows = out.filter(
    (row) =>
      row.appearances.length >= 2 ||
      !multiRowEvalIds.has(row.appearances[0]?.evalSummaryId ?? ""),
  )

  // Row-level dedup: when two benchmark_index entries resolve to the
  // exact same set of (familyKey, score) appearances, they're aliases
  // of the same canonical (e.g. AIME vs aime-2025 both resolving to
  // {Vals.ai 12.9%, Artificial Analysis 11.7%}). Collapse to one row.
  // Tie-break on the shorter / cleaner canonical key — the longer
  // alias is usually the year-suffixed or otherwise-disambiguated
  // variant. Single-appearance rows are exempt from the score
  // signature (two unrelated benchmarks from the same family can land
  // on the same number); they collapse only when they point at the
  // very same eval, or the very same parts.
  const dedupSig = (row: OverlapRow) => {
    if (row.appearances.length >= 2) {
      return row.appearances
        .map((a) => `${a.familyKey}::${a.score.toFixed(8)}`)
        .sort()
        .join("|")
    }
    const only = row.appearances[0]
    if (only?.parts) return `parts::${only.parts.map((p) => p.evalSummaryId).join(",")}`
    return `single::${only?.evalSummaryId || row.rowKey}`
  }
  const bestBySig = new Map<string, OverlapRow>()
  for (const row of rows) {
    const sig = dedupSig(row)
    const prev = bestBySig.get(sig)
    if (
      !prev ||
      row.canonicalKey.length < prev.canonicalKey.length ||
      (row.canonicalKey.length === prev.canonicalKey.length &&
        row.canonicalDisplayName.localeCompare(prev.canonicalDisplayName) < 0)
    ) {
      bestBySig.set(sig, row)
    }
  }
  const deduped = Array.from(bestBySig.values())
  deduped.sort(
    (a, b) =>
      b.appearances.length - a.appearances.length ||
      a.canonicalDisplayName.localeCompare(b.canonicalDisplayName),
  )
  return deduped
}

/** Rows where the model has ≥2 independent appearances — the population the
 *  view used to be limited to, and what the tab default keys on. */
export function countMultiSourceRows(rows: OverlapRow[]): number {
  let n = 0
  for (const row of rows) if (row.appearances.length >= 2) n += 1
  return n
}
