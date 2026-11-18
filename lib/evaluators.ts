/**
 * Evaluator (reporting-org) grouping + slug helpers for the /evals
 * "group by Evaluator" view and the /evaluators/<slug> detail route.
 *
 * Frontend-only: every function operates on the already-loaded eval list
 * (`BenchmarkEvalListItem[]` from /api/eval-list-lite). An eval carries
 * `evaluator_names` (de-aliased reporting orgs) and a `verified_evaluator_names`
 * subset (validated submitters). A single eval may name multiple evaluators.
 *
 * Membership rule:
 *   - normal:        (eval, org) counts when org ∈ eval.evaluator_names
 *   - verified-only: (eval, org) counts when org ∈ eval.verified_evaluator_names
 *
 * Slugs are derived deterministically from the full org universe so the
 * list page and the detail route agree on slug→org without a server round
 * trip. Junk org strings (a long university list, "CapArena (Cheng et al.,
 * 2025)") still produce a valid, unique, non-empty slug.
 */

import type { OrgMetadata } from "@/lib/backend-artifacts"
import type { BenchmarkEvalListItem } from "@/lib/eval-processing"
import { normalizeOrgKey } from "@/lib/evaluator-logo"

/** Display-name → registry org metadata (incl. the stable canonical `id`),
 *  as delivered by the organizations.json sidecar (keyed by normalizeOrgKey). */
export type OrgMetaMap = Record<string, OrgMetadata>

/**
 * "Recognized" evaluator orgs — public leaderboards whose results we ingest
 * directly but which are not submitter-verified. They get the grey
 * VerifiedBadge tier (vs the blue verified one). Keys are the view-layer
 * evaluator/source names of the five ingested sources:
 *   artificial_analysis → "Artificial Analysis"
 *   llm_stats           → "LLM Stats"
 *   hfopenllm_v2        → "Hugging Face"
 *   global-mmlu-lite    → "kaggle"
 *   vals_ai             → "Vals.ai"
 * Matched case-insensitively (see isRecognizedEvaluator).
 */
export const RECOGNIZED_EVALUATOR_NAMES = new Set([
  "artificial analysis",
  "llm stats",
  "hugging face",
  "kaggle",
  "vals.ai",
])

/** True when the org name is one of the recognized leaderboard sources. */
export function isRecognizedEvaluator(name: string | null | undefined): boolean {
  if (!name) return false
  return RECOGNIZED_EVALUATOR_NAMES.has(name.trim().toLowerCase())
}

export interface EvaluatorGroup {
  /** Canonical org name as it appears in `evaluator_names`. */
  name: string
  /** URL-safe slug for /evaluators/<slug>. Unique across the corpus. */
  slug: string
  /** Number of evals this org reported (respecting the verified filter). */
  evalCount: number
  /** Number of those evals carrying a trust badge for this org — blue
   *  (verified evaluator for the eval) or grey (org is a recognized source).
   *  For a recognized-only org this equals evalCount. */
  verifiedCount: number
  /** True when the org is a verified evaluator for ≥1 eval (regardless of filter). */
  isVerified: boolean
}

/**
 * Base slug from an arbitrary org string: lowercase, non-alphanumerics →
 * single hyphen, trimmed. Falls back to "evaluator" when the string has no
 * usable characters so we never emit an empty path segment. Length-capped
 * so a pathological org (e.g. a multi-institution author list) doesn't
 * produce an absurd URL — uniqueness is restored by the suffix step.
 */
export function evaluatorSlug(name: string): string {
  const slug = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "")
  return slug || "evaluator"
}

/**
 * Stable, URL-safe slug for an evaluator — the SINGLE source of truth for
 * /evaluators/<slug> URLs (every link builder and the detail-route resolver
 * go through this).
 *
 * When the org resolves to a registry entity (`orgMeta` carries its canonical
 * `id`), the slug is derived from that STABLE id, so renaming the display name
 * never changes the URL. Orgs with no registry entry (raw corpus strings,
 * which can't be renamed) fall back to the display-name slug. `evaluatorSlug`
 * is applied to the id too so the slug stays lowercase/url-safe regardless of
 * id casing (e.g. id "TIGER-Lab" → "tiger-lab").
 */
export function evaluatorSlugFor(name: string, orgMeta?: OrgMetaMap): string {
  const id = orgMeta?.[normalizeOrgKey(name)]?.id
  return id && id.trim() ? evaluatorSlug(id) : evaluatorSlug(name)
}

/** @deprecated internal alias — use {@link evaluatorSlug}. */
const baseSlug = evaluatorSlug

/**
 * Build a deterministic, collision-free slug↔org map over every org that
 * appears in any eval's `evaluator_names`. Orgs are processed in a stable
 * order (name-sorted) so the same corpus always yields the same slugs;
 * collisions get a numeric suffix (`-2`, `-3`, …).
 */
export function buildEvaluatorSlugMap(
  evals: BenchmarkEvalListItem[],
  orgMeta?: OrgMetaMap,
): {
  slugToName: Map<string, string>
  nameToSlug: Map<string, string>
} {
  const names = new Set<string>()
  for (const ev of evals) {
    for (const org of ev.evaluator_names ?? []) {
      const trimmed = (org ?? "").trim()
      if (trimmed) names.add(trimmed)
    }
  }

  const slugToName = new Map<string, string>()
  const nameToSlug = new Map<string, string>()
  const used = new Map<string, number>()

  for (const name of Array.from(names).sort((a, b) => a.localeCompare(b))) {
    const base = evaluatorSlugFor(name, orgMeta)
    const seen = used.get(base) ?? 0
    const slug = seen === 0 ? base : `${base}-${seen + 1}`
    used.set(base, seen + 1)
    slugToName.set(slug, name)
    nameToSlug.set(name, slug)
  }

  return { slugToName, nameToSlug }
}

/**
 * Group the eval list by evaluator org. When `verifiedOnly` is true, an
 * (eval, org) membership only counts where org ∈ verified_evaluator_names,
 * so the result collapses to the genuine validated runners. Returns groups
 * sorted by eval count descending (name as the tie-break).
 */
export function groupEvalsByEvaluator(
  evals: BenchmarkEvalListItem[],
  opts?: { verifiedOnly?: boolean; orgMeta?: OrgMetaMap },
): EvaluatorGroup[] {
  const verifiedOnly = opts?.verifiedOnly ?? false
  const { nameToSlug } = buildEvaluatorSlugMap(evals, opts?.orgMeta)

  const acc = new Map<string, { evalCount: number; verifiedCount: number; isVerified: boolean }>()

  for (const ev of evals) {
    // Slices (is_slice=true) are within-benchmark child rows; the evaluator
    // surfaces count/show only root benchmarks. The /evals family-tree view
    // nests slices under their parent, so excluding them here keeps the flat
    // evaluator list to root benchmarks.
    if (ev.is_slice) continue
    const orgs = ev.evaluator_names ?? []
    const verifiedSet = new Set(ev.verified_evaluator_names ?? [])
    for (const raw of orgs) {
      const org = (raw ?? "").trim()
      if (!org) continue
      const isVerifiedHere = verifiedSet.has(org)
      const recognized = isRecognizedEvaluator(org)
      // In verified-only mode, the membership counts when the org carries a
      // trust badge for this eval — either blue (verified *for this eval*) or
      // grey (a recognized source). Both are surfaced.
      if (verifiedOnly && !isVerifiedHere && !recognized) continue
      const cur = acc.get(org) ?? { evalCount: 0, verifiedCount: 0, isVerified: false }
      cur.evalCount += 1
      // verifiedCount spans both trust tiers (blue verified-here or grey
      // recognized) so a recognized-only org reports its full count, not 0.
      // isVerified stays blue-only — it drives the blue vs grey badge tier.
      if (isVerifiedHere || recognized) cur.verifiedCount += 1
      if (isVerifiedHere) cur.isVerified = true
      acc.set(org, cur)
    }
  }

  const groups: EvaluatorGroup[] = []
  for (const [name, v] of acc) {
    groups.push({
      name,
      slug: nameToSlug.get(name) ?? evaluatorSlugFor(name, opts?.orgMeta),
      evalCount: v.evalCount,
      verifiedCount: v.verifiedCount,
      isVerified: v.isVerified,
    })
  }

  groups.sort((a, b) => b.evalCount - a.evalCount || a.name.localeCompare(b.name))
  return groups
}

/**
 * Evals reported by a single evaluator org (resolved from its slug). When
 * `verifiedOnly` is true, restrict to evals where the org is a verified
 * evaluator. Returns `{ name, evals }`; `name` is null when the slug
 * resolves to no org (404 on the detail page).
 */
export function getEvalsForEvaluator(
  allEvals: BenchmarkEvalListItem[],
  slug: string,
  opts?: { verifiedOnly?: boolean; orgMeta?: OrgMetaMap },
): { name: string | null; isVerified: boolean; evals: BenchmarkEvalListItem[] } {
  const verifiedOnly = opts?.verifiedOnly ?? false
  const { slugToName } = buildEvaluatorSlugMap(allEvals, opts?.orgMeta)
  // Direct hit on the (possibly collision-suffixed) full slug, else fall back
  // to base-slug matching so links built from the shared `evaluatorSlug(name)`
  // helper — which can't see the suffix step — still resolve. The fallback is
  // deterministic via the same name-sorted order buildEvaluatorSlugMap uses.
  let name = slugToName.get(slug) ?? null
  if (!name) {
    for (const [, candidate] of Array.from(slugToName.entries()).sort((a, b) =>
      a[1].localeCompare(b[1]),
    )) {
      if (evaluatorSlugFor(candidate, opts?.orgMeta) === slug) {
        name = candidate
        break
      }
    }
  }
  if (!name) return { name: null, isVerified: false, evals: [] }

  let isVerified = false
  const recognized = isRecognizedEvaluator(name)
  const evals = allEvals.filter((ev) => {
    // Exclude slices — evaluator surfaces show root benchmarks only.
    if (ev.is_slice) return false
    const orgs = ev.evaluator_names ?? []
    if (!orgs.includes(name)) return false
    const verifiedHere = (ev.verified_evaluator_names ?? []).includes(name)
    if (verifiedHere) isVerified = true
    // Verified-only keeps both trust tiers: blue (verified for this eval) and
    // grey (recognized source — applies to all of the org's evals).
    if (verifiedOnly) return verifiedHere || recognized
    return true
  })

  return { name, isVerified, evals }
}

/**
 * Evaluation_ids that have ≥1 verified evaluator — drives the Family-mode
 * "Verified only" filter (restrict the family tree to verified evals).
 */
export function verifiedEvalIds(evals: BenchmarkEvalListItem[]): Set<string> {
  const out = new Set<string>()
  for (const ev of evals) {
    if ((ev.verified_evaluator_names ?? []).length > 0) out.add(ev.evaluation_id)
  }
  return out
}
