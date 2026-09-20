/**
 * Benchmark-first evaluation schema types
 * Based on the evalevalai.com schema structure
 */

import type { EvalcardsAnnotations, RowAnnotations, SignalSummaries } from "@/lib/backend-artifacts"

// TODO: standardize eval-id naming across the frontend. `eval_summary_id`
// (raw warehouse evaluation_id) vs `evaluation_id` (always-present, sometimes
// synthetic key) are distinct but confusingly named; the whole eval-id /
// constituent-id vocabulary needs a cleanup pass to match the backend contract.
export interface BenchmarkEvaluation {
  schema_version: string
  eval_summary_id?: string
  evaluation_id: string
  retrieved_timestamp: string
  /** Legacy benchmark-name-or-slug field. The view-data layer
   *  (lib/view-data.ts) populates this from eval_evaluation_name with a
   *  benchmark_id fallback, so it works as a stable name source for
   *  badges and grouping when nothing better is on-hand. New callers
   *  should prefer `display_name` / `canonical_display_name`; this
   *  field is kept for the surfaces that aren't yet migrated. */
  benchmark?: string
  display_name?: string
  canonical_display_name?: string
  derived_tags?: EvalTag[]
  family_id?: string
  benchmark_family_name?: string
  parent_benchmark_id?: string
  benchmark_parent_name?: string
  /** Display name of the parent benchmark for slice rows (additive view
   *  column; absent on older snapshots, null for non-slice rows). */
  parent_benchmark_display_name?: string
  benchmark_leaf_name?: string
  is_slice?: boolean
  benchmark_component_key?: string | null
  benchmark_component_name?: string | null
  is_summary_score?: boolean
  slice_key?: string
  slice_name?: string

  source_data: string[] | SourceData
  source_metadata: SourceMetadata
  eval_library?: EvalLibrary
  model_info: ModelInfo
  generation_config?: GenerationConfig
  evaluation_results: EvaluationResult[]
  detailed_evaluation_results_per_samples?: SampleResult[]
  evalcards?: { annotations?: EvalcardsAnnotations }
}

export interface EvalLibrary {
  name: string
  version?: string
  additional_details?: Record<string, any>
}

export interface SourceData {
  dataset_name: string
  source_type?: string
  hf_repo?: string
  hf_split?: string
  samples_number?: number
  url?: string[]
  dataset_url?: string
  dataset_version?: string
  [key: string]: any
}

export interface SourceMetadata {
  source_name?: string
  source_type: 'evaluation_run' | 'documentation' | 'paper' | 'leaderboard'
  source_organization_name: string
  source_organization_url?: string
  evaluator_relationship: 'first_party' | 'third_party' | 'collaborative' | 'other'
  source_url?: string
  publication_date?: string
}

export interface ModelInfo {
  name: string
  id: string
  developer?: string
  inference_platform?: string
  inference_engine?: string
  model_version?: string
  architecture?: string
  parameter_count?: string
  release_date?: string
  model_url?: string
  // Same tri-state as EvaluationCardData.open_weights.
  open_weights?: boolean | null
  additional_details?: {
    precision?: string
    architecture?: string
    params_billions?: number | string
    [key: string]: any
  }
  modalities?: {
    input: string[]
    output: string[]
  }
}

export interface EvaluationResult {
  evaluation_name: string
  display_name?: string
  canonical_display_name?: string
  metric_summary_id?: string
  metric_key?: string
  evaluation_timestamp: string
  source_data?: string[] | SourceData
  metric_config: MetricConfig
  score_details: ScoreDetails
  detailed_evaluation_results_url?: string
  generation_config?: GenerationConfig
  evalcards?: { annotations?: RowAnnotations }
  /** Per-result verification flag emitted by the producer's
   *  `eval_results_view.is_verified_evaluator` column (one boolean per
   *  (model, benchmark, metric) triple). When true the UI renders a
   *  small VerifiedBadge next to the metric value. Nullable/absent for
   *  snapshots produced before the column shipped — treated as
   *  unverified. */
  is_verified_evaluator?: boolean
}

export interface MetricConfig {
  evaluation_description: string
  lower_is_better: boolean
  score_type: 'continuous' | 'discrete' | 'binary'
  min_score?: number
  max_score?: number
  unit?: string
}

export interface ScoreDetails {
  score: number
  details?: Record<string, any>
  confidence_interval?: {
    lower: number
    upper: number
    confidence_level: number
  }
  sample_size?: number
  standard_error?: number
}

export interface GenerationConfig {
  num_few_shot?: number
  generation_args?: {
    temperature?: number
    top_p?: number
    top_k?: number
    max_tokens?: number
    reasoning?: boolean
    [key: string]: any
  }
  additional_details?: string | Record<string, any>
  prompt_template?: string
}

export interface SampleResult {
  sample_id: string
  input: string
  ground_truth?: string
  response: string
  choices?: string[]
  is_correct?: boolean
  metadata?: Record<string, any>
}

/**
 * Evaluation tags — the 17-tag vocabulary emitted by the pipeline's
 * derived_tags (replaces the legacy 5-bucket category system). Ordering
 * matches the producer (evalcard_tags.py) for stable UI display. Tags
 * overlap: a benchmark/eval can carry several.
 */
export const EVALUATION_TAGS = [
  'general',
  'knowledge',
  'safety',
  'agentic',
  'mathematics',
  'logical_reasoning',
  'commonsense_reasoning',
  'applied_reasoning',
  'software_engineering',
  'linguistic_core',
  'multimodal',
  'natural_sciences',
  'humanities_and_social_sciences',
  'law',
  'finance',
  'hallucination',
  'robustness',
] as const

/** A derived evaluation tag. Kept as a widened string (not a strict
 *  union) so values coming straight off the warehouse JSON never trip
 *  the type boundary; EVALUATION_TAGS is the canonical ordered list. */
export type EvalTag = string

const TAG_COLORS: Record<string, string> = {
  general: 'bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-950/40 dark:text-sky-200',
  knowledge: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200',
  safety: 'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/40 dark:text-rose-200',
  agentic: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-200',
  mathematics: 'bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-950/40 dark:text-violet-200',
  logical_reasoning: 'bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-200',
  commonsense_reasoning: 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-950/40 dark:text-purple-200',
  applied_reasoning: 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200 dark:bg-fuchsia-950/40 dark:text-fuchsia-200',
  software_engineering: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-950/40 dark:text-blue-200',
  linguistic_core: 'bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-950/40 dark:text-teal-200',
  multimodal: 'bg-cyan-100 text-cyan-800 border-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-200',
  natural_sciences: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-950/40 dark:text-green-200',
  humanities_and_social_sciences: 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-950/40 dark:text-orange-200',
  law: 'bg-stone-100 text-stone-800 border-stone-200 dark:bg-stone-900/40 dark:text-stone-200',
  finance: 'bg-lime-100 text-lime-800 border-lime-200 dark:bg-lime-950/40 dark:text-lime-200',
  hallucination: 'bg-pink-100 text-pink-800 border-pink-200 dark:bg-pink-950/40 dark:text-pink-200',
  robustness: 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-200',
}

/**
 * Human-readable label for a tag (snake_case → Title Case).
 */
export function tagLabel(tag: string): string {
  return tag
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Returns Tailwind badge classes for a given tag.
 */
export function getTagColor(tag: string): string {
  return TAG_COLORS[tag] ?? 'bg-muted text-muted-foreground border-border'
}

// Regex fallback: derive tags from a benchmark name when the warehouse
// didn't supply derived_tags. Mirrors the producer's _FALLBACK_RULES
// (evalcard_tags.py). Returns 1+ tags; defaults to ['general'].
const TAG_FALLBACK_RULES: Array<[RegExp, EvalTag]> = [
  [/\b(?:safety|harmful|toxic|truthful|unsafe|civilcomments|civil_comments|jailbreak|red[-_]?team|adversarial)\b/i, 'safety'],
  [/\b(?:agent|swe[-_]?bench\b|terminal[-_]?bench\b|tau[-_]?bench\b|appworld\b|browsecomp\b)/i, 'agentic'],
  [/\b(?:math|gsm|aime|minerva|olympiad|arithmetic)\b/i, 'mathematics'],
  [/\b(?:code|humaneval|livecodebench|mbpp|codecontests|apps|bigcodebench|swe)\b/i, 'software_engineering'],
  [/\b(?:reasoning|bbh|musr|gpqa|arc[-_]?c|logiqa|winogrande)\b/i, 'applied_reasoning'],
  [/\b(?:mmlu|knowledge|trivia|medqa|legalbench|theory[-_]?of[-_]?mind)\b/i, 'knowledge'],
  [/\b(?:multimodal|vision|vqa|mmmu|image|video|visual)\b/i, 'multimodal'],
  [/(?:hallucin|\bfaithful|\bfactual)/i, 'hallucination'],
  [/(?:robust|\bperturbation|\bnoisy|\bcorrupted)/i, 'robustness'],
  [/\b(?:legal|law|jurisprudence)\b/i, 'law'],
  [/\b(?:finance|financial|trading|accounting)\b/i, 'finance'],
]

/**
 * Helper to derive tags from a benchmark name. The pipeline now provides
 * derived_tags directly, so this is only a fallback for names the
 * warehouse left untagged.
 */
export function inferTagsFromBenchmark(benchmarkName: string): EvalTag[] {
  // First matching rule wins, exactly as the producer's resolve_benchmark_tags
  // does; a union here made the two repos tag the same fallback name
  // differently (SWE-bench-Live: agentic vs agentic + software_engineering).
  const hit = TAG_FALLBACK_RULES.find(([re]) => re.test(benchmarkName))
  return hit ? [hit[1]] : ['general']
}

/**
 * Aggregate evaluations by model
 */
export interface ModelSummaryCore extends SignalSummaries {
  model_info: ModelInfo
  evaluations_by_tag: Record<string, BenchmarkEvaluation[]>
  total_evaluations: number
  last_updated: string
  tags_covered: EvalTag[]
  // model-resolution-rework (additive, all nullable). Server-provided model
  // identity provenance; surfaced on the model detail page. Carried here on
  // the core so both the summary and variant shapes expose them.
  lineage_origin_model_id?: string    // deepest non-variant ancestor (base model)
  resolution_source?: string          // enum: hf | models_dev | curated | inferred | none
  resolution_granularity?: string     // enum: variant | group | family
}

export interface ModelVariantSummary extends ModelSummaryCore {
  variant_id: string
  variant_key: string
  variant_label: string
  variant_display_name: string
  raw_model_ids: string[]
  family_id: string
  family_name: string
  version_date?: string
  version_qualifier?: string
}

export interface ModelEvaluationSummary extends ModelSummaryCore {
  model_group_id: string
  model_route_id: string
  model_family_name: string
  raw_model_ids: string[]
  variants: ModelVariantSummary[]
}

/**
 * Display-friendly format for the UI
 */
export interface EvaluationCardData {
  id: string
  route_id: string
  model_name: string
  model_id: string
  canonical_model_name: string
  developer: string
  evaluations_count: number
  benchmarks_count: number
  variant_count: number
  tags: EvalTag[]
  tag_stats: Record<string, number>
  latest_timestamp: string
  evaluator_count: number
  evaluator_names: string[]
  source_type_count: number
  source_types: Array<SourceMetadata["source_type"]>
  evidence_count: number
  missing_generation_config_count: number
  third_party_eval_count: number
  independent_verification_ratio: number
  reproducibility_status: "complete" | "partial" | "missing"
  eval_libraries: Array<{
    name: string
    version?: string
    fork?: string
  }>
  latest_source_name?: string
  params_billions?: number | null
  // TRUE = weights published, FALSE = registry-curated closed, null/absent =
  // unknown. See `lib/model-openness.ts` — null is NOT closed.
  open_weights?: boolean | null
  benchmark_names?: string[]
  score_summary?: {
    count: number
    min: number
    max: number
    average: number | null
  }
  reproducibility_summary?: SignalSummaries["reproducibility_summary"]
  provenance_summary?: SignalSummaries["provenance_summary"]
  comparability_summary?: SignalSummaries["comparability_summary"]
  
  // Quick stats
  top_scores: Array<{
    benchmark: string
    benchmarkKey?: string
    score: number
    metric: string
  }>
  
  // Links
  source_urls: string[]
  detail_urls: string[]

  // Model Metadata (from auxiliary sources or model_metadata.json)
  model_url?: string
  release_date?: string
  input_modalities?: string[]
  output_modalities?: string[]
  architecture?: string
  params?: string
  inference_engine?: string
  inference_platform?: string

  // model-resolution-rework (additive, all nullable). Server-provided
  // (producer view layer) — the frontend no longer computes families
  // client-side. See notes/backend-v2-migration.md.
  model_group_id?: string             // group canonical id (membership / grouping root)
  lineage_origin_model_id?: string    // deepest non-variant ancestor (base model)
  resolution_source?: string          // enum: hf | models_dev | curated | inferred | none
  resolution_granularity?: string     // enum: variant | group | family
}

// ── Benchmark Card types (from metadata/benchmark_card_*.json) ────────────────

export interface BenchmarkCardDetails {
  name: string
  overview: string
  data_type: string
  domains: string[]
  languages: string[]
  similar_benchmarks: string[] | string
  resources: string[]
}

export interface BenchmarkCardPurpose {
  goal: string
  audience: string[] | string
  tasks: string[]
  limitations: string
  out_of_scope_uses: string[] | string
}

export interface BenchmarkCardData {
  source: string
  size: string
  format: string
  annotation: string
}

export interface BenchmarkCardMethodology {
  methods: string[]
  metrics: string[]
  calculation: string
  interpretation: string
  baseline_results: string
  validation: string
}

export interface BenchmarkCardEthical {
  privacy_and_anonymity: string
  data_licensing: string
  consent_procedures: string
  compliance_with_regulations: string
}

export interface BenchmarkCardRisk {
  category: string
  description: string[]
  url: string
}

export interface BenchmarkCard {
  benchmark_details: BenchmarkCardDetails
  purpose_and_intended_users: BenchmarkCardPurpose
  data: BenchmarkCardData
  methodology: BenchmarkCardMethodology
  ethical_and_legal_considerations: BenchmarkCardEthical
  possible_risks: BenchmarkCardRisk[]
  flagged_fields: Record<string, string>
  missing_fields: string[]
  card_info: {
    created_at: string
    llm: string
  }
}
