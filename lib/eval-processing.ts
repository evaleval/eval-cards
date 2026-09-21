/**
 * Benchmark-first evaluation types, shared between the v2 view-layer reader
 * (lib/view-data.ts) and its UI consumers. The data-shaping functions that
 * used to live here were part of the legacy v1 (HF-JSON / duckdb) backend and
 * were removed once the producer pipeline took over aggregation.
 */

import type {
  BenchmarkCard,
  BenchmarkEvaluation,
  EvalTag,
  GenerationConfig,
  ModelInfo,
  SourceMetadata,
  SourceData,
  ScoreDetails,
  MetricConfig,
  EvaluationResult,
  ModelEvaluationSummary,
} from './benchmark-schema'
import type {
  ComparabilityStatus,
  EvalcardsAnnotations,
  RowAnnotations,
  SignalSummaries,
} from './backend-artifacts'
import type {
  CollectionAttachment,
  CollectionsSidecarEntry,
  ProtocolAxesByCollection,
  StudyRef,
} from './collections'

export type { BenchmarkCard }
export type { ModelEvaluationSummary }


/**
 * True when a result ran under the oracle answer-feedback arm of a
 * protocol-varied collection (the model was told when its answer was
 * correct). Assisted rows are shown but excluded from client-side ranking
 * by default — mirroring the backend, which never serves them a rank.
 */
export function isAssistedResult(protocolCondition: string | null | undefined): boolean {
  if (!protocolCondition) return false
  try {
    const parsed = JSON.parse(protocolCondition) as { feedback?: unknown } | null
    return parsed != null && typeof parsed === "object" && parsed.feedback === "answer_feedback"
  } catch {
    return false
  }
}

export interface ScoreSpread {
  /** How many scores the range spans. */
  n: number
  min: number
  max: number
}

/**
 * Where a model's runs on one page landed: the smallest and the largest,
 * and how many there were.
 *
 * Descriptive only, and deliberately so. The runs are different
 * CONFIGURATIONS (token budget, thinking tokens, effort, answer oracle),
 * not repeated draws of one quantity, so there is no population to
 * estimate and no sampling error to bound. An interval computed from
 * them would narrow as the study added design points while the observed
 * range stayed as wide, and would then be read as a claim about the
 * model's ability. The observed endpoints make no such claim.
 */
export function summariseScoreSpread(values: readonly number[]): ScoreSpread | null {
  const finite = values.filter((value) => Number.isFinite(value))
  if (finite.length === 0) return null
  return { n: finite.length, min: Math.min(...finite), max: Math.max(...finite) }
}

/** A parsed `judge_condition`. `judges` holds the canonical
 *  model ids of the LLM judges behind the number, `label` the source's own
 *  name for the channel. */
export interface JudgeCondition {
  judges: string[]
  label: string | null
}

/**
 * Parse the view's canonical `judge_condition` JSON
 * (`{"judges":[...],"label":"..."}`). NULL/absent means the source did not
 * disclose a judge — never "no judge" — so it parses to null and the row
 * is labelled as an ordinary result. Orthogonal to `protocol_condition`,
 * whose semantics (isAssistedResult above) are unchanged.
 */
export function parseJudgeCondition(
  raw: string | null | undefined,
): JudgeCondition | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { judges?: unknown; label?: unknown } | null
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null
    // Trim, drop empties, dedupe. A blank id would render "judged by "
    // and a repeated one would inflate "mean of N judges" — both claim
    // something about the panel that isn't in the data.
    const judges = Array.isArray(parsed.judges)
      ? [
          ...new Set(
            parsed.judges
              .filter((judge): judge is string => typeof judge === "string")
              .map((judge) => judge.trim())
              .filter((judge) => judge.length > 0),
          ),
        ]
      : []
    const label =
      typeof parsed.label === "string" && parsed.label.trim().length > 0
        ? parsed.label.trim()
        : null
    if (judges.length === 0 && label == null) return null
    return { judges, label }
  } catch {
    return null
  }
}

/**
 * Row label for a judged result: the judge when a single model graded it,
 * the panel size when several did, plus the panel's display names for the
 * row's tooltip. `displayName` resolves a judge's canonical model id to its
 * registry display name (server-built, see BenchmarkEvalSummary
 * .judge_display_names) and falls back to the raw id. Returns null when the
 * source disclosed no judge at all.
 */
export function judgeConditionSummary(
  raw: string | null | undefined,
  displayName: (modelId: string) => string,
): { label: string; names: string[]; judges: string[] } | null {
  const condition = parseJudgeCondition(raw)
  if (!condition || condition.judges.length === 0) return null
  const names = condition.judges.map(displayName)
  return {
    label: names.length === 1 ? `judged by ${names[0]}` : `mean of ${names.length} judges`,
    names,
    // The raw ids behind the names. Two dated variants that folded into
    // one survivor resolve to the SAME display name, so the id is the
    // only thing that tells a reader which reading a row is.
    judges: condition.judges,
  }
}

/** One non-headline judge reading of a (model, metric) cell: the panel the
 *  producer did not pick, and the number it published. */
export interface JudgeReading {
  judge_condition: string
  score: number | null
}

/**
 * Judge treatment for one cell of the multi-metric matrix, which is a pivot
 * of headline readings only. `label` is the same "judged by …" / "mean of N
 * judges" wording the per-row leaderboard uses, and `tooltip` names the
 * panel's members and then lists every OTHER judge reading of the same
 * (model, metric) with its value — the pivot has no row to put those on, so
 * dropping them would hide a disagreement the page is meant to show.
 * `formatScore` renders an alternate's number the way the column renders its
 * cells. Returns null when nothing about the cell names a judge.
 */
export function judgeCellSummary(
  condition: string | null | undefined,
  alternates: JudgeReading[] | undefined,
  displayName: (modelId: string) => string,
  formatScore: (score: number) => string,
): { label: string; tooltip: string } | null {
  const headline = judgeConditionSummary(condition, displayName)
  const others = (alternates ?? [])
    .map((reading) => ({
      summary: judgeConditionSummary(reading.judge_condition, displayName),
      score: reading.score,
    }))
    .filter(
      (reading): reading is { summary: NonNullable<typeof reading.summary>; score: number | null } =>
        reading.summary !== null,
    )
  if (!headline && others.length === 0) return null

  const lines: string[] = []
  if (headline) {
    lines.push(
      headline.names.length > 1
        ? `Judges: ${headline.names.join(", ")}`
        : `Judge model id: ${headline.judges[0]}`,
    )
  }
  if (others.length > 0) {
    lines.push("Other judge readings, not ranked:")
    for (const other of others) {
      const value =
        typeof other.score === "number" && Number.isFinite(other.score)
          ? formatScore(other.score)
          : "—"
      lines.push(`${other.summary.label}: ${value}`)
    }
  }

  return {
    // No headline judge but alternates exist (the producer's pick was an
    // undisclosed-judge row): say so rather than showing nothing.
    label:
      headline?.label
      ?? `${others.length} other judge reading${others.length === 1 ? "" : "s"}`,
    tooltip: lines.join("\n"),
  }
}

/**
 * The matrix column the page ranks on: the eval's `primary_metric_id`, which
 * is the metric every other surface on the page summarises. A payload that
 * declares no primary metric, or names one no column carries, falls back to
 * the first root metric and then to the first column.
 */
export function primaryMetricColumnKey(
  metrics: Array<{ column_key: string; metric_id?: string; scope?: string }> | undefined,
  primaryMetricId: string | null | undefined,
): string | undefined {
  const all = metrics ?? []
  const roots = all.filter((metric) => metric.scope !== "subtask")
  const primary = primaryMetricId?.trim()
  const declared = primary
    ? roots.find((metric) => metric.column_key === primary || metric.metric_id === primary)
    : undefined
  return declared?.column_key ?? roots[0]?.column_key ?? all[0]?.column_key
}

/** A row the backend did not pick as its model's headline reading (a losing
 *  judge panel or protocol arm) — shown beneath the headline, never ranked.
 *  An absent field reads as "headline", which is what a payload assembled
 *  outside the view layer (a fixture, an embed) gets. */
export function isHeadlineResult(result: {
  is_headline?: boolean | null
}): boolean {
  return result.is_headline !== false
}

/**
 * Score standings for rows already in score order: one rank per ranked
 * row, ties sharing a rank, and 0 for every row the caller says takes no
 * rank (an assisted run, a losing judge panel, a secondary protocol
 * point). The standing is the model's position in the field, so it is
 * assigned once here and never recomputed from a row's display position.
 */
export function scoreStandings<T>(
  rows: T[],
  score: (row: T) => number,
  ranked: (row: T) => boolean,
): number[] {
  let currentRank = 0
  let previousScore: number | null = null
  let rankedCount = 0
  return rows.map((row) => {
    if (!ranked(row)) return 0
    rankedCount += 1
    const value = score(row)
    if (previousScore === null || Math.abs(value - previousScore) > 1e-9) {
      currentRank = rankedCount
      previousScore = value
    }
    return currentRank
  })
}

/** The identity a model's rows group under: the producer's route id when
 *  it resolved one, else whatever identifies the model at all. */
export function modelGroupKey(result: {
  model_route_id?: string
  model_info?: { id?: string; name?: string }
}): string {
  return result.model_route_id ?? result.model_info?.id ?? result.model_info?.name ?? ""
}

/**
 * Group rows so that a model's non-headline readings (its judge panels and
 * protocol arms) stay attached beneath its headline row.
 *
 * Sorting a leaderboard must reorder these GROUPS, never the flattened row
 * list: reversing a flat list alone puts every secondary row above its own
 * headline, and an arbitrary key sort separates them from their model
 * entirely. A non-headline row whose model has no group yet opens one of
 * its own rather than attaching to an unrelated model above it.
 */
export function groupByHeadlineModel<T>(
  rows: readonly T[],
  resultOf: (row: T) => { is_headline?: boolean | null; model_route_id?: string; model_info?: { id?: string; name?: string } },
): T[][] {
  const groups: T[][] = []
  const openByModel = new Map<string, T[]>()
  for (const row of rows) {
    const result = resultOf(row)
    const key = modelGroupKey(result)
    const open = openByModel.get(key)
    if (open && !isHeadlineResult(result)) {
      open.push(row)
      continue
    }
    const group = [row]
    groups.push(group)
    openByModel.set(key, group)
  }
  return groups
}

/**
 * The direction the ranker's own row order already reads in: best first,
 * which is ASCENDING when the metric's better end is the low one. A score
 * sort that assumes "best first == descending" shows a lower-is-better
 * board upside down and then reverses the wrong way on the toggle.
 */
export function scoreSortBaseDirection(lowerIsBetter?: boolean | null): "asc" | "desc" {
  return lowerIsBetter ? "asc" : "desc"
}

/**
 * Score-ordered rows for a user-chosen direction. Takes the GROUPS the
 * ranker produced (each a headline row plus the judge / protocol readings
 * beneath it) so a reversal moves whole models — reversing the flat row
 * list would put every secondary reading above its own headline.
 */
export function orderGroupsByScore<T>(
  groups: readonly T[][],
  direction: "asc" | "desc",
  lowerIsBetter?: boolean | null,
): T[] {
  return direction === scoreSortBaseDirection(lowerIsBetter)
    ? groups.flat()
    : [...groups].reverse().flat()
}

/**
 * Composite comparison view: one score per (model, sub-eval) across a
 * suite's child evaluations, for the models x sub-evals matrix.
 *
 * Headline rows only. The cell is written once per matching row, so
 * without the filter a later judge panel or protocol arm overwrites the
 * model's summary reading — and that overwritten number is then averaged
 * across the suite and ranked as the model's standing.
 */
export function compositeScoresByModel(
  subSummaries: ReadonlyArray<{
    evaluation_name: string
    model_results: ModelResultForBenchmark[]
  }>,
): Map<string, { name: string; developer: string; scores: Map<string, number | null> }> {
  const modelScores = new Map<
    string,
    { name: string; developer: string; scores: Map<string, number | null> }
  >()
  for (const sub of subSummaries) {
    for (const result of sub.model_results) {
      if (!isHeadlineResult(result)) continue
      const id = result.model_info.id
      const existing = modelScores.get(id) ?? {
        name: result.model_info.name,
        developer: result.model_info.developer ?? "",
        scores: new Map<string, number | null>(),
      }
      existing.scores.set(sub.evaluation_name, result.score)
      modelScores.set(id, existing)
    }
  }
  return modelScores
}

export interface ModelResultForBenchmark {
  model_info: ModelInfo
  model_route_id?: string
  /**
   * model-resolution-rework: server-provided group canonical id. Used as
   * the routing fallback when `model_route_id` is absent — replaces the
   * old client-side family-route computation (since removed).
   */
  model_group_id?: string
  score: number
  score_details: ScoreDetails
  evaluation_timestamp: string
  source_metadata: SourceMetadata
  source_data: BenchmarkEvaluation['source_data']
  /** Per-result verification flag; mirrors `result.is_verified_evaluator`. */
  is_verified_evaluator?: boolean
  /** De-aliased evaluator identity (registry canonical display name when
   *  the org resolves, raw string otherwise). Preferred for the Source
   *  label so upstream spelling drift never leaks into display; the raw
   *  source_metadata strings stay available for provenance. */
  evaluator_display_name?: string
  result: EvaluationResult
  /** URL to the underlying record JSON in the upstream HF dataset, when known. */
  source_record_url?: string
  /** Deep-link to the raw EEE_datastore source record this score came from, when known. */
  eee_record_url?: string
  /** Merged-page rows only (set by lib/merged-adapter): the observation's
   *  source composite slug, used for the ?source= row pre-highlight. */
  merged_source_slug?: string
  /** Collections (see the backend's collections spec, warehouse-outputs section): submission-channel id of
   *  the row's representative fact row — key into the snapshot's
   *  `collections.json` sidecar. */
  collection_id?: string
  /** Protocol point for protocol-varied collections: canonical sorted-key
   *  JSON typed by the collection's declared `protocol_axes`; absent/null
   *  for ordinary rows. The view ships one row per protocol point; rows
   *  whose reserved `feedback` key is `answer_feedback` are
   *  shown-but-not-ranked (backend already emits NULL position for them). */
  protocol_condition?: string | null
  /** Canonical `{"judges":[...],"label":"..."}` JSON for a
   *  judged result; absent/null when the source disclosed no judge. */
  judge_condition?: string | null
  /** True on the one row per (composite, benchmark, metric, model) the
   *  producer picked as the page's summary reading. The view layer always
   *  projects it, deriving it from the producer's ranking on a snapshot
   *  that predates the column — see isHeadlineResult. */
  is_headline?: boolean | null
  /** The source's own label for the published number (`gpt_score`).
   *  Display and provenance only — never a key. */
  metric_source_label?: string | null
  /** How the score was produced: `generative` when the model wrote the
   *  answer, `log_prob` when the harness scored likelihoods over fixed
   *  choices. The producer's own classification, so it outranks anything
   *  inferred from a row's raw fields; absent on a snapshot predating the
   *  column, and null when the producer could not classify the row. */
  scoring_mode?: string | null
  /** The row's comparability verdict; only `ok` groups were assessed. */
  comparability_status?: ComparabilityStatus | null
  /** The number the source published, before any canonical-scale
   *  conversion applied to `score`. */
  score_published?: number
  aggregate_components?: Array<{
    evaluation_id: string
    composite_benchmark_key: string
    composite_benchmark_name: string
    score: number
    normalized_score: number
    evaluation_timestamp: string
    source_name?: string
    source_type: SourceMetadata["source_type"]
    source_organization_name: string
    evaluator_relationship: SourceMetadata["evaluator_relationship"]
  }>
}

export interface BenchmarkEvalSummary extends SignalSummaries {
  evaluation_name: string
  /** Registry display names for the judge model ids named in this page's
   *  judge conditions, keyed by the raw id the condition carries (which
   *  can be a dated variant that folded into the named model). Built
   *  server-side from models_view; absent when no row on the page names a
   *  judge, and missing an entry when models_view has no matching row —
   *  the label then falls back to the raw id. */
  judge_display_names?: Record<string, string>
  /** URL-safe slug derived from evaluation_name */
  evaluation_id: string
  /** True when this summary was adapted from a merged all-sources payload
   *  (lib/merged-adapter) — lets shared UI phrase observation-grain rows
   *  correctly ("N results · M models", not "N of M"). */
  merged_view?: true
  canonical_display_name?: string
  composite_benchmark_key: string
  composite_benchmark_name: string
  derived_tags?: EvalTag[]
  metric_config: MetricConfig
  model_results: ModelResultForBenchmark[]
  models_count: number
  /** Unique evaluator organisation names */
  evaluator_names: string[]
  /** Subset of `evaluator_names` that are validated submitters (badge). */
  verified_evaluator_names?: string[]
  source_types: SourceMetadata["source_type"][]
  latest_source_name?: string
  third_party_ratio: number
  missing_generation_config_count: number
  best_model: { name: string; score: number } | null
  worst_model: { name: string; score: number } | null
  avg_score: number
  /** avg_score normalised to 0-1 using metric_config.min/max_score */
  avg_score_norm: number | null
  /** Rich benchmark card from the metadata/ folder, when available */
  benchmark_card?: BenchmarkCard
  is_aggregated?: boolean
  aggregate_sources?: Array<{
    evaluation_id: string
    composite_benchmark_key: string
    composite_benchmark_name: string
    models_count: number
    avg_score_norm: number | null
  }>
  /** Tags from the pipeline (domains, languages, tasks) */
  tags?: { domains: string[]; languages: string[]; tasks: string[] }
  /** Number of distinct metrics for this benchmark */
  metrics_count?: number
  /** Names of all metrics */
  metric_names?: string[]
  /** Instance-level data availability */
  instance_data?: { available: boolean; url_count: number; sample_urls: string[]; models_with_loaded_instances: number }
  /** Canonical benchmark id (the registry-resolved benchmark). Drives
   *  benchmark-card lookups regardless of slice/composite axis. */
  benchmark_id?: string
  /** Family display name. */
  benchmark_family_name?: string
  /** Composite (leaderboard) slug — e.g. "wasp", "helm-classic". */
  composite_slug?: string
  /** Composite display name — e.g. "WASP", "HELM Classic". */
  composite_display_name?: string
  /** Curated multi-benchmark family slug (e.g. "mmlu"), defaults to
   *  benchmark id for singletons. */
  family_id?: string
  /** Family display, post-cutover canonical name. */
  family_display_name?: string
  /** Parent benchmark id — populated when this row is a slice of a
   *  root benchmark; null for non-slice rows. */
  parent_benchmark_id?: string
  /** True when this row is a within-benchmark slice cut. */
  is_slice?: boolean
  /** Source dataset metadata from the pipeline */
  source_data?: SourceData
  /** Best raw score reported in the eval summary list */
  top_score?: number
  /** Count of nested subtasks reported for the benchmark */
  subtasks_count?: number
  /** Whether this row is a summary/rollup score for a composite */
  is_summary_score?: boolean
  /** Evaluation_ids this benchmark summary is composed of. */
  constituent_evaluation_ids?: string[]
  /** Canonical benchmark-level metrics from root metrics[] */
  root_metrics?: BenchmarkSummaryMetric[]
  /** Canonical benchmark subdivisions from subtasks[] */
  subtasks?: BenchmarkSummarySubtask[]
  /** The metric the page ranks on (`evals_view.primary_metric_id`) — the one
   *  every other surface here summarises. The multi-metric matrix sorts and
   *  charts this column rather than whichever measure happens to come first.
   *  Absent on payloads assembled outside the view layer. */
  primary_metric_id?: string
  /** Matrix columns for multi-metric benchmark leaderboards */
  leaderboard_metrics?: BenchmarkLeaderboardMetric[]
  /** Matrix rows for multi-metric benchmark leaderboards */
  leaderboard_rows?: BenchmarkLeaderboardRow[]
  evalcards?: { annotations?: EvalcardsAnnotations }
  /** Curated protocol-varied collection attachment. Per-source-only:
   *  built server-side from the
   *  collections.json sidecar; the merged adapter never sets it, which
   *  gates every collection surface off merged summaries. Per-source
   *  embeds carry it and render the study surfaces deliberately. */
  collection?: CollectionAttachment
  /** Curated studies the visible rows come from. Attribution only, and
   *  the one study surface a merged summary carries. */
  study_refs?: StudyRef[]
  /** Declared protocol axes keyed by collection id, for a page whose rows
   *  span several collections. Descriptor lookup only: it gives a row's
   *  numbers their unit and says which axes apply to which row. */
  protocol_axes_by_collection?: ProtocolAxesByCollection
  /** Source ↔ merged switcher data for per-source pages.
   *  Absent when the page has neither a merged page nor sibling sources,
   *  and on old snapshots. */
  source_options?: EvalSourceOptions
}

export interface EvalSourceOption {
  /** Per-source eval page id (URL-encoded, straight off evals_view). */
  evaluation_id: string
  composite_slug?: string
  composite_display_name?: string
  models_count?: number
}

export interface EvalSourceOptions {
  /** Merged-page id to navigate to, or null when NO merged page exists —
   *  the switcher must never navigate to a nonexistent merged page. */
  merged_evaluation_id: string | null
  sources: EvalSourceOption[]
}

export interface BenchmarkSummaryMetric {
  metric_summary_id: string
  metric_name: string
  display_name: string
  canonical_display_name?: string
  metric_key?: string
  lower_is_better: boolean
  models_count: number
  top_score?: number
  unit?: string
}

export interface BenchmarkSummarySubtask {
  subtask_key: string
  subtask_name: string
  display_name: string
  canonical_display_name?: string
  metrics: BenchmarkSummaryMetric[]
}

export interface BenchmarkLeaderboardMetric {
  column_key: string
  /** Registry metric id. Equal to `column_key` on root metrics; a subtask
   *  entry keys its column "<metric_id>::<slice>" and carries the base id
   *  here. Matches `evals_view.primary_metric_id`. */
  metric_id?: string
  metric_summary_id: string
  metric_name: string
  display_name: string
  canonical_display_name?: string
  lower_is_better: boolean
  unit?: string
  scope: "root" | "subtask"
  subtask_key?: string
  subtask_name?: string
}

export interface BenchmarkLeaderboardRow {
  model_info: ModelInfo
  model_route_id?: string
  /** model-resolution-rework: server group id, routing fallback. */
  model_group_id?: string
  evaluation_timestamp: string
  source_metadata: SourceMetadata
  source_data: BenchmarkEvaluation["source_data"]
  values: Record<string, number | null>
  /** Per-column verified-evaluator flag, keyed identically to `values`. */
  verified?: Record<string, boolean>
  annotations_by_metric?: Record<string, RowAnnotations | null | undefined>
  /** Per-column comparability verdict, keyed identically to `values`.
   *  Prebaked matrix cells carry no annotation struct, so this is what
   *  lets a matrix cell render "not assessable" instead of silence. */
  comparability_status_by_metric?: Record<string, ComparabilityStatus | null | undefined>
  /** Per-column `judge_condition` of the headline reading the cell shows,
   *  keyed identically to `values`. */
  judge_condition_by_metric?: Record<string, string | null | undefined>
  /** Per-column non-headline judge readings of the same (model, metric).
   *  The pivot keeps one row per model, so these ride the cell rather than
   *  becoming rows of their own. */
  judge_alternates_by_metric?: Record<string, JudgeReading[] | undefined>
  metrics_present: number
}

export type BenchmarkEvalListItem = Omit<BenchmarkEvalSummary, "model_results">

// ---------------------------------------------------------------------------
// Merged benchmark view (merged-benchmark-view spec F1) — one page per
// resolved canonical benchmark, merging every publishing source at
// observation grain. Backed by `merged_evals_view.parquet` plus a live
// query over `eval_results_view`.
// ---------------------------------------------------------------------------

/** 'flagged' rows have no canonical-scale score (never guessed); 'no_bounds'
 *  rows pass the raw score through unconverted; 'curated' rows were
 *  multiplied by a registry-declared factor (e.g. raw 1-10 onto 0-1). */
export type MergedScaleConversion = "none" | "div100" | "mul100" | "curated" | "flagged" | "no_bounds"

export interface MergedAggregateSource {
  /** Per-source eval page id; null for slice-only sources (no top-level page target). */
  evaluation_id: string | null
  composite_slug: string
  composite_display_name: string
  models_count: number
  results_count: number
  /** False = excluded from the default view (source reports only other metrics). */
  reports_preferred: boolean
  /** True = source reports slice-level results only (disclosure note). */
  slice_only: boolean
}

export interface MergedMetricOption {
  metric_id: string
  display_name: string
  results_count: number
  models_count: number
  sources_count: number
  lower_is_better: boolean | null
}

export interface MergedSliceOption {
  slice_id: string
  display_name: string
}

export interface MergedBestResult {
  model_name: string | null
  model_key: string | null
  score: number | null
  score_canonical: number | null
  composite_slug: string | null
  evaluation_id: string | null
}

/** One (model, source) observation row. Echo republications stay visible —
 *  the merged accessor never dedupes by model identity (spec design pt 3). */
export interface MergedObservationRow {
  model_info: ModelInfo
  model_route_id?: string
  model_key?: string
  /** The observation's per-source evaluation_id (two-segment) — Source link target. */
  evaluation_id: string
  composite_slug: string
  composite_display_name?: string
  score: number
  /** Score on the metric's registry canonical scale; null for flagged rows. */
  score_canonical: number | null
  scale_conversion: MergedScaleConversion | null
  evaluation_timestamp: string
  source_metadata: SourceMetadata
  /** The row's own upstream dataset provenance (repo, url, version,
   *  sample count). Absent when the fact row carries none. */
  source_data?: SourceData
  generation_config?: GenerationConfig
  is_verified_evaluator?: boolean
  /** De-aliased evaluator identity (canonical display when resolvable). */
  evaluator_display_name?: string
  /** Collections: submission-channel id of the observation's source row. */
  collection_id?: string
  /** Protocol point (canonical sorted-key JSON) for protocol-varied
   *  collections; absent/null for ordinary observations. */
  protocol_condition?: string | null
  /** Same meanings as on ModelResultForBenchmark. Merged pages
   *  pool one observation per (model, source), so only headline rows
   *  belong in the pool (see lib/merged-adapter). */
  judge_condition?: string | null
  is_headline?: boolean | null
  metric_source_label?: string | null
  comparability_status?: ComparabilityStatus | null
  /** The number the source published, before any canonical-scale
   *  conversion applied to `score`. */
  score_published?: number
}

export interface MergedBenchmarkSummary {
  /** Discriminator vs the per-source BenchmarkEvalSummary payload. */
  merged: true
  /** Single-segment percent-encoded benchmark id (never contains %2F). */
  evaluation_id: string
  benchmark_id: string
  display_name: string
  family_id?: string | null
  family_display_name?: string | null
  /** 'slice' = benchmark has no top-level data; page shows a slice selector. */
  grain: "benchmark" | "slice"
  preferred_metric_id: string
  preferred_metric_display_name: string
  preferred_from_registry: boolean
  lower_is_better: boolean
  /** Counts at default-metric grain (spec P5). */
  sources_count: number
  all_sources_count: number
  results_count: number
  models_count: number
  best_result: MergedBestResult | null
  aggregate_sources: MergedAggregateSource[]
  metrics: MergedMetricOption[]
  /** Non-null only for grain='slice'. */
  slices: MergedSliceOption[] | null
  /** Metric actually queried for `results` (defaults to preferred). */
  selected_metric_id: string
  selected_lower_is_better: boolean
  /** For grain='slice': the slice actually queried (defaults to the first). */
  selected_slice_id: string | null
  results: MergedObservationRow[]
  /** Registry display names for the judge ids named by these rows, keyed
   *  by the raw id — same map and same fallback rule as
   *  BenchmarkEvalSummary.judge_display_names. */
  judge_display_names?: Record<string, string>
  /** The benchmark's card, sourced from a per-source instantiation that
   *  authored one (preferring a source that reports the preferred metric). */
  benchmark_card?: BenchmarkCard | null
  /** `collections.json` entries for the curated collections these rows
   *  belong to, keyed by collection_id. Lets the reader name the study a
   *  row comes from and give its protocol numbers their declared units
   *  without a second fetch. */
  collections?: Record<string, CollectionsSidecarEntry>
}

/**
 * Collapse leaderboard rows that describe the same model under two
 * source attributions (typical: one record with `developer: "OpenAI"`,
 * another with `developer: "unknown"` from a source that didn't carry
 * the developer field, both pointing at the same physical model). We
 * only merge when every shared score column is byte-equal across the
 * duplicates — that guarantees we never mask a legitimate second run
 * that happens to share a name. When merging, we keep the attribution
 * that actually identifies a developer.
 */
function devAttributionScore(developer: string | undefined | null): number {
  if (!developer) return 0
  const lower = developer.trim().toLowerCase()
  if (!lower || lower === "unknown") return 0
  return 1
}

function routeAttributionScore(routeId: string | undefined | null): number {
  if (!routeId) return 0
  const lower = routeId.toLowerCase()
  return lower.startsWith("unknown%2f") || lower.startsWith("unknown/") ? 0 : 1
}

export function dedupeLeaderboardRowsByModelIdentity(
  rows: BenchmarkLeaderboardRow[],
): BenchmarkLeaderboardRow[] {
  if (rows.length < 2) return rows
  const groups = new Map<string, BenchmarkLeaderboardRow[]>()
  for (const row of rows) {
    const name = (row.model_info?.name ?? "").trim().toLowerCase()
    if (!name) continue
    const bucket = groups.get(name)
    if (bucket) bucket.push(row)
    else groups.set(name, [row])
  }

  const result: BenchmarkLeaderboardRow[] = []
  const consumed = new WeakSet<BenchmarkLeaderboardRow>()
  for (const row of rows) {
    if (consumed.has(row)) continue
    const name = (row.model_info?.name ?? "").trim().toLowerCase()
    const bucket = name ? groups.get(name) : null
    if (!bucket || bucket.length < 2) {
      result.push(row)
      continue
    }

    // Verify per-column score agreement before merging. Any conflict
    // (two different numbers for the same column key) means the rows
    // are distinct runs that happen to share a model name — leave them.
    let conflict = false
    const valuesByKey: Record<string, number> = {}
    outer: for (const candidate of bucket) {
      for (const [key, raw] of Object.entries(candidate.values ?? {})) {
        if (typeof raw !== "number" || !Number.isFinite(raw)) continue
        if (key in valuesByKey) {
          if (valuesByKey[key] !== raw) {
            conflict = true
            break outer
          }
        } else {
          valuesByKey[key] = raw
        }
      }
    }
    if (conflict) {
      result.push(row)
      continue
    }

    // Pick the canonical row: best developer attribution, then best
    // route id, then most populated values map as a tiebreaker.
    const canonical = [...bucket].sort((a, b) => {
      const devDelta = devAttributionScore(b.model_info?.developer) - devAttributionScore(a.model_info?.developer)
      if (devDelta !== 0) return devDelta
      const routeDelta = routeAttributionScore(b.model_route_id) - routeAttributionScore(a.model_route_id)
      if (routeDelta !== 0) return routeDelta
      return Object.keys(b.values ?? {}).length - Object.keys(a.values ?? {}).length
    })[0]

    const mergedValues: Record<string, number | null> = { ...(canonical.values ?? {}) }
    const mergedAnnotations: Record<string, unknown> = { ...(canonical.annotations_by_metric ?? {}) }
    const mergedStatus: Record<string, unknown> = {
      ...(canonical.comparability_status_by_metric ?? {}),
    }
    for (const candidate of bucket) {
      if (candidate === canonical) continue
      for (const [key, raw] of Object.entries(candidate.values ?? {})) {
        if (mergedValues[key] == null && raw != null) mergedValues[key] = raw
      }
      for (const [key, ann] of Object.entries(candidate.annotations_by_metric ?? {})) {
        if (mergedAnnotations[key] == null && ann != null) mergedAnnotations[key] = ann
      }
      for (const [key, status] of Object.entries(candidate.comparability_status_by_metric ?? {})) {
        if (mergedStatus[key] == null && status != null) mergedStatus[key] = status
      }
      consumed.add(candidate)
    }

    result.push({
      ...canonical,
      values: mergedValues,
      annotations_by_metric: mergedAnnotations as typeof canonical.annotations_by_metric,
      comparability_status_by_metric:
        mergedStatus as typeof canonical.comparability_status_by_metric,
    })
    consumed.add(canonical)
  }
  return result
}
