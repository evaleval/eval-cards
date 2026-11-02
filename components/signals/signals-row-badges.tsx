"use client"

import type { ComparabilityStatus, RowAnnotations } from "@/lib/backend-artifacts"
import { cn } from "@/lib/utils"
import { CrossPartyDivergenceBadge } from "./cross-party-divergence-badge"
import { isNotAssessable } from "./signal-utils"
import { VariantDivergenceBadge } from "./variant-divergence-badge"

/**
 * Renders the row-level divergence badges (variant + cross-party, or "not
 * assessable" when the row's comparability was never assessed).
 *
 * Two signals are intentionally NOT rendered here:
 * - Provenance: every leaderboard that carries this strip already has an
 *   EVALUATOR column (first/third-party pill), and showing the same fact
 *   twice in two styles confused readers.
 * - Reproducibility: most results leave at least one of the eight setup
 *   items undisclosed, so a per-row badge fired on most rows and drowned
 *   the divergence badges. It stays in the eval page's signals strip, the
 *   merged view's R flag square and, in research view, the per-result
 *   reproducibility card.
 */
export function SignalsRowBadges({
  annotations,
  comparabilityStatus,
  className,
  hideOnMobile = true,
}: {
  annotations?: RowAnnotations | null
  /** The row's comparability verdict, when the caller has it
   *  outside the annotation block (eval_results_view ships it flat). */
  comparabilityStatus?: ComparabilityStatus | null
  className?: string
  hideOnMobile?: boolean
}) {
  // Strict `=== true` — the flags are nullable and a NULL is
  // "not assessable", which the variant badge renders in its own right.
  const hasVariant = annotations?.variant_divergence?.has_variant_divergence === true
  const hasCrossParty = annotations?.cross_party_divergence?.has_cross_party_divergence === true
  // A row whose comparability group was never assessed carries the verdict
  // on the row itself, so it earns a chip even when the producer attached
  // no annotation struct to it.
  const notAssessable = isNotAssessable(annotations, comparabilityStatus)

  if (!hasVariant && !hasCrossParty && !notAssessable) {
    return null
  }

  return (
    <div
      className={cn(
        "mt-1.5 flex flex-wrap justify-end gap-1.5",
        hideOnMobile && "hidden md:flex",
        className
      )}
    >
      <VariantDivergenceBadge
        divergence={annotations?.variant_divergence}
        annotations={annotations}
        comparabilityStatus={comparabilityStatus}
      />
      <CrossPartyDivergenceBadge divergence={annotations?.cross_party_divergence} />
    </div>
  )
}
