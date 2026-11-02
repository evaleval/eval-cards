"use client"

import { useAudienceMode } from "@/components/audience-mode-provider"
import type { RowAnnotations } from "@/lib/backend-artifacts"
import { setupItemLabel } from "@/lib/setup-items"
import { cn } from "@/lib/utils"
import { SignalTooltip } from "./signal-tooltip"

const SQUARE =
  "inline-flex h-4 w-4 items-center justify-center rounded-[3px] border text-[9px] font-semibold leading-none"
const AMBER =
  "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100"

// The corpus completeness distribution is bimodal: ~0.107 (no benchmark
// card — only the EEE source fields populated) vs ~0.929 (carded). 0.5
// cleanly separates the undocumented cluster; it is not a tuned knob.
const COMPLETENESS_FLAG_THRESHOLD = 0.5

function FlagSquare({
  letter,
  tooltip,
  className,
}: {
  letter: string
  tooltip: string
  className?: string
}) {
  return (
    <SignalTooltip content={tooltip}>
      <span className={cn(SQUARE, className)} aria-label={tooltip}>
        {letter}
      </span>
    </SignalTooltip>
  )
}

/**
 * Compact letter-square flags for a result row: a square per signal that
 * actually fires (R = reproducibility gap, P = first-party only). Quiet
 * states (third-party, fully documented setups) render nothing — this is a
 * flags column, not a relationship label. Comparability squares are
 * deferred; completeness is eval-level and has no per-row source yet.
 */
export function RowFlagSquares({
  annotations,
}: {
  annotations?: RowAnnotations | null
}) {
  const { mode } = useAudienceMode()
  const isResearchView = mode === "research"

  const squares: React.ReactNode[] = []

  const gap = annotations?.reproducibility_gap
  if (gap?.has_reproducibility_gap === true) {
    const missing = gap.missing_fields.map(setupItemLabel)
    const populated = gap.populated_field_count ?? gap.populated_count
    const required = gap.required_field_count ?? gap.required_count
    const countLine =
      populated != null && required != null
        ? `${populated} of ${required} setup items disclosed.`
        : ""
    squares.push(
      <FlagSquare
        key="R"
        letter="R"
        className={AMBER}
        tooltip={
          isResearchView
            ? `Reproducibility gap. Undisclosed: ${missing.join(", ") || "none listed"}. ${countLine}`
            : `This score's setup is not fully documented, so it cannot be re-run as-is. ${countLine}`
        }
      />,
    )
  }

  const completeness = annotations?.reporting_completeness?.completeness_score
  if (completeness != null && completeness < COMPLETENESS_FLAG_THRESHOLD) {
    const pct = Math.round(completeness * 100)
    squares.push(
      <FlagSquare
        key="C"
        letter="C"
        className={AMBER}
        tooltip={
          isResearchView
            ? `Low reporting completeness: ${pct}% of the benchmark documentation schema populated.`
            : `This benchmark's documentation is largely missing (${pct}% complete).`
        }
      />,
    )
  }

  // P flags one-sided evaluator coverage: the result is not reported by
  // both first-party and third-party. 'both' (or coverage unknown) stays
  // quiet.
  const coverage = annotations?.provenance?.coverage_cell
  if (coverage === "self" || coverage === "third") {
    squares.push(
      <FlagSquare
        key="P"
        letter="P"
        className={AMBER}
        tooltip={
          coverage === "self"
            ? isResearchView
              ? "Not reported by both parties: only first-party (developer) reports exist for this result."
              : "Only the model's developer has reported this result."
            : isResearchView
              ? "Not reported by both parties: only third-party reports exist for this result."
              : "The model's developer has not reported this result; only third parties have."
        }
      />,
    )
  }

  if (squares.length === 0) {
    return <span className="text-[color:var(--fg-subtle)]">—</span>
  }

  return <span className="flex flex-wrap items-center gap-1">{squares}</span>
}
