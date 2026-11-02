"use client"

import { AlertTriangle } from "lucide-react"

import { useAudienceMode } from "@/components/audience-mode-provider"
import { Badge } from "@/components/ui/badge"
import type { ReproducibilityGap } from "@/lib/backend-artifacts"
import { setupItemLabel } from "@/lib/setup-items"
import { cn } from "@/lib/utils"
import { SignalTooltip } from "./signal-tooltip"

export function ReproducibilityBadge({
  gap,
  className,
}: {
  gap?: ReproducibilityGap | null
  className?: string
}) {
  const { mode } = useAudienceMode()
  const isResearchView = mode === "research"

  if (gap?.has_reproducibility_gap !== true) {
    return null
  }

  const missing = gap.missing_fields.map(setupItemLabel)
  const populated = gap.populated_field_count ?? gap.populated_count
  const required = gap.required_field_count ?? gap.required_count
  const countLine =
    populated != null && required != null
      ? `${populated} of ${required} setup items disclosed.`
      : ""
  const tooltip = isResearchView
    ? `Setup not fully documented. Undisclosed: ${missing.join(", ") || "none listed"}. ${countLine}`
    : `This score's setup is not fully documented, so it cannot be re-run as-is. ${countLine}`

  return (
    <SignalTooltip content={tooltip}>
      <Badge
        variant="outline"
        className={cn(
          "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100",
          className
        )}
      >
        <AlertTriangle className="h-3 w-3" />
        {isResearchView ? "Reproducibility gap" : "Setup not documented"}
      </Badge>
    </SignalTooltip>
  )
}
