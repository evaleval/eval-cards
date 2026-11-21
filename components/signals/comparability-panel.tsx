"use client"

import { useMemo, type ReactNode } from "react"
import { ChevronDown, GitCompareArrows, Info, UsersRound } from "lucide-react"

import { useAudienceMode } from "@/components/audience-mode-provider"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { SignalTooltip } from "@/components/signals/signal-tooltip"
import type { BenchmarkComparability, ComparabilitySummary, DifferingSetupField } from "@/lib/backend-artifacts"
import type {
  BenchmarkLeaderboardMetric,
  BenchmarkLeaderboardRow,
  ModelResultForBenchmark,
} from "@/lib/eval-processing"
import {
  formatFieldLabel,
  formatNotAssessableReason,
  formatSignalNumber,
  formatSignalValue,
  summarizeNotAssessable,
  type MetricComparabilityStatus,
} from "./signal-utils"

interface FlaggedRow {
  modelRouteId: string | null
  modelName: string
  variant: boolean
  crossParty: boolean
  fieldLabels: string[]
}

/**
 * Derive the per-row flagged-model list from row-level annotations on
 * each model_results entry. Used by the policy/research placeholder
 * when the benchmark-level per-group annotations are sparse but the
 * row data still tells us which specific models are affected.
 */
function deriveFlaggedRows(modelResults: readonly ModelResultForBenchmark[]): FlaggedRow[] {
  const flagged: FlaggedRow[] = []
  const seen = new Set<string>()
  for (const r of modelResults) {
    const ann = r.result?.evalcards?.annotations
    if (!ann) continue
    // Strict `=== true`: the flags are nullable, and a NULL means the
    // group was never assessed — Boolean() would silently report it as
    // "checked, no divergence".
    const variant = ann.variant_divergence?.has_variant_divergence === true
    const crossParty = ann.cross_party_divergence?.has_cross_party_divergence === true
    if (!variant && !crossParty) continue
    const routeId = r.model_route_id ?? null
    const name = r.model_info?.name ?? r.model_info?.id ?? routeId ?? "Unknown model"
    const dedupKey = routeId ?? name
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)
    const fields = ann.variant_divergence?.differing_setup_fields ?? []
    flagged.push({
      modelRouteId: routeId,
      modelName: name,
      variant,
      crossParty,
      fieldLabels: fields.map((f) => formatFieldLabel(f.field)),
    })
  }
  return flagged
}

function joinList(items: string[], maxVisible = 4): string {
  const visible = items.slice(0, maxVisible)
  const overflow = items.length - visible.length
  if (overflow > 0) {
    return `${visible.join(", ")} and ${overflow} more`
  }
  if (visible.length <= 1) return visible[0] ?? ""
  return `${visible.slice(0, -1).join(", ")} and ${visible[visible.length - 1]}`
}

function reasonClauseForMetrics(metrics: readonly MetricComparabilityStatus[], isResearchView: boolean): string {
  const allNoBounds = metrics.every((m) => m.noBoundsCount === m.notAssessableCount)
  const allMixed = metrics.every((m) => m.mixedScaleCount === m.notAssessableCount)
  if (allNoBounds) {
    return isResearchView
      ? "declare no scale bounds, so divergence was not assessed"
      : "have no declared scale range, so scores could not be cross-checked"
  }
  if (allMixed) {
    return isResearchView
      ? "sit on mixed scales, so divergence was not assessed"
      : "sit on mixed scales, so scores could not be cross-checked"
  }
  return isResearchView
    ? "sit on mixed or undeclared scales, so divergence was not assessed"
    : "could not be placed on a common scale, so scores could not be cross-checked"
}

export function ComparabilityPanel({
  comparability,
  summary,
  modelResults,
  leaderboardMetrics,
  leaderboardRows,
}: {
  comparability?: BenchmarkComparability | null
  summary?: ComparabilitySummary
  modelResults?: readonly ModelResultForBenchmark[]
  leaderboardMetrics?: readonly BenchmarkLeaderboardMetric[]
  leaderboardRows?: readonly BenchmarkLeaderboardRow[]
}) {
  const { mode } = useAudienceMode()
  const isResearchView = mode === "research"
  const variantGroups = comparability?.variant_divergence_groups ?? []
  const crossPartyGroups = comparability?.cross_party_divergence_groups ?? []
  const showNoCrossPartyNote = summary?.groups_with_cross_party_check === 0
  // The roll-up summary can flag divergence even when per-group annotations
  // are sparse on this benchmark. Pull the actual flagged models off the
  // row-level annotations so we can name them instead of saying "flagged
  // at the roll-up level" — that phrase means nothing to the reader.
  const hasSummaryConcern =
    (summary?.variant_divergent_count ?? 0) > 0 ||
    (summary?.cross_party_divergent_count ?? 0) > 0
  const noGroupDetail =
    variantGroups.length === 0 && crossPartyGroups.length === 0

  const flaggedRows = useMemo(
    () => deriveFlaggedRows(modelResults ?? []),
    [modelResults],
  )
  const notAssessable = useMemo(
    () =>
      summarizeNotAssessable({
        leaderboardMetrics,
        leaderboardRows,
        modelResults,
      }),
    [leaderboardMetrics, leaderboardRows, modelResults],
  )

  // Hide the panel entirely when we have nothing concrete to show: no
  // per-group detail, no summary concern, and no cross-party gap to call
  // out. We also hide when the only signal is a roll-up count that we
  // can't connect to specific models — vague counts confuse readers.
  if (noGroupDetail && !showNoCrossPartyNote && !hasSummaryConcern && !notAssessable.hasAnyNotAssessable) {
    return null
  }
  if (
    noGroupDetail &&
    hasSummaryConcern &&
    flaggedRows.length === 0 &&
    !showNoCrossPartyNote &&
    !notAssessable.hasAnyNotAssessable
  ) {
    return null
  }

  return (
    <section
      id="comparability-panel"
      className="ec-card warm scroll-mt-24"
      style={{ padding: "20px 24px" }}
    >
      <header className="mb-3 flex flex-wrap items-center gap-3">
        <GitCompareArrows className="h-4 w-4" style={{ color: "var(--fg-muted)" }} />
        <span className="kicker kicker-fg" style={{ fontSize: 12, letterSpacing: "0.16em" }}>
          {isResearchView ? "Comparability" : "Can these scores be compared directly?"}
        </span>
        {summary && (
          <span
            className="ml-auto font-mono text-[10px] uppercase tracking-[0.12em]"
            style={{ color: "var(--fg-subtle)" }}
          >
            {summary.groups_with_variant_check} setup checks · {summary.groups_with_cross_party_check} source checks
          </span>
        )}
      </header>
      <p className="mb-3 text-[13px]" style={{ color: "var(--fg-muted)", maxWidth: "48rem", lineHeight: 1.6 }}>
        {isResearchView
          ? "Groups where reported scores diverge across setups or reporting organizations."
          : "Flags cases where score differences may come from setup choices or different reporting sources."}
      </p>

      {showNoCrossPartyNote && (
        <div
          className="mt-3 px-3 py-2 text-[13px]"
          style={{
            border: "1px dashed var(--border-soft)",
            background: "var(--bg)",
            color: "var(--fg-muted)",
            lineHeight: 1.6,
          }}
        >
          {isResearchView
            ? "No third-party reports are available for cross-party comparison."
            : "No independent third-party reports are available to cross-check the developer's numbers on this benchmark."}
        </div>
      )}

      {notAssessable.hasAnyNotAssessable && (
        <div
          className="mt-3 px-3 py-2 text-[13px]"
          style={{
            border: "1px dashed var(--border-soft)",
            background: "var(--bg)",
            color: "var(--fg-muted)",
            lineHeight: 1.6,
          }}
        >
          {notAssessable.isMultiMetric ? (
            <div className="space-y-1">
              {notAssessable.fullyUnassessableMetrics.length > 0 && (
                <div>
                  <span className="font-semibold" style={{ color: "var(--fg)" }}>
                    {joinList(notAssessable.fullyUnassessableMetrics.map((m) => m.label))}
                  </span>{" "}
                  {notAssessable.fullyUnassessableMetrics.length === 1
                    ? reasonClauseForMetrics(notAssessable.fullyUnassessableMetrics, isResearchView)
                        .replace(/^declare /, "declares ")
                        .replace(/^have /, "has ")
                        .replace(/^sit /, "sits ")
                    : reasonClauseForMetrics(notAssessable.fullyUnassessableMetrics, isResearchView)}
                  .
                </div>
              )}
              {notAssessable.partiallyUnassessableMetrics.map((m) => {
                const modelsPreview = m.affectedModels.slice(0, 4)
                const overflow = m.affectedModels.length - modelsPreview.length
                const reason =
                  m.mixedScaleCount === m.notAssessableCount
                    ? formatNotAssessableReason("mixed_scale")
                    : m.noBoundsCount === m.notAssessableCount
                      ? formatNotAssessableReason("no_bounds")
                      : "mixed or undeclared scales"
                return (
                  <div key={m.columnKey}>
                    On <span className="font-semibold" style={{ color: "var(--fg)" }}>{m.label}</span>,{" "}
                    {m.notAssessableCount} model{m.notAssessableCount === 1 ? "" : "s"}{" "}
                    {isResearchView ? "not assessable" : "could not be cross-checked"} ({reason}):{" "}
                    {modelsPreview.map((entry, idx) => (
                      <span key={entry.modelRouteId ?? entry.modelName}>
                        {idx > 0 ? ", " : ""}
                        {entry.modelRouteId ? (
                          <a
                            href={`#row-${entry.modelRouteId}`}
                            className="font-medium underline-offset-4 hover:underline"
                            style={{ color: "var(--fg)" }}
                          >
                            {entry.modelName}
                          </a>
                        ) : (
                          <span className="font-medium" style={{ color: "var(--fg)" }}>
                            {entry.modelName}
                          </span>
                        )}
                      </span>
                    ))}
                    {overflow > 0 ? ` and ${overflow} more` : ""}.
                  </div>
                )
              })}
            </div>
          ) : (() => {
            const only = notAssessable.metrics[0]
            if (only?.allNotAssessable) {
              const allNoBounds = only.noBoundsCount === only.notAssessableCount
              return isResearchView
                ? allNoBounds
                  ? `This metric declares no scale bounds, so divergence was not assessed (${only.totalModels} model${only.totalModels === 1 ? "" : "s"}).`
                  : `${only.totalModels} model${only.totalModels === 1 ? "" : "s"} not assessable: the reported numbers sit on mixed or undeclared scales, so divergence was never checked.`
                : allNoBounds
                  ? `This metric has no declared scale range, so scores could not be cross-checked (${only.totalModels} model${only.totalModels === 1 ? "" : "s"}).`
                  : `${only.totalModels} model${only.totalModels === 1 ? "" : "s"} could not be checked here, because the numbers reported for them are not on a common scale.`
            }
            const count = notAssessable.affectedModelCount
            const modelsPreview = (only?.affectedModels ?? []).slice(0, 4)
            const overflow = (only?.affectedModels.length ?? 0) - modelsPreview.length
            return (
              <div>
                {isResearchView
                  ? `${count} model${count === 1 ? "" : "s"} not assessable (mixed or undeclared scales)`
                  : `${count} model${count === 1 ? "" : "s"} could not be cross-checked (not on a common scale)`}
                {modelsPreview.length > 0 && (
                  <>
                    :{" "}
                    {modelsPreview.map((entry, idx) => (
                      <span key={entry.modelRouteId ?? entry.modelName}>
                        {idx > 0 ? ", " : ""}
                        {entry.modelRouteId ? (
                          <a
                            href={`#row-${entry.modelRouteId}`}
                            className="font-medium underline-offset-4 hover:underline"
                            style={{ color: "var(--fg)" }}
                          >
                            {entry.modelName}
                          </a>
                        ) : (
                          <span className="font-medium" style={{ color: "var(--fg)" }}>
                            {entry.modelName}
                          </span>
                        )}
                      </span>
                    ))}
                    {overflow > 0 ? ` and ${overflow} more` : ""}
                  </>
                )}
                .
              </div>
            )
          })()}
        </div>
      )}

      {!isResearchView && (variantGroups.length > 0 || crossPartyGroups.length > 0) && (
        <div
          className="mt-3 px-4 py-3 text-[13px]"
          style={{
            border: "1px solid var(--border-soft)",
            background: "var(--bg)",
            color: "var(--fg)",
            lineHeight: 1.6,
          }}
        >
          {buildPolicyComparabilitySentence(variantGroups.length, crossPartyGroups.length)}
        </div>
      )}

      {noGroupDetail && hasSummaryConcern && flaggedRows.length > 0 && (
        <div
          className="mt-3 px-3 py-3"
          style={{
            border: "1px solid var(--border-soft)",
            background: "var(--bg)",
            color: "var(--fg)",
            lineHeight: 1.6,
          }}
        >
          <div
            className="mb-2 font-mono uppercase"
            style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
          >
            Flagged models · {flaggedRows.length}
          </div>
          <ul className="flex flex-col gap-1.5">
            {flaggedRows.map((row) => {
              const tags: string[] = []
              if (row.variant) tags.push("setup divergence")
              if (row.crossParty) tags.push("source divergence")
              const fieldNote = row.fieldLabels.length > 0
                ? ` (differs by ${row.fieldLabels.slice(0, 3).join(", ")}${row.fieldLabels.length > 3 ? ", …" : ""})`
                : ""
              const inner = (
                <>
                  <span className="font-semibold" style={{ color: "var(--fg)" }}>{row.modelName}</span>
                  <span style={{ color: "var(--fg-muted)" }}>{" · "}{tags.join(" · ")}{fieldNote}</span>
                </>
              )
              return (
                <li key={row.modelRouteId ?? row.modelName} className="text-[13px]">
                  {row.modelRouteId ? (
                    <a
                      href={`#row-${row.modelRouteId}`}
                      className="inline-flex items-center gap-2 hover:underline underline-offset-4"
                      style={{ color: "var(--fg)" }}
                    >
                      {inner}
                      <span
                        className="font-mono uppercase"
                        style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--accent)" }}
                      >
                        Jump to row →
                      </span>
                    </a>
                  ) : (
                    <span className="inline-flex items-center gap-2">{inner}</span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {isResearchView && (() => {
        const onlyOne =
          (variantGroups.length > 0 ? 1 : 0) + (crossPartyGroups.length > 0 ? 1 : 0) === 1
        const sectionClass = onlyOne ? "" : "lg:grid lg:grid-cols-2 lg:gap-3"
        const itemsClass = onlyOne ? "grid gap-2 md:grid-cols-2" : "space-y-2"
        return (
          <div className={`mt-4 ${sectionClass}`}>
            {variantGroups.length > 0 && (
              <GroupList
                icon="variant"
                title="Variant divergence"
                count={variantGroups.length}
                itemsClassName={itemsClass}
              >
                {variantGroups.slice(0, 8).map((group) => (
                  <DivergenceGroupItem
                    key={group.group_id}
                    modelRouteId={group.model_route_id}
                    magnitude={group.divergence_magnitude}
                    threshold={group.threshold_used}
                    fields={group.differing_setup_fields}
                  />
                ))}
              </GroupList>
            )}

            {crossPartyGroups.length > 0 && (
              <GroupList
                icon="cross-party"
                title="Cross-party divergence"
                count={crossPartyGroups.length}
                itemsClassName={itemsClass}
              >
                {crossPartyGroups.slice(0, 8).map((group) => (
                  <DivergenceGroupItem
                    key={group.group_id}
                    modelRouteId={group.model_route_id}
                    magnitude={group.divergence_magnitude}
                    threshold={group.threshold_used}
                    fields={group.differing_setup_fields}
                    scoresByOrganization={group.scores_by_organization}
                  />
                ))}
              </GroupList>
            )}
          </div>
        )
      })()}
    </section>
  )
}

/**
 * Policy-mode caveat. Hides field names and divergence magnitudes (per the
 * policy spec) and rolls the counts into a single narrative line.
 */
function buildPolicyComparabilitySentence(variantCount: number, crossPartyCount: number): string {
  const variantPhrase =
    variantCount === 0
      ? null
      : variantCount === 1
        ? "one model has been reported under different evaluation setups"
        : `${variantCount} models have been reported under different evaluation setups`
  const crossPartyPhrase =
    crossPartyCount === 0
      ? null
      : crossPartyCount === 1
        ? "one model has different scores reported by different organizations"
        : `${crossPartyCount} models have different scores reported by different organizations`

  if (variantPhrase && crossPartyPhrase) {
    return `${variantPhrase[0].toUpperCase()}${variantPhrase.slice(1)}, and ${crossPartyPhrase}. Some apparent score differences may reflect those choices rather than capability.`
  }
  if (variantPhrase) {
    return `${variantPhrase[0].toUpperCase()}${variantPhrase.slice(1)}, which may explain some of the variation seen in reported numbers.`
  }
  if (crossPartyPhrase) {
    return `${crossPartyPhrase[0].toUpperCase()}${crossPartyPhrase.slice(1)}. Treat the headline number as a range rather than a single value.`
  }
  return ""
}

function GroupList({
  icon,
  title,
  count,
  children,
  itemsClassName = "space-y-2",
}: {
  icon: "variant" | "cross-party"
  title: string
  count: number
  children: ReactNode
  itemsClassName?: string
}) {
  const Icon = icon === "variant" ? GitCompareArrows : UsersRound

  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between px-3 py-2 text-left transition-colors hover:bg-[color:var(--bg-warm)]"
          style={{
            border: "1px solid var(--border-soft)",
            background: "var(--bg)",
          }}
        >
          <span
            className="flex items-center gap-2 font-mono uppercase"
            style={{ fontSize: 11, letterSpacing: "0.14em", color: "var(--fg)" }}
          >
            <Icon className="h-3.5 w-3.5" style={{ color: "var(--fg-muted)" }} />
            {title}
            <span
              className="ml-1 font-mono tabular-nums"
              style={{ fontSize: 11, color: "var(--fg-muted)" }}
            >
              · {count}
            </span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0" style={{ color: "var(--fg-muted)" }} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className={`mt-2 ${itemsClassName}`}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Try to extract a human-readable label from a structured setup-field value.
 * Common shape from agentic evals: { additional_details: { agent_name, agent_framework } }.
 * Falls back to picking the first short string property, or null when the
 * value can't be summarized cleanly.
 */
function extractFriendlyLabel(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === "string") return value.length > 60 ? null : value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value !== "object") return null

  const obj = value as Record<string, unknown>
  const details = (obj.additional_details && typeof obj.additional_details === "object")
    ? (obj.additional_details as Record<string, unknown>)
    : obj

  const agentName = typeof details.agent_name === "string" ? details.agent_name : null
  const agentFramework = typeof details.agent_framework === "string" ? details.agent_framework : null
  if (agentName) {
    return agentFramework && agentFramework !== agentName ? `${agentName} (${agentFramework})` : agentName
  }

  for (const key of ["name", "label", "id", "title"]) {
    const v = details[key]
    if (typeof v === "string" && v.length <= 60) return v
  }

  return null
}

function chipsForFieldValues(values: unknown[]): { label: string; raw: unknown }[] {
  const seen = new Set<string>()
  const result: { label: string; raw: unknown }[] = []
  for (const v of values) {
    const friendly = extractFriendlyLabel(v)
    const label = friendly ?? formatSignalValue(v)
    const truncated = label.length > 80 ? label.slice(0, 80) + "…" : label
    if (seen.has(truncated)) continue
    seen.add(truncated)
    result.push({ label: truncated, raw: v })
  }
  return result
}

function DivergenceGroupItem({
  modelRouteId,
  magnitude,
  threshold,
  fields,
  scoresByOrganization,
}: {
  modelRouteId: string
  magnitude: number
  threshold: number
  fields: DifferingSetupField[]
  scoresByOrganization?: Record<string, number>
}) {
  const fieldLabels = fields.map((f) => formatFieldLabel(f.field))
  const summarySentence =
    fieldLabels.length === 0
      ? `Reported scores diverge by ${formatSignalNumber(magnitude)}, above the ${formatSignalNumber(threshold)} threshold. The setup difference is not labeled.`
      : `Reported scores diverge by ${formatSignalNumber(magnitude)} (threshold ${formatSignalNumber(threshold)}) because the runs differ on ${
          fieldLabels.length === 1
            ? fieldLabels[0]
            : fieldLabels.slice(0, -1).join(", ") + " and " + fieldLabels[fieldLabels.length - 1]
        }. The chips below show each variant.`

  return (
    <a
      href={`#row-${modelRouteId}`}
      className="block px-3 py-2.5 text-[13px] transition-colors hover:bg-[color:var(--bg-warm)]"
      style={{
        border: "1px solid var(--border-soft)",
        background: "var(--bg)",
        color: "var(--fg)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold" style={{ color: "var(--fg)" }}>{modelRouteId}</span>
            <SignalTooltip content={summarySentence}>
              <Info className="h-3.5 w-3.5 shrink-0 cursor-help" style={{ color: "var(--fg-muted)" }} />
            </SignalTooltip>
          </div>
          <div className="mt-1 font-mono tabular-nums" style={{ fontSize: 11, color: "var(--fg-muted)" }}>
            Diverges by {formatSignalNumber(magnitude)} (threshold {formatSignalNumber(threshold)})
          </div>
        </div>
        <span
          className="shrink-0 font-mono uppercase"
          style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--accent)" }}
        >
          Jump to row →
        </span>
      </div>

      {fields.slice(0, 3).map((field) => {
        const chips = chipsForFieldValues(field.values).slice(0, 6)
        const overflow = field.values.length - chips.length
        return (
          <div key={field.field} className="mt-2">
            <div
              className="mb-1 font-mono uppercase"
              style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
            >
              Differs by {formatFieldLabel(field.field)}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {chips.map((chip, idx) => {
                const friendly = extractFriendlyLabel(chip.raw)
                const tooltipBody = friendly ? formatSignalValue(chip.raw) : null
                const pill = (
                  <span
                    className="ec-tag outline truncate"
                    style={{
                      maxWidth: "18rem",
                      textTransform: "none",
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                    }}
                    title={!tooltipBody ? chip.label : undefined}
                  >
                    {chip.label}
                  </span>
                )
                return tooltipBody ? (
                  <SignalTooltip
                    key={`${field.field}-${idx}`}
                    content={
                      <span className="block max-w-[24rem] break-all font-mono text-[10px] leading-snug">
                        {tooltipBody}
                      </span>
                    }
                  >
                    {pill}
                  </SignalTooltip>
                ) : (
                  <span key={`${field.field}-${idx}`}>{pill}</span>
                )
              })}
              {overflow > 0 && (
                <span
                  className="inline-flex items-center px-2 py-0.5 font-mono"
                  style={{
                    fontSize: 11,
                    border: "1px dashed var(--border-soft)",
                    color: "var(--fg-muted)",
                  }}
                >
                  +{overflow} more
                </span>
              )}
            </div>
          </div>
        )
      })}

      {scoresByOrganization && Object.keys(scoresByOrganization).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {Object.entries(scoresByOrganization).slice(0, 4).map(([org, score]) => (
            <span
              key={org}
              className="px-2 py-0.5 font-mono tabular-nums"
              style={{
                fontSize: 11,
                border: "1px solid var(--border-soft)",
                background: "var(--bg-warm)",
                color: "var(--fg-muted)",
              }}
            >
              {org}: {formatSignalNumber(score)}
            </span>
          ))}
        </div>
      )}
    </a>
  )
}
