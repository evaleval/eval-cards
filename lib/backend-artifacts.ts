export interface BackendManifest {
  generated_at: string
  config_version: number
  skipped_configs: string[]
  // Counts the upstream pipeline already records in manifest.json. The home
  // page reads these directly so it does not have to load model-cards-lite
  // (~20MB) just to display headline numbers.
  model_count?: number
  eval_count?: number
  metric_eval_count?: number
  source_config_count?: number
  skipped_config_count?: number
  summary_artifacts?: {
    corpus_aggregates?: string
    eval_hierarchy?: string
    [key: string]: string | undefined
  }
}

export interface BackendManifestStatus {
  currentManifest: BackendManifest | null
  latestManifest: BackendManifest | null
  currentManifestSignature: string | null
  latestManifestSignature: string | null
  updateAvailable: boolean
  refreshing: boolean
  pendingRefreshCount: number
}

// ---------------------------------------------------------------------------
// EvalCards interpretive signals v1.0
// ---------------------------------------------------------------------------

// The view layer emits `populated_count`/`required_count`; the
// `*_field_count` spellings are the v1 fixtures'.
export interface ReproducibilityGap {
  has_reproducibility_gap?: boolean
  missing_fields: string[]
  required_field_count?: number
  populated_field_count?: number
  required_count?: number
  populated_count?: number
  /** One character per setup item, in the order of `SETUP_ITEMS`
   *  (lib/setup-items.ts): d disclosed, m missing, n not applicable,
   *  u applicability unknown. */
  item_states?: string
  signal_version?: string
}

export type ProvenanceSourceType =
  | "first_party"
  | "third_party"
  | "collaborative"
  | "unspecified"

// Same caveat: the view layer emits `source_type`/`evaluator_relationship`/
// `organization_name` only; the group-level flags are spec'd but not yet
// produced — treat as possibly absent.
export interface Provenance {
  source_type: ProvenanceSourceType
  evaluator_relationship?: string
  organization_name?: string | null
  is_multi_source?: boolean
  first_party_only?: boolean
  // Group-level evaluator coverage across all sources of the (model,
  // benchmark, metric) group: 'both' parties reported, only 'self'
  // (first-party), or only 'third'. Folded in from the view's flat
  // coverage_cell column (see view-data.ts withGroupSignals).
  coverage_cell?: "both" | "self" | "third" | null
  distinct_reporting_organizations?: number
  signal_version?: string
}

export type DivergenceThresholdBasis =
  | "proportion_or_continuous_normalized"
  | "percent"
  | "range_5pct"
  | "fallback_default"

export interface DifferingSetupField {
  field: string
  values: unknown[]
}

export interface VariantDivergence {
  /** NULL means "not assessable" (a contributing comparability
   *  group was not `ok`), never "no divergence". Read it together with
   *  `RowAnnotations.comparability_status`.
   *
   *  ABSENT is a third state, and not the same as NULL: the snapshot
   *  never declared a verdict for this row at all (its producer struct
   *  predates the field), so nothing can be concluded from it. See
   *  view-data.ts `withGroupSignals`, which normalises the producer's
   *  `has_divergence` / flat-column spellings into this one. */
  has_variant_divergence?: boolean | null
  group_id: string
  divergence_magnitude: number
  threshold_used: number
  threshold_basis: DivergenceThresholdBasis
  differing_setup_fields: DifferingSetupField[]
  scores_in_group: number[]
  this_triple_score: number | null
  triple_count_in_group: number
  score_scale_anomaly: boolean
  group_variant_breakdown: Array<{ variant_key: string; row_count: number }>
  signal_version: string
}

export interface CrossPartyDivergence {
  /** Nullable — and absent — for the same reasons as
   *  `has_variant_divergence`. */
  has_cross_party_divergence?: boolean | null
  group_id: string
  divergence_magnitude: number
  threshold_used: number
  threshold_basis: DivergenceThresholdBasis
  scores_by_organization: Record<string, number>
  differing_setup_fields: DifferingSetupField[]
  organization_count: number
  group_variant_breakdown: Array<{ variant_key: string; row_count: number }>
  signal_version: string
}

/** The comparability group's verdict; only `ok` groups were assessed. */
export type ComparabilityStatus = "ok" | "mixed_scale" | "no_bounds"

export interface RowAnnotations {
  reproducibility_gap: ReproducibilityGap | null
  provenance: Provenance | null
  variant_divergence: VariantDivergence | null
  cross_party_divergence: CrossPartyDivergence | null
  // Folded in client-side from the view's flat completeness_score column
  // (group-level C(b) per the paper's 28-field scoring) — see
  // view-data.ts withGroupSignals. Not part of the producer's struct.
  reporting_completeness?: Pick<ReportingCompleteness, "completeness_score"> | null
  // Folded in client-side from the view's flat
  // comparability_status column (see view-data.ts withGroupSignals), which
  // is what separates "not assessable" from "assessed, no divergence".
  comparability_status?: ComparabilityStatus | null
}

export interface ReportingCompleteness {
  completeness_score: number
  total_fields_evaluated: number
  missing_required_fields: string[]
  partial_fields: Array<{
    field_path: string
    score: number
    populated_subitems: number
    total_subitems: number
  }>
  field_scores: Array<{
    field_path: string
    coverage_type: "full" | "partial" | "reserved"
    score: number
  }>
  signal_version: string
}

export interface BenchmarkComparability {
  variant_divergence_groups: Array<{
    group_id: string
    model_route_id: string
    divergence_magnitude: number
    threshold_used: number
    threshold_basis: DivergenceThresholdBasis
    differing_setup_fields: DifferingSetupField[]
  }>
  cross_party_divergence_groups: Array<{
    group_id: string
    model_route_id: string
    divergence_magnitude: number
    threshold_used: number
    threshold_basis: DivergenceThresholdBasis
    scores_by_organization: Record<string, number>
    differing_setup_fields: DifferingSetupField[]
  }>
}

export interface EvalcardsAnnotations {
  reporting_completeness?: ReportingCompleteness
  benchmark_comparability?: BenchmarkComparability
}

export interface ReproducibilitySummary {
  results_total: number
  has_reproducibility_gap_count: number
  populated_ratio_avg: number | null
}

export interface ProvenanceSummary {
  total_results: number
  total_groups: number
  multi_source_groups: number
  first_party_only_groups: number
  source_type_distribution: Record<ProvenanceSourceType, number>
}

export interface ComparabilitySummary {
  total_groups: number
  groups_with_variant_check: number
  groups_with_cross_party_check: number
  variant_divergent_count: number
  cross_party_divergent_count: number
}

export interface SignalSummaries {
  reproducibility_summary?: ReproducibilitySummary
  provenance_summary?: ProvenanceSummary
  comparability_summary?: ComparabilitySummary
}

export interface CorpusAggregates {
  generated_at: string
  signal_version: string
  stratification_dimensions: ["category"]
  reproducibility: Stratified<ReproducibilityCorpusBlock>
  /** In item order. */
  setup_items?: SetupItemFields[]
  completeness: Stratified<CompletenessCorpusBlock>
  provenance: Stratified<ProvenanceCorpusBlock>
  comparability: Stratified<ComparabilityCorpusBlock>
  reporting_org_count?: number
  total_benchmarks?: number
  developers?: DeveloperListEntry[]
  families?: Array<{
    family_key: string
    display_name: string
    model_count: number
    eval_count: number
  }>
  categories?: Array<{
    category: string
    model_count: number
    eval_count: number
  }>
}

export interface DeveloperListEntry {
  developer: string
  route_id: string
  model_count: number
  benchmark_count: number
  evaluation_count: number
  popular_evals: Array<{ benchmark: string; model_count: number }>
}

export interface Stratified<T> {
  overall: T
  by_category: Record<string, T>
}

export interface ReproducibilityCorpusBlock {
  total_triples: number
  triples_with_reproducibility_gap: number
  reproducibility_gap_rate: number | null
  /** Keyed by setup item id. */
  per_field_missingness: Record<string, {
    missing_count: number
    missing_rate: number | null
    denominator: "all_triples" | "agentic_only"
    denominator_count: number
  }>
}

/** The field and value that disclosed one setup item on one result row. */
export interface ReproducibilityEvidence {
  item: string
  field: string
  value: string
}

/** /api/eval-row-reproducibility payload: evidence for the row's disclosed
 *  items, and the evidence paths each setup item accepts. */
export interface EvalRowReproducibility {
  evidence: ReproducibilityEvidence[]
  accepted_fields: Record<string, string[]>
}

/** One setup item and the evidence paths that disclose it. */
export interface SetupItemFields {
  id: string
  accepted_fields: string[]
}

export interface CompletenessCorpusBlock {
  total_triples: number
  completeness_avg: number | null
  completeness_min: number | null
  completeness_max: number | null
}

export interface ProvenanceCorpusBlock {
  total_triples: number
  multi_source_triples: number
  first_party_only_triples: number
  source_type_distribution: Record<ProvenanceSourceType, number>
}

export interface ComparabilityCorpusBlock {
  total_triples: number
  variant_divergent_count: number
  cross_party_divergent_count: number
  groups_with_variant_check: number
  groups_with_cross_party_check: number
}

// ---------------------------------------------------------------------------
// Hierarchy types (v3 — family-rooted tree).
//
// The producer emits this shape via eval_card_backend's
// `write_hierarchy()` after the producer's hierarchy reshape.
//
// Top level: `families[]` is the rich entity. Composites nest under
// families[].composites[]. `benchmark_index[]` cross-links a canonical
// benchmark that appears in multiple families.
//
// Each family chooses ONE of three layouts:
//   - standalone_benchmarks: single-benchmark family.
//   - benchmarks (flat): multiple benchmarks, no composite layer.
//   - composites: multi-composite family (HELM has 7).
// ---------------------------------------------------------------------------

export interface HierarchyTags {
  domains: string[]
  languages: string[]
  tasks: string[]
}

export interface HierarchyMetric {
  key: string
  display_name: string
  /** Producer-supplied list of organisations whose results back this
   *  metric. Empty when source attribution wasn't recoverable. */
  sources?: string[]
  /** True when this is the benchmark's primary metric
   *  (matches `primary_metric_key`). */
  is_primary?: boolean
  /** Distinct model count contributing to this metric — drives
   *  primary-metric tie-break. */
  models_count?: number
}

export interface HierarchySlice {
  key: string
  display_name: string
  metrics: HierarchyMetric[]
  /** Marks the bare-stem "Overall" slice (e.g. `gaia` inside the
   *  `gaia` benchmark). Frontend labels such a row "Overall". */
  is_bare_stem?: boolean
  /** Categorical tags derived client-side; see HierarchyFamily.derivedTags. */
  derivedTags?: string[]
}

export interface HierarchyBenchmark extends SignalSummaries {
  key: string
  display_name: string
  family_id: string
  /** Canonical benchmark id when a merged all-sources page exists for
   *  this node (additive, 2026-08 producer). Null/absent on older
   *  snapshots and on hotfix-re-keyed/synthetic nodes — those leaves
   *  fall back to the per-source link (merged-benchmark-view spec F2). */
  benchmark_id?: string | null
  is_slice: boolean
  /** True when this row IS the family/composite root (canonical_id
   *  matches the family or composite key). For a singleton family,
   *  the sole benchmark is overall. For multi-bench families with
   *  no head benchmark of the same name (HAL, BFCL with no `bfcl`
   *  benchmark), all are False. */
  is_overall: boolean
  /** True for the benchmark within its family that's the headline
   *  reading. Selected via FAMILY_PRIMARY_OVERRIDE → is_overall →
   *  alphabetical (see _mark_family_primary_benchmark in producer). */
  is_primary?: boolean
  /** Metric key whose primary metric should be displayed as the
   *  benchmark's headline number. Null when the benchmark has no
   *  metrics. */
  primary_metric_key?: string | null
  has_card: boolean
  tags: HierarchyTags
  slices: HierarchySlice[]
  metrics: HierarchyMetric[]
  /** Evaluation_ids this node is composed of (rolled-up coverage). */
  constituent_evaluation_ids?: string[]
  /** Categorical tags derived client-side; see HierarchyFamily.derivedTags. */
  derivedTags?: string[]
}

export interface HierarchyComposite extends SignalSummaries {
  key: string
  display_name: string
  category: string
  tags: HierarchyTags
  benchmarks: HierarchyBenchmark[]
  evals_count?: number
  constituent_evaluation_ids?: string[]
  /** True for the headline composite within a multi-composite family. */
  is_primary?: boolean
  /** Categorical tags derived client-side; see HierarchyFamily.derivedTags. */
  derivedTags?: string[]
}

export interface HierarchyFamily extends SignalSummaries {
  key: string
  display_name: string
  category: string
  tags: HierarchyTags
  evals_count: number
  constituent_evaluation_ids: string[]
  /** Exactly ONE of the three layout fields below is present. */
  standalone_benchmarks?: HierarchyBenchmark[]
  benchmarks?: HierarchyBenchmark[]
  composites?: HierarchyComposite[]
  /** Categorical tags derived at hydration time from
   *  data/benchmarks/categories.json (ref lookup with parent
   *  inheritance, regex fallback). Populated client-side after
   *  fetchEvalHierarchy via decorateHierarchyDerivedTags in
   *  lib/benchmark-tags.ts; not present in the snapshot artefact. */
  derivedTags?: string[]
}

export interface BenchmarkIndexAppearance {
  family_key: string
  benchmark_key: string
  constituent_evaluation_ids: string[]
  /** True when the family this appearance is under is the benchmark's
   *  natural "home" family (family_key === benchmark_key). */
  is_canonical_home: boolean
}

export interface BenchmarkIndexEntry {
  key: string
  display_name: string
  appearances: BenchmarkIndexAppearance[]
}

export interface EvalHierarchyStats {
  family_count: number
  composite_count: number
  benchmark_count: number
  slice_count: number
  metric_count: number
  metric_rows_scanned: number
}

export interface EvalHierarchy {
  /** Schema marker: "v3.hierarchy.1". Older snapshots lack this. */
  schema_version?: string
  generated_at?: string
  stats?: EvalHierarchyStats
  families: HierarchyFamily[]
  benchmark_index?: BenchmarkIndexEntry[]
  /** Per-model cleaned benchmark count, keyed by model_route_id.
   *  Injected by cleanHierarchy() and persisted in the disk cache so
   *  data-backend can override the warehouse's pre-baked benchmarks_count
   *  (which is computed before the cleaner folds split families). */
  _modelCoverageMap?: Record<string, number>
}

// ---------------------------------------------------------------------------
// comparison-index.json — per-(eval, metric) leaderboards for the histogram UI
// ---------------------------------------------------------------------------

export type MetricGroup =
  | "capability"
  | "robustness"
  | "efficiency"
  | "cost"
  | "latency"
  | "rank"
  | "other"

export type SubmissionAxis = "default" | "harness" | "variant" | "rerun" | "mixed"

export interface ComparisonSubmission {
  score: number
  run_kind: SubmissionAxis
  run_label: string
  raw_model_id: string | null
}

/** How a per-source `score` maps onto `score_canonical` (spec F5).
 *  'flagged' rows have no canonical-scale score (never guessed);
 *  'no_bounds' rows pass the raw score through unconverted; 'curated'
 *  rows were multiplied by a registry-declared factor (e.g. raw 1-10
 *  onto a 0-1 metric). Same union as `MergedScaleConversion` in
 *  eval-processing.ts (merged-view rows). */
export type ScaleConversion = "none" | "div100" | "mul100" | "curated" | "flagged" | "no_bounds"

export interface ComparisonScoreEntry {
  model_route_id: string
  // The group root id, slash-form (e.g. "zhipu/glm-4-6-fc-thinking") — the field
  // comparison-index score rows actually carry. Peer labels fall back to it when
  // model_family_name is empty (most rows). NOTE: `model_group_id` below is NOT
  // present on these rows; it stays declared only because other consumers read
  // it as a `|| model_group_id` fallback (always undefined here, harmless).
  model_family_id: string
  model_group_id: string
  model_family_name: string
  developer: string
  variant_key: string
  score: number
  rank: number
  total: number
  submission_count: number
  submission_axis: SubmissionAxis
  headline_run_kind?: SubmissionAxis
  headline_run_label?: string
  submissions?: ComparisonSubmission[]
  /** Generation params from the headline run's generation config. Optional:
   *  absent on snapshots produced before the fields shipped, null when the
   *  source never reported them. */
  temperature?: number | null
  max_tokens?: number | null
  /** Score on the metric's registry scale ([0,1] fraction metrics, [0,100]
   *  percent metrics); null when the row was flagged unconvertible. Absent
   *  on snapshots predating spec F5. */
  score_canonical?: number | null
  scale_conversion?: ScaleConversion | null
  /** Dataset split as the source reported it (`train`, `test`, `validation`,
   *  `val`, `dev`, or an uncontrolled token like `gpt`). Null when the source
   *  stated none; absent on snapshots predating comparison_index_version 2. */
  split?: string | null
}

export interface ComparisonMetricEntry {
  metric_summary_id: string
  metric_name: string
  metric_id: string | null
  metric_key: string | null
  group: MetricGroup
  group_order: number
  lower_is_better: boolean
  unit: string | null
  /** Registry bounds of the EFFECTIVE metric — the scale `score_canonical`
   *  sits on (e.g. [0,1] for a fold target like wb-score). Null when the
   *  registry declares no bounds; absent on snapshots predating the stamp. */
  canonical_min_score?: number | null
  canonical_max_score?: number | null
  scores: ComparisonScoreEntry[]
}

export interface ComparisonEvalEntry {
  evaluation_id: string
  benchmark_id: string | null
  family_id: string | null
  family_display_name: string | null
  composite_slug: string | null
  composite_display_name: string | null
  parent_benchmark_id: string | null
  display_name: string | null
  category: string
  is_slice: boolean
  is_summary_score: boolean
  summary_score_for: string | null
  /** True on the cross-source merged entry (one best row per model, one
   *  preferred metric). Absent on snapshots that never emitted the flag. */
  is_merged?: boolean
  metrics: ComparisonMetricEntry[]
}

export interface ComparisonByModelEntry {
  score: number
  rank: number
  total: number
  submission_count: number
  submission_axis: SubmissionAxis
  /** Same canonical-scale pair as ComparisonScoreEntry; absent pre-F5. */
  score_canonical?: number | null
  scale_conversion?: ScaleConversion | null
}

export interface ComparisonIndex {
  generated_at: string
  config_version: number
  /** Capability gate for split-aware cross-source peers: >= 2 means every
   *  per-source score entry carries `split`. Absent on older snapshots, which
   *  keep the source-only histogram path. */
  comparison_index_version?: number
  metric_group_order: MetricGroup[]
  evals: Record<string, ComparisonEvalEntry>
  /** Per-model score acceleration map. Optional — slated for removal from the
   *  producer; consumers must fall back to the per-metric scores[] scan. */
  by_model?: Record<string, Record<string, Record<string, ComparisonByModelEntry>>>
}

// ---------------------------------------------------------------------------
// peer-ranks.json — primary-metric peer rank per (eval, model)
// ---------------------------------------------------------------------------

/** Bare map shape consumed by the model-detail benchmark grid. */
export type PeerRanksMap = Record<
  string,
  Record<string, { position: number; total: number }>
>

/** Wrapped sidecar payload emitted by the v2 producer. Older (unversioned)
 *  publishings of peer-ranks.json at the dataset root were a bare map; the
 *  v2 snapshot wraps it with the same `{generated_at, config_version, ...}`
 *  envelope as the other sidecars. */
export interface PeerRanksSidecar {
  generated_at: string
  config_version: number
  ranks: PeerRanksMap
}

// ---------------------------------------------------------------------------
// organizations.json — per-evaluator-org metadata (homepage URL + logo)
// ---------------------------------------------------------------------------

/** Metadata for one reporting org, sourced from the registry (canonical_orgs).
 *  All fields beyond `name` are optional — an org only appears here when it
 *  carries a website or logo_url, so the evaluator page degrades gracefully
 *  (monogram, no link) for everyone absent. */
export interface OrgMetadata {
  /** Canonical display name (matches an `evaluator_names` string). */
  name: string
  /** Canonical org id, when resolved. */
  id?: string
  /** Homepage URL (registry `website`). */
  url?: string
  /** Brand-mark pointer (registry `logo_url`): frontend-relative path or URL. */
  logo?: string
}

/** organizations.json envelope. `orgs` is keyed by the NORMALISED display name
 *  (lower-cased, whitespace-collapsed — see normalizeOrgKey) so the evaluator
 *  page can look an org up directly from the name it already holds. */
export interface OrgMetadataIndex {
  generated_at: string
  orgs: Record<string, OrgMetadata>
}
