/**
 * Rule-based plain-language summaries for the policy-mode views.
 *
 * Pure templating — no live LLM calls. Each function takes a structured
 * data object (model summary, eval summary, signal block) and returns
 * either a single sentence or a small struct of paragraph fragments.
 *
 * Templating rules of thumb:
 *   - Lead with the headline (numbers / coverage), then the caveat.
 *   - Pick exactly one phrasing per branch — readers should never see
 *     two stitched-together fragments that mean the same thing.
 *   - "Not specified" sentinels collapse silently (caller decides whether
 *     to render the row at all).
 */
import type { ModelSummaryCore, BenchmarkEvaluation, MetricConfig } from "@/lib/benchmark-schema"
import type { BenchmarkEvalSummary } from "@/lib/eval-processing"
import type { ProvenanceSummary, ReproducibilitySummary, ComparabilitySummary } from "@/lib/backend-artifacts"
import { formatTagLabel } from "@/lib/benchmark-tags"

// ---------------------------------------------------------------------------
// Sentence-list helpers (kept tiny & pure — no JSX, no React)
// ---------------------------------------------------------------------------

/** Oxford-comma list with "and". `["a","b","c"]` → `"a, b, and c"`. */
export function listAnd(items: readonly string[]): string {
  if (items.length === 0) return ""
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`
}

/** Plural-aware count phrase. `(1, "result")` → `"1 result"`. */
export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural ?? `${singular}s`}`
}

/**
 * Categories the EvalCards taxonomy can express. We compare against this
 * canonical list to surface what *isn't* reported, not just what is.
 *
 * Sourced from data/benchmarks/categories.json — top-level tags that the
 * derivedTag pipeline produces. We list the headliners only; obscure
 * categories ("multilingual_general", "video_understanding") aren't
 * useful as gap-callouts on a policy summary.
 */
export const HEADLINE_POLICY_CATEGORIES = [
  "general",
  "knowledge",
  "logical_reasoning",
  "applied_reasoning",
  "mathematics",
  "coding",
  "agentic",
  "safety",
  "multilingual_general",
  "multimodal",
] as const

/**
 * Map a derivedTag category into a small bucket of "policy-relevant"
 * groupings, so e.g. logical_reasoning + applied_reasoning collapse to
 * "Reasoning" for a non-technical reader. Returns null when the input is
 * neither headlinable nor in the policy bucket map.
 */
const POLICY_BUCKETS: Record<string, string> = {
  general: "General capability",
  knowledge: "Knowledge",
  logical_reasoning: "Reasoning",
  applied_reasoning: "Reasoning",
  commonsense_reasoning: "Reasoning",
  mathematics: "Math",
  coding: "Coding",
  software_engineering: "Coding",
  agentic: "Agentic",
  safety: "Safety",
  multilingual_general: "Multilingual",
  multimodal: "Multimodal",
}

/** Group categories into ~6 policy-readable buckets. */
export function bucketCategories(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of tags) {
    const bucket = POLICY_BUCKETS[tag]
    if (bucket && !seen.has(bucket)) {
      seen.add(bucket)
      out.push(bucket)
    }
  }
  return out
}

const HEADLINE_BUCKET_LIST = ["General capability", "Knowledge", "Reasoning", "Math", "Coding", "Agentic", "Safety"] as const

/** Buckets we'd expect a frontier general-purpose model to report on. */
function expectedBuckets(): readonly string[] {
  return HEADLINE_BUCKET_LIST
}

// ---------------------------------------------------------------------------
// MODEL view — produces the Measures / Caveat / Coverage / Reporting block.
// ---------------------------------------------------------------------------

export interface ModelPolicySummary {
  /** "Reported across N benchmarks in K categories." */
  scopeSentence: string
  /** "Coverage spans Reasoning, Knowledge, and Agentic." (or null when there's only one category) */
  coverageSentence: string | null
  /** "No Safety or Math evaluations have been reported." Returns null when nothing material is missing. */
  gapSentence: string | null
  /** "Reported by Anthropic (the developer) and one independent third party." */
  reportingSentence: string
  /** "X% of reported scores (N of M) disclose every setup item that applies to them." or null when there is no data. */
  reproducibilitySentence: string | null
  /** "Comparing scores directly is limited because reporting setups differ." or null. */
  comparabilitySentence: string | null
  /** "Independently verified across N benchmarks." used as the optional headline tag. */
  verificationLabel: string | null
}

interface ModelPolicyInputs {
  /** Accepts any ModelSummaryCore-shaped object — the model page passes
   *  either the family summary or a selected variant. We only read the
   *  signal-summary blocks plus `total_evaluations`. */
  summary: ModelSummaryCore
  /** Pre-computed third-party tally from caller (cheap to compute, but
   *  caller already has it in benchmark-detail). */
  thirdPartyEvaluations: number
  /** Denominator for the third-party share. MUST be counted from the same
   *  population as `thirdPartyEvaluations` (the caller's flattened evaluation
   *  list), not the warehouse's distinct `total_evaluations` — those have
   *  different grains, which made the share exceed 100%. */
  reportedEvaluationCount: number
  organizationCount: number
  organizationNames: string[]
  /** Distinct benchmark count derived from group reduction. */
  benchmarkCount: number
  /** Categories actually reported, derived-tag form (snake_case). */
  reportedCategories: readonly string[]
}

export function buildModelPolicySummary({
  summary,
  thirdPartyEvaluations,
  reportedEvaluationCount,
  organizationCount,
  organizationNames,
  benchmarkCount,
  reportedCategories,
}: ModelPolicyInputs): ModelPolicySummary {
  const totalEvals = summary.total_evaluations
  // Denominator for the third-party share, counted from the same population as
  // the numerator so the ratio stays within 0–100%. Falls back to totalEvals
  // only if the caller passed nothing.
  const thirdPartyBase = reportedEvaluationCount > 0 ? reportedEvaluationCount : totalEvals
  const repro = summary.reproducibility_summary
  const reproGap = repro?.has_reproducibility_gap_count ?? 0
  const reproTotal = repro?.results_total ?? totalEvals
  const provenance = summary.provenance_summary
  const comparability = summary.comparability_summary

  // ── 1. Scope ────────────────────────────────────────────────────────────
  const scopeSentence =
    benchmarkCount === 0
      ? "No benchmark evaluations have been reported for this model."
      : `Reported across ${pluralize(benchmarkCount, "benchmark")}` +
        (totalEvals > benchmarkCount
          ? ` (${pluralize(totalEvals, "result")} total).`
          : ".")

  // ── 2. Coverage / Gap (the "missing categories" piece the user wanted) ──
  const reportedBuckets = bucketCategories(reportedCategories)
  let coverageSentence: string | null = null
  let gapSentence: string | null = null

  if (reportedBuckets.length > 1) {
    coverageSentence = `Coverage spans ${listAnd(reportedBuckets)}.`
  } else if (reportedBuckets.length === 1) {
    coverageSentence = `Coverage is concentrated in ${reportedBuckets[0]} only.`
  }

  if (reportedBuckets.length > 0) {
    const reportedSet = new Set(reportedBuckets)
    const missing = expectedBuckets().filter((b) => !reportedSet.has(b))
    // Only flag a gap when there's a meaningful absence — at least one
    // category reported AND at least one common bucket missing. We cap the
    // list at three to stay readable.
    if (missing.length > 0 && missing.length < expectedBuckets().length) {
      const head = missing.slice(0, 3)
      const trail = missing.length > 3 ? ` (and ${missing.length - 3} other categories)` : ""
      gapSentence =
        head.length === 1
          ? `No ${head[0]} evaluations have been reported.`
          : `No ${listAnd(head)} evaluations have been reported${trail}.`
    }
  }

  // ── 3. Reporting (provenance) ───────────────────────────────────────────
  const firstPartyOnly =
    provenance?.first_party_only_groups != null && provenance.total_groups > 0
      ? provenance.first_party_only_groups === provenance.total_groups
      : null
  const allThirdParty = thirdPartyBase > 0 && thirdPartyEvaluations === thirdPartyBase
  const noThirdParty = thirdPartyEvaluations === 0 && thirdPartyBase > 0
  const lead = organizationNames[0]

  let reportingSentence: string
  if (organizationCount === 0) {
    reportingSentence = "No reporting organization is recorded."
  } else if (organizationCount === 1 && lead) {
    reportingSentence = allThirdParty
      ? `Tested independently by ${lead} (a third party, not the model's developer).`
      : noThirdParty
        ? `Reported only by ${lead}; no independent third-party scores are available.`
        : `Reported by ${lead}.`
  } else if (lead) {
    const others = organizationCount - 1
    reportingSentence = allThirdParty
      ? `Tested independently by ${lead} and ${pluralize(others, "other organization")}.`
      : noThirdParty
        ? `Reported by ${lead} and ${pluralize(others, "other organization")}, but no independent third-party scores are available.`
        : `Reported by ${lead} and ${pluralize(others, "other organization")}.`
  } else {
    reportingSentence = `Reported by ${pluralize(organizationCount, "organization")}.`
  }

  // ── 4. Reproducibility gap (plain language, no field names) ────────────
  let reproducibilitySentence: string | null = null
  if (reproTotal > 0) {
    if (reproGap === 0) {
      reproducibilitySentence = "Every reported score discloses the setup items that apply to it."
    } else if (reproGap === reproTotal) {
      reproducibilitySentence =
        "No reported score discloses every setup item that applies to it. Scores cannot be independently re-run as reported."
    } else {
      const documented = reproTotal - reproGap
      const pct = Math.round((documented / reproTotal) * 100)
      reproducibilitySentence = `${pct}% of reported scores (${documented} of ${reproTotal}) disclose every setup item that applies to them. The rest cannot be re-run as-is.`
    }
  }

  // ── 5. Comparability caveat (no field names) ──────────────────────────
  let comparabilitySentence: string | null = null
  if (comparability) {
    const variantHits = comparability.variant_divergent_count
    const crossPartyHits = comparability.cross_party_divergent_count
    const noCrossPartyChecks = comparability.groups_with_cross_party_check === 0
    if (variantHits === 0 && crossPartyHits === 0 && !noCrossPartyChecks) {
      comparabilitySentence = "Where multiple reports are available, scores agree closely across setups and reporters."
    } else if (variantHits > 0 && crossPartyHits > 0) {
      comparabilitySentence = `Scores diverge across reporting setups in ${pluralize(variantHits, "case")} and across different reporters in ${pluralize(crossPartyHits, "case")}; some apparent score gaps may reflect setup choices rather than capability.`
    } else if (variantHits > 0) {
      comparabilitySentence = `Scores diverge across reporting setups in ${pluralize(variantHits, "case")}; apparent score gaps may partly reflect those setup choices.`
    } else if (crossPartyHits > 0) {
      comparabilitySentence = `Different reporters disagree on ${pluralize(crossPartyHits, "score")}; treat headline numbers as a range rather than a single value.`
    } else if (noCrossPartyChecks) {
      comparabilitySentence = "No third-party reports are available to cross-check the developer's numbers."
    }
  } else if (firstPartyOnly === true) {
    comparabilitySentence = "Only the model's developer has reported these scores; cross-party comparison is not possible."
  }

  // ── 6. Verification headline ─────────────────────────────────────────
  let verificationLabel: string | null = null
  if (allThirdParty && thirdPartyBase > 0) {
    verificationLabel = "100% third party"
  } else if (thirdPartyEvaluations > 0 && thirdPartyBase > 0) {
    const pct = Math.min(100, Math.round((thirdPartyEvaluations / thirdPartyBase) * 100))
    verificationLabel = `${pct}% third party`
  } else if (noThirdParty) {
    verificationLabel = "Developer-reported only"
  }

  return {
    scopeSentence,
    coverageSentence,
    gapSentence,
    reportingSentence,
    reproducibilitySentence,
    comparabilitySentence,
    verificationLabel,
  }
}

// ---------------------------------------------------------------------------
// EVAL view — produces single-sentence narrative for each of the four
// interpretive signals (used by the policy-mode panel renderers).
// ---------------------------------------------------------------------------

export interface EvalPolicySignals {
  metricSentence: string
  reproducibilitySentence: string | null
  provenanceSentence: string | null
  comparabilitySentence: string | null
}

export function buildEvalPolicySignals(summary: BenchmarkEvalSummary): EvalPolicySignals {
  const cfg = summary.metric_config
  const metricSentence = formatMetricSentence(cfg)

  const reproducibilitySentence = formatReproducibilitySentence(summary.reproducibility_summary)
  const provenanceSentence = formatProvenanceSentence(summary)
  const comparabilitySentence = formatComparabilitySentence(summary.comparability_summary)

  return {
    metricSentence,
    reproducibilitySentence,
    provenanceSentence,
    comparabilitySentence,
  }
}

function formatMetricSentence(cfg: MetricConfig): string {
  const lower = cfg.lower_is_better
  const min = cfg.min_score
  const max = cfg.max_score

  const direction = lower
    ? "Lower scores indicate better performance"
    : "Higher scores indicate better performance"

  // Only mention the scale when both ends are documented and look like a
  // tidy interval. Otherwise the sentence collapses to direction-only.
  if (typeof min === "number" && typeof max === "number" && max > min) {
    if (min === 0 && max === 1) return `${direction}, on a 0 to 1 scale.`
    if (min === 0 && max === 100) return `${direction}, on a 0 to 100 scale.`
    return `${direction}, on a ${min} to ${max} scale.`
  }
  return `${direction}.`
}

function formatReproducibilitySentence(repro?: ReproducibilitySummary): string | null {
  if (!repro || repro.results_total === 0) return null
  const total = repro.results_total
  const gap = repro.has_reproducibility_gap_count
  if (gap === 0) {
    return "Every reported score discloses the setup items that apply to it."
  }
  if (gap === total) {
    return "No reported score discloses every setup item that applies to it. Scores cannot be independently re-run as reported."
  }
  const documented = total - gap
  const pct = Math.round((documented / total) * 100)
  return `${pct}% of reported scores (${documented} of ${total}) disclose every setup item that applies to them.`
}

function formatProvenanceSentence(summary: BenchmarkEvalSummary): string | null {
  const prov: ProvenanceSummary | undefined = summary.provenance_summary
  if (!prov) {
    // Fall back to coarser ratio when the summary isn't attached.
    if (summary.third_party_ratio === 0) {
      return "These scores were reported only by the model developers themselves."
    }
    if (summary.third_party_ratio === 1) {
      return "These scores were reported by independent third parties, not the model developers."
    }
    return null
  }
  const total = prov.total_groups
  if (total === 0) return null
  const firstPartyOnly = prov.first_party_only_groups
  const multi = prov.multi_source_groups
  if (firstPartyOnly === total) {
    return "Every reported score on this benchmark comes only from the model's own developer; no independent third-party numbers are available."
  }
  if (firstPartyOnly === 0 && multi === 0) {
    return "All reported scores come from independent third parties rather than the model developers."
  }
  if (multi > 0) {
    const pctMulti = Math.round((multi / total) * 100)
    return `${pctMulti}% of reported scores have been corroborated by more than one reporting organization.`
  }
  return null
}

function formatComparabilitySentence(comp?: ComparabilitySummary): string | null {
  if (!comp || comp.total_groups === 0) return null
  const variant = comp.variant_divergent_count
  const crossParty = comp.cross_party_divergent_count
  const noCrossPartyChecks = comp.groups_with_cross_party_check === 0
  if (variant === 0 && crossParty === 0 && !noCrossPartyChecks) {
    return "Where multiple reports exist, the scores agree closely; direct comparison across reports is reasonable."
  }
  if (variant > 0 && crossParty > 0) {
    return "These scores have been reported under different setups and by different organizations, which may explain some of the variation seen across reports."
  }
  if (variant > 0) {
    return "These scores have been reported under different evaluation setups, which may explain some of the variation across reports."
  }
  if (crossParty > 0) {
    return "Different organizations have reported notably different numbers for the same model on this benchmark."
  }
  if (noCrossPartyChecks) {
    return "No independent third-party reports are available to cross-check the developer's numbers."
  }
  return null
}

// ---------------------------------------------------------------------------
// Helpers used by the existing policySummary lede in benchmark-detail.tsx,
// re-exported so the inline copy can be replaced.
// ---------------------------------------------------------------------------

/**
 * Pull derived-tag categories off a flat list of evaluations. Useful when the
 * caller already has the per-result entries grouped in the page.
 */
export function collectReportedCategoriesFromEvals(
  evaluations: readonly BenchmarkEvaluation[],
  resolveCategory: (e: BenchmarkEvaluation) => string | null | undefined
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const evaluation of evaluations) {
    const cat = resolveCategory(evaluation)
    if (!cat) continue
    if (!seen.has(cat)) {
      seen.add(cat)
      out.push(cat)
    }
  }
  return out
}

/** "Reasoning, Knowledge, Agentic" — for compact category badge rows. */
export function formatPolicyBucketsCompact(tags: readonly string[]): string {
  return bucketCategories(tags).join(" · ")
}

/** Pretty-print a derivedTag for the rare case the policy bucket falls
 *  through (we still want a friendly word, not snake_case). */
export function formatTagAsPolicyLabel(tag: string): string {
  return formatTagLabel(tag)
}
