"use client"

import { Fragment, useMemo, useState } from "react"
import Link from "next/link"
import {
  ChevronDown,
  ExternalLink,
} from "lucide-react"
import type { BenchmarkEvaluationCardData } from "@/components/benchmark-evaluation-card"
import { routeIdToPath } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

function formatDate(isoString: string | null | undefined) {
  if (!isoString) return "—"
  const numeric = Number(isoString)
  const parsedDate =
    !Number.isNaN(numeric) && !isoString.includes("-")
      ? new Date(numeric * 1000)
      : new Date(isoString)

  try {
    return parsedDate.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    })
  } catch {
    return isoString
  }
}

function parseParamsBillionsFromModelName(modelName: string | null | undefined) {
  if (!modelName) return null

  // Parse explicit size tokens like 7B, 40B, or 560M from model names.
  const sizeTokens = Array.from(modelName.matchAll(/\b(\d+(?:\.\d+)?)\s*([bm])\b/gi))
  if (sizeTokens.length === 0) return null

  const lastToken = sizeTokens[sizeTokens.length - 1]
  const numericValue = Number(lastToken[1])
  if (!Number.isFinite(numericValue)) return null

  const unit = lastToken[2].toLowerCase()
  if (unit === "b") return numericValue
  if (unit === "m") return numericValue / 1000

  return null
}

function formatParamsBillions(value: number | null | undefined, modelName?: string) {
  const resolvedValue =
    value == null || Number.isNaN(value) ? parseParamsBillionsFromModelName(modelName) : value

  if (resolvedValue == null || Number.isNaN(resolvedValue)) return "Not reported"
  if (resolvedValue >= 100) return `${Math.round(resolvedValue)}B`
  return `${resolvedValue.toFixed(1)}B`
}

function formatBenchmarkScore(score: number, unit?: string) {
  if (unit === "accuracy" || unit === "pass@1" || (!unit && score >= 0 && score <= 1)) {
    return `${(score * 100).toFixed(1)}`
  }

  if (unit === "points") {
    return score.toFixed(1)
  }

  return score.toFixed(2)
}

function formatSummaryScore(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "Not summarized"
  if (value >= 0 && value <= 1) return `${(value * 100).toFixed(1)}%`
  if (Math.abs(value) >= 100) return value.toFixed(0)
  return value.toFixed(2)
}

function getBenchmarkSection(name: string) {
  const value = name.toLowerCase()

  if (
    value.includes("tau") ||
    value.includes("swe-bench") ||
    value.includes("browsecomp") ||
    value.includes("agent")
  ) {
    return "Agentic"
  }

  if (
    value.includes("aime") ||
    value.includes("gpqa") ||
    value.includes("hmmt") ||
    value.includes("beyond aime") ||
    value.includes("reason")
  ) {
    return "Reasoning"
  }

  if (
    value.includes("math") ||
    value.includes("mmlu") ||
    value.includes("ifeval") ||
    value.includes("arena") ||
    value.includes("live code") ||
    value.includes("humaneval") ||
    value.includes("mbpp") ||
    value.includes("code")
  ) {
    return "General"
  }

  return "Other"
}

const SECTION_ORDER = ["General", "Reasoning", "Agentic", "Other"]

const CONTEXT_ROWS = [
  { key: "developer", label: "Developer" },
  { key: "params", label: "Parameter range" },
  { key: "benchmarks", label: "Benchmark coverage" },
  { key: "variants", label: "Versions" },
  { key: "score_summary", label: "Score range" },
  { key: "reproducibility", label: "Re-runnability" },
  { key: "latest", label: "Latest summary" },
  { key: "updated", label: "Updated" },
] as const

interface ModelCompareDialogProps {
  models: BenchmarkEvaluationCardData[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ModelCompareDialog({
  models,
  open,
  onOpenChange,
}: ModelCompareDialogProps) {
  const [sharedOnly, setSharedOnly] = useState(false)
  const benchmarkRows = useMemo(() => {
    const rows = new Map<
      string,
      {
        benchmark: string
        metric: string
        section: string
        values: Record<string, { score: number; unit?: string }>
        order: number
      }
    >()

    let order = 0

    for (const model of models) {
      for (const score of model.top_scores) {
        const existing = rows.get(score.benchmark)
        if (!existing) {
          rows.set(score.benchmark, {
            benchmark: score.benchmark,
            metric: score.metric,
            section: getBenchmarkSection(score.benchmark),
            values: {
              [model.id]: {
                score: score.score,
                unit: score.unit,
              },
            },
            order,
          })
          order += 1
          continue
        }

        existing.values[model.id] = {
          score: score.score,
          unit: score.unit,
        }
      }
    }

    return Array.from(rows.values()).sort((a, b) => {
      const sectionDiff = SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section)
      if (sectionDiff !== 0) {
        return sectionDiff
      }

      return a.order - b.order
    })
  }, [models])

  const benchmarkSections = useMemo(() => {
    return SECTION_ORDER.map((section) => ({
      section,
      rows: benchmarkRows.filter((row) => row.section === section),
    })).filter((group) => group.rows.length > 0)
  }, [benchmarkRows])

  const sharedBenchmarkCount = useMemo(
    () => benchmarkRows.filter((row) => Object.keys(row.values).length === models.length).length,
    [benchmarkRows, models.length]
  )

  const visibleBenchmarkSections = useMemo(() => {
    if (!sharedOnly) {
      return benchmarkSections
    }

    return benchmarkSections
      .map((group) => ({
        ...group,
        rows: group.rows.filter((row) => Object.keys(row.values).length === models.length),
      }))
      .filter((group) => group.rows.length > 0)
  }, [benchmarkSections, models.length, sharedOnly])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[85dvh] max-h-[85dvh] max-w-[min(96vw,1220px)] overflow-hidden rounded-none border-[var(--border-soft)] p-0 sm:max-w-[min(96vw,1220px)]">
        <div className="flex h-full min-h-0 flex-col">
          <DialogHeader className="border-b border-[var(--border-soft)] px-6 py-5 space-y-2">
            <div className="kicker">Side-By-Side Comparison</div>
            <DialogTitle className="text-2xl font-bold tracking-tight">Compare Selected Models</DialogTitle>
            <DialogDescription className="text-sm leading-relaxed">
              Start with the benchmark table. Use the context table when you need coverage breadth, version spread, or score range detail.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
            <div className="min-w-[920px] space-y-10">
              <section>
                <div className="section-head">
                  <h2>Benchmark comparison</h2>
                  <button
                    type="button"
                    onClick={() => setSharedOnly((current) => !current)}
                    className={`btn-ec ${sharedOnly ? "" : "outline"}`}
                    style={{ padding: "7px 14px", fontSize: 11 }}
                  >
                    {sharedOnly ? "Showing shared only" : "Show shared only"}
                  </button>
                </div>

                <p className="mb-3 max-w-[60rem] text-[13px] leading-[1.65] text-[color:var(--fg-muted)]">
                  Rows are drawn from the most relevant surfaced benchmarks across the selected models, closer to how release posts present comparison tables.
                </p>
                <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]">
                  <span>{benchmarkRows.length} surfaced benchmarks</span>
                  <span>· {sharedBenchmarkCount} shared across all selected models</span>
                </div>

                <div className="overflow-auto">
                  <table className="ec-htable">
                    <thead>
                      <tr>
                        <th className="w-[260px]">Benchmark</th>
                        {models.map((model) => (
                          <th key={model.id} className="min-w-[170px] align-top">
                            <div className="text-[13px] font-semibold normal-case tracking-normal text-[color:var(--fg)]">
                              {model.model_name}
                            </div>
                            <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[color:var(--fg-subtle)]">
                              {model.developer || "Unknown"}
                            </div>
                            <div className="mt-1.5 flex flex-wrap items-center gap-2 normal-case tracking-normal">
                              <span className="ec-tag" style={{ fontSize: 9.5 }}>
                                {formatParamsBillions(model.params_billions, model.model_name)}
                              </span>
                              <Link
                                href={`/models/${routeIdToPath(model.route_id)}`}
                                className="font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--fg-muted)] hover:text-[color:var(--accent)]"
                              >
                                View →
                              </Link>
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleBenchmarkSections.map((group) => (
                        <Fragment key={group.section}>
                          <tr>
                            <td
                              colSpan={models.length + 1}
                              style={{
                                borderBottom: "1px solid var(--border-soft)",
                                borderTop: "1px solid var(--fg)",
                                background: "var(--bg-warm)",
                                padding: "8px 16px",
                              }}
                              className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--accent)] font-semibold"
                            >
                              {group.section}
                            </td>
                          </tr>
                          {group.rows.map((row) => {
                            const rowValues = Object.values(row.values).map((value) => value.score)
                            const maxScore = rowValues.length > 0 ? Math.max(...rowValues) : null

                            return (
                              <tr key={row.benchmark}>
                                <td className="whitespace-normal">
                                  <div className="text-[13px] font-medium">{row.benchmark}</div>
                                  <div className="mt-0.5 font-mono text-[10.5px] text-[color:var(--fg-subtle)]">{row.metric}</div>
                                </td>
                                {models.map((model) => {
                                  const value = row.values[model.id]
                                  const isBest = value && maxScore != null && value.score === maxScore

                                  return (
                                    <td
                                      key={`${row.benchmark}-${model.id}`}
                                      style={{
                                        background: isBest ? "var(--bg-warm)" : undefined,
                                      }}
                                    >
                                      {value ? (
                                        <div className="font-mono text-[15px] font-semibold tabular-nums" style={{ color: isBest ? "var(--accent)" : "var(--fg)" }}>
                                          {formatBenchmarkScore(value.score, value.unit)}
                                        </div>
                                      ) : (
                                        <div className="font-mono text-[12px] text-[color:var(--fg-subtle)]">––</div>
                                      )}
                                    </td>
                                  )
                                })}
                              </tr>
                            )
                          })}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <Collapsible className="border-t border-[color:var(--border-soft)] pt-4">
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 py-2 text-left transition-colors hover:text-[color:var(--accent)]"
                  >
                    <div>
                      <div className="kicker">Dive deeper</div>
                      <div className="mt-1 text-[14px] font-semibold text-[color:var(--fg)]">
                        Show coverage and score-summary context
                      </div>
                    </div>
                    <ChevronDown className="h-4 w-4 text-[color:var(--fg-muted)]" />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-4">
                  <div className="overflow-auto">
                    <table className="ec-htable">
                      <thead>
                        <tr>
                          <th className="w-[220px]">Signal</th>
                          {models.map((model) => (
                            <th key={`${model.id}-context`} className="min-w-[220px]">
                              <div className="text-[13px] font-semibold normal-case tracking-normal text-[color:var(--fg)]">
                                {model.model_name}
                              </div>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {CONTEXT_ROWS.map((row) => (
                          <tr key={row.key}>
                            <td className="font-mono text-[11px] uppercase tracking-[0.1em] text-[color:var(--fg-subtle)]">
                              {row.label}
                            </td>
                            {models.map((model) => (
                              <td key={`${model.id}-${row.key}`} className="align-top whitespace-normal text-[13px]">
                                {row.key === "developer" ? model.developer || "Unknown developer" : null}
                                {row.key === "params"
                                  ? formatParamsBillions(model.params_billions, model.model_name)
                                  : null}
                                {row.key === "benchmarks" ? (
                                  <div>
                                    <div className="font-medium">{model.benchmarks_count} covered benchmarks</div>
                                    <div className="mt-0.5 text-[12px] text-[color:var(--fg-muted)]">
                                      {(model.benchmark_names ?? []).slice(0, 4).join(", ") || `${model.evaluations_count} reported result${model.evaluations_count !== 1 ? "s" : ""}`}
                                    </div>
                                  </div>
                                ) : null}
                                {row.key === "variants" ? (
                                  <div>
                                    <div className="font-medium">
                                      {model.variant_count} version{model.variant_count !== 1 ? "s" : ""}
                                    </div>
                                    <div className="mt-0.5 text-[12px] text-[color:var(--fg-muted)]">
                                      {model.variant_count > 1 ? "Family-level summary spans multiple published variants" : "Single summarized variant"}
                                    </div>
                                  </div>
                                ) : null}
                                {row.key === "score_summary" ? (
                                  <div className="text-[12px] text-[color:var(--fg-muted)]">
                                    Range {formatSummaryScore(model.score_summary?.min ?? null)} to {formatSummaryScore(model.score_summary?.max ?? null)} across {model.score_summary?.count ?? 0} surfaced scores
                                  </div>
                                ) : null}
                                {row.key === "reproducibility" ? (
                                  model.reproducibility_summary && model.reproducibility_summary.has_reproducibility_gap_count > 0 ? (
                                    <div>
                                      <div className="font-medium">
                                        {model.reproducibility_summary.has_reproducibility_gap_count} with a reproducibility gap
                                      </div>
                                      <div className="mt-0.5 text-[12px] text-[color:var(--fg-muted)]">
                                        Out of {model.reproducibility_summary.results_total} reported scores
                                      </div>
                                    </div>
                                  ) : (
                                    <span className="text-[color:var(--fg-muted)]">No reproducibility gaps</span>
                                  )
                                ) : null}
                                {row.key === "latest" ? (
                                  <div className="flex items-center gap-2">
                                    <span>{model.latest_source_name || `${model.benchmarks_count} benchmark composites summarized`}</span>
                                    {model.source_urls?.[0] ? (
                                      <a
                                        href={model.source_urls[0]}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-[color:var(--fg-muted)] hover:text-[color:var(--accent)]"
                                      >
                                        <ExternalLink className="h-3.5 w-3.5" />
                                      </a>
                                    ) : null}
                                  </div>
                                ) : null}
                                {row.key === "updated" ? formatDate(model.latest_timestamp) : null}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
