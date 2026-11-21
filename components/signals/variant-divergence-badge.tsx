"use client"

import { GitCompareArrows } from "lucide-react"

import { useAudienceMode } from "@/components/audience-mode-provider"
import { Badge } from "@/components/ui/badge"
import type { VariantDivergence } from "@/lib/backend-artifacts"
import { cn } from "@/lib/utils"
import { formatDifferingFields, formatSignalNumber } from "./signal-utils"
import { SignalTooltip } from "./signal-tooltip"

/**
 * Renders the per-row variant-divergence chip when `has_variant_divergence`
 * is strictly `true`.
 *
 * Rows whose comparability group was never assessed (`no_bounds` or
 * `mixed_scale`, leaving the divergence flag NULL) intentionally stay
 * quiet inside table cells — just like reproducibility gaps, repeating a
 * boxed "Not assessable" pill on every row of an unbounded metric column
 * clutters the table and drowns genuine divergence flags. That status is
 * surfaced in the clickable Comparability (X) signal tile, the
 * ComparabilityPanel, and the expanded row detail card.
 */
export function VariantDivergenceBadge({
  divergence,
  className,
}: {
  divergence?: VariantDivergence | null
  className?: string
}) {
  const { mode } = useAudienceMode()
  const isResearchView = mode === "research"

  if (divergence?.has_variant_divergence !== true) {
    return null
  }

  const magnitude = formatSignalNumber(divergence.divergence_magnitude)
  const fields = formatDifferingFields(divergence.differing_setup_fields)
  const tooltip = isResearchView
    ? `Scores diverge by ${magnitude} across different setups: ${fields}.`
    : "Different runs of this evaluation produced different scores, so the setup matters."

  return (
    <SignalTooltip content={tooltip}>
      <Badge
        variant="outline"
        className={cn(
          "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/35 dark:text-rose-100",
          className
        )}
      >
        <GitCompareArrows className="h-3 w-3" />
        {isResearchView ? "Variant divergence" : "Score depends on setup"}
      </Badge>
    </SignalTooltip>
  )
}
