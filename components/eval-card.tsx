"use client"

import type { ComponentType, CSSProperties } from "react"
import { useAudienceMode } from "@/components/audience-mode-provider"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { VerifiedBadge } from "@/components/signals/verified-badge"
import { useRouter } from "next/navigation"
import {
  AlertTriangle,
  BadgeCheck,
  BookOpenText,
  ChartNoAxesColumn,
  Database,
  ExternalLink,
  FlaskConical,
  Scale,
  Users,
} from "lucide-react"
import Link from "next/link"
import { routeIdToPath } from "@/lib/utils"
import { useEvaluatorSlug, useKnownEvaluator } from "@/components/org-metadata-provider"
import { isRecognizedEvaluator } from "@/lib/evaluators"
import type { BenchmarkEvalListItem } from "@/lib/eval-processing"
import { getTagColor, tagLabel } from "@/lib/benchmark-schema"

const LICENSE_COLORS: Record<string, string> = {
  "mit": "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200",
  "apache": "bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-950/40 dark:text-sky-200",
  "cc by": "bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-950/40 dark:text-violet-200",
  "cc0": "bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-950/40 dark:text-teal-200",
  "cc-by-sa": "bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-200",
}

function licenseBadgeClass(license: string): string {
  const l = license.toLowerCase()
  for (const [key, cls] of Object.entries(LICENSE_COLORS)) {
    if (l.includes(key)) return cls
  }
  return "bg-muted text-muted-foreground border-border"
}

function shortenLicense(license: string): string {
  if (!license || license === "Not specified") return ""
  // Shorten known verbose license names
  if (license.toLowerCase().includes("creative commons attribution 4")) return "CC BY 4.0"
  if (license.toLowerCase().includes("creative commons zero")) return "CC0"
  if (license.toLowerCase().includes("apache license 2") || license.toLowerCase().includes("apache 2")) return "Apache 2.0"
  if (license.toLowerCase().includes("mit license")) return "MIT"
  if (license.toLowerCase().includes("cc-by-sa")) return "CC BY-SA"
  if (license.length > 24) return license.slice(0, 22) + "…"
  return license
}

interface EvalCardProps {
  summary: BenchmarkEvalListItem
  delayMs?: number
}

export function EvalCard({ summary, delayMs = 0 }: EvalCardProps) {
  const router = useRouter()
  const slugFor = useEvaluatorSlug()
  const isKnownEvaluator = useKnownEvaluator()
  const { mode } = useAudienceMode()
  const isResearchView = mode === "research"
  // A null normalised score (metric without bounds, or nothing to normalise)
  // renders as N/A; rounding null would show a fabricated 0%.
  const scorePercent =
    summary.avg_score_norm == null || Number.isNaN(summary.avg_score_norm)
      ? "N/A"
      : `${Math.round(summary.avg_score_norm * 100)}%`
  const card = summary.benchmark_card
  const domains: string[] = summary.tags?.domains ?? card?.benchmark_details?.domains ?? []
  const license = card?.ethical_and_legal_considerations?.data_licensing ?? ""
  const shortLicense = shortenLicense(license)
  // Use the benchmark overview as a richer description when available
  const overviewText = card?.benchmark_details?.overview
  // Policy: rich context from metadata card
  const policyGoal = card?.purpose_and_intended_users?.goal
  const policyLimitations = card?.purpose_and_intended_users?.limitations
  const policyAudience = card?.purpose_and_intended_users?.audience
  const audienceText = Array.isArray(policyAudience)
    ? policyAudience.slice(0, 2).join("; ")
    : typeof policyAudience === "string"
    ? policyAudience
    : null
  // Research: score interpretation + similar benchmarks
  const scoreInterpretation = card?.methodology?.interpretation
  const rawSimilar = card?.benchmark_details?.similar_benchmarks
  const similarBenchmarks: string[] = Array.isArray(rawSimilar) ? rawSimilar : rawSimilar ? [rawSimilar] : []
  const domainPreview = domains.slice(0, 2)
  // Validated evaluators (subset of evaluator_names) for the badge.
  const verifiedEvaluators = new Set(summary.verified_evaluator_names ?? [])
  // Source provenance pulled from the pipeline's source_data
  const sourceData = summary.source_data
  const reproducibilitySummary = summary.reproducibility_summary
  const reproducibilityGapCount =
    reproducibilitySummary?.has_reproducibility_gap_count ?? summary.missing_generation_config_count
  const reproducibilityResultsTotal =
    reproducibilitySummary?.results_total ?? summary.models_count
  const datasetName = sourceData?.dataset_name
  const datasetUrl =
    sourceData?.dataset_url ??
    (Array.isArray(sourceData?.url) ? sourceData?.url?.[0] : sourceData?.url) ??
    (sourceData?.hf_repo ? `https://huggingface.co/datasets/${sourceData.hf_repo}` : undefined)
  const datasetVersion = sourceData?.dataset_version
  const sourceTypeLabel = sourceData?.source_type

  return (
    <Card
      className="motion-academic-enter motion-academic-surface motion-academic-hover cursor-pointer overflow-hidden border-border/70 bg-card hover:shadow-lg"
      style={{ "--enter-delay": `${delayMs}ms` } as CSSProperties}
      onClick={() => router.push(`/evals/${routeIdToPath(summary.evaluation_id)}`)}
    >
      <CardHeader className="space-y-3 border-b border-border/60 pb-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
              Single Benchmark
            </div>
            {summary.derived_tags?.map((tag) => (
              <span key={tag} className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${getTagColor(tag)}`}>
                {tagLabel(tag)}
              </span>
            ))}
          </div>
          {shortLicense && (
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${licenseBadgeClass(license)}`}>
              {shortLicense}
            </span>
          )}
        </div>

        <div className="min-w-0">
          <div className="text-xl font-bold">{summary.evaluation_name}</div>
          <div className="mt-1 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Composite: {summary.composite_benchmark_name}
          </div>
          <div className="mt-1 text-sm text-muted-foreground line-clamp-2">
            {/*
             * Policy readers benefit from a plain-language framing of what
             * the benchmark is for. The Auto-BenchmarkCards `goal` field is
             * usually written for non-experts; the `overview` field is more
             * technical. Prefer goal in policy mode, overview in research.
             */}
            {isResearchView
              ? overviewText ?? policyGoal ?? summary.metric_config.evaluation_description
              : policyGoal ?? overviewText ?? summary.metric_config.evaluation_description}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {summary.third_party_ratio > 0 && (
            <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">
              <BadgeCheck className="mr-1 h-3 w-3" />
              Third-party reported
            </Badge>
          )}
          {reproducibilityGapCount > 0 && (
            <Badge className="bg-amber-500 text-amber-950 hover:bg-amber-500">
              <AlertTriangle className="mr-1 h-3 w-3" />
              Reproducibility gap
            </Badge>
          )}
        </div>

        {domains.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className="font-semibold uppercase tracking-[0.16em]">Domain coverage</span>
            {domainPreview.map((domain) => (
              <span
                key={domain}
                className="rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-[10px] font-medium capitalize text-muted-foreground"
              >
                {domain}
              </span>
            ))}
            {domains.length > domainPreview.length && <span>+{domains.length - domainPreview.length} more</span>}
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-4 pt-4">
        {isResearchView ? (
          <>
            <div className="grid gap-2 sm:grid-cols-3">
              <MetricPill icon={FlaskConical} label="Models" value={summary.models_count.toLocaleString()} tone="bg-sky-100/80 text-sky-900 dark:bg-sky-950/40 dark:text-sky-100" />
              <MetricPill icon={ChartNoAxesColumn} label="Avg Score" value={scorePercent} tone="bg-amber-100/80 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100" />
              <MetricPill icon={Users} label="Evaluators" value={summary.evaluator_names.length.toLocaleString()} tone="bg-emerald-100/80 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100" />
            </div>

            {/* Research: score interpretation from metadata */}
            {scoreInterpretation && (
              <div className="rounded-xl border border-sky-200/60 bg-sky-50/40 p-3 text-sm dark:border-sky-900/40 dark:bg-sky-950/10">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-sky-700 dark:text-sky-300">Score interpretation</div>
                <p className="text-muted-foreground line-clamp-2">{scoreInterpretation}</p>
              </div>
            )}

            <div className="rounded-xl border bg-muted/10 p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Methodology</div>
              <div className="space-y-1.5 text-sm">
                {summary.tags?.tasks && summary.tags.tasks.length > 0 && (
                  <DataRow label="Tasks" value={summary.tags.tasks.join(", ")} />
                )}
                {summary.latest_source_name && (
                  <DataRow label="Source" value={summary.latest_source_name} />
                )}
                <DataRow
                  label="Config"
                  value={
                    reproducibilityGapCount > 0
                      ? `${reproducibilityGapCount} of ${reproducibilityResultsTotal} scores have setup gaps`
                      : "Fully documented"
                  }
                />
                <DataRow label="Third-party" value={`${Math.round(summary.third_party_ratio * 100)}%`} />
                {similarBenchmarks.length > 0 && (
                  <DataRow label="See also" value={similarBenchmarks.slice(0, 3).join(", ")} />
                )}
              </div>
            </div>

            {(datasetName || datasetUrl || sourceTypeLabel) && (
              <ProvenanceRow
                datasetName={datasetName}
                datasetUrl={datasetUrl}
                datasetVersion={datasetVersion}
                sourceType={sourceTypeLabel}
              />
            )}
          </>
        ) : (
          <>
            {/* Policy: goal from metadata card */}
            <div className="rounded-xl border border-amber-200/70 bg-amber-50/75 p-3 dark:border-amber-900/40 dark:bg-amber-950/15">
              <div className="flex items-start gap-2">
                <Scale className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div>
                  <div className="text-sm font-semibold">Purpose</div>
                  <div className="text-sm text-muted-foreground line-clamp-3">
                    {policyGoal ?? "General single-benchmark evaluation"}
                  </div>
                </div>
              </div>
            </div>

            {/* Policy: audience + limitations from metadata */}
            {(audienceText || policyLimitations) && (
              <div className="space-y-2">
                {audienceText && (
                  <div className="rounded-xl border border-sky-200/60 bg-sky-50/50 p-3 text-sm dark:border-sky-900/40 dark:bg-sky-950/15">
                    <span className="font-semibold text-sky-800 dark:text-sky-200">Intended for: </span>
                    <span className="text-muted-foreground">{audienceText}</span>
                  </div>
                )}
                {policyLimitations && (
                  <div className="rounded-xl border border-rose-200/60 bg-rose-50/50 p-3 text-sm dark:border-rose-900/40 dark:bg-rose-950/15">
                    <span className="font-semibold text-rose-800 dark:text-rose-200">Known limitation: </span>
                    <span className="text-muted-foreground line-clamp-2">{policyLimitations}</span>
                  </div>
                )}
              </div>
            )}

            <div className="grid gap-2 sm:grid-cols-2">
              <MetricPill icon={BadgeCheck} label="Independent" value={`${Math.round(summary.third_party_ratio * 100)}%`} tone="bg-emerald-100/80 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100" />
              <MetricPill icon={BookOpenText} label="Models" value={summary.models_count.toLocaleString()} tone="bg-sky-100/80 text-sky-900 dark:bg-sky-950/40 dark:text-sky-100" />
            </div>

            <div className="rounded-xl border bg-muted/10 p-3">
              <div className="space-y-1.5 text-sm">
                <DataRow label="Avg score" value={scorePercent} />
                <div className="flex items-start justify-between gap-3">
                  <span className="shrink-0 text-muted-foreground">Reported by</span>
                  <span className="text-right font-medium text-foreground">
                    {summary.evaluator_names.length === 0
                      ? "Unknown"
                      : summary.evaluator_names.map((name, i) => (
                          <span key={name} className="inline-flex items-center">
                            {i > 0 ? ", " : null}
                            {/* Only an org with an evaluator page links;
                                anything else stays plain text. */}
                            {!isKnownEvaluator(name) ? (
                              <span>{name}</span>
                            ) : (
                              <Link
                                href={`/evaluators/${slugFor(name)}`}
                                className="hover:text-[color:var(--accent)] hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {name}
                              </Link>
                            )}
                            <VerifiedBadge
                              verified={verifiedEvaluators.has(name)}
                              recognized={isRecognizedEvaluator(name)}
                              size="sm"
                              className="ml-1 align-middle"
                            />
                          </span>
                        ))}
                  </span>
                </div>
                {reproducibilityGapCount > 0 && (
                  <p className="pt-1 text-xs text-muted-foreground">
                    {reproducibilityGapCount} of {reproducibilityResultsTotal} reported scores are not fully documented.
                  </p>
                )}
              </div>
            </div>

            {(datasetName || datasetUrl || sourceTypeLabel) && (
              <ProvenanceRow
                datasetName={datasetName}
                datasetUrl={datasetUrl}
                datasetVersion={datasetVersion}
                sourceType={sourceTypeLabel}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function MetricPill({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: string
  tone: string
}) {
  return (
    <div className={`flex items-center justify-between rounded-xl px-3 py-2 ${tone}`}>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] opacity-80">{label}</span>
      </div>
      <span className="text-sm font-bold">{value}</span>
    </div>
  )
}

function DataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  )
}

function ProvenanceRow({
  datasetName,
  datasetUrl,
  datasetVersion,
  sourceType,
}: {
  datasetName?: string
  datasetUrl?: string
  datasetVersion?: string
  sourceType?: string
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/60 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        <Database className="h-3 w-3" />
        Upstream dataset
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {datasetName && (
          <span className="font-medium text-foreground">
            {datasetName}
            {datasetVersion ? <span className="text-muted-foreground"> · v{datasetVersion}</span> : null}
          </span>
        )}
        {sourceType && (
          <span className="rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {sourceType.replace(/_/g, " ")}
          </span>
        )}
        {datasetUrl && (
          <a
            href={datasetUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            View source
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  )
}
