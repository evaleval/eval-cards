/**
 * Adapters for the merged-benchmark payload (`{ merged: true, ... }` from
 * /api/eval-summary for single-segment ids — merged-benchmark-view spec F1).
 *
 * `fetchEvalSummary` runs every payload through
 * `mergedSummaryToEvalSummary`, so legacy consumers — the embed
 * leaderboard / distribution / frontier pages in particular — render
 * merged ids without their own wiring. The merged page
 * (components/merged-benchmark-view) fetches the raw payload via
 * `fetchMergedBenchmarkSummary` (for the source/metric/slice controls and
 * disclosure notes) and adapts it through here to mount the full
 * EvalDetail experience at merged grain.
 *
 * Client-safe: types only, no server imports.
 */

import type {
  BenchmarkEvalSummary,
  MergedBenchmarkSummary,
  MergedObservationRow,
} from "@/lib/eval-processing"
import { isAssistedResult, isHeadlineResult } from "@/lib/eval-processing"
import type { ProtocolAxesByCollection, StudyRef } from "@/lib/collections"
import type { MetricConfig, SourceData } from "@/lib/benchmark-schema"

export function isMergedBenchmarkSummary(payload: unknown): payload is MergedBenchmarkSummary {
  return (
    payload != null &&
    typeof payload === "object" &&
    (payload as { merged?: unknown }).merged === true
  )
}

/**
 * Rows eligible for the default merged pool: unassisted observations with
 * a score on the metric's registry canonical scale. Assisted conditions
 * belong on their source study's dedicated views, where their protocol is
 * explicit; treating them as ordinary all-sources observations would make
 * the merged comparison misleading.
 *
 * Flagged rows (score_canonical null — the producer could not safely
 * convert the raw score) are also excluded from the leaderboard,
 * distribution pool, average, and bounds inference. Pooling raw
 * unconverted numbers with canonical ones would rank apples against
 * oranges (e.g. a raw 1.42 outranking a true 0.85 best).
 *
 * Non-headline rows (a losing judge panel or protocol arm) are excluded
 * too — the merged page pools ONE observation per (model,
 * source), and a model's three judge readings are not three sources.
 */
export function convertedRows(merged: MergedBenchmarkSummary): MergedObservationRow[] {
  return merged.results.filter(
    (row) =>
      isHeadlineResult(row) &&
      !isAssistedResult(row.protocol_condition) &&
      row.score_canonical != null &&
      Number.isFinite(row.score_canonical),
  )
}

/**
 * Reshape a merged payload into the BenchmarkEvalSummary surface legacy
 * consumers read: `model_results` at observation grain plus a
 * single-column `leaderboard_metrics`/`leaderboard_rows` matrix keyed by
 * the selected metric id. Observation rows are NOT deduped by model
 * identity — echoes stay visible (spec design pt 3).
 */
export function mergedSummaryToEvalSummary(merged: MergedBenchmarkSummary): BenchmarkEvalSummary {
  const columnKey = merged.selected_metric_id || merged.preferred_metric_id || "score"
  const selectedMetric = merged.metrics.find((m) => m.metric_id === columnKey)
  const metricDisplayName =
    selectedMetric?.display_name ??
    (columnKey === merged.preferred_metric_id ? merged.preferred_metric_display_name : columnKey)

  const rows = convertedRows(merged)

  // Reporting identity comes from the ROWS. A source's composite display
  // name is the title of a leaderboard or a paper ("How Inference Compute
  // Shapes Frontier LLM Evaluation"), never an organisation, and reading
  // it as an evaluator both misattributes the work and links a title to
  // an evaluator page that does not exist.
  //
  // Trim before falling back, or a whitespace-only de-aliased name hides
  // a perfectly good source organisation.
  const evaluatorOf = (row: MergedObservationRow): string =>
    row.evaluator_display_name?.trim() ||
    row.source_metadata?.source_organization_name?.trim() ||
    ""
  // Ordered by how much of the page each org reported, then by name. Row
  // order alone is not deterministic (equal scores for one model have no
  // source tie-break in the query), and the hero shows only the first two
  // names, so the two it shows are the page's main reporters.
  const orderedReporters = (pool: MergedObservationRow[]): string[] => {
    const counts = new Map<string, number>()
    for (const row of pool) {
      const name = evaluatorOf(row)
      if (!name) continue
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .sort(([nameA, countA], [nameB, countB]) => countB - countA || nameA.localeCompare(nameB))
      .map(([name]) => name)
  }
  const evaluatorNames = orderedReporters(rows)
  const verifiedEvaluatorNames = orderedReporters(
    rows.filter((row) => row.is_verified_evaluator),
  )

  // Study attribution and axis descriptors, resolved per row from the
  // collections sidecar the merged payload carries. Deliberately NOT the
  // `collection` attachment: that one gates the Compute chip and the
  // trajectory panels, which belong to a per-source study page.
  const collectionIds = Array.from(
    new Set(rows.map((row) => row.collection_id).filter((id): id is string => Boolean(id))),
  )
  const studyRefs: StudyRef[] = []
  const protocolAxesByCollection: ProtocolAxesByCollection = {}
  for (const id of collectionIds) {
    const entry = merged.collections?.[id]
    if (!entry?.curated) continue
    if (entry.display_name) {
      // The family the study's own rows on this page sit under. A merged
      // page pools several sources, so only the rows belonging to THIS
      // study are asked; when they disagree there is no single listing
      // to send the reader to and the name stays plain text.
      const families = new Set(
        rows
          .filter((row) => row.collection_id === id)
          .map((row) => row.composite_slug)
          .filter((slug): slug is string => Boolean(slug)),
      )
      studyRefs.push({
        collection_id: id,
        name: entry.display_name,
        url: entry.url,
        family_key: families.size === 1 ? [...families][0] : undefined,
      })
    }
    if (entry.protocol_axes?.length) protocolAxesByCollection[id] = entry.protocol_axes
  }

  // Infer canonical-scale bounds from the pooled canonical scores so
  // score bars / normalisation in EvalDetail behave: prefer the
  // conventional 0–1 and 0–100 scales when every score fits, else fall
  // back to the data range (rounded to whole numbers for display —
  // "0 – 1620", not "0 – 1619.7821…"). The merged payload doesn't carry
  // declared bounds; scores are already on the registry canonical scale.
  const canonicalScores = rows.map((row) => row.score_canonical as number)
  let bounds: Pick<MetricConfig, "min_score" | "max_score"> = {}
  if (canonicalScores.length > 0) {
    const lo = Math.min(...canonicalScores)
    const hi = Math.max(...canonicalScores)
    if (lo >= 0 && hi <= 1) bounds = { min_score: 0, max_score: 1 }
    else if (lo >= 0 && hi <= 100) bounds = { min_score: 0, max_score: 100 }
    else bounds = { min_score: Math.min(0, Math.floor(lo)), max_score: Math.ceil(hi) }
  }

  const metricConfig: MetricConfig = {
    evaluation_description: `${metricDisplayName} — merged across ${
      selectedMetric?.sources_count ?? merged.sources_count
    } sources`,
    lower_is_better: merged.selected_lower_is_better,
    score_type: "continuous",
    ...bounds,
  }

  // Each row keeps its own upstream provenance: the repo, url, version
  // and sample count differ per source, and replacing them all with the
  // benchmark's name throws away what the row actually came from. The
  // benchmark name stands in only for a row that carries nothing.
  const fallbackSourceData: SourceData = { dataset_name: merged.display_name }
  const sourceDataOf = (row: MergedObservationRow): SourceData =>
    row.source_data && Object.keys(row.source_data).length > 0
      ? row.source_data
      : fallbackSourceData

  const model_results = rows.map((row) => {
    const score = row.score_canonical as number
    const sourceData = sourceDataOf(row)
    return {
      model_info: row.model_info,
      model_route_id: row.model_route_id,
      score,
      score_details: { score },
      evaluation_timestamp: row.evaluation_timestamp,
      source_metadata: row.source_metadata,
      source_data: sourceData,
      merged_source_slug: row.composite_slug,
      is_verified_evaluator: row.is_verified_evaluator,
      evaluator_display_name: row.evaluator_display_name,
      collection_id: row.collection_id,
      eval_library: row.eval_library,
      protocol_condition: row.protocol_condition,
      judge_condition: row.judge_condition,
      is_headline: row.is_headline,
      metric_source_label: row.metric_source_label,
      comparability_status: row.comparability_status,
      scoring_mode: row.scoring_mode,
      score_published: row.score_published,
      result: {
        evaluation_name: metricDisplayName,
        display_name: metricDisplayName,
        metric_key: columnKey,
        evaluation_timestamp: row.evaluation_timestamp,
        source_data: sourceData,
        metric_config: metricConfig,
        score_details: { score },
        generation_config: row.generation_config,
        is_verified_evaluator: row.is_verified_evaluator,
      },
    }
  })

  const leaderboard_rows = rows.map((row) => ({
    model_info: row.model_info,
    model_route_id: row.model_route_id,
    evaluation_timestamp: row.evaluation_timestamp,
    source_metadata: row.source_metadata,
    source_data: sourceDataOf(row),
    values: { [columnKey]: row.score_canonical as number },
    verified: row.is_verified_evaluator ? { [columnKey]: true } : undefined,
    metrics_present: 1,
  }))

  const scores = model_results
    .map((r) => r.score)
    .filter((s): s is number => Number.isFinite(s))
  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0

  // Best model comes from the visible pool itself. The producer's raw
  // best_result may describe an assisted or unconvertible observation;
  // the merged query returns rows best-first in the metric's direction.
  const bestModel = rows.length > 0
    ? { name: rows[0].model_info.name, score: rows[0].score_canonical as number }
    : null

  return {
    evaluation_id: merged.evaluation_id,
    evaluation_name: merged.display_name,
    judge_display_names: merged.judge_display_names,
    canonical_display_name: merged.display_name,
    benchmark_id: merged.benchmark_id,
    composite_benchmark_key: merged.benchmark_id,
    composite_benchmark_name: merged.display_name,
    family_id: merged.family_id ?? undefined,
    family_display_name: merged.family_display_name ?? undefined,
    benchmark_family_name: merged.family_display_name ?? undefined,
    derived_tags: [],
    metric_config: metricConfig,
    model_results,
    // Distinct models among the rows actually SHOWN (flagged rows are
    // excluded from the pool) — the producer's rollup counts models whose
    // only observation is hidden, which reads as "80 results · 81 models".
    models_count: (() => {
      const shown = new Set(
        rows.map((r) => r.model_key ?? r.model_route_id ?? r.model_info?.name),
      )
      return shown.size > 0 ? shown.size : (selectedMetric?.models_count ?? merged.models_count)
    })(),
    evaluator_names: evaluatorNames,
    verified_evaluator_names: verifiedEvaluatorNames,
    ...(studyRefs.length > 0 ? { study_refs: studyRefs } : {}),
    ...(Object.keys(protocolAxesByCollection).length > 0
      ? { protocol_axes_by_collection: protocolAxesByCollection }
      : {}),
    source_types: [],
    third_party_ratio: 0,
    missing_generation_config_count: 0,
    best_model: bestModel,
    worst_model: null,
    avg_score: avgScore,
    avg_score_norm: 0,
    merged_view: true,
    benchmark_card: merged.benchmark_card ?? undefined,
    metrics_count: merged.metrics.length,
    metric_names: merged.metrics.map((m) => m.display_name),
    leaderboard_metrics: [
      {
        column_key: columnKey,
        metric_summary_id: columnKey,
        metric_name: columnKey,
        display_name: metricDisplayName,
        canonical_display_name: metricDisplayName,
        lower_is_better: merged.selected_lower_is_better,
        scope: "root",
      },
    ],
    leaderboard_rows,
  }
}
