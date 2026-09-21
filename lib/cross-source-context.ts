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
    const subjectRow =
      modelRows.find((row) => row.sourceSlug === subjectSlug) ?? modelRows[0]
    const others = modelRows.filter((row) => row !== subjectRow)

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
