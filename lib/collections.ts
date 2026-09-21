/**
 * Protocol-varied collections (notes/collection-benchmark-page-spec.md).
 *
 * Pure helpers shared by the server payload builder (lib/view-data) and
 * the client surfaces (eval-detail / score-distribution): protocol-
 * condition parsing, the R1 compute-axis selection rule, and the
 * compute-view mark builder. Client-safe: no server imports.
 *
 * Vocabulary follows the study's own: runs belong to a FEEDBACK
 * CONDITION ("no feedback" / "oracle score feedback"), never an "arm".
 */

export type FeedbackCondition = "none" | "answer_feedback" | "unknown"

export interface CollectionProtocolAxis {
  key: string
  type: string
  unit?: string | null
  values?: Array<string | null> | null
}

/** One entry of the snapshot's `collections.json` sidecar, keyed by
 *  `eval_results_view.collection_id` (NOT the composite slug). */
export interface CollectionsSidecarEntry {
  curated: boolean
  display_name: string
  kind?: string
  url?: string
  has_trajectories?: boolean
  /** Keyed by the study's own per-benchmark raw names (`benchmark_raw`),
   *  which need not match canonical benchmark ids. */
  outcome_type?: Record<string, string>
  protocol_axes?: CollectionProtocolAxis[]
  merge_raw_keys?: string[]
}

export interface CollectionComputeAxis {
  key: string
  /** Names the NOMINAL quantity ("token budget (limit)") — never tokens
   *  consumed; consumed-token curves are the trajectory panels' surface. */
  label: string
  unit?: string
}

/**
 * The eval-summary payload's optional `collection` attachment. Built
 * server-side for per-source pages whose rows belong to a CURATED
 * collection; the merged adapter never sets it, which is what keeps the
 * Compute view off merged summaries everywhere. Per-source embeds carry
 * the attachment and render the study surfaces deliberately.
 */
export interface CollectionAttachment {
  collection_id: string
  display_name: string
  url?: string
  curated: boolean
  kind?: string
  has_trajectories?: boolean
  /** This page's benchmark outcome type when resolvable from the sidecar
   *  map; absent when the map key doesn't match the canonical id. */
  outcome_type?: string
  protocol_axes?: CollectionProtocolAxis[]
  /** Server-computed R1 x-axis choice; null = no Compute view for this
   *  page by design (nothing numeric varies within a condition). */
  compute_axis: CollectionComputeAxis | null
  /** Scaffold-context strips for this (collection, benchmark), built from
   *  the `collection_context.json` sidecar. Null when the sidecar carries
   *  no entry for this pair — the Context view is then absent by design. */
  context?: ScaffoldContextPayload | null
}

export function parseProtocolCondition(
  raw: string | null | undefined,
): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** The comparability-bearing condition family. Unknown stays unknown —
 *  unparseable or missing feedback never gets promoted to a clean
 *  condition. */
export function feedbackConditionOf(raw: string | null | undefined): FeedbackCondition {
  const fields = parseProtocolCondition(raw)
  const feedback = fields?.feedback
  if (feedback === "none") return "none"
  if (feedback === "answer_feedback") return "answer_feedback"
  return "unknown"
}

// Preference order is the study's own: token_limit is the headline
// budget axis; reasoning_tokens is the fallback for pages where the
// budget never varies within a condition.
const COMPUTE_AXIS_CANDIDATES: CollectionComputeAxis[] = [
  { key: "token_limit", label: "token budget (limit)", unit: "tokens" },
  { key: "reasoning_tokens", label: "reasoning-token allowance", unit: "tokens" },
]

function axisValue(fields: Record<string, unknown>, key: string): number | null {
  const value = fields[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * A protocol axis that actually VARIES on one page, surfaced as its own
 * leaderboard column. `format` is applied per row by
 * `formatProtocolValue`.
 */
export interface ProtocolColumn {
  key: string
  /** Column header — the study's key, humanised. */
  label: string
  /** The axis type as the study declares it (`int`, `boolean`,
   *  `categorical`); "unknown" when only the rows know the key. */
  type: string
  unit?: string | null
}

/** Nothing is excluded. `feedback` used to be, because an ASSISTED badge
 *  carried it; the badge is gone (the run list states conditions rather
 *  than commenting on them), so the axis has to appear here or the fact
 *  that a run had an answer oracle disappears from the page. */
const PROTOCOL_COLUMN_EXCLUDED = new Set<string>()

/** These columns live in a row's expanded run list, which has room, but
 *  a table nobody can scan is still no use. */
const MAX_PROTOCOL_COLUMNS = 6

const PROTOCOL_COLUMN_LABELS: Record<string, string> = {
  feedback: "Feedback",
  token_limit: "Token budget",
  reasoning_tokens: "Thinking tokens",
  reasoning_effort: "Effort",
  compaction: "Compaction",
  scaffold: "Scaffold",
}

function humaniseProtocolKey(key: string): string {
  const known = PROTOCOL_COLUMN_LABELS[key]
  if (known) return known
  const spaced = key.replace(/[_-]+/g, " ").trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** Distinct-value identity for one row's value of one axis. A missing
 *  key and an explicit null are the SAME reading ("the study did not set
 *  it here"), so they must not count as two values and conjure a column
 *  out of nothing. */
function protocolValueKey(value: unknown): string {
  return value == null ? "\u0000absent" : JSON.stringify(value)
}

/**
 * The columns a leaderboard needs to tell its protocol rows apart.
 *
 * Nine rows reading "Claude Opus 4.6" are nine different runs, and
 * without the varying axis the reader sees nine identical rows with
 * different scores. So: one column per axis whose value actually
 * differs across the rows on this page. An axis the study held constant
 * (one scaffold everywhere) explains nothing and is left out.
 *
 * `declaredAxes` is the collection sidecar's own axis list — it carries
 * the study's ordering, types and units. Keys seen only in the rows are
 * appended after it so a new axis still surfaces, untyped, rather than
 * silently disappearing.
 */
export function chooseProtocolColumns(
  protocolConditions: Array<string | null | undefined>,
  declaredAxes?: CollectionProtocolAxis[] | null,
): ProtocolColumn[] {
  const parsed = protocolConditions
    .map((raw) => parseProtocolCondition(raw))
    .filter((fields): fields is Record<string, unknown> => fields != null)
  if (parsed.length < 2) return []

  const ordered: Array<{ key: string; type: string; unit?: string | null }> = []
  const seen = new Set<string>()
  for (const axis of declaredAxes ?? []) {
    if (!axis?.key || seen.has(axis.key)) continue
    seen.add(axis.key)
    ordered.push({ key: axis.key, type: axis.type ?? "unknown", unit: axis.unit })
  }
  for (const fields of parsed) {
    for (const key of Object.keys(fields)) {
      if (seen.has(key)) continue
      seen.add(key)
      ordered.push({ key, type: "unknown" })
    }
  }

  const columns: ProtocolColumn[] = []
  for (const axis of ordered) {
    if (PROTOCOL_COLUMN_EXCLUDED.has(axis.key)) continue
    const values = new Set(parsed.map((fields) => protocolValueKey(fields[axis.key])))
    if (values.size < 2) continue
    columns.push({
      key: axis.key,
      label: humaniseProtocolKey(axis.key),
      type: axis.type,
      unit: axis.unit ?? null,
    })
    if (columns.length === MAX_PROTOCOL_COLUMNS) break
  }
  return columns
}

/** 32000 -> "32k", 10000000 -> "10M", 1500 -> "1.5k". Budgets are the
 *  study's round numbers; the raw digits crowd the cell for no gain. */
function formatCompactCount(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
  if (abs >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`
  return String(value)
}

/**
 * One row's value for one protocol column. Returns null when the row
 * does not set the axis — the caller renders its own "not set" mark
 * rather than a word that would read as a value.
 */
export function formatProtocolValue(
  raw: string | null | undefined,
  column: ProtocolColumn,
): string | null {
  const fields = parseProtocolCondition(raw)
  const value = fields?.[column.key]
  if (value == null) return null
  if (typeof value === "boolean") return value ? "on" : "off"
  if (typeof value === "number" && Number.isFinite(value)) {
    // Counts get the compact form; a bare number (a temperature, a
    // seed) is not a magnitude and stays verbatim.
    return column.type === "int" || column.unit === "tokens"
      ? formatCompactCount(value)
      : String(value)
  }
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

/**
 * R1 per-page x-axis selection: the first candidate axis with >= 2
 * distinct numeric values WITHIN at least one feedback condition.
 * Cross-condition variation alone never qualifies — that would plot a
 * comparison the study says must be made at matched budgets. Returns
 * null when nothing numeric varies within a condition (the chip is then
 * absent by design).
 */
export function chooseComputeAxis(
  protocolConditions: Array<string | null | undefined>,
): CollectionComputeAxis | null {
  for (const candidate of COMPUTE_AXIS_CANDIDATES) {
    const valuesByCondition = new Map<FeedbackCondition, Set<number>>()
    for (const raw of protocolConditions) {
      const fields = parseProtocolCondition(raw)
      if (!fields) continue
      const value = axisValue(fields, candidate.key)
      if (value == null) continue
      const condition = feedbackConditionOf(raw)
      const values = valuesByCondition.get(condition) ?? new Set<number>()
      values.add(value)
      valuesByCondition.set(condition, values)
    }
    for (const values of valuesByCondition.values()) {
      if (values.size >= 2) return candidate
    }
  }
  return null
}

/**
 * Build the payload attachment from the sidecar entry. Curated entries
 * only — every ordinary leaderboard row also carries a collection_id,
 * and attaching those would light up study chrome on ordinary pages.
 * Returns null for uncurated or missing entries.
 */
export function buildCollectionAttachment(
  collectionId: string,
  entry: CollectionsSidecarEntry | undefined,
  benchmarkId: string | undefined,
  protocolConditions: Array<string | null | undefined>,
): CollectionAttachment | null {
  if (!entry?.curated) return null
  // outcome_type is keyed by the study's raw benchmark names; attach only
  // on a defensible match (exact, or exact after stripping separators) —
  // never guessed. The trajectory route re-resolves this precisely via
  // benchmark_raw.
  let outcomeType: string | undefined
  if (benchmarkId && entry.outcome_type) {
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "")
    outcomeType =
      entry.outcome_type[benchmarkId] ??
      Object.entries(entry.outcome_type).find(
        ([key]) => normalize(key) === normalize(benchmarkId),
      )?.[1]
  }
  return {
    collection_id: collectionId,
    display_name: entry.display_name,
    url: entry.url,
    curated: true,
    kind: entry.kind,
    has_trajectories: entry.has_trajectories,
    outcome_type: outcomeType,
    protocol_axes: entry.protocol_axes,
    compute_axis: chooseComputeAxis(protocolConditions),
  }
}

// ---------------------------------------------------------------------------
// Measurement context (finding I1): the collection's own published score for
// a model, placed among the community's published measurements of the same
// model on the same benchmark. Scaffold names, where a source records them,
// are point metadata — not the unit of the plot.
//
// The producer pre-joins EVERYTHING into `collection_context.json` — the
// external points are already matched to the collection's models on
// `model_aggregation_key`, already scale-converted, already restricted to
// the source's latest harvest, and the "no official entries" list is
// producer-computed. Nothing here joins across artifacts; a client-side
// join would mislabel a failed match as an absence.
// ---------------------------------------------------------------------------

/** One external measurement: a published run of this model under the
 *  reporting source's own setup, which the source mostly does not record.
 *  `scaffold` is present only where the source names one; `source` is the
 *  reporting composite's display name (absent on old-schema sidecars). */
export interface ScaffoldContextExternalEntry {
  scaffold: string | null
  source?: string | null
  score: number
  score_se?: number | null
  run_date?: string | null
}

/** A curated context source: a composite the external measurements come
 *  from. The producer resolves the display name, so the frontend never
 *  has to prettify an id. */
export interface ScaffoldContextSource {
  id: string
  display_name: string
}

/** One model's entry in the sidecar, keyed by `model_aggregation_key`. */
export interface ScaffoldContextSidecarModel {
  display_name: string
  score: number
  /** The study's published standard error for the plotted row. */
  score_se?: number | null
  n_tasks: number
  /** Recorded attempts per task, from the trajectory pool. */
  attempts_min: number
  attempts_max: number
  /** Copied VERBATIM from the fact rows by the producer — caption 3
   *  depends on byte equality with the page's own condition strings. */
  protocol_condition: string
  /** Legacy re-run band fields; still emitted, no longer rendered. */
  band_lo?: number
  band_hi?: number
  band_runs?: number
  band_method?: string
  band_seed?: number
  /** The fullest-coverage answer-feedback (assisted) cell, when it clears
   *  the same coverage gate as the main pick. Absent on old sidecars. */
  assisted?: {
    score: number
    score_se?: number | null
    n_tasks: number
    protocol_condition: string
  } | null
  external: ScaffoldContextExternalEntry[]
}

/** One (collection, benchmark) entry of `collection_context.json`. */
export interface ScaffoldContextEntry {
  harvested_at: string
  official_task_count: number
  context_sources: ScaffoldContextSource[]
  /** Producer-joined display names, in `context_sources` order — what
   *  caption 1 names as the origin of the external points. */
  context_source_display: string
  models_without_context: string[]
  /** Models shown in the view whose assisted cell was gated out (low task
   *  coverage), with that cell's coverage for the caption. Absent on old
   *  sidecars. */
  models_without_assisted?: Array<{ display_name: string; n_tasks: number | null }>
  models: Record<string, ScaffoldContextSidecarModel>
}

/** `collection_context.json`: collection_id → benchmark_key → entry. */
export type CollectionContextSidecar = Record<string, Record<string, ScaffoldContextEntry>>

export interface ScaffoldContextPoint {
  scaffold: string | null
  source?: string | null
  score: number
  scoreSe?: number | null
  runDate?: string | null
}

/** One horizontal strip: the model's published score (diamond) with its
 *  published-SE whisker, and the external measurement points (circles). */
export interface ScaffoldContextModel {
  /** `model_aggregation_key` — the dated↔undated bridge the producer
   *  joined on. Display-only here. */
  key: string
  displayName: string
  /** Published score of the fullest no-feedback condition. */
  score: number
  /** The study's published standard error for that row, if reported. */
  scoreSe: number | null
  nTasks: number
  /** Legacy re-run band; tolerated from old sidecars, never rendered. */
  bandLo?: number
  bandHi?: number
  bandRuns?: number
  /** Recorded attempts per task, from the trajectory pool. */
  attemptsMin: number
  attemptsMax: number
  /** The study's assisted (oracle answer feedback) companion cell — a
   *  second study mark on the strip. Null when gated out or on old
   *  sidecars. */
  assisted: {
    score: number
    scoreSe: number | null
    nTasks: number
    protocolCondition: string
  } | null
  points: ScaffoldContextPoint[]
  /** External points dropped by the >30 rule (0 in every shipped case). */
  hiddenCount: number
  /** Caption 3: this model is shown at its fullest-coverage condition,
   *  which is NOT the best-scoring no-feedback condition the ranked list
   *  above shows. Per-model — a global caption would be wrong for the
   *  single-condition models. */
  conditionDiffersFromBestScoring: boolean
}

export interface ScaffoldContextPayload {
  /** Snapshot id of the harvest the external points come from. */
  harvestedAt: string
  officialTaskCount: number
  /** Curated context sources, verbatim from the sidecar. */
  contextSources: ScaffoldContextSource[]
  /** Producer-resolved display string for those sources (caption 1). */
  contextSourceDisplay: string
  /** Producer-computed: collection models with no external entry. */
  modelsWithoutContext: string[]
  /** Models on the plot whose assisted cell was gated out, with that
   *  cell's task coverage for the caption. */
  modelsWithoutAssisted: Array<{ displayName: string; nTasks: number | null }>

  /** Benchmark display name for the captions. */
  benchmarkLabel: string
  /** Collection display name for the captions. */
  collectionLabel: string
  models: ScaffoldContextModel[]
  /** Sum of `hiddenCount` — drives the "+N not shown" caption. */
  hiddenTotal: number
}

/** The summary fields the builder reads. Structural so this module stays
 *  client-safe and free of a payload-type import cycle. */
export interface ScaffoldContextSummaryInput {
  evaluation_name?: string
  canonical_display_name?: string
  collection?: { display_name?: string } | null
  model_results: Array<{
    score: number
    protocol_condition?: string | null
    /** The producer's pick of the model's summary reading, or the rule the
     *  view layer derives on a snapshot predating the column. */
    is_headline?: boolean | null
    model_route_id?: string
    model_group_id?: string
    model_info: { name?: string; id?: string }
  }>
}

/** Never truncate below this many external points per model (today's max
 *  is 10; the live board has 11). */
const CONTEXT_POINT_CAP = 30

/**
 * Rank-quantile thinning that ALWAYS keeps both extremes. Top-N-by-score
 * truncation would narrow the visible spread — the exact quantity the
 * finding is about. Returns the kept points in the producer's original
 * order plus the number dropped.
 */
export function thinContextPoints(
  points: ScaffoldContextPoint[],
): { points: ScaffoldContextPoint[]; hiddenCount: number } {
  if (points.length <= CONTEXT_POINT_CAP) return { points, hiddenCount: 0 }

  // Rank order (ties broken by original position) so the quantile spacing
  // is over ranks, not over the producer's emit order.
  const byRank = points
    .map((point, index) => ({ point, index }))
    .sort((a, b) => a.point.score - b.point.score || a.index - b.index)

  const last = byRank.length - 1
  const keptRanks = new Set<number>([0, last])
  // Interior slots: quantile positions across the rank axis, rounded and
  // deduped, then topped up from the unused ranks so the cap is always met.
  const interior = CONTEXT_POINT_CAP - 2
  for (let i = 1; i <= interior; i += 1) {
    keptRanks.add(Math.round((i / (interior + 1)) * last))
  }
  for (let rank = 0; rank <= last && keptRanks.size < CONTEXT_POINT_CAP; rank += 1) {
    keptRanks.add(rank)
  }

  const keptIndices = new Set(
    Array.from(keptRanks, (rank) => byRank[rank].index),
  )
  return {
    points: points.filter((_, index) => keptIndices.has(index)),
    hiddenCount: points.length - keptIndices.size,
  }
}

/** Identity candidates a page row can be addressed by. The sidecar keys on
 *  `model_aggregation_key`, which equals the page's `model_key` for the
 *  collection's own rows; the display name is the last resort. */
function rowIdentities(row: ScaffoldContextSummaryInput["model_results"][number]): string[] {
  const ids: string[] = []
  if (row.model_info?.id) ids.push(row.model_info.id)
  if (row.model_group_id) ids.push(row.model_group_id)
  if (row.model_route_id) {
    try {
      ids.push(decodeURIComponent(row.model_route_id))
    } catch {
      ids.push(row.model_route_id)
    }
  }
  return ids
}

/**
 * The `feedback == "none"` condition of the row the ranked list above the
 * plot shows — which is the model's HEADLINE row, the one the producer
 * picked as its summary reading and the only one it serves a rank.
 * Highest-scoring is the fallback for snapshots that mark no headline.
 * Caption 3 fires when the sidecar's condition (fullest coverage) is a
 * DIFFERENT string from this one.
 */
function rankedNoFeedbackCondition(
  summary: ScaffoldContextSummaryInput,
  key: string,
  displayName: string,
): string | null {
  const normalizedName = displayName.trim().toLowerCase()
  const headlines: string[] = []
  let best: { score: number; condition: string } | null = null
  for (const row of summary.model_results ?? []) {
    if (!Number.isFinite(row.score)) continue
    const condition = row.protocol_condition
    if (!condition) continue
    if (feedbackConditionOf(condition) !== "none") continue
    const matches =
      rowIdentities(row).includes(key) ||
      (row.model_info?.name ?? "").trim().toLowerCase() === normalizedName
    if (!matches) continue
    if (row.is_headline === true) headlines.push(condition)
    if (!best || row.score > best.score) best = { score: row.score, condition }
  }
  // Exactly one headline is the producer's pick. Several means the group
  // was never ranked, so no row is privileged, and the highest score is
  // then what the list shows.
  if (headlines.length === 1) return headlines[0]
  return best?.condition ?? null
}

/**
 * Build the Context view payload from one sidecar entry. Pure. Returns null
 * when the sidecar carries no entry for this (collection, benchmark) or the
 * entry has no models — the view is then absent by design, never an empty
 * plot.
 */
export function buildScaffoldContext(
  entry: ScaffoldContextEntry | null | undefined,
  summary: ScaffoldContextSummaryInput,
): ScaffoldContextPayload | null {
  if (!entry) return null
  const sidecarModels = Object.entries(entry.models ?? {})
  if (sidecarModels.length === 0) return null

  const models: ScaffoldContextModel[] = []
  for (const [key, model] of sidecarModels) {
    if (!model) continue
    if (!Number.isFinite(model.score)) continue
    const displayName = model.display_name?.trim() || key
    const external = (model.external ?? [])
      .filter((point) => Number.isFinite(point?.score))
      .map((point) => ({
        scaffold: point.scaffold ?? null,
        source: point.source ?? null,
        score: point.score,
        scoreSe: point.score_se ?? null,
        runDate: point.run_date ?? null,
      }))
    const { points, hiddenCount } = thinContextPoints(external)
    const rankedCondition = rankedNoFeedbackCondition(summary, key, displayName)
    models.push({
      key,
      displayName,
      score: model.score,
      scoreSe: model.score_se ?? null,
      nTasks: model.n_tasks,
      bandLo: model.band_lo,
      bandHi: model.band_hi,
      bandRuns: model.band_runs,
      attemptsMin: model.attempts_min,
      attemptsMax: model.attempts_max,
      assisted:
        model.assisted && Number.isFinite(model.assisted.score)
          ? {
              score: model.assisted.score,
              scoreSe: model.assisted.score_se ?? null,
              nTasks: model.assisted.n_tasks,
              protocolCondition: model.assisted.protocol_condition,
            }
          : null,
      points,
      hiddenCount,
      // String equality on the verbatim producer-copied condition. A
      // missing page row can never fire the caption — we would be
      // asserting a difference we cannot see.
      conditionDiffersFromBestScoring:
        rankedCondition != null && rankedCondition !== model.protocol_condition,
    })
  }
  if (models.length === 0) return null

  return {
    harvestedAt: entry.harvested_at,
    officialTaskCount: entry.official_task_count,
    contextSources: entry.context_sources ?? [],
    contextSourceDisplay: entry.context_source_display,
    modelsWithoutContext: entry.models_without_context ?? [],
    modelsWithoutAssisted: (entry.models_without_assisted ?? []).map((m) => ({
      displayName: m.display_name,
      nTasks: m.n_tasks ?? null,
    })),
    benchmarkLabel:
      summary.canonical_display_name?.trim() || summary.evaluation_name?.trim() || "this benchmark",
    collectionLabel: summary.collection?.display_name?.trim() || "This study",
    models,
    hiddenTotal: models.reduce((acc, model) => acc + model.hiddenCount, 0),
  }
}
