import type { ScaleConversion } from "./backend-artifacts"
import { mergeRegistryBounds, resolveCanonicalScaleGroup, scaleOnto, type CanonicalScaleCell } from "./score-scale"

/**
 * Helpers for the numbers a model page shows for a benchmark.
 *
 * Which reading an eval's row leads with is not decided here: view-data
 * flags it on the row (`EvaluationResult.is_lead_metric`). What is decided
 * here is the one rule for combining readings: when several may be
 * averaged into one number.
 */
export interface HeadlineReadingKeys {
  /** `eval_results_view.metric_id` of the reading. */
  metricKey?: string | null
  /** `evals_view.primary_metric_id` of the eval the reading belongs to. */
  primaryMetricId?: string | null
}

function isPrimaryReading(keys: HeadlineReadingKeys): boolean {
  return Boolean(keys.primaryMetricId) && keys.metricKey === keys.primaryMetricId
}

/** One reading as the averageable rule sees it. */
export interface AverageableReading {
  /** `eval_results_view.metric_id` (`metric_key` on the frontend). */
  metricKey: string | null | undefined
  lowerIsBetter: boolean | null | undefined
  /** The dataset split the source states; absent when it states none. */
  split?: string | null
  unit: string | null | undefined
  score: number
  /** Producer canonical-scale fields; absent on snapshots without them. */
  scoreCanonical?: number | null
  scaleConversion?: ScaleConversion | null
  /** Registry bounds of the metric `scoreCanonical` sits on. */
  canonicalMinScore?: number | null
  canonicalMaxScore?: number | null
}

const normalizedUnit = (unit: string | null | undefined) => (unit ?? "").trim().toLowerCase()

/** True for "percent", false for "proportion", null for any other unit.
 *  Exact names: the snapshot's vocabulary also has "percentage_points",
 *  a difference rather than a level. */
function percentUnit(unit: string | null | undefined): boolean | null {
  const u = normalizedUnit(unit)
  return u === "percent" ? true : u === "proportion" ? false : null
}

const onePercentOrProportion = (readings: AverageableReading[]) =>
  readings.every((reading) => percentUnit(reading.unit) != null)

function scaleCell(reading: AverageableReading): CanonicalScaleCell {
  return {
    score: reading.score,
    scoreCanonical: reading.scoreCanonical,
    scaleConversion: reading.scaleConversion,
    unit: reading.unit ?? null,
  }
}

function canonicalScaleGroup(readings: AverageableReading[]) {
  return resolveCanonicalScaleGroup(
    readings.map(scaleCell),
    mergeRegistryBounds(
      readings.map((reading) => ({ min: reading.canonicalMinScore, max: reading.canonicalMaxScore })),
    ),
  )
}

/**
 * Whether readings are one measurement and so may be averaged: the same
 * metric id, the same direction, the same split where they state one, and
 * one scale: one unit, the producer's canonical scale (it puts readings of
 * one metric onto its registry scale), or percent and proportion, which
 * differ by a factor of 100. Nothing else may be averaged.
 */
export function averageable(readings: AverageableReading[]): boolean {
  if (readings.length === 0) return false
  const [first] = readings
  if (!first.metricKey) return false
  const splits = new Set<string>()
  for (const reading of readings) {
    if (reading.metricKey !== first.metricKey) return false
    if (Boolean(reading.lowerIsBetter) !== Boolean(first.lowerIsBetter)) return false
    if (!Number.isFinite(reading.score)) return false
    if (reading.split) splits.add(reading.split)
  }
  if (splits.size > 1) return false
  if (readings.length === 1) return true
  if (new Set(readings.map((reading) => normalizedUnit(reading.unit))).size === 1) return true
  return canonicalScaleGroup(readings) != null || onePercentOrProportion(readings)
}

/**
 * Averageable readings' values on one scale, in the readings' order:
 *   1. the producer's canonical scale when it resolves, shown as a percent
 *      or a proportion (percent when percent sources are at least as many,
 *      the "Scores" table's convention);
 *   2. else the readings' shared unit, values as reported;
 *   3. else percent, each value scaled from its own unit (percent or
 *      proportion).
 * No value is ever rescaled by its magnitude. Null when the readings are
 * not averageable.
 */
export function onOneScale(
  readings: AverageableReading[],
): { values: number[]; unit: string | null; canonical: boolean } | null {
  if (!averageable(readings)) return null
  const group = canonicalScaleGroup(readings)
  if (group) {
    const percent = group.percentSourceCount >= group.fractionSourceCount
    return {
      values: readings.map((reading) => group.toDisplay(scaleCell(reading), percent)),
      unit: percent ? "percent" : "proportion",
      canonical: true,
    }
  }
  if (new Set(readings.map((reading) => normalizedUnit(reading.unit))).size === 1) {
    return { values: readings.map((reading) => reading.score), unit: readings[0].unit ?? null, canonical: false }
  }
  return {
    values: readings.map((reading) => scaleOnto(reading.score, percentUnit(reading.unit)!, true)),
    unit: "percent",
    canonical: false,
  }
}

function trimmed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, "")
}

/**
 * One reading as text, on the unit it states: percent as reported with
 * "%", proportion ×100 with "%" (the one conversion `averageable` allows),
 * any other unit as reported followed by that unit, and no unit as
 * reported. Never rescaled by its magnitude or by a guess at what a unit
 * name means.
 */
export function formatReading(score: number, unit: string | null | undefined): string {
  const percent = percentUnit(unit)
  if (percent != null) {
    const value = scaleOnto(score, percent, true)
    return `${trimmed(value, Math.abs(value) < 10 ? 2 : 1)}%`
  }
  const u = (unit ?? "").trim()
  return u ? `${trimmed(score, 3)} ${u}` : trimmed(score, 3)
}

/** The mean of averageable readings on the scale `onOneScale` puts them on;
 *  null when they are not averageable. */
export function averageReadings(
  readings: AverageableReading[],
): { mean: number; unit: string | null } | null {
  const scaled = onOneScale(readings)
  return scaled ? { mean: mean(scaled.values), unit: scaled.unit } : null
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** `avg of N parts`, or `1 part` for a single part. */
export function partsMeanLabel(count: number): string {
  return count === 1 ? "1 part" : `avg of ${count} parts`
}

/** `N parts`, printed where a group with no number would show one. */
export function partsCountLabel(count: number): string {
  return count === 1 ? "1 part" : `${count} parts`
}

/**
 * The unit of one reading on a model page.
 *
 * `evals_view.metric_config` describes the eval's primary metric, so its
 * unit stands in for a reading's missing unit only when the reading is on
 * that metric. A bias score reported beside an accuracy is not a
 * "proportion" because the accuracy is. When the row names no primary
 * metric the eval's unit is the only one on offer and is kept.
 */
export function readingUnit(
  ownUnit: string | undefined,
  evalUnit: string | undefined,
  keys: HeadlineReadingKeys,
): string | undefined {
  if (ownUnit) return ownUnit
  return !keys.primaryMetricId || isPrimaryReading(keys) ? evalUnit : undefined
}
