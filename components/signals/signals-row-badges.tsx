"use client"

import type { ComparabilityStatus, RowAnnotations } from "@/lib/backend-artifacts"
import { cn } from "@/lib/utils"
import { CrossPartyDivergenceBadge } from "./cross-party-divergence-badge"
import { VariantDivergenceBadge } from "./variant-divergence-badge"

/**
 * Renders the row-level positive divergence badges (variant + cross-party).
 *
 * Three signals are intentionally NOT rendered inside table cells:
 * - Provenance: every leaderboard that carries this strip already has an
 *   EVALUATOR column (first/third-party pill), and showing the same fact
 *   twice in two styles confused readers.
 * - Reproducibility: most results leave at least one of the eight setup
 *   items undisclosed, so a per-row badge fired on most rows and drowned
 *   the divergence badges. It stays in the eval page's signals strip, the
 *   merged view's R flag square and, in research view, the per-result
 *   reproducibility card.
 * - Not assessable (`no_bounds` / `mixed_scale`): fires on every row of an
 *   unbounded metric column (such as BBQ bias scores), adding heavy visual
 *   clutter. It lives in the clickable Comparability (X) signal tile, the
 *   ComparabilityPanel, and the expanded row detail card.
 */
export function SignalsRowBadges({
  annotations,
  comparabilityStatus: _comparabilityStatus,
  className,
  hideOnMobile = true,
}: {
  annotations?: RowAnnotations | null
  /** Accepted for backwards compatibility; not-assessable verdicts are
   *  surfaced in the Comparability signal dialog, panel, and row drawer
   *  rather than as per-cell pills. */
  comparabilityStatus?: ComparabilityStatus | null
  className?: string
  hideOnMobile?: boolean
}) {
  // Strict `=== true` — the flags are nullable and a NULL means
  // "not assessable", which never counts as a positive divergence flag.
  const hasVariant = annotations?.variant_divergence?.has_variant_divergence === true
  const hasCrossParty = annotations?.cross_party_divergence?.has_cross_party_divergence === true

  if (!hasVariant && !hasCrossParty) {
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
      <VariantDivergenceBadge divergence={annotations?.variant_divergence} />
      <CrossPartyDivergenceBadge divergence={annotations?.cross_party_divergence} />
    </div>
  )
}
