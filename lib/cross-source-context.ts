/**
 * Cross-source context: one model's score on this page, placed among the
 * other sources' measurements of the same model on the same benchmark.
 *
 * The curated `collection_context.json` sidecar does this for one study
 * (uk-aisi-inference-scaling / terminal-bench-2 — the only entry the producer
 * bakes today) with extras only a study has: scaffold names per point,
 * harvest dates, an official task count, a with-oracle companion mark.
 *
 * The same QUESTION is answerable for any benchmark two sources both measured,
 * out of data the warehouse already joins: 3,559 of 72,052 (benchmark, model)
 * cells carry two or more sources, spread across 250 of 1,218 benchmarks. This
 * builds the thinner payload for those, so the plot is not stranded on a
 * single page.
 *
 * It answers a DIFFERENT question from the study version, and callers must
 * label it as such: "is this source's number an outlier?", not "what did
 * inference budget do to this score?". Hence `subjectLabel`.
 */
import type { ScaffoldContextModel, ScaffoldContextPayload } from "@/lib/collections"
import type { MergedBenchmarkSummary } from "@/lib/eval-processing"
import { convertedRows } from "@/lib/merged-adapter"

export interface CrossSourceRow {
  /** Stable model identity — the same key across sources. */
  modelKey: string
  displayName: string
  score: number
  scoreSe?: number | null
  nTasks?: number | null
  /** Which source reported it; rows sharing a slug are one source. */
  sourceSlug: string
  sourceLabel: string
  runDate?: string | null
}

export interface CrossSourceContextOptions {
  /**
   * The source this page speaks for. Its rows become each model's own mark
   * and every other source becomes a comparison point. Omit on a merged page,
   * where no single source is the subject: the best-covered source is then
   * the reference, so the strips have a consistent anchor.
   */
  subjectSourceSlug?: string
  /** "This source" / "This study" — what the subject mark is called. */
  subjectLabel?: string
  /** Captions name what is being compared. */
  benchmarkLabel?: string
  sourceLabel?: string
}

/** Models with nothing to compare against are dropped, not drawn empty: a
 *  strip with a single mark implies a comparison that was never made. */
const MIN_COMPARISON_POINTS = 1

/**
 * Build a `ScaffoldContextPayload` from rows spanning several sources.
 * Returns null when no model on the page has another source to sit against,
 * which is the common case and is why the view stays hidden by default.
 */
export function buildCrossSourceContext(
  rows: readonly CrossSourceRow[],
  options: CrossSourceContextOptions = {},
): ScaffoldContextPayload | null {
  const usable = rows.filter((row) => Number.isFinite(row.score) && row.modelKey)
  if (usable.length === 0) return null

  const byModel = new Map<string, CrossSourceRow[]>()
  for (const row of usable) {
    byModel.set(row.modelKey, [...(byModel.get(row.modelKey) ?? []), row])
  }

  // On a merged page no source is "this" one. Anchoring every strip to the
  // same source keeps them comparable down the column; picking the one with
  // the widest coverage keeps the most strips anchored at all.
  const subjectSlug =
    options.subjectSourceSlug ?? widestCoverageSource(usable) ?? undefined

  const models: ScaffoldContextModel[] = []
  const modelsWithoutContext: string[] = []

  for (const [modelKey, modelRows] of byModel) {
    const subjectRow = modelRows.find((row) => row.sourceSlug === subjectSlug)
    // A model the subject source never measured has no mark of its own,
    // and drawing another source's reading in its place would put that
    // source's number under this page's label.
    if (!subjectRow) continue
    // Whatever else the subject source published for this model is still
    // this page speaking, not somebody else measuring it.
    const others = modelRows.filter((row) => row.sourceSlug !== subjectRow.sourceSlug)

    if (others.length < MIN_COMPARISON_POINTS) {
      modelsWithoutContext.push(subjectRow.displayName)
      continue
    }

    models.push({
      key: modelKey,
      displayName: subjectRow.displayName,
      score: subjectRow.score,
      scoreSe: subjectRow.scoreSe ?? null,
      nTasks: subjectRow.nTasks ?? 0,
      // Bands are legacy study instrumentation and are never rendered;
      // attempts are a trajectory-pool fact a plain cross-source
      // comparison does not have. 0 is the shipped "not recorded" value.
      attemptsMin: 0,
      attemptsMax: 0,
      assisted: null,
      points: others
        .map((row) => ({
          scaffold: null,
          source: row.sourceLabel,
          score: row.score,
          scoreSe: row.scoreSe ?? null,
          runDate: row.runDate ?? null,
        }))
        .sort((a, b) => a.score - b.score),
      hiddenCount: 0,
      conditionDiffersFromBestScoring: false,
    })
  }

  if (models.length === 0) return null

  // Best-covered model first: the reader meets the strip with the most to
  // say before the sparse ones.
  models.sort((a, b) => b.points.length - a.points.length)

  const sources = new Map<string, string>()
  for (const row of usable) sources.set(row.sourceSlug, row.sourceLabel)

  const sourceList = [...sources].map(([id, display_name]) => ({ id, display_name }))

  return {
    // Study-only instrumentation. Empty rather than invented: the captions
    // that read these degrade to saying nothing, which is correct here.
    harvestedAt: "",
    officialTaskCount: 0,
    hiddenTotal: 0,
    contextSources: sourceList,
    contextSourceDisplay: sourceList.map((s) => s.display_name).join(", "),
    benchmarkLabel: options.benchmarkLabel ?? "",
    collectionLabel: options.sourceLabel ?? "",
    models,
    modelsWithoutContext,
    modelsWithoutAssisted: [],
    subjectLabel: options.subjectLabel ?? "This source",
  }
}

/**
 * Whether a merged payload answers the same question the page does.
 *
 * A merged payload is already one metric, one benchmark and one grain, so
 * it is the payload as a whole that either matches the page or does not:
 * a different metric, a benchmark the id resolved to by another route, or
 * one slice's rows standing in for the whole benchmark all put two
 * different measurements on one axis. Mismatch means no strip rather than
 * a strip with a footnote.
 */
export function mergedPayloadIsComparable(
  merged: Pick<MergedBenchmarkSummary, "benchmark_id" | "selected_metric_id" | "grain">,
  page: { benchmarkId: string; metricId: string },
): boolean {
  return (
    merged.benchmark_id === page.benchmarkId &&
    merged.selected_metric_id === page.metricId &&
    merged.grain === "benchmark"
  )
}

/**
 * The merged payload's observations as comparison rows, one per (source,
 * model).
 *
 * `convertedRows` is the merged page's own pool, and the three things it
 * drops are the three that would each be a measurement this is not: a
 * non-headline row (a losing judge panel or protocol arm is another
 * reading of one cell, not another run), an answer-feedback row (a score
 * reached by being told when the answer was right), and a row the
 * producer could not put on the canonical scale (a published number on a
 * scale of its own).
 *
 * Echo republications survive that pool by design, because the merged
 * page wants them visible, so the first reading each source gives a model
 * is the one kept. A source disagreeing with itself is still one source,
 * and the merged query has already ordered its rows by canonical score in
 * the metric's direction.
 */
export function crossSourceRowsFromMerged(merged: MergedBenchmarkSummary): CrossSourceRow[] {
  const seen = new Set<string>()
  const rows: CrossSourceRow[] = []
  for (const observation of convertedRows(merged)) {
    const modelKey =
      observation.model_key ?? observation.model_route_id ?? observation.model_info?.id ?? ""
    const sourceSlug = observation.composite_slug ?? ""
    if (!modelKey || !sourceSlug) continue
    const reading = `${sourceSlug}\u0000${modelKey}`
    if (seen.has(reading)) continue
    seen.add(reading)
    rows.push({
      modelKey,
      displayName: observation.model_info?.name ?? modelKey,
      score: observation.score_canonical as number,
      sourceSlug,
      sourceLabel: observation.composite_display_name ?? sourceSlug,
      runDate: observation.evaluation_timestamp ?? null,
    })
  }
  return rows
}

/** The source reporting the most models here. Ties break on slug so the
 *  anchor does not wander between renders. */
function widestCoverageSource(rows: readonly CrossSourceRow[]): string | null {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.sourceSlug, (counts.get(row.sourceSlug) ?? 0) + 1)
  let best: string | null = null
  let bestCount = -1
  for (const [slug, count] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) {
      best = slug
      bestCount = count
    }
  }
  return best
}
