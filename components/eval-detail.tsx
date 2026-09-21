"use client"

import { useAudienceMode } from "@/components/audience-mode-provider"
import { Fragment, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { BenchmarkSignalsStrip } from "@/components/signals/benchmark-signals-strip"
import { SignalsRowBadges } from "@/components/signals/signals-row-badges"
import { VerifiedBadge } from "@/components/signals/verified-badge"
import { getCompletenessPopulatedCount } from "@/components/signals/signal-utils"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ScoreDistribution } from "@/components/score-distribution"
import { ParamRangePicker } from "@/components/param-range-picker"
import { EmbedButton } from "@/components/embed-button"
import {
  PARAM_RANGE_MAX_INDEX,
  paramStepToNumeric,
  parseParamsBillionsFromText,
  parseParamsBillionsFromModelName,
} from "@/lib/param-range"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn, formatDateISO, humanizeEvaluationId, routeIdFromModelId, routeIdToPath } from "@/lib/utils"
import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
  Globe,
  Scale,
  Search,
  Shield,
  SlidersHorizontal,
  Tag,
  X,
} from "lucide-react"
import type { BenchmarkCard, SourceData } from "@/lib/benchmark-schema"
import { tagLabel } from "@/lib/benchmark-schema"
import {
  groupByHeadlineModel,
  isAssistedResult,
  isHeadlineResult,
  judgeCellSummary,
  judgeConditionSummary,
  modelGroupKey,
  orderGroupsByScore,
  primaryMetricColumnKey,
  scoreSortBaseDirection,
  summariseScores,
} from "@/lib/eval-processing"
import type { BenchmarkEvalSummary, ModelResultForBenchmark } from "@/lib/eval-processing"
import {
  chooseProtocolColumns,
  formatProtocolValue,
  type ProtocolColumn,
} from "@/lib/collections"
import { CollectionTrajectories } from "@/components/collection-trajectories"
import { isRecognizedEvaluator } from "@/lib/evaluators"
import { useEvaluatorSlug } from "@/components/org-metadata-provider"
import type { ComparisonIndex, EvalHierarchy } from "@/lib/backend-artifacts"
import type { HierarchyEvalLocation } from "@/lib/hierarchy-lookup"
import { PolicyOverview } from "@/components/policy-overview"
import { ResearcherReproducibilityCard } from "@/components/researcher-reproducibility-card"
import { KnownIssuesPanel } from "@/components/known-issues-panel"
import { getKnownIssues, type KnownIssue } from "@/lib/known-issues"
import { ApplesToApplesBanner } from "@/components/apples-to-apples-banner"
import { ComparabilityPanel } from "@/components/signals/comparability-panel"
import { FlagScoreButton } from "@/components/flag-score-button"
import { OpennessFilter } from "@/components/openness-filter"
import {
  MODEL_OPENNESS_ORDER,
  matchesOpenness,
  modelOpenness,
  type ModelOpenness,
} from "@/lib/model-openness"

interface SplitOption {
  id: string
  label: string
}

interface SplitConfig {
  options: SplitOption[]
  activeId: string
  onChange: (id: string) => void
  /** Picker label, e.g. "Split" or "Slice". */
  label?: string
}

interface EvalDetailProps {
  summary: BenchmarkEvalSummary
  hierarchyLocation?: HierarchyEvalLocation | null
  /** Full eval hierarchy — used by the signals strip to find sibling
   *  appearances of the same canonical benchmark across other suites. */
  evalHierarchy?: EvalHierarchy | null
  /** Per-(eval, metric) leaderboard data — used to fetch sibling scores
   *  for cross-suite comparability. */
  comparisonIndex?: ComparisonIndex | null
  /**
   * Drives the leaderboard section when a split is selected. Defaults to
   * `summary` when omitted, preserving the single-summary behaviour.
   */
  activeSummary?: BenchmarkEvalSummary
  splitConfig?: SplitConfig
  /** Rows for which this returns true get a warm background tint. Used by
   *  the merged page for the ?source= pre-highlight. */
  rowHighlight?: (modelResult: ModelResultForBenchmark) => boolean
  /** Merged pages only: link target for "view the study's per-setting
   *  analysis" inside the study-protocol banner. The merged page has no
   *  per-source evaluation_id in scope here, so MergedBenchmarkView
   *  passes the resolved per-source href down. */
  studySourceHref?: string
}

/** One model's folded leaderboard row: the number it reports, and every
 *  reading that number was folded from. */
interface LeaderboardFold {
  key: string
  rank: number
  /** The pipeline's designated reading for this model — the row whose
   *  metadata the folded row shows. NOT a number the source declared:
   *  the producer picks it (best non-assisted arm, or the preferred
   *  judge panel), so it must never be labelled as the study's own
   *  reported figure. */
  headlineRow: LeaderboardRow
  /** Every reading of this model on this page, headline first. */
  members: LeaderboardRow[]
  /** Mean across every reading in the fold. */
  foldedScore: number
  /** Half-width of the 95% interval across the runs, or null for a
   *  single run. Spread across CONFIGURATIONS, not sampling error. */
  ci95: number | null
  normalizedScore: number
  runCount: number
  minScore: number
  maxScore: number
  assistedCount: number
}

interface LeaderboardRow {
  key: string
  rank: number
  modelResult: ModelResultForBenchmark
  normalizedScore: number
  /** "judged by <model>" / "mean of N judges" for a row whose
   *  source disclosed its LLM judges; null for ordinary rows. */
  judgeLabel: string | null
  /** Hover text for the judge label: the panel's members on a multi-judge
   *  row, and on a single-judge row the judge's raw canonical id — two
   *  dated variants that folded into one survivor share a display name,
   *  so the id is the only thing telling those rows apart. */
  judgeTooltip?: string
}

type LeaderboardMetric = NonNullable<BenchmarkEvalSummary["leaderboard_metrics"]>[number]
type LeaderboardMatrixRow = NonNullable<BenchmarkEvalSummary["leaderboard_rows"]>[number]

/**
 * Pick a representative row-level annotation for the matrix view.
 *
 * Reproducibility and provenance are typically constant across all metrics for
 * a given (model, benchmark) pair, so rendering them in every cell is just
 * noise. This helper grabs the first non-null annotation across visible metrics
 * and returns it for the row-level badge strip.
 */
function getRowLevelAnnotations(
  row: LeaderboardMatrixRow,
  visibleMetrics: LeaderboardMetric[]
) {
  const annotationsByMetric = row.annotations_by_metric
  if (!annotationsByMetric) {
    return null
  }

  for (const metric of visibleMetrics) {
    const annotations = annotationsByMetric[metric.column_key]
    if (annotations) {
      return annotations
    }
  }

  return null
}

/**
 * Compact dropdown shown above the leaderboard when an eval has multiple
 * splits (separate eval IDs that share a benchmark) or slices (subtasks within
 * one eval). Lives below the apples-to-apples banner so the hero/cards stay
 * stable while the leaderboard data swaps.
 */
function SplitPicker({
  config,
  className,
}: {
  config: {
    options: { id: string; label: string }[]
    activeId: string
    onChange: (id: string) => void
    label?: string
  }
  className?: string
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <span
        className="font-mono uppercase tracking-[0.14em] shrink-0"
        style={{ fontSize: 10, color: "var(--fg-subtle)" }}
      >
        {config.label ?? "Split"}
      </span>
      <select
        className="ec-select"
        value={config.activeId}
        onChange={(event) => config.onChange(event.target.value)}
      >
        {config.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}

const SLICE_PILL_THRESHOLD = 5

interface SliceTab {
  key: string
  label: string
}

/**
 * Slice picker that adapts to slice count.
 *
 * - <= SLICE_PILL_THRESHOLD: render every slice as a pill (current familiar UX).
 * - > SLICE_PILL_THRESHOLD: render "All slices" + currently-selected pill +
 *   a "Browse N slices" button that opens a searchable dialog. Hundreds of
 *   slices (e.g. AIRBench's 374) fit cleanly.
 */
function SliceSelector({
  activeSliceTab,
  onChange,
  tabs,
}: {
  activeSliceTab: string
  onChange: (key: string) => void
  tabs: SliceTab[]
}) {
  const [browserOpen, setBrowserOpen] = useState(false)
  const [search, setSearch] = useState("")

  const useBrowser = tabs.length > SLICE_PILL_THRESHOLD
  const activeTab = tabs.find((tab) => tab.key === activeSliceTab)

  const filteredTabs = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return tabs
    return tabs.filter((tab) => tab.label.toLowerCase().includes(query))
  }, [search, tabs])

  if (!useBrowser) {
    return (
      <div>
        <div className="kicker mb-2">Benchmark slices</div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={`ec-pill${activeSliceTab === "all" ? " on" : ""}`}
            onClick={() => onChange("all")}
          >
            All slices
          </button>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`ec-pill${activeSliceTab === tab.key ? " on" : ""}`}
              onClick={() => onChange(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="kicker">Benchmark slices</div>
        <span className="kicker">{tabs.length} total</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`ec-pill${activeSliceTab === "all" ? " on" : ""}`}
          onClick={() => onChange("all")}
        >
          All slices
        </button>
        {activeTab && (
          <button
            type="button"
            className="ec-pill on max-w-[18rem] truncate"
            onClick={() => onChange("all")}
            title={`Active: ${activeTab.label}. Click to clear.`}
          >
            {activeTab.label}
            <X className="ml-1.5 inline-block h-3 w-3 shrink-0" />
          </button>
        )}
        <button
          type="button"
          className="ec-pill"
          onClick={() => setBrowserOpen(true)}
        >
          <Search className="mr-1.5 inline-block h-3 w-3" />
          {activeTab ? "Change slice" : `Browse ${tabs.length} slices`}
        </button>
      </div>

      <Dialog
        open={browserOpen}
        onOpenChange={(open) => {
          setBrowserOpen(open)
          if (!open) setSearch("")
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Browse benchmark slices</DialogTitle>
            <DialogDescription>
              {tabs.length} slices in this benchmark. Pick one to filter the leaderboard,
              or close to keep showing all slices.
            </DialogDescription>
          </DialogHeader>

          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search slices..."
            autoFocus
          />

          <div className="max-h-[60vh] overflow-y-auto border" style={{ borderRadius: 0 }}>
            <button
              type="button"
              onClick={() => {
                onChange("all")
                setBrowserOpen(false)
              }}
              className={cn(
                "flex w-full items-center justify-between border-b px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted/40",
                activeSliceTab === "all" && "bg-muted/40 font-semibold"
              )}
            >
              <span>All slices (no filter)</span>
              {activeSliceTab === "all" && <span className="text-xs text-muted-foreground">selected</span>}
            </button>
            {filteredTabs.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                No slices match "{search}".
              </div>
            ) : (
              filteredTabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => {
                    onChange(tab.key)
                    setBrowserOpen(false)
                  }}
                  className={cn(
                    "flex w-full items-center justify-between border-b px-4 py-2 text-left text-sm transition-colors hover:bg-muted/40 last:border-b-0",
                    activeSliceTab === tab.key && "bg-muted/40 font-semibold"
                  )}
                >
                  <span className="min-w-0 truncate pr-2">{tab.label}</span>
                  {activeSliceTab === tab.key && (
                    <span className="shrink-0 text-xs text-muted-foreground">selected</span>
                  )}
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function getParamsBillionsFromModelInfo(modelInfo: ModelResultForBenchmark["model_info"]) {
  const additionalDetails = modelInfo.additional_details
  const rawParamsBillions =
    additionalDetails?.params_billions ??
    additionalDetails?.parameter_count ??
    additionalDetails?.num_parameters ??
    additionalDetails?.params

  if (typeof rawParamsBillions === "number") {
    return rawParamsBillions
  }

  if (typeof rawParamsBillions === "string") {
    const parsed = parseParamsBillionsFromText(rawParamsBillions)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  if (typeof modelInfo.parameter_count === "string") {
    const parsed = parseParamsBillionsFromText(modelInfo.parameter_count)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return parseParamsBillionsFromModelName(modelInfo.name)
}

function getParamsBillions(modelResult: ModelResultForBenchmark) {
  return getParamsBillionsFromModelInfo(modelResult.model_info)
}

function formatMetadataValue(value: unknown): string {
  if (value == null) {
    return "N/A"
  }

  if (typeof value === "string") {
    return value
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toLocaleString() : String(value)
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false"
  }

  if (Array.isArray(value)) {
    return value.map((item) => formatMetadataValue(item)).join(", ")
  }

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// Re-exported as `formatDate` so the existing call sites in this file
// keep working — the component code reads "formatDate" everywhere. The
// shared YYYY-MM-DD implementation lives in `lib/utils` so model-page
// and other surfaces format identically.
const formatDate = formatDateISO

/**
 * Render an evaluator org name. When `linkName` is a known evaluator (a
 * de-aliased name with a /evaluators/<slug> page) the name links there;
 * otherwise it renders as plain text so we never emit a broken link. The
 * slug uses the shared, deterministic `evaluatorSlug` base helper.
 */
function EvaluatorName({
  display,
  linkName,
  className,
  style,
}: {
  display: React.ReactNode
  linkName: string | null
  className?: string
  style?: React.CSSProperties
}) {
  const slugFor = useEvaluatorSlug()
  if (!linkName) {
    return <span className={className} style={style}>{display}</span>
  }
  return (
    <Link
      href={`/evaluators/${slugFor(linkName)}`}
      className={cn("hover:text-[color:var(--accent)] hover:underline", className)}
      style={style}
      onClick={(e) => e.stopPropagation()}
    >
      {display}
    </Link>
  )
}

/**
 * Render a benchmark-card field path (e.g. `methodology.metrics`,
 * `purpose_and_intended_users.goal`) as a human-readable label —
 * `Methodology › Metrics`, `Purpose and intended users › Goal`.
 *
 * Replaces underscores with spaces and joins dotted segments with a
 * `›` separator. Capitalises the first letter of each segment but
 * keeps the rest lower-case so multi-word segments like
 * `purpose_and_intended_users` don't render as a tower of capitals.
 */
function humanizeCardFieldPath(path: string): string {
  return path
    .split(".")
    .map((seg) => {
      const spaced = seg.replace(/_/g, " ").trim()
      if (!spaced) return seg
      return spaced.charAt(0).toUpperCase() + spaced.slice(1)
    })
    .join(" › ")
}

/**
 * Card-quality notes from the AutoBenchmarkCard pipeline arrive as
 * strings shaped like `[Possible Hallucination], no supporting
 * evidence found in source material`. The leading bracketed label
 * names the *kind* of issue; the rest is the specific note.
 *
 * Split them so the renderer can promote the kind to a small badge
 * and treat the body as flowing prose. Falls back to `{tag: null,
 * body: <whole string>}` when no leading bracket is present.
 */
function splitFlagNote(raw: string): { tag: string | null; body: string } {
  if (!raw) return { tag: null, body: "" }
  const match = /^\s*\[([^\]]+)\]\s*[,—\-:]?\s*(.*)$/.exec(raw)
  if (!match) return { tag: null, body: raw.trim() }
  return { tag: match[1].trim(), body: match[2].trim() }
}

function formatRawScore(score: number | null | undefined, unit?: string) {
  if (score == null || !Number.isFinite(score)) return "—"
  const suffix = unit ? ` ${unit}` : ""
  return `${score.toFixed(2)}${suffix}`
}

function isNumericScore(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/**
 * Sortable column-header button used by the single-metric leaderboard.
 * Lives inside a `<th>` so the th's hairline border / cell layout still
 * apply; the button only owns the label, the arrow indicator, and the
 * click target.
 *
 * `<button>` resets `text-transform`, so we re-assert `uppercase`
 * explicitly to match the surrounding plain-th uppercase styling.
 */
function SortableTh({
  label,
  active,
  indicator,
  onClick,
  title,
}: {
  label: string
  active: boolean
  indicator: "↑" | "↓" | null
  onClick: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? `Sort by ${label.toLowerCase()}`}
      className="inline-flex items-center gap-1 hover:text-[color:var(--accent)] transition-colors"
      style={{
        background: "transparent",
        border: 0,
        padding: 0,
        cursor: "pointer",
        font: "inherit",
        color: active ? "var(--accent)" : "inherit",
        letterSpacing: "inherit",
        textTransform: "uppercase",
      }}
    >
      {label}
      {indicator && (
        <span aria-hidden style={{ fontSize: 9 }}>
          {indicator}
        </span>
      )}
    </button>
  )
}

function metricLabelReadsAsPercentage(metricLabel: string, unit?: string) {
  const normalized = `${metricLabel} ${unit ?? ""}`.toLowerCase()
  return unit === "%" || /percent|percentage|accuracy|exact match|win rate|pass@|precision|recall|f1/.test(normalized)
}

function describeLeaderboardMetric(metric: LeaderboardMetric) {
  const metricLabel = getMetricChipLabel(metric)
  const metricPhrase = metricLabelReadsAsPercentage(metricLabel, metric.unit)
    ? `${metricLabel} percentage`
    : metricLabel

  if (metric.scope === "subtask" && metric.subtask_name) {
    return `${metricPhrase} for ${metric.subtask_name}`
  }

  // Bold label already carries the compact name; only add a subtitle when the
  // canonical name says something more than the label (avoid echoing it).
  const canonical = metric.canonical_display_name?.trim()
  return canonical && canonical !== metricLabel ? canonical : ""
}

function compactizePath(value: string): string {
  const parts = value
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
  return parts[parts.length - 1] ?? value
}

function getCompactMetricLabel(value: string | undefined): string {
  if (value && value.trim()) return compactizePath(value)
  return "Metric"
}

/**
 * Humanise a raw metric identifier (metric_id / column_key) into a
 * compact, readable label.
 *
 * Two shapes the upstream view layer leaves un-curated:
 *  - path-ish keys (`inspect_evals/avg_full_score`) → keep the tail
 *    (`avg full score`).
 *  - `<benchmark-slug>.<stat>` keys (`cyse2-vulnerability-exploit.mean`,
 *    `swebench-…-mariushobbhahn.mean`) → the slug prefix just repeats the
 *    eval name, so collapse to the trailing stat (`Mean`). Without this the
 *    column header echoes the raw UPPER.SLUG.
 */
function humanizeMetricKey(raw: string): string {
  const tail = compactizePath(raw)
  // `<slug>.mean` / `.std` / `.stderr` → just the trailing stat.
  const dotMatch = /^(.+)\.([a-z0-9_]+)$/i.exec(tail)
  if (dotMatch) {
    const [, prefix, stat] = dotMatch
    // Only collapse when the prefix looks like a slug (has a hyphen or is
    // long), not a genuinely dotted metric name.
    if (prefix.includes("-") || prefix.length > 6) {
      return humanizeMetricKey(stat)
    }
  }
  const spaced = tail.replace(/_/g, " ").trim()
  if (!spaced) return tail
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * Build a chip-friendly label for a leaderboard metric. Prefers a curated
 * display_name / metric_name, then a humanised tail of metric_id /
 * column_key. The upstream pipeline frequently leaves display_name blank
 * (e.g. inspect_evals/avg_full_score → ifeval's final_acc, inst_loose_acc)
 * or echoes the raw column key as the "display name" (cyse2's
 * `cyse2-vulnerability-exploit.mean`). In both cases the humanised key tail
 * is what we want to surface — never the literal 'Metric' or a raw slug.
 */
function getMetricChipLabel(metric: {
  display_name?: string | null
  metric_name?: string | null
  metric_id?: string | null
  column_key?: string | null
}): string {
  const key = metric.metric_id ?? metric.column_key ?? null
  // Treat a display/metric name that merely echoes the raw column key as
  // absent — it carries no more information than the key itself.
  const isRawEcho = (value: string | null | undefined) =>
    !!value && !!key && value.trim() === key.trim()

  const candidates = [
    isRawEcho(metric.display_name) ? null : metric.display_name,
    isRawEcho(metric.metric_name) ? null : metric.metric_name,
  ]
  for (const c of candidates) {
    if (c && String(c).trim()) {
      return compactizePath(String(c)).replace(/_/g, " ")
    }
  }
  if (key && key.trim()) {
    return humanizeMetricKey(key)
  }
  return "Metric"
}

/**
 * Best-effort "setup" caption for a row (e.g. "8-shot CoT", "0-shot").
 *
 * Different sources record shots/CoT in different fields, so we look across
 * the common ones in priority order. If nothing useful is recorded we return
 * an empty string and the caller hides the caption rather than printing a
 * placeholder.
 */
function getSetupLabel(modelResult: ModelResultForBenchmark): string {
  const gen = modelResult.result.generation_config
  const args: Record<string, unknown> | undefined = gen?.generation_args as Record<string, unknown> | undefined
  const additional: Record<string, unknown> | undefined =
    typeof gen?.additional_details === "object" && gen?.additional_details !== null
      ? (gen.additional_details as Record<string, unknown>)
      : undefined

  const pickNumber = (...candidates: Array<unknown>) => {
    for (const c of candidates) {
      if (typeof c === "number" && Number.isFinite(c)) return c
      if (typeof c === "string" && /^\d+$/.test(c.trim())) return Number(c.trim())
    }
    return null
  }
  const pickString = (...candidates: Array<unknown>) => {
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim()
    }
    return null
  }

  const shots = pickNumber(
    args?.num_shots,
    args?.n_shots,
    args?.shots,
    args?.num_few_shot,
    additional?.num_shots,
    additional?.n_shots,
    additional?.shots,
  )
  const promptingHint = pickString(
    args?.prompting_strategy,
    args?.reasoning,
    additional?.prompting_strategy,
    additional?.reasoning,
  )
  const isCot = (() => {
    const candidates = [
      args?.chain_of_thought,
      args?.cot,
      additional?.chain_of_thought,
      additional?.cot,
    ]
    if (candidates.some((c) => c === true)) return true
    if (promptingHint && /\bcot\b|chain.of.thought/i.test(promptingHint)) return true
    return false
  })()

  const parts: string[] = []
  if (shots != null) parts.push(`${shots}-shot`)
  if (isCot) parts.push("CoT")
  if (parts.length === 0 && promptingHint) parts.push(promptingHint)
  return parts.join(" ")
}

export function EvalDetail({
  summary,
  hierarchyLocation,
  evalHierarchy,
  comparisonIndex,
  activeSummary,
  splitConfig,
  rowHighlight,
  studySourceHref,
}: EvalDetailProps) {
  const { mode } = useAudienceMode()
  const isResearchView = mode === "research"
  // The leaderboard section reads from `lb` (the active split when one is
  // selected, else the page-level summary). Hero / cards / signals continue to
  // read from `summary` so the rich info above the leaderboard stays stable.
  const lb = activeSummary ?? summary

  /**
   * Does the comparability data carry per-model attribution we can actually
   * surface? When false the apples-to-apples banner switches to honest copy
   * that doesn't promise a model list / panel that won't render. The
   * producer pipeline ships rollup counts even on benchmarks where the
   * per-row `has_*_divergence` flags and per-group breakdowns are empty
   * (e.g. cocoabench), so this guard avoids a misleading banner.
   */
  const hasComparabilityActionableDetail = useMemo(() => {
    const ann = summary.evalcards?.annotations?.benchmark_comparability
    if ((ann?.variant_divergence_groups?.length ?? 0) > 0) return true
    if ((ann?.cross_party_divergence_groups?.length ?? 0) > 0) return true
    for (const r of summary.model_results ?? []) {
      const a = r.result?.evalcards?.annotations
      // Strict `=== true`: the flags are nullable and a NULL means the
      // group was never assessed, which is not per-model attribution.
      if (a?.variant_divergence?.has_variant_divergence === true) return true
      if (a?.cross_party_divergence?.has_cross_party_divergence === true) return true
    }
    return false
  }, [summary.evalcards?.annotations?.benchmark_comparability, summary.model_results])
  // Multi-metric leaderboard is only meaningful when there is more than one
  // *root* metric. Subtask-scope entries are slices of one root metric (e.g.
  // Global MMLU has 19 language slices of `score`); promoting them to columns
  // here makes the matrix mix metrics and splits in confusing ways. Those
  // evals fall into the single-metric branch where a slice picker drives the
  // score column instead.
  const rootMetricCount = (lb.leaderboard_metrics ?? []).filter(
    (m) => m.scope !== "subtask",
  ).length
  const hasMultiMetricLeaderboard =
    rootMetricCount > 1 && (lb.leaderboard_rows?.length ?? 0) > 0
  const [overviewOpen, setOverviewOpen] = useState(true)
  // Collapse the dense technical overview by default in policy mode; expand
  // for researchers. Reset whenever the user switches modes.
  useEffect(() => {
    setOverviewOpen(isResearchView)
  }, [isResearchView])
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({})
  const [leaderboardPage, setLeaderboardPage] = useState(1)
  const [minParamStep, setMinParamStep] = useState(0)
  const [maxParamStep, setMaxParamStep] = useState(PARAM_RANGE_MAX_INDEX)

  const maxScore = lb.metric_config.max_score ?? 1
  const minScore = lb.metric_config.min_score ?? 0
  const range = maxScore - minScore

  const normalizeScore = (raw: number) => (range > 0 ? (raw - minScore) / range : raw)

  const numericMinParams = useMemo(() => paramStepToNumeric(minParamStep, "min"), [minParamStep])
  const numericMaxParams = useMemo(() => paramStepToNumeric(maxParamStep, "max"), [maxParamStep])

  // Slice picker — visible when the eval has a single root metric but
  // multiple subtask-scope entries (e.g. Global MMLU's 19 languages).
  // Picking a slice swaps each model's score for that slice's score
  // pulled from `lb.leaderboard_rows[i].values["{rootMetric}::{slice}"]`.
  const subtaskSlices = useMemo(() => {
    const seen = new Map<string, string>()
    for (const metric of lb.leaderboard_metrics ?? []) {
      if (metric.scope === "subtask" && metric.subtask_key && !seen.has(metric.subtask_key)) {
        seen.set(metric.subtask_key, metric.subtask_name ?? metric.subtask_key)
      }
    }
    return Array.from(seen, ([key, name]) => ({ key, label: name }))
  }, [lb.leaderboard_metrics])

  // Suppress the slice picker when a split picker is already in play.
  // For evals like Fibble Arena both pickers partition the same axis
  // (each split is one of the per-lie variants; each slice is the
  // matrix-backfilled subtask for the same per-lie variant), so showing
  // both reads as a redundant control. The page-level split is more
  // authoritative — it loads richer per-eval data — so it wins.
  const hasSlicePicker =
    !hasMultiMetricLeaderboard && subtaskSlices.length > 1 && !splitConfig

  const ALL_SLICE_KEY = "__all__"
  const [activeSlice, setActiveSlice] = useState<string>(ALL_SLICE_KEY)

  // Reset the picker when the underlying eval changes (e.g. user flips
  // the page-level split dropdown to a sibling that doesn't carry the
  // previously-selected slice).
  useEffect(() => {
    setActiveSlice(ALL_SLICE_KEY)
  }, [lb.evaluation_id])

  const primaryMetricColumn = useMemo(
    () =>
      (lb.leaderboard_metrics ?? []).find((m) => m.scope !== "subtask")
        ?.column_key,
    [lb.leaderboard_metrics],
  )

  const slicedScoreByRoute = useMemo(() => {
    if (!hasSlicePicker || activeSlice === ALL_SLICE_KEY || !primaryMetricColumn) {
      return null
    }
    const columnKey = `${primaryMetricColumn}::${activeSlice}`
    const map = new Map<string, number>()
    for (const row of lb.leaderboard_rows ?? []) {
      if (!row.model_route_id) continue
      const value = row.values[columnKey]
      if (typeof value === "number" && Number.isFinite(value)) {
        map.set(row.model_route_id, value)
      }
    }
    return map
  }, [
    hasSlicePicker,
    activeSlice,
    primaryMetricColumn,
    lb.leaderboard_rows,
  ])

  // Judge display names are resolved server-side against models_view (a
  // judge need not appear on this page at all, and its id can be a dated
  // variant that folded into another model). An id models_view cannot
  // place keeps its raw spelling rather than being hidden.
  const judgeDisplayName = useMemo(() => {
    const names = lb.judge_display_names ?? summary.judge_display_names ?? {}
    return (modelId: string) => names[modelId] ?? modelId
  }, [lb.judge_display_names, summary.judge_display_names])

  // The view ships one row per (model, protocol arm, judge
  // panel) and marks ONE of them as the model's headline reading. Sort
  // and rank the headline rows; each model's other rows follow directly
  // beneath their headline, in the order the producer served them, and
  // never take a rank. On snapshots predating the column every row is a
  // headline, so this is the old flat ordering exactly.
  const sortedResults = useMemo(() => {
    const sourceResults = slicedScoreByRoute
      ? lb.model_results
          .map((result) => {
            const route = result.model_route_id
            const overrideScore = route ? slicedScoreByRoute.get(route) : undefined
            return overrideScore != null
              ? { ...result, score: overrideScore }
              : null
          })
          .filter((r): r is NonNullable<typeof r> => r !== null)
      : lb.model_results

    const secondaryByModel = new Map<string, ModelResultForBenchmark[]>()
    const headline: ModelResultForBenchmark[] = []
    for (const result of sourceResults) {
      if (isHeadlineResult(result)) {
        headline.push(result)
        continue
      }
      const key = modelGroupKey(result)
      secondaryByModel.set(key, [...(secondaryByModel.get(key) ?? []), result])
    }
    headline.sort((a, b) =>
      lb.metric_config.lower_is_better ? a.score - b.score : b.score - a.score
    )

    const ordered: ModelResultForBenchmark[] = []
    for (const result of headline) {
      ordered.push(result)
      const key = modelGroupKey(result)
      const secondary = secondaryByModel.get(key)
      if (secondary) {
        ordered.push(...secondary)
        secondaryByModel.delete(key)
      }
    }
    // A non-headline row whose model has no headline row on this page
    // (e.g. the headline lives on another metric) still deserves to be
    // readable, so keep it at the end rather than dropping it.
    for (const secondary of secondaryByModel.values()) ordered.push(...secondary)
    return ordered
  }, [lb.model_results, lb.metric_config.lower_is_better, slicedScoreByRoute])

  const [showUnknownSize, setShowUnknownSize] = useState(true)

  // Protocol-varied collections (e.g. the AISI inference-scaling study):
  // rows may carry a protocol_condition. Assisted (answer-feedback) runs
  // are shown but UNRANKED by default — mirroring the backend, which never
  // serves them a rank — with an explicit opt-in that re-includes them in
  // the client-side ranking.
  const hasProtocolRows = useMemo(
    () => lb.model_results.some((r) => r.protocol_condition != null),
    [lb.model_results]
  )
  const protocolRowCount = useMemo(
    () => lb.model_results.filter((r) => r.protocol_condition != null).length,
    [lb.model_results]
  )
  const allRowsHaveProtocol = protocolRowCount === lb.model_results.length
  const hasAssistedRows = useMemo(
    () => lb.model_results.some((r) => isAssistedResult(r.protocol_condition)),
    [lb.model_results]
  )
  // In the producer's current contract an assisted row is never its
  // model's headline reading, so it cannot be ranked back in — the
  // backend has already withheld the rank, and offering to "include it in
  // the ranking" would promise something the data forbids. On such a page
  // the toggle governs whether the assisted rows are SHOWN. On a snapshot
  // that still serves assisted rows as headlines, the old meaning stands.
  const assistedRowsAreNonHeadline = useMemo(
    () =>
      hasAssistedRows &&
      lb.model_results.every(
        (r) => !isAssistedResult(r.protocol_condition) || r.is_headline === false
      ),
    [hasAssistedRows, lb.model_results]
  )
  const [includeAssistedInRanking, setIncludeAssistedInRanking] = useState(false)
  const [showAssistedRows, setShowAssistedRows] = useState(true)

  // Protocol rows repeat the model name — nine "Claude Opus 4.6" rows on
  // the AISI inference-scaling page are nine runs at different reasoning
  // budgets, and with only the name and the metric in the cell they read
  // as nine copies of one row with inexplicably different scores. Give
  // each axis that actually varies its own column. Derived from the whole
  // page's rows, not the visible page, so the table doesn't change shape
  // as the reader pages or filters.
  const protocolColumns = useMemo<ProtocolColumn[]>(
    () =>
      chooseProtocolColumns(
        lb.model_results.map((result) => result.protocol_condition),
        summary.collection?.protocol_axes,
      ),
    [lb.model_results, summary.collection?.protocol_axes]
  )

  /** The compact one-line form for the narrow table, which has no room
   *  for a column per axis: "xhigh · 32k · on". */
  const protocolSummaryFor = useMemo(
    () => (result: ModelResultForBenchmark) => {
      if (protocolColumns.length === 0) return null
      const parts = protocolColumns
        .map((column) => formatProtocolValue(result.protocol_condition, column))
        .filter((part): part is string => part != null)
      return parts.length > 0 ? parts.join(" · ") : null
    },
    [protocolColumns]
  )

  const hasParameterData = useMemo(
    () => sortedResults.some((result) => getParamsBillions(result) != null),
    [sortedResults]
  )

  const filteredResults = useMemo(() => {
    return sortedResults.filter((modelResult) => {
      if (
        assistedRowsAreNonHeadline &&
        !showAssistedRows &&
        isAssistedResult(modelResult.protocol_condition)
      ) {
        return false
      }
      const paramsBillions = getParamsBillions(modelResult)

      if (paramsBillions == null) return showUnknownSize

      if (numericMinParams != null && paramsBillions < numericMinParams) return false
      if (numericMaxParams != null && paramsBillions > numericMaxParams) return false
      return true
    })
  }, [
    assistedRowsAreNonHeadline,
    numericMaxParams,
    numericMinParams,
    showAssistedRows,
    showUnknownSize,
    sortedResults,
  ])

  // Individual readings no longer carry a rank: the leaderboard shows one
  // FOLDED row per model and the fold is what gets ranked. A reading's
  // own score still travels with it for the unfurled list.
  const leaderboardRows = useMemo<LeaderboardRow[]>(() => {
    return filteredResults.map((modelResult, index) => {
      const judge = judgeConditionSummary(modelResult.judge_condition, judgeDisplayName)

      return {
        key: `${modelResult.model_info.id}-${index}`,
        rank: 0,
        modelResult,
        normalizedScore: normalizeScore(modelResult.score),
        judgeLabel: judge?.label ?? null,
        judgeTooltip: !judge
          ? undefined
          : judge.names.length > 1
            ? `Judges: ${judge.names.join(", ")}`
            : `Judge model id: ${judge.judges[0]}`,
      }
    })
  }, [filteredResults, judgeDisplayName])

  // Plotbox input: assisted runs stay out of the distribution stats and
  // the frontier cumulative-best regardless of the ranking toggle — a
  // "best" that needed the answer oracle is not a frontier. Non-headline
  // rows stay out for the same reason the ranking excludes them: one
  // model must contribute one measurement to a distribution.
  const unassistedLeaderboardRows = useMemo(
    () =>
      leaderboardRows.filter(
        (r) =>
          isHeadlineResult(r.modelResult) &&
          !isAssistedResult(r.modelResult.protocol_condition)
      ),
    [leaderboardRows]
  )

  // Context view: the study's own score for each model placed among the
  // community's published measurements. Server-built and pre-joined by
  // the producer; null unless this exact (collection, benchmark) pair
  // passed the bake gates.
  const scaffoldContext = summary.collection?.context ?? undefined

  // Optional user-driven sort. `default` keeps the score-ordered rows
  // the ranker already produced. The rank label is always by score
  // regardless of row order — it's the model's standing on this metric,
  // not its position in the visible table.
  type RowSortKey =
    | "default"
    | "model"
    | "developer"
    | "score"
    | "evaluator"
    | "source"
    | "released"
    | "updated"
  const [userRowSort, setUserRowSort] = useState<{ key: RowSortKey; dir: "asc" | "desc" }>(
    { key: "default", dir: "desc" },
  )

  const [openness, setOpenness] = useState<ModelOpenness[]>([...MODEL_OPENNESS_ORDER])

  // Weights filter narrows which standings are DISPLAYED; it deliberately
  // does not re-rank. A model's rank is its position in the full standings,
  // so filtering to open weights shows "best open model is #4 overall"
  // rather than renumbering it to #1 and losing that.
  const opennessVisibleRows = useMemo(
    () =>
      leaderboardRows.filter((row) =>
        matchesOpenness(row.modelResult.model_info?.open_weights, openness)
      ),
    [leaderboardRows, openness]
  )

  const opennessCounts = useMemo(() => {
    const tally: Partial<Record<ModelOpenness, number>> = {}
    for (const row of leaderboardRows) {
      const bucket = modelOpenness(row.modelResult.model_info?.open_weights)
      tally[bucket] = (tally[bucket] ?? 0) + 1
    }
    return tally
  }, [leaderboardRows])

  // A model and the judge / protocol readings sitting beneath it move
  // together. Sorting the flattened row list would immediately break that:
  // reversing it alone puts every secondary row ABOVE its own headline.
  const leaderboardGroups = useMemo(
    () => groupByHeadlineModel(opennessVisibleRows, (row) => row.modelResult),
    [opennessVisibleRows]
  )

  // One row per MODEL. A study that ran a model under many
  // configurations produced many readings of one model, and listing them
  // all at top level made the standings unreadable: the same name nine
  // times, one of them ranked and the rest not. So each model folds to a
  // single row carrying the MEDIAN of its readings — its typical
  // behaviour across the configurations, not its best one — and the
  // readings themselves live behind the row's expander.
  //
  // Assisted readings are excluded from the median: a score the model
  // reached by being told when its answer was correct is not evidence of
  // its typical behaviour. They are still listed when the row unfurls.
  const foldedLeaderboardGroups = useMemo<LeaderboardFold[]>(() => {
    const folds = leaderboardGroups.map((members) => {
      const headlineRow =
        members.find((row) => isHeadlineResult(row.modelResult)) ?? members[0]
      // Every reading the fold holds counts. An assisted run is one of
      // the conditions the study deliberately ran, so leaving it out
      // would be our editorial judgment rather than the study's design;
      // a reader who wants it gone hides assisted runs, which removes
      // them from the fold and from this number together.
      const scores = members.map((row) => row.modelResult.score)
      const summary = summariseScores(scores)
      const mean = summary?.mean ?? headlineRow.modelResult.score
      return {
        key: headlineRow.key,
        rank: 0,
        headlineRow,
        members,
        foldedScore: mean,
        ci95: summary?.ci95 ?? null,
        normalizedScore: normalizeScore(mean),
        runCount: members.length,
        minScore: summary?.min ?? mean,
        maxScore: summary?.max ?? mean,
        assistedCount: members.filter((row) =>
          isAssistedResult(row.modelResult.protocol_condition)
        ).length,
      }
    })

    // Rank the folds, best first for the metric's own direction. One
    // rank per model, no gaps; equal medians share a rank.
    const ordered = [...folds].sort((a, b) =>
      lb.metric_config.lower_is_better
        ? a.foldedScore - b.foldedScore
        : b.foldedScore - a.foldedScore
    )
    let currentRank = 0
    let previousScore: number | null = null
    ordered.forEach((fold, index) => {
      if (previousScore === null || Math.abs(fold.foldedScore - previousScore) > 1e-9) {
        currentRank = index + 1
        previousScore = fold.foldedScore
      }
      fold.rank = currentRank
    })
    return ordered
  }, [lb.metric_config.lower_is_better, leaderboardGroups, normalizeScore])

  const orderedLeaderboardRows = useMemo(() => {
    // The folds are already ranked best-first, which IS the default
    // order now — one row per model, strictly by the number it reports.
    if (userRowSort.key === "default") return foldedLeaderboardGroups
    if (userRowSort.key === "score") {
      const best = scoreSortBaseDirection(lb.metric_config.lower_is_better)
      return userRowSort.dir === best
        ? foldedLeaderboardGroups
        : [...foldedLeaderboardGroups].reverse()
    }
    const parseTs = (d?: string | null): number | null => {
      if (!d) return null
      const t = new Date(d).getTime()
      return Number.isFinite(t) ? t : null
    }
    const evaluatorOrder: Record<string, number> = {
      first_party: 0,
      collaborative: 1,
      third_party: 2,
    }
    const sourceLabel = (r: ModelResultForBenchmark): string =>
      (r.source_metadata.source_name?.trim() ||
        r.source_metadata.source_organization_name?.trim() ||
        (typeof r.source_metadata.source_type === "string" ? r.source_metadata.source_type : "") ||
        "").toLowerCase()

    const dirSign = userRowSort.dir === "asc" ? 1 : -1

    // Every comparator reads the fold's HEADLINE row, so a model sorts
    // by its own metadata rather than by whichever reading happens to
    // sit first.
    return [...foldedLeaderboardGroups].sort((a, b) => {
      const ma = a.headlineRow.modelResult
      const mb = b.headlineRow.modelResult
      let cmp = 0
      switch (userRowSort.key) {
        case "model":
          cmp = (ma.model_info.name ?? "").localeCompare(mb.model_info.name ?? "")
          break
        case "developer":
          cmp = (ma.model_info.developer ?? "").localeCompare(mb.model_info.developer ?? "")
          break
        case "evaluator": {
          const av = evaluatorOrder[ma.source_metadata.evaluator_relationship] ?? 99
          const bv = evaluatorOrder[mb.source_metadata.evaluator_relationship] ?? 99
          cmp = av - bv
          break
        }
        case "source":
          cmp = sourceLabel(ma).localeCompare(sourceLabel(mb))
          break
        case "released":
        case "updated": {
          const ta = userRowSort.key === "released"
            ? parseTs(ma.model_info.release_date)
            : parseTs(ma.evaluation_timestamp)
          const tb = userRowSort.key === "released"
            ? parseTs(mb.model_info.release_date)
            : parseTs(mb.evaluation_timestamp)
          // Always push unknown timestamps to the bottom — flipping
          // direction shouldn't make missing data masquerade as old or
          // new; it's neither.
          if (ta == null && tb == null) cmp = 0
          else if (ta == null) return 1
          else if (tb == null) return -1
          else cmp = ta - tb
          break
        }
      }
      // Stable name fallback so equal keys don't shuffle on re-render.
      if (cmp === 0) cmp = (ma.model_info.name ?? "").localeCompare(mb.model_info.name ?? "")
      return cmp * dirSign
    })
  }, [foldedLeaderboardGroups, userRowSort, lb.metric_config.lower_is_better])

  /** One fold's readings, best first. No tags and no commentary: the
   *  list shows each run's own conditions and its own score, and lets
   *  the reader draw the comparison. */
  const foldMemberRows = (fold: LeaderboardFold) =>
    [...fold.members].sort((a, b) =>
      lb.metric_config.lower_is_better
        ? a.modelResult.score - b.modelResult.score
        : b.modelResult.score - a.modelResult.score
    )

  // The models line counts the page's STANDINGS, which is now exactly
  // its folded rows: one per model, each carrying that model's readings.
  const rankedRowCount = useMemo(
    () => foldedLeaderboardGroups.length,
    [foldedLeaderboardGroups]
  )

  const LEADERBOARD_PAGE_SIZE = 50
  const pagedLeaderboardRows = useMemo(
    () => orderedLeaderboardRows.slice(0, leaderboardPage * LEADERBOARD_PAGE_SIZE),
    [orderedLeaderboardRows, leaderboardPage]
  )

  // First click on a column picks a sensible initial direction (alpha
  // for text, "best/most-recent first" for numeric/date). Second click
  // flips. Third click returns to the page's natural order.
  const naturalDir = (key: Exclude<RowSortKey, "default">): "asc" | "desc" =>
    key === "model" || key === "developer" || key === "evaluator" || key === "source"
      ? "asc"
      : "desc"

  // The direction the page's natural order already reads in: ascending on a
  // lower-is-better metric, where the best score is the smallest.
  const scoreBaseDir = scoreSortBaseDirection(lb.metric_config.lower_is_better)

  const cycleRowSort = (key: Exclude<RowSortKey, "default">) =>
    setUserRowSort((prev) => {
      // For "score" the default order already IS the metric's own
      // direction, so the visible first-click flip is to the other one.
      if (key === "score") {
        if (prev.key !== "score") {
          return { key: "score", dir: scoreBaseDir === "asc" ? "desc" : "asc" }
        }
        return { key: "default", dir: "desc" }
      }
      const initial = naturalDir(key)
      if (prev.key !== key) return { key, dir: initial }
      if (prev.dir === initial) return { key, dir: initial === "asc" ? "desc" : "asc" }
      return { key: "default", dir: "desc" }
    })

  const rowSortIndicator = (key: Exclude<RowSortKey, "default">): "↑" | "↓" | null => {
    if (key === "score") {
      // The default order is one folded row per model, strictly by the
      // number each reports — a real score ordering, so the arrow is
      // honest again.
      if (userRowSort.key === "default") return scoreBaseDir === "asc" ? "↑" : "↓"
      if (userRowSort.key === "score") return userRowSort.dir === "asc" ? "↑" : "↓"
      return null
    }
    if (userRowSort.key !== key) return null
    return userRowSort.dir === "asc" ? "↑" : "↓"
  }

  const avgScoreLabel = formatRawScore(lb.avg_score, lb.metric_config.unit)
  const scoreDirectionLabel = lb.metric_config.lower_is_better ? "Lower scores rank higher" : "Higher scores rank higher"
  const leaderboardTitle = isResearchView ? "Leaderboard" : "Reporting Comparison"
  const sourceDatasetLabel = summary.source_data?.hf_repo ?? summary.source_data?.dataset_name ?? "Summary source"
  const instanceDataLabel = summary.instance_data?.available
    ? `${summary.instance_data.url_count.toLocaleString()} linked URL${summary.instance_data.url_count === 1 ? "" : "s"}`
    : "Not linked"
  const leaderboardDescription = isResearchView
    ? lb.is_aggregated
      ? "Models ranked by average raw score across the composite's component benchmarks."
      : "Models ranked by raw score for this benchmark."
    : lb.is_aggregated
      ? "Averaged model results across the composite's component benchmarks, with drill-down to each component score."
      : "Model results with benchmark context, upstream dataset detail, and optional instance-data links."
  const reportingCompleteness = summary.evalcards?.annotations?.reporting_completeness
  const documentationPopulatedCount = reportingCompleteness
    ? getCompletenessPopulatedCount(reportingCompleteness)
    : null

  const toggleRow = (key: string) =>
    setExpandedRows((current) => ({
      ...current,
      [key]: !current[key],
    }))

  // Prefer the curated family name from hierarchy.json — the producer's
  // composite_benchmark_name often equals the eval's own slug (e.g.
  // "cyse2_interpreter_abuse"), so the header repeats itself. When the
  // hierarchy resolves a different parent family ("CySE2"), use that instead.
  const hierarchyHeaderOrg = (() => {
    const familyName = hierarchyLocation?.familyDisplayName?.trim()
    if (!familyName || familyName === summary.evaluation_name) {
      return null
    }
    return familyName
  })()
  const headerOrg = hierarchyHeaderOrg
    ?? (summary.composite_benchmark_name && summary.composite_benchmark_name !== summary.evaluation_name
      ? summary.composite_benchmark_name
      : null)

  // Surface the evaluator (org that ran the eval) as a hero kicker. Two
  // benchmarks can share the same upstream dataset (e.g. TIGER-Lab/MMLU-Pro
  // re-evaluated by both TIGER-Lab and Arcadia Impact) and otherwise look
  // identical in chrome — naming the evaluator up-front is the cheapest
  // way to make the pages visually distinct.
  const evaluatorList = summary.evaluator_names ?? []
  // Validated evaluators (de-aliased names, same space as evaluator_names),
  // straight from the backend rollup — used to badge the "Reported by" names.
  const verifiedEvaluators = useMemo(
    () => new Set(summary.verified_evaluator_names ?? []),
    [summary.verified_evaluator_names],
  )

  // De-aliased evaluator names that have a /evaluators/<slug> page. The header
  // renders these names directly (always linkable); the per-row Source column
  // shows a *raw* source name, so we resolve it case-insensitively against the
  // known evaluator names and only link when it maps to a real evaluator page.
  // We key on the union of summary + active-split evaluator names so a split
  // view's Source cells still resolve.
  const knownEvaluatorByLower = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of [...(summary.evaluator_names ?? []), ...(lb.evaluator_names ?? [])]) {
      const t = (n ?? "").trim()
      if (t) m.set(t.toLowerCase(), t)
    }
    return m
  }, [summary.evaluator_names, lb.evaluator_names])

  // Resolve a (raw or de-aliased) org name to a known evaluator's de-aliased
  // name, or null when it isn't a known evaluator (→ render plain text). The
  // per-row Source value is the *raw* source name (e.g. "crfm"), which can be
  // an alias of a de-aliased evaluator ("Stanford CRFM"); when it doesn't match
  // directly but the eval has exactly one evaluator, that row unambiguously
  // belongs to it, so we link to the sole evaluator.
  const soleEvaluator =
    knownEvaluatorByLower.size === 1 ? Array.from(knownEvaluatorByLower.values())[0] : null
  const resolveEvaluatorName = (raw: string | undefined | null): string | null => {
    const t = (raw ?? "").trim()
    if (!t) return null
    return knownEvaluatorByLower.get(t.toLowerCase()) ?? soleEvaluator
  }

  const heroLede = isResearchView
    ? summary.metric_config.evaluation_description
    : (summary.benchmark_card?.benchmark_details?.overview?.trim()
       || summary.benchmark_card?.purpose_and_intended_users?.goal?.trim()
       || summary.metric_config.evaluation_description)

  return (
    <div className="space-y-12">
      {/* HERO ------------------------------------------------ */}
      <header className="motion-academic-enter">
        {evaluatorList.length > 0 && (
          <div
            className="font-mono uppercase"
            style={{
              fontSize: 11,
              letterSpacing: "0.16em",
              color: "var(--fg-subtle)",
              margin: "0 0 10px",
            }}
          >
            <span style={{ color: "var(--fg-muted)" }}>Reported by </span>
            {evaluatorList.slice(0, 2).map((name, i) => (
              <span key={name} style={{ color: "var(--fg)" }}>
                {i > 0 ? ", " : null}
                <EvaluatorName display={name} linkName={resolveEvaluatorName(name)} />
                <VerifiedBadge
                  verified={verifiedEvaluators.has(name)}
                  recognized={isRecognizedEvaluator(name)}
                  size="sm"
                  className="ml-1 align-middle"
                />
              </span>
            ))}
            {evaluatorList.length > 2 ? (
              <span style={{ color: "var(--fg)" }}> +{evaluatorList.length - 2} more</span>
            ) : null}
          </div>
        )}
        <h1
          className="font-bold tracking-[-0.025em]"
          style={{ fontSize: "clamp(40px, 5vw, 60px)", lineHeight: 1.04, margin: "0 0 12px" }}
        >
          {lb.evaluation_name}
        </h1>
        <div
          className="mb-6 flex flex-wrap items-center gap-3 font-mono text-[11px] uppercase tracking-[0.12em]"
          style={{ color: "var(--fg-muted)" }}
        >
          {headerOrg && (
            <>
              <span>{headerOrg}</span>
              <span style={{ color: "var(--fg-subtle)" }}>·</span>
            </>
          )}
          <span>{lb.metric_config.score_type}</span>
          <span style={{ color: "var(--fg-subtle)" }}>·</span>
          <span>{lb.metric_config.lower_is_better ? "Lower is better ↓" : "Higher is better ↑"}</span>
          {lb.derived_tags && lb.derived_tags.length > 0 && (
            <>
              <span style={{ color: "var(--fg-subtle)" }}>·</span>
              <span>{lb.derived_tags.map(tagLabel).join(", ")}</span>
            </>
          )}
          {lb.tags?.languages && lb.tags.languages.length > 0 && (
            <>
              <span style={{ color: "var(--fg-subtle)" }}>·</span>
              <span>{lb.tags.languages.slice(0, 3).join(", ")}</span>
            </>
          )}
        </div>
        {/* Study attribution, curated collections only. */}
        {summary.collection?.curated && (
          <div className="-mt-3 mb-6 text-[13px]" style={{ color: "var(--fg-muted)" }}>
            Part of{" "}
            <span style={{ fontWeight: 600, color: "var(--fg)" }}>
              {summary.collection.display_name}
            </span>
            {summary.collection.url && (
              <>
                {" · "}
                <a
                  href={summary.collection.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2 hover:text-[color:var(--accent)]"
                >
                  paper ↗
                </a>
              </>
            )}
          </div>
        )}
        {/* Summary view renders the description inside the "At a glance"
            card just below — avoid duplicating it in the hero. Researcher
            view's heroLede is the metric-config description (different
            text from the overview), so it stays. */}
        {isResearchView && (
          <p
            style={{
              fontSize: 17,
              lineHeight: 1.65,
              color: "var(--fg)",
              maxWidth: 760,
              margin: 0,
            }}
          >
            {heroLede}
          </p>
        )}
      </header>

      {/* AT A GLANCE (Summary view only) — pinned above the benchmark
          card so non-technical readers land on plain-language framing
          first. */}
      {!isResearchView && <PolicyOverview summary={summary} />}

      {/* BENCHMARK CARD — top-level collapsible. In Researcher view it
          defaults open (methodology is the headline). In Summary view
          it defaults collapsed so non-technical readers aren't drowned
          in the dataset/methodology/risks fields up front. Suppressed
          entirely when there's nothing useful to show. */}
      {summary.benchmark_card && (
        <BenchmarkCardCollapsible
          card={summary.benchmark_card}
          isResearchView={isResearchView}
          defaultOpen={isResearchView}
          defaultRisksOpen={false}
          evaluationName={summary.evaluation_name}
          sourceDataFallback={
            summary.source_data && !Array.isArray(summary.source_data)
              ? summary.source_data
              : null
          }
          knownIssues={getKnownIssues(
            summary.evaluation_name,
            summary.composite_benchmark_name,
            summary.composite_benchmark_key,
            summary.family_id,
            summary.benchmark_id,
            summary.benchmark_card.benchmark_details?.name,
          )}
        />
      )}

      {/* TECHNICAL OVERVIEW — secondary, collapsed by default in policy mode.
          Holds metric spec, completeness/comparability signals, and benchmark
          structure (sub-tasks). Tucked away so the hero / card / policy note
          carry the page's primary read. -------------------------------- */}
      <Collapsible open={overviewOpen} onOpenChange={setOverviewOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between text-left transition-colors hover:bg-[color:var(--bg-warm)]"
            style={{
              padding: "12px 20px",
              border: "1px solid var(--border-soft)",
              background: "var(--bg)",
            }}
          >
            <div className="flex items-center gap-3">
              <span className="kicker kicker-fg">
                {isResearchView ? "Metric & signals" : "Technical details"}
              </span>
              <span
                className="font-mono text-[10px] uppercase tracking-[0.12em]"
                style={{ color: "var(--fg-subtle)" }}
              >
                metric spec · completeness · comparability{summary.subtasks?.length ? " · splits" : ""}
              </span>
            </div>
            {overviewOpen ? (
              <ChevronUp className="h-4 w-4 shrink-0" style={{ color: "var(--fg-muted)" }} />
            ) : (
              <ChevronDown className="h-4 w-4 shrink-0" style={{ color: "var(--fg-muted)" }} />
            )}
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent className="mt-3">
          <div className="space-y-4">
            {/* Four interpretive signals, benchmark-level. */}
            <BenchmarkSignalsStrip
              summary={summary}
              evalHierarchy={evalHierarchy}
              comparisonIndex={comparisonIndex}
            />

            {/* Metric spec / nested datalist (paper-aligned hairline def-list) */}
            <div className="ec-card warm" style={{ padding: "18px 22px" }}>
              <div className="kicker mb-3">
                {isResearchView ? "Metric specification" : "Reading context"}
              </div>
              <dl className="ec-datalist">
                <dt>Composite</dt>
                <dd>
                  {summary.is_aggregated
                    ? summary.aggregate_sources?.map((source) => source.composite_benchmark_name).join(", ") || "Multiple composites"
                    : summary.composite_benchmark_name}
                </dd>
                <dt>{isResearchView ? "Benchmark ID" : "What this covers"}</dt>
                <dd className="break-words">
                  {isResearchView
                    ? humanizeEvaluationId(summary.evaluation_id)
                    : summary.metric_config.evaluation_description}
                </dd>
                <dt>{isResearchView ? "Score scale" : "How to read scores"}</dt>
                <dd>
                  {isResearchView
                    ? `${summary.metric_config.min_score ?? 0} – ${summary.metric_config.max_score ?? 1}`
                    : scoreDirectionLabel}
                </dd>
                <dt>Models</dt>
                <dd className="font-mono tabular-nums">{summary.models_count.toLocaleString()}</dd>
                <dt>{hasMultiMetricLeaderboard ? "Measures" : "Avg score"}</dt>
                <dd className="font-mono tabular-nums">
                  {hasMultiMetricLeaderboard
                    ? summary.metrics_count ?? summary.leaderboard_metrics?.length ?? 1
                    : avgScoreLabel}
                </dd>
                {summary.tags?.domains && summary.tags.domains.length > 0 && (
                  <>
                    <dt>Domain tags</dt>
                    <dd className="capitalize">
                      {summary.tags.domains.slice(0, 4).join(", ")}
                      {summary.tags.domains.length > 4 ? ` +${summary.tags.domains.length - 4} more` : ""}
                    </dd>
                  </>
                )}
                <dt>Upstream dataset</dt>
                <dd>{sourceDatasetLabel}</dd>
                <dt>Instance data</dt>
                <dd>{instanceDataLabel}</dd>
                {reportingCompleteness && (
                  <>
                    <dt>Card completeness</dt>
                    <dd className="font-mono tabular-nums" style={{ color: "var(--accent)" }}>
                      {Math.round(reportingCompleteness.completeness_score * 100)}%
                      <span className="ml-1" style={{ color: "var(--fg-muted)" }}>
                        ({documentationPopulatedCount}/{reportingCompleteness.total_fields_evaluated} fields)
                      </span>
                    </dd>
                  </>
                )}
              </dl>
            </div>

            {/* The compact BenchmarkSignalsStrip above already covers
             *  completeness and comparability with paper-aligned framing,
             *  so the standalone rounded shadcn cards that used to live
             *  here are intentionally dropped. */}

            {!hasMultiMetricLeaderboard && (summary.root_metrics?.length || summary.subtasks?.length) ? (
              <section
                style={{
                  padding: 22,
                  border: "1px solid var(--border-soft)",
                  background: "var(--bg)",
                }}
              >
                <div className="kicker mb-2">Benchmark structure</div>
                <p className="text-[13px] mb-4" style={{ color: "var(--fg-muted)", maxWidth: 640 }}>
                  Benchmark-level summary metrics and slices grouped in one section.
                </p>

                {summary.root_metrics && summary.root_metrics.length > 0 && (
                  <div className="space-y-2 mb-4">
                    <div
                      className="font-mono uppercase"
                      style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
                    >
                      Benchmark-level metrics
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {summary.root_metrics.map((metric) => (
                        <span
                          key={metric.metric_summary_id}
                          className="ec-tag outline"
                          title={metric.canonical_display_name || metric.display_name}
                        >
                          {getCompactMetricLabel(metric.display_name)}
                          {typeof metric.top_score === "number" ? ` · ${formatRawScore(metric.top_score, metric.unit)}` : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {summary.subtasks && summary.subtasks.length > 0 && (() => {
                  // When every slice reports the same single metric (e.g. all
                  // Global MMLU language splits share "score · proportion"),
                  // hoist the metric label to the section header and render
                  // each slice as a compact "name  value" row in a multi-
                  // column grid. Otherwise fall back to per-row metric badges.
                  const firstMetric = summary.subtasks[0]?.metrics?.[0]
                  const uniformSingleMetric =
                    !!firstMetric &&
                    summary.subtasks.every(
                      (s) =>
                        s.metrics.length === 1 &&
                        getCompactMetricLabel(s.metrics[0].display_name) ===
                          getCompactMetricLabel(firstMetric.display_name) &&
                        (s.metrics[0].unit ?? null) === (firstMetric.unit ?? null),
                    )
                  const headerSuffix = uniformSingleMetric
                    ? ` · ${getCompactMetricLabel(firstMetric!.display_name)}${
                        firstMetric!.unit ? ` (${firstMetric!.unit.toLowerCase()})` : ""
                      }`
                    : ""
                  return (
                    <div className="space-y-2">
                      <div
                        className="font-mono uppercase mb-1"
                        style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
                      >
                        Split breakdown · {summary.subtasks.length}
                        {headerSuffix}
                      </div>
                      {uniformSingleMetric ? (
                        <div
                          className="grid"
                          style={{
                            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                            columnGap: 24,
                          }}
                        >
                          {summary.subtasks.map((slice) => {
                            const metric = slice.metrics[0]
                            return (
                              <div
                                key={slice.subtask_key}
                                className="flex items-baseline justify-between gap-3 py-1.5 min-w-0"
                                style={{ borderBottom: "1px solid var(--border-soft)" }}
                              >
                                <span
                                  className="text-[12.5px] truncate"
                                  title={slice.canonical_display_name || slice.display_name || slice.subtask_name}
                                >
                                  {slice.display_name || slice.subtask_name}
                                </span>
                                <span
                                  className="font-mono text-[12px] tabular-nums shrink-0"
                                  style={{ color: "var(--fg)" }}
                                >
                                  {typeof metric.top_score === "number"
                                    ? formatRawScore(metric.top_score, metric.unit)
                                    : "—"}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <ul
                          className="flex flex-col"
                          style={{ borderTop: "1px solid var(--border-soft)" }}
                        >
                          {summary.subtasks.map((slice) => (
                            <li
                              key={slice.subtask_key}
                              className="grid gap-x-4 py-3"
                              style={{
                                gridTemplateColumns: "minmax(160px, 280px) 1fr",
                                borderBottom: "1px solid var(--border-soft)",
                              }}
                            >
                              <div className="min-w-0">
                                <div className="font-semibold text-[13px] truncate">
                                  {slice.display_name || slice.subtask_name}
                                </div>
                                {slice.canonical_display_name && slice.canonical_display_name !== (slice.display_name || slice.subtask_name) && (
                                  <div
                                    className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.08em] truncate"
                                    style={{ color: "var(--fg-subtle)" }}
                                    title={slice.canonical_display_name}
                                  >
                                    {slice.canonical_display_name}
                                  </div>
                                )}
                              </div>
                              <div className="flex flex-wrap items-center gap-1.5">
                                {slice.metrics.map((metric) => (
                                  <span
                                    key={metric.metric_summary_id}
                                    className="ec-tag"
                                    title={metric.canonical_display_name || metric.display_name}
                                  >
                                    {getCompactMetricLabel(metric.display_name)}
                                    {typeof metric.top_score === "number" ? ` · ${formatRawScore(metric.top_score, metric.unit)}` : ""}
                                  </span>
                                ))}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )
                })()}
              </section>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Comparability deep-dive — sits with the rest of the eval
          metadata above the leaderboard. Auto-hidden by the panel
          itself when there are no divergence groups to show. */}
      <ComparabilityPanel
        comparability={summary.evalcards?.annotations?.benchmark_comparability}
        summary={summary.comparability_summary}
        modelResults={summary.model_results}
      />

      {hasMultiMetricLeaderboard ? (
        <section>
          <ApplesToApplesBanner
            summary={lb.comparability_summary}
            hasActionableDetail={hasComparabilityActionableDetail}
          />
          <MultiMetricLeaderboard
            summary={lb}
            isResearchView={isResearchView}
            splitConfig={splitConfig}
            judgeDisplayName={judgeDisplayName}
          />
        </section>
      ) : (
        <section>
          <ApplesToApplesBanner
            summary={lb.comparability_summary}
            hasActionableDetail={hasComparabilityActionableDetail}
          />
          <div className="section-head mt-8">
            <h2>{leaderboardTitle}</h2>
            <span
              className="font-mono text-[10px] uppercase tracking-[0.12em]"
              style={{ color: "var(--fg-muted)" }}
            >
              {/* Merged pages count OBSERVATION rows (one per model+source),
                  so "5024 of 4882" phrasing would read as a broken filter —
                  spell out both grains instead. */}
              {lb.merged_view
                ? `${leaderboardRows.length.toLocaleString()} results · ${lb.models_count.toLocaleString()} models`
                : unassistedLeaderboardRows.length === lb.models_count
                  ? `${lb.models_count} models`
                  : `${rankedRowCount} of ${lb.models_count}`}
              {" · "}
              {lb.metric_config.lower_is_better ? "lower is better ↓" : "higher is better ↑"}
              {isResearchView && (
                <>
                  {" · "}scale {lb.metric_config.min_score ?? 0}–{lb.metric_config.max_score ?? 1}
                </>
              )}
            </span>
          </div>
          <p
            className="text-[13px] leading-[1.6] mb-4"
            style={{ color: "var(--fg-muted)", maxWidth: 720 }}
          >
            {leaderboardDescription}
          </p>

          {splitConfig && (
            <SplitPicker config={splitConfig} className="mb-4" />
          )}

          {/* Weights filter. Hidden when every model on the page falls in
              one bucket — a filter with a single option filters nothing. */}
          {Object.keys(opennessCounts).length > 1 && (
            <OpennessFilter
              className="mb-4"
              selected={openness}
              onChange={setOpenness}
              counts={opennessCounts}
              hideEmpty
            />
          )}

          {/* Subtask split picker for evals like Global MMLU Lite where
              the splits live as subtasks of a single eval (not as
              separate eval IDs the page-level SplitPicker can swap to).
              Suppressed when a page-level split is already in play —
              two pickers would partition the same axis (see fibble). */}
          {hasSlicePicker && (
            <SplitPicker
              className="mb-4"
              config={{
                label: "Split",
                activeId: activeSlice,
                onChange: setActiveSlice,
                options: [
                  { id: ALL_SLICE_KEY, label: "Overall" },
                  ...subtaskSlices.map((s) => ({ id: s.key, label: s.label })),
                ],
              }}
            />
          )}

          {/* Score distribution — paper-themed mean/median/quartile summary,
              with an optional Frontier toggle when models carry release dates. */}
          {hasProtocolRows && (
            <div
              className="mb-4 flex items-start gap-3 px-4 py-3"
              style={{
                border: "1px solid var(--border-soft)",
                borderLeft: "2px solid var(--fg-muted)",
                background: "var(--bg-warm)",
                color: "var(--fg)",
              }}
            >
              <div className="text-[13px] leading-relaxed">
                <span style={{ fontWeight: 600 }}>Study-specific protocol.</span>{" "}
                {allRowsHaveProtocol
                  ? "This study ran models with much larger inference budgets than standard evaluations. Compare with published scores with caution."
                  : `${protocolRowCount} of the results below come from a study that used much larger inference budgets. Compare them with the other rows or with published scores with caution.`}
                {hasAssistedRows && (assistedRowsAreNonHeadline ? (
                  <>
                    {" "}Assisted runs, where the model is told when its answer
                    is correct, are labeled and counted in each model&apos;s mean
                    {showAssistedRows ? "" : " (currently hidden, so they are left out)"}.{" "}
                    <button
                      type="button"
                      onClick={() => setShowAssistedRows((v) => !v)}
                      className="underline underline-offset-2 hover:text-[color:var(--accent)]"
                      style={{ color: "var(--fg-muted)" }}
                    >
                      {showAssistedRows ? "Hide assisted runs" : "Show assisted runs"}
                    </button>
                  </>
                ) : (
                  <>
                    {" "}Assisted runs, where the model is told when its answer
                    is correct, are labeled and excluded from ranking
                    {includeAssistedInRanking ? " (currently included)" : ""}.{" "}
                    <button
                      type="button"
                      onClick={() => setIncludeAssistedInRanking((v) => !v)}
                      className="underline underline-offset-2 hover:text-[color:var(--accent)]"
                      style={{ color: "var(--fg-muted)" }}
                    >
                      {includeAssistedInRanking
                        ? "Exclude assisted runs from ranking"
                        : "Include assisted runs in ranking"}
                    </button>
                  </>
                ))}
                {studySourceHref && (
                  <>
                    {" "}
                    <Link
                      href={studySourceHref}
                      className="underline underline-offset-2 hover:text-[color:var(--accent)]"
                      style={{ color: "var(--fg-muted)" }}
                    >
                      View the study&apos;s per-setting analysis →
                    </Link>
                  </>
                )}
              </div>
            </div>
          )}

          {unassistedLeaderboardRows.length >= 3 && (
            <div className="mb-4">
              <div className="flex justify-end mb-2">
                <EmbedButton
                  label="Score distribution"
                  defaultHeight={420}
                  size="sm"
                  variants={[
                    {
                      id: "distribution",
                      label: "Distribution",
                      embedPath: `/embed/eval/distribution/${routeIdToPath(summary.evaluation_id)}`,
                    },
                    {
                      id: "frontier",
                      label: "Frontier",
                      embedPath: `/embed/eval/frontier/${routeIdToPath(summary.evaluation_id)}`,
                    },
                    {
                      id: "both",
                      label: "Both",
                      embedPath: `/embed/eval/distribution/${routeIdToPath(summary.evaluation_id)}?view=both`,
                    },
                    // Same gate as the Context chip: the server-built
                    // scaffold-context payload on this page's summary.
                    ...(scaffoldContext
                      ? [
                          {
                            id: "context",
                            label: "Context",
                            embedPath: `/embed/eval/distribution/${routeIdToPath(summary.evaluation_id)}?view=context`,
                          },
                        ]
                      : []),
                  ]}
                />
              </div>
              <ScoreDistribution
                series={[{
                  key: "primary",
                  label: lb.metric_config.unit ?? "Score",
                  values: unassistedLeaderboardRows.map((r) => r.modelResult.score),
                  unit: lb.metric_config.unit,
                  lowerIsBetter: lb.metric_config.lower_is_better,
                  points: unassistedLeaderboardRows.map((r) => ({
                    score: r.modelResult.score,
                    releaseDate: r.modelResult.model_info.release_date,
                    modelName: r.modelResult.model_info.name,
                  })),
                }]}
                context={scaffoldContext}
              />
            </div>
          )}

          {/* Trajectory panels for per-source collection pages
              only: the attachment is per-source, and the section hides
              itself when the route serves no data. */}
          {summary.collection?.has_trajectories && (
            <CollectionTrajectories
              evaluationId={summary.evaluation_id}
              isResearchView={isResearchView}
              showEmbedButton
            />
          )}

          {hasParameterData && (
            <div className="mb-4">
              <ParamRangePicker
                variant="promo"
                headline="Parameter range"
                subline="Narrow the leaderboard to comparable model sizes."
                minStep={minParamStep}
                maxStep={maxParamStep}
                onMinChange={setMinParamStep}
                onMaxChange={setMaxParamStep}
                onReset={() => {
                  setMinParamStep(0)
                  setMaxParamStep(PARAM_RANGE_MAX_INDEX)
                }}
                showUnknownSize={showUnknownSize}
                onShowUnknownSizeChange={setShowUnknownSize}
              />
            </div>
          )}

          <div className="flex justify-end mb-2">
            <EmbedButton
              embedPath={`/embed/eval/leaderboard/${routeIdToPath(summary.evaluation_id)}`}
              label="Leaderboard"
              defaultHeight={560}
              size="sm"
            />
          </div>
          <div className="ec-card" style={{ padding: 0, overflow: "hidden" }}>
            {/* Mobile (< lg): compact embed-style list — rank, model ·
                developer, score. Drops the expand chevron, the score
                bar, and the four extra columns. Tapping the row's model
                name still navigates to the model page; everything else
                stays on the desktop layout below. */}
            <div className="lg:hidden">
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--fg)" }}>
                    <th
                      className="font-mono uppercase"
                      style={{
                        fontSize: 10,
                        letterSpacing: "0.12em",
                        color: "var(--fg-muted)",
                        padding: "10px 14px",
                        textAlign: "left",
                        width: 44,
                      }}
                    >
                      #
                    </th>
                    <th
                      className="font-mono uppercase"
                      style={{
                        fontSize: 10,
                        letterSpacing: "0.12em",
                        color: "var(--fg-muted)",
                        padding: "10px 8px",
                        textAlign: "left",
                      }}
                    >
                      Model
                    </th>
                    <th
                      className="font-mono uppercase"
                      style={{
                        fontSize: 10,
                        letterSpacing: "0.12em",
                        color: "var(--fg-muted)",
                        padding: "10px 14px",
                        textAlign: "right",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {lb.metric_config.unit ?? "Score"}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pagedLeaderboardRows.map((fold) => {
                  const { key, rank } = fold
                  const { modelResult, judgeLabel, judgeTooltip } = fold.headlineRow
                  return (
                    <tr
                      key={key}
                      style={{
                        borderBottom: "1px solid var(--border-soft)",
                        ...(rowHighlight?.(modelResult) ? { background: "var(--bg-warm)" } : undefined),
                      }}
                    >
                      <td
                        className="font-mono tabular-nums"
                        style={{
                          padding: "10px 14px",
                          color: rank === 1 ? "var(--accent)" : "var(--fg-subtle)",
                          fontSize: 12,
                          fontWeight: rank === 1 ? 600 : 500,
                        }}
                      >
                        {rank}
                      </td>
                      <td style={{ padding: "10px 8px", color: "var(--fg)" }}>
                        <Link
                          href={`/models/${routeIdToPath(modelResult.model_route_id ?? routeIdFromModelId(modelResult.model_group_id))}`}
                          className="hover:text-[color:var(--accent)] transition-colors"
                          style={{ color: "var(--fg)", fontWeight: 500, fontSize: 14 }}
                        >
                          {modelResult.model_info.name}
                        </Link>
                        {modelResult.model_info.developer && (
                          <span
                            className="ml-2"
                            style={{ fontSize: 11, color: "var(--fg-muted)" }}
                          >
                            · {modelResult.model_info.developer}
                          </span>
                        )}
                        {(judgeLabel || modelResult.metric_source_label) && (
                          <div
                            style={{ fontSize: 11, color: "var(--fg-muted)" }}
                            title={judgeTooltip}
                          >
                            {judgeLabel}
                            {judgeLabel && modelResult.metric_source_label ? " · " : null}
                            {modelResult.metric_source_label && (
                              <span className="font-mono" style={{ fontSize: 10 }}>
                                {modelResult.metric_source_label}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td
                        className="font-mono tabular-nums"
                        style={{
                          padding: "10px 14px",
                          textAlign: "right",
                          fontSize: 13.5,
                          fontWeight: 600,
                          color: "var(--fg)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {/* Unit suffix omitted — already shown in the
                            column header so it doesn't need to repeat
                            on every row. */}
                        {formatRawScore(fold.foldedScore)}
                        {fold.runCount > 1 && (
                          <div
                            className="font-mono"
                            style={{ fontSize: 9, fontWeight: 400, color: "var(--fg-subtle)" }}
                          >
                            {`mean · ${fold.runCount} runs`}
                          </div>
                        )}
                      </td>
                    </tr>
                  )})}
                  {pagedLeaderboardRows.length === 0 && (
                    <tr>
                      <td
                        colSpan={3}
                        style={{ padding: "32px 16px", textAlign: "center", color: "var(--fg-muted)" }}
                      >
                        No leaderboard entries match the selected parameter range.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Desktop (≥ lg): full rich table with sortable columns,
                row expansion, score bar, evaluator/source/release/updated. */}
            <div className="overflow-x-auto hidden lg:block">
            <table className="ec-htable" style={{ minWidth: 980 }}>
              <thead>
                <tr>
                  <th
                    style={{ width: 64 }}
                    className="num"
                    title="One rank per model, by the score its row reports."
                  >
                    Rank
                  </th>
                  <th style={{ minWidth: 260 }}>
                    <SortableTh
                      label="Model"
                      active={userRowSort.key === "model"}
                      indicator={rowSortIndicator("model")}
                      onClick={() => cycleRowSort("model")}
                    />
                  </th>
                  <th className="hidden lg:table-cell" style={{ minWidth: 160 }}>
                    <SortableTh
                      label={isResearchView ? "Developer" : "Provider"}
                      active={userRowSort.key === "developer"}
                      indicator={rowSortIndicator("developer")}
                      onClick={() => cycleRowSort("developer")}
                    />
                  </th>
                  <th className="num" style={{ minWidth: 200 }}>
                    <SortableTh
                      label={lb.metric_config.unit ?? "Score"}
                      active={userRowSort.key === "score"}
                      indicator={rowSortIndicator("score")}
                      onClick={() => cycleRowSort("score")}
                      title={
                        protocolColumns.length > 0
                          ? "Median across each model's runs on this page. Expand a row to see every run and which one the leaderboard treats as primary."
                          : "Sort by score"
                      }
                    />
                  </th>
                  <th className="hidden lg:table-cell" style={{ width: 110 }}>
                    <SortableTh
                      label="Evaluator"
                      active={userRowSort.key === "evaluator"}
                      indicator={rowSortIndicator("evaluator")}
                      onClick={() => cycleRowSort("evaluator")}
                      title="Sort by evaluator relationship (1st-party first)"
                    />
                  </th>
                  <th className="num hidden lg:table-cell" style={{ width: 100 }}>
                    <SortableTh
                      label="Source"
                      active={userRowSort.key === "source"}
                      indicator={rowSortIndicator("source")}
                      onClick={() => cycleRowSort("source")}
                    />
                  </th>
                  <th className="hidden lg:table-cell num" style={{ width: 110 }}>
                    <SortableTh
                      label="Released"
                      active={userRowSort.key === "released"}
                      indicator={rowSortIndicator("released")}
                      onClick={() => cycleRowSort("released")}
                      title="Sort by model release date"
                    />
                  </th>
                </tr>
              </thead>
              <tbody>
                {pagedLeaderboardRows.map((fold) => {
                  const { key, rank, normalizedScore } = fold
                  const { modelResult, judgeLabel, judgeTooltip } = fold.headlineRow
                  const isFolded = fold.runCount > 1
                  // A judge column earns its place only when the fold's
                  // readings actually differ by judge.
                  const foldHasJudgeLabels = fold.members.some((member) => member.judgeLabel)
                  const isExpanded = expandedRows[key] ?? false
                  const slices = modelResult.score_details.details
                    ? Object.entries(modelResult.score_details.details).filter(([, value]) => typeof value === "number")
                    : []
                  const hasExpandableDetails =
                    isFolded ||
                    isResearchView ||
                    (modelResult.aggregate_components && modelResult.aggregate_components.length > 1) ||
                    slices.length > 1

                  const datasetName = Array.isArray(modelResult.source_data)
                    ? undefined
                    : modelResult.source_data.dataset_name

                  const samples = Array.isArray(modelResult.source_data)
                    ? undefined
                    : modelResult.source_data.samples_number
                  const rowAnnotations = modelResult.result.evalcards?.annotations
                  const setupLabel = getSetupLabel(modelResult)
                  const evaluatorRel = modelResult.source_metadata.evaluator_relationship
                  const evaluatorTag = evaluatorRel === "first_party"
                    ? "SELF"
                    : evaluatorRel === "third_party"
                      ? "THIRD-PARTY"
                      : "—"
                  const isThirdParty = evaluatorRel === "third_party"
                  // Prefer the human-readable source name (e.g. "kaggle",
                  // "Anthropic Eval Run") over `source_data.source_type`,
                  // which can be a file format like "Parquet" that's
                  // useless to a reader. Fall back to source_type only
                  // when nothing else is set.
                  const sourceTypeLabel =
                    // De-aliased evaluator identity first: upstream raw
                    // strings can carry stale spellings (e.g. the AISI
                    // "Initiative"→"Institute" rename) that the registry
                    // has already resolved.
                    modelResult.evaluator_display_name?.trim() ||
                    modelResult.source_metadata.source_name?.trim() ||
                    modelResult.source_metadata.source_organization_name?.trim() ||
                    (!Array.isArray(modelResult.source_data) && modelResult.source_data.source_type) ||
                    modelResult.source_metadata.source_type ||
                    ""
                  // Link the Source value to its evaluator page when the row's
                  // org resolves to a known (de-aliased) evaluator. Try the org
                  // name first, then the displayed source label.
                  const sourceEvaluatorName =
                    resolveEvaluatorName(modelResult.source_metadata.source_organization_name) ??
                    resolveEvaluatorName(modelResult.source_metadata.source_name) ??
                    resolveEvaluatorName(sourceTypeLabel)
                  const familyLabel = modelResult.model_info.architecture
                    ?? modelResult.model_info.parameter_count
                    ?? null
                  // Release date is benchmark-agnostic model metadata, but
                  // showing it under the model name lets a researcher orient
                  // a row in time without expanding it / clicking through.
                  const releaseDateLabel = modelResult.model_info.release_date
                    ? formatDate(modelResult.model_info.release_date).split(",")[0]
                    : null
                  const isTopRank = rank === 1
                  const rankColor = rank === 1 ? "var(--accent)" : "var(--fg-muted)"
                  const isAssisted = isAssistedResult(modelResult.protocol_condition)
                  // Assisted first: an assisted row is also a non-headline
                  // row in the current contract, and "the model was told the
                  // answer" is the reason a reader needs.
                  const unrankedReason = isAssisted
                    ? "Assisted run (answer feedback) — shown, not ranked"
                    : judgeLabel
                      ? "Another judge's reading of the same model — shown, not ranked"
                      : "Another run of the same model — shown, not ranked"

                  return (
                    <Fragment key={key}>
                      <tr
                        id={modelResult.model_route_id ? `row-${modelResult.model_route_id}` : undefined}
                        className={cn(
                          "align-top",
                          (isExpanded || rowHighlight?.(modelResult)) && "bg-[color:var(--bg-warm)]",
                        )}
                      >
                        <td className="num align-top">
                          <span
                            className="font-mono tabular-nums"
                            style={{
                              fontSize: 14,
                              fontWeight: isTopRank ? 600 : 500,
                              color: rankColor,
                            }}
                            aria-label={`Rank ${rank}`}
                          >
                            {`#${rank}`}
                          </span>
                        </td>

                        <td className="align-top whitespace-normal">
                          <div className="flex items-start gap-1.5 leading-tight">
                            {hasExpandableDetails && (
                              <button
                                type="button"
                                onClick={() => toggleRow(key)}
                                aria-label={isExpanded ? "Collapse details" : "Expand details"}
                                aria-expanded={isExpanded}
                                className="-ml-1 mt-0.5 inline-flex h-4 w-4 items-center justify-center transition-colors hover:text-[color:var(--accent)]"
                                style={{ color: "var(--fg-muted)" }}
                              >
                                {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                              </button>
                            )}
                            <div className="min-w-0">
                              <Link
                                href={`/models/${routeIdToPath(modelResult.model_route_id ?? routeIdFromModelId(modelResult.model_group_id))}`}
                                className="font-semibold text-[14px] hover:text-[color:var(--accent)] transition-colors"
                                style={{ color: "var(--fg)" }}
                              >
                                {modelResult.model_info.name}
                              </Link>
                              {isAssisted && (
                                <span
                                  className="ml-1.5 inline-block align-middle font-mono uppercase"
                                  style={{
                                    fontSize: 9,
                                    letterSpacing: "0.08em",
                                    color: "var(--fg-muted)",
                                    border: "1px solid var(--border-soft)",
                                    borderRadius: 3,
                                    padding: "1px 4px",
                                  }}
                                  title="The model was told when its answer was correct (oracle answer feedback)."
                                >
                                  assisted
                                </span>
                              )}
                              {(judgeLabel || modelResult.metric_source_label) && (
                                <div
                                  className="mt-0.5 truncate"
                                  style={{ fontSize: 11, color: "var(--fg-muted)" }}
                                  title={judgeTooltip}
                                >
                                  {judgeLabel}
                                  {judgeLabel && modelResult.metric_source_label ? " · " : null}
                                  {modelResult.metric_source_label && (
                                    <span className="font-mono" style={{ fontSize: 10 }}>
                                      {modelResult.metric_source_label}
                                    </span>
                                  )}
                                </div>
                              )}
                              {familyLabel && (
                                <div
                                  className="mt-0.5 font-mono uppercase truncate"
                                  style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--fg-subtle)" }}
                                >
                                  {familyLabel}
                                </div>
                              )}
                              {/* Mobile-only developer line. On desktop the
                                  Developer is its own column; on narrow
                                  viewports it folds under the model name
                                  to save horizontal space. */}
                              <div
                                className="mt-0.5 lg:hidden truncate text-[12px]"
                                style={{ color: "var(--fg-muted)" }}
                              >
                                {modelResult.model_info.developer ?? "Unknown developer"}
                              </div>
                              {modelResult.aggregate_components && modelResult.aggregate_components.length > 1 && (
                                <div
                                  className="mt-0.5 font-mono uppercase"
                                  style={{ fontSize: 9.5, letterSpacing: "0.1em", color: "var(--fg-subtle)" }}
                                >
                                  Avg of {modelResult.aggregate_components.length}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>

                        <td className="hidden lg:table-cell align-top">
                          <div className="text-[13px] truncate" style={{ color: "var(--fg-muted)" }}>
                            {modelResult.model_info.developer ?? "Unknown developer"}
                          </div>
                        </td>

                        <td className="num align-top">
                          {/* Score with inline performance bar so the
                              previously-dedicated bar column can be
                              dropped — its only purpose was visualising
                              this same number. Caption shows shot/CoT
                              setup or a differing dataset name when
                              available; otherwise it's omitted. */}
                          <div className="flex items-baseline justify-end gap-2 tabular-nums" style={{ fontSize: 15, fontWeight: 600 }}>
                            <span>
                              {formatRawScore(fold.foldedScore, undefined)}
                              {fold.ci95 != null && (
                                <span style={{ fontSize: 11, fontWeight: 500, color: "var(--fg-muted)" }}>
                                  {" ± "}
                                  {formatRawScore(fold.ci95, undefined)}
                                </span>
                              )}
                            </span>
                          </div>
                          {isFolded && (
                            // A bare number here would contradict what the
                            // row shows when it unfurls — 0.96 and 1.00 are
                            // both in there. Say which number this is.
                            // With a single counted run there is no median
                            // to speak of: the number IS that run, and
                            // calling it "median of 1 runs" would be both
                            // ungrammatical and a claim about spread that
                            // one run cannot support.
                            <div
                              className="mt-0.5 text-right"
                              style={{ fontSize: 10, color: "var(--fg-subtle)" }}
                              title={`Mean of this model's ${fold.runCount} runs on this page (range ${formatRawScore(fold.minScore, undefined)}–${formatRawScore(fold.maxScore, undefined)})${fold.assistedCount > 0 ? `, including ${fold.assistedCount} assisted ${fold.assistedCount === 1 ? "run" : "runs"}` : ""}. The interval is the 95% spread ACROSS those runs — they are different configurations, not repeated samples, so it measures how much the setup moved the score, not sampling error. Expand the row to see every run.`}
                            >
                              mean of {fold.runCount} runs
                              {fold.ci95 != null && " · 95% across runs"}
                            </div>
                          )}
                          <div
                            className="mt-1 hidden md:block"
                            style={{
                              position: "relative",
                              height: 4,
                              background: "var(--bg-surface)",
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                position: "absolute",
                                inset: 0,
                                width: `${Math.max(2, normalizedScore * 100)}%`,
                                background: isTopRank ? "var(--accent)" : "var(--fg-muted)",
                                opacity: isTopRank ? 1 : 0.55,
                              }}
                            />
                          </div>
                          {setupLabel && (
                            <div
                              className="mt-1 font-mono uppercase truncate text-right"
                              style={{ fontSize: 10, letterSpacing: "0.06em", color: "var(--fg-subtle)" }}
                            >
                              {setupLabel}
                            </div>
                          )}
                          {!setupLabel &&
                            datasetName &&
                            !isResearchView &&
                            datasetName !== lb.evaluation_name && (
                              <div
                                className="mt-1 font-mono truncate text-right"
                                style={{ fontSize: 10, color: "var(--fg-subtle)" }}
                              >
                                {datasetName}
                              </div>
                            )}
                          {/* Per-row signal badges (reproducibility,
                              provenance, variant/cross-party divergence)
                              — make the apples-to-apples banner's
                              "per-row signal badges below" reference
                              concrete on the single-metric leaderboard. */}
                          <SignalsRowBadges
                            annotations={rowAnnotations}
                            comparabilityStatus={modelResult.comparability_status}
                            className="justify-end"
                          />
                        </td>

                        <td className="hidden lg:table-cell align-top">
                          <span
                            className="font-mono uppercase inline-flex items-center"
                            style={{
                              fontSize: 9.5,
                              padding: "2px 6px",
                              letterSpacing: "0.08em",
                              background: isThirdParty ? "var(--accent)" : "var(--bg-surface)",
                              color: isThirdParty ? "var(--accent-fg)" : "var(--fg-muted)",
                              border: isThirdParty ? "none" : "1px solid var(--border-soft)",
                            }}
                          >
                            {evaluatorTag}
                          </span>
                        </td>

                        <td className="num hidden lg:table-cell align-top">
                          {sourceTypeLabel ? (
                            <span className="inline-flex items-center justify-end gap-1">
                              {sourceEvaluatorName ? (
                                <EvaluatorName
                                  display={sourceTypeLabel}
                                  linkName={sourceEvaluatorName}
                                  className="font-mono lowercase"
                                  style={{ fontSize: 11, color: "var(--fg-muted)" }}
                                />
                              ) : modelResult.source_metadata.source_url ? (
                                <a
                                  href={modelResult.source_metadata.source_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="font-mono lowercase hover:text-[color:var(--accent)]"
                                  style={{ fontSize: 11, color: "var(--fg-muted)" }}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {sourceTypeLabel}
                                </a>
                              ) : (
                                <span
                                  className="font-mono lowercase"
                                  style={{ fontSize: 11, color: "var(--fg-muted)" }}
                                >
                                  {sourceTypeLabel}
                                </span>
                              )}
                              <VerifiedBadge
                                verified={modelResult.result?.is_verified_evaluator}
                                recognized={isRecognizedEvaluator(
                                  modelResult.source_metadata?.source_name
                                    ?? modelResult.source_metadata?.source_organization_name,
                                )}
                                size="sm"
                              />
                            </span>
                          ) : (
                            <span style={{ color: "var(--fg-subtle)" }}>—</span>
                          )}
                        </td>

                        <td
                          className="num hidden lg:table-cell align-top font-mono tabular-nums"
                          style={{ fontSize: 11, color: "var(--fg-muted)" }}
                        >
                          {modelResult.model_info.release_date
                            ? formatDate(modelResult.model_info.release_date).split(",")[0]
                            : <span style={{ color: "var(--fg-subtle)" }}>—</span>}
                        </td>

                      </tr>

                      {isExpanded && (
                        <tr>
                          <td colSpan={7} style={{ background: "var(--bg-warm)", padding: 0 }}>
                            <div className="space-y-5 px-4 py-5 sm:px-6">
                              {isFolded && (
                                <div className="space-y-2">
                                  <div
                                    className="font-mono uppercase"
                                    style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
                                  >
                                    Runs on this page
                                  </div>
                                  {/* No commentary: each run's own
                                      conditions and its own score. The
                                      reader compares them. */}
                                  <div className="overflow-x-auto" style={{ border: "1px solid var(--border-soft)" }}>
                                    <table className="ec-htable">
                                      <thead>
                                        <tr>
                                          {protocolColumns.map((column) => (
                                            <th key={`fold-head-${key}-${column.key}`}>
                                              {column.label}
                                              {column.unit ? ` (${column.unit})` : ""}
                                            </th>
                                          ))}
                                          {foldHasJudgeLabels && <th>Judge</th>}
                                          <th className="num">{lb.metric_config.unit ?? "Score"}</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {foldMemberRows(fold).map((member) => (
                                          <tr key={`fold-run-${member.key}`}>
                                            {protocolColumns.map((column) => {
                                              const value = formatProtocolValue(
                                                member.modelResult.protocol_condition,
                                                column,
                                              )
                                              // `answer_feedback` / `none` are the
                                              // producer's raw enum; as cell text they
                                              // read as debug output. The axis matters
                                              // enough to say in words.
                                              const badge =
                                                column.key === "feedback" && value != null
                                                  ? value === "answer_feedback"
                                                    ? { text: "assisted", strong: true }
                                                    : value === "none"
                                                      ? { text: "none", strong: false }
                                                      : null
                                                  : null
                                              return (
                                                <td
                                                  key={`fold-cell-${member.key}-${column.key}`}
                                                  className="font-mono text-[12px]"
                                                  style={{ color: value == null ? "var(--fg-subtle)" : "var(--fg-muted)" }}
                                                >
                                                  {badge ? (
                                                    <span
                                                      className="inline-block font-mono uppercase"
                                                      style={{
                                                        fontSize: 9,
                                                        letterSpacing: "0.08em",
                                                        color: badge.strong ? "var(--fg)" : "var(--fg-subtle)",
                                                        border: `1px solid ${badge.strong ? "var(--fg-muted)" : "var(--border-soft)"}`,
                                                        borderRadius: 3,
                                                        padding: "1px 5px",
                                                      }}
                                                      title={
                                                        badge.strong
                                                          ? "Oracle answer feedback: the model was told when its answer was correct."
                                                          : "No feedback: the model was not told whether its answers were correct."
                                                      }
                                                    >
                                                      {badge.text}
                                                    </span>
                                                  ) : (
                                                    (value ?? "—")
                                                  )}
                                                </td>
                                              )
                                            })}
                                            {foldHasJudgeLabels && (
                                              <td className="text-[12px]" style={{ color: "var(--fg-muted)" }}>
                                                {member.judgeLabel ?? "—"}
                                              </td>
                                            )}
                                            <td className="num font-mono tabular-nums text-[13px]" style={{ color: "var(--fg)" }}>
                                              {formatRawScore(member.modelResult.score)}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              )}

                              {modelResult.aggregate_components && modelResult.aggregate_components.length > 1 && (
                                <div className="space-y-2">
                                  <div
                                    className="font-mono uppercase"
                                    style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
                                  >
                                    Composite score breakdown
                                  </div>
                                  <div className="overflow-x-auto" style={{ border: "1px solid var(--border-soft)" }}>
                                    <table className="ec-htable">
                                      <thead>
                                        <tr>
                                          <th>Benchmark</th>
                                          <th>Source</th>
                                          <th className="num">Raw</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {modelResult.aggregate_components.map((component, i) => (
                                          <tr key={`${component.evaluation_id}-${i}`}>
                                            <td className="font-medium text-[13px]">{component.composite_benchmark_name}</td>
                                            <td className="text-[13px]" style={{ color: "var(--fg-muted)" }}>
                                              {component.source_organization_name}
                                            </td>
                                            <td className="num font-mono tabular-nums text-[13px]" style={{ color: "var(--fg-muted)" }}>
                                              {formatRawScore(component.score)}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              )}

                              {slices.length > 1 && (
                                <div className="space-y-2">
                                  <div
                                    className="font-mono uppercase"
                                    style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
                                  >
                                    Split breakdown
                                  </div>
                                  <div className="overflow-x-auto" style={{ border: "1px solid var(--border-soft)" }}>
                                    <table className="ec-htable">
                                      <thead>
                                        <tr>
                                          <th>Split</th>
                                          <th className="num">Raw</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {slices.map(([sliceName, value]) => {
                                          const numericValue = value as number
                                          return (
                                            <tr key={sliceName}>
                                              <td className="font-medium text-[13px] capitalize">{sliceName.replace(/_/g, " ")}</td>
                                              <td className="num font-mono tabular-nums text-[13px]" style={{ color: "var(--fg-muted)" }}>
                                                {formatRawScore(numericValue, lb.metric_config.unit)}
                                              </td>
                                            </tr>
                                          )
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              )}

                              {isResearchView ? (
                                <div className="space-y-3">
                                  <ResearcherReproducibilityCard
                                    modelResult={modelResult}
                                    benchmarkKey={lb.benchmark_id ?? lb.composite_benchmark_key}
                                    evalName={lb.evaluation_name}
                                  />
                                  <div className="flex justify-end">
                                    <FlagScoreButton
                                      modelName={modelResult.model_info.name}
                                      modelId={modelResult.model_info.id}
                                      benchmarkName={lb.evaluation_name}
                                      benchmarkId={lb.evaluation_id}
                                      score={formatRawScore(modelResult.score, lb.metric_config.unit)}
                                      sourceUrl={modelResult.source_metadata.source_url}
                                      sourceRecordUrl={modelResult.source_record_url}
                                      eeeRecordUrl={modelResult.eee_record_url}
                                    />
                                  </div>
                                </div>
                              ) : (
                                modelResult.result.generation_config && (
                                  <div className="space-y-3">
                                    <div>
                                      <div
                                        className="font-mono uppercase"
                                        style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
                                      >
                                        Generation config
                                      </div>
                                      <div className="text-[12px]" style={{ color: "var(--fg-muted)" }}>
                                        Evaluation-time generation parameters.
                                      </div>
                                    </div>

                                    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                                      {modelResult.result.generation_config.generation_args &&
                                        Object.entries(modelResult.result.generation_config.generation_args).map(([key, value]) => (
                                          <div
                                            key={key}
                                            style={{
                                              padding: 14,
                                              border: "1px solid var(--border-soft)",
                                              background: "var(--bg)",
                                            }}
                                          >
                                            <div
                                              className="font-mono uppercase"
                                              style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--fg-subtle)" }}
                                            >
                                              {key.replace(/_/g, " ")}
                                            </div>
                                            <div className="mt-2 text-[13px] font-medium font-mono tabular-nums">
                                              {formatMetadataValue(value)}
                                            </div>
                                          </div>
                                        ))}

                                      {modelResult.result.generation_config.additional_details && (
                                        <div
                                          className="md:col-span-2 xl:col-span-3"
                                          style={{
                                            padding: 14,
                                            border: "1px solid var(--border-soft)",
                                            background: "var(--bg)",
                                          }}
                                        >
                                          <div
                                            className="font-mono uppercase"
                                            style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--fg-subtle)" }}
                                          >
                                            Additional details
                                          </div>
                                          <div className="mt-2 text-[13px] font-medium whitespace-pre-wrap">
                                            {formatMetadataValue(modelResult.result.generation_config.additional_details)}
                                          </div>
                                        </div>
                                      )}

                                      {modelResult.result.generation_config.prompt_template && (
                                        <div
                                          className="md:col-span-2 xl:col-span-3"
                                          style={{
                                            padding: 14,
                                            border: "1px solid var(--border-soft)",
                                            background: "var(--bg)",
                                          }}
                                        >
                                          <div
                                            className="font-mono uppercase"
                                            style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--fg-subtle)" }}
                                          >
                                            Prompt template
                                          </div>
                                          <div className="mt-2 text-[12.5px] font-mono whitespace-pre-wrap">
                                            {formatMetadataValue(modelResult.result.generation_config.prompt_template)}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
                {leaderboardRows.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ padding: "32px 16px", textAlign: "center", color: "var(--fg-muted)" }}>
                      No leaderboard entries match the selected parameter range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>

            {pagedLeaderboardRows.length < orderedLeaderboardRows.length && (
              <div
                style={{
                  borderTop: "1px solid var(--border-soft)",
                  background: "var(--bg-warm)",
                  padding: "16px",
                  textAlign: "center",
                }}
              >
                <button
                  type="button"
                  className="btn-ec outline"
                  onClick={() => setLeaderboardPage((p) => p + 1)}
                >
                  Load more ({orderedLeaderboardRows.length - pagedLeaderboardRows.length} remaining)
                </button>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}

function MultiMetricLeaderboard({
  summary,
  isResearchView,
  splitConfig,
  judgeDisplayName,
}: {
  summary: BenchmarkEvalSummary
  isResearchView: boolean
  splitConfig?: SplitConfig
  /** Same server-resolved map the per-row leaderboard labels with, so one
   *  judge id reads the same on both surfaces. */
  judgeDisplayName: (modelId: string) => string
}) {
  const [page, setPage] = useState(1)
  // The column the page ranks on: the eval's declared primary metric, which
  // is what the hero, the metric spec block and every other surface here
  // summarise. Sorting on whichever measure comes first instead would open a
  // page like OpenEval HarmBench on an attack-success-rate ranking under a
  // refusal-score heading. Falls back to the first root metric.
  const primaryMetricKey = useMemo(
    () => primaryMetricColumnKey(summary.leaderboard_metrics, summary.primary_metric_id),
    [summary.leaderboard_metrics, summary.primary_metric_id],
  )
  // We don't sort by metric coverage by default — coverage tells you how
  // many slices reported, not how the model performed.
  const [sortKey, setSortKey] = useState<string>(() => primaryMetricKey ?? "model")
  // Best-first in the metric's own direction, the same rule a header click
  // applies — a lower-is-better primary metric must not open worst-first.
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">(() =>
    (summary.leaderboard_metrics ?? []).find((m) => m.column_key === primaryMetricKey)
      ?.lower_is_better
      ? "asc"
      : "desc",
  )
  const [activeSliceTab, setActiveSliceTab] = useState<string>("all")
  const [minParamStep, setMinParamStep] = useState(0)
  const [maxParamStep, setMaxParamStep] = useState(PARAM_RANGE_MAX_INDEX)
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({})

  // Resolve a raw Source-column org name to a known (de-aliased) evaluator name
  // so the cell can link to /evaluators/<slug>; null → render plain text.
  const knownEvaluatorByLower = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of summary.evaluator_names ?? []) {
      const t = (n ?? "").trim()
      if (t) m.set(t.toLowerCase(), t)
    }
    return m
  }, [summary.evaluator_names])
  const soleEvaluator =
    knownEvaluatorByLower.size === 1 ? Array.from(knownEvaluatorByLower.values())[0] : null
  const resolveEvaluatorName = (raw: string | undefined | null): string | null => {
    const t = (raw ?? "").trim()
    if (!t) return null
    return knownEvaluatorByLower.get(t.toLowerCase()) ?? soleEvaluator
  }

  // Index ModelResultForBenchmark entries by model_info.id so we can power the
  // research-mode reproducibility card from a multi-metric row. There may be
  // several entries per model (one per metric); we prefer one with a recorded
  // generation_config so the card has the most data to show.
  const modelResultByModelId = useMemo(() => {
    const map = new Map<string, ModelResultForBenchmark>()
    for (const result of summary.model_results) {
      const id = result.model_info.id
      const existing = map.get(id)
      if (!existing) {
        map.set(id, result)
        continue
      }
      const existingHasGen = existing.result.generation_config != null
      const candidateHasGen = result.result.generation_config != null
      if (!existingHasGen && candidateHasGen) {
        map.set(id, result)
      }
    }
    return map
  }, [summary.model_results])

  const toggleExpandedRow = (key: string) =>
    setExpandedRows((current) => ({ ...current, [key]: !current[key] }))
  const leaderboardMetrics = summary.leaderboard_metrics ?? []
  const leaderboardRows = summary.leaderboard_rows ?? []
  const allMetricKeys = useMemo(() => leaderboardMetrics.map((metric) => metric.column_key), [leaderboardMetrics])
  // Cap default visible columns to avoid hangs on benchmarks with hundreds of metrics
  // (e.g. helm_air_bench has 374 slice×metric pairs). Users can opt in to more.
  const DEFAULT_VISIBLE_METRIC_CAP = 24
  const defaultVisibleMetricKeys = useMemo(
    () => allMetricKeys.slice(0, DEFAULT_VISIBLE_METRIC_CAP),
    [allMetricKeys]
  )
  const [visibleMetricKeys, setVisibleMetricKeys] = useState<string[]>(() => defaultVisibleMetricKeys)
  const leaderboardMetricMap = useMemo(
    () => new Map(leaderboardMetrics.map((metric) => [metric.column_key, metric])),
    [leaderboardMetrics]
  )
  const visibleMetricKeySet = useMemo(() => new Set(visibleMetricKeys), [visibleMetricKeys])
  // Labels for the "Visible measure columns" dropdown. The measure name alone
  // is ambiguous in two opposite ways: subtask benchmarks repeat one measure
  // across slices (ACE: every column is "Score"), while others repeat one
  // trivial slice across distinct measures (BFCL: Accuracy/Rank/… all "overall").
  // So append the slice ONLY when the measure label actually collides with
  // another column — and never a trivial "overall"/"all"/"total" token.
  const metricDropdownLabels = useMemo(() => {
    const measureLabelOf = (m: LeaderboardMetric) => getMetricChipLabel(m)
    const measureCounts = new Map<string, number>()
    for (const m of leaderboardMetrics) {
      const l = measureLabelOf(m)
      measureCounts.set(l, (measureCounts.get(l) ?? 0) + 1)
    }
    const isTrivialSlice = (s: string) => /^(overall|all|total|default)$/i.test(s)
    const out = new Map<string, { label: string; description: string }>()
    for (const m of leaderboardMetrics) {
      const measureLabel = measureLabelOf(m)
      let label = measureLabel
      if ((measureCounts.get(measureLabel) ?? 0) > 1) {
        const subtask = m.subtask_name?.trim() ?? ""
        const keySuffix = m.column_key.includes("::")
          ? humanizeMetricKey(m.column_key.split("::").pop() ?? "")
          : ""
        const slice = subtask && !isTrivialSlice(subtask) ? subtask : keySuffix
        // Last resort: the humanised full key guarantees uniqueness when no
        // meaningful slice exists.
        label = slice
          ? `${measureLabel} · ${slice}`
          : `${measureLabel} · ${humanizeMetricKey(m.column_key)}`
      }
      const canonical = m.canonical_display_name?.trim()
      const description = canonical && canonical !== measureLabel && canonical !== label ? canonical : ""
      out.set(m.column_key, { label, description })
    }
    return out
  }, [leaderboardMetrics])
  // Every distinct subtask key surfaces as a slice option; metric chips
  // stay scoped to the eval's root metrics. Without this, evals like
  // Fibble Arena (3 metrics × 6 lies = 18 subtask entries) render every
  // (metric, slice) pair as its own chip/column — three "Mean Response
  // Time" chips next to three "Score" chips, etc. — which is what
  // produced the user-visible duplication.
  const sliceTabs = useMemo(() => {
    const seen = new Map<string, string>()
    for (const metric of leaderboardMetrics) {
      if (metric.scope === "subtask" && metric.subtask_key && !seen.has(metric.subtask_key)) {
        seen.set(metric.subtask_key, metric.subtask_name ?? getCompactMetricLabel(metric.display_name))
      }
    }
    return Array.from(seen, ([key, label]) => ({ key, label }))
  }, [leaderboardMetrics])

  const hasSliceTabs = sliceTabs.length > 1

  // A `<benchmark-slug>.mean` column whose per-row values are identical to an
  // earlier column (e.g. cyse2's `cyse2-vulnerability-exploit.mean` mirrors
  // `accuracy`) is a redundant alias of the primary score, not a distinct
  // measure. Suppress it so the matrix doesn't render two columns of the same
  // numbers under a humanised "Mean" header next to the real metric.
  const duplicateMeanColumnKeys = useMemo(() => {
    const dupes = new Set<string>()
    const meanMetrics = leaderboardMetrics.filter(
      (m) => m.scope !== "subtask" && /\.mean$/i.test(m.column_key),
    )
    if (meanMetrics.length === 0) return dupes
    const others = leaderboardMetrics.filter((m) => m.scope !== "subtask")
    const valuesEqual = (a: string, b: string) => {
      let comparable = 0
      for (const row of leaderboardRows) {
        const va = row.values[a]
        const vb = row.values[b]
        const aNum = isNumericScore(va)
        const bNum = isNumericScore(vb)
        if (aNum !== bNum) return false
        if (aNum && bNum && Math.abs(va - vb) > 1e-6) return false
        if (aNum && bNum) comparable += 1
      }
      return comparable > 0
    }
    for (const mean of meanMetrics) {
      const twin = others.find(
        (o) => o.column_key !== mean.column_key && valuesEqual(mean.column_key, o.column_key),
      )
      if (twin) dupes.add(mean.column_key)
    }
    return dupes
  }, [leaderboardMetrics, leaderboardRows])

  const visibleMetrics = useMemo(
    () =>
      leaderboardMetrics.filter((metric) => {
        if (!visibleMetricKeySet.has(metric.column_key)) {
          return false
        }

        if (duplicateMeanColumnKeys.has(metric.column_key)) {
          return false
        }

        if (!hasSliceTabs || activeSliceTab === "all") {
          // "All" / no-slice-filter case: only show root metrics so the
          // chips stay one-per-metric instead of one-per-(metric, slice).
          return metric.scope !== "subtask"
        }

        return metric.scope === "subtask" && metric.subtask_key === activeSliceTab
      }),
    [activeSliceTab, duplicateMeanColumnKeys, hasSliceTabs, leaderboardMetrics, visibleMetricKeySet]
  )
  const visibleMetricColumnKeySet = useMemo(
    () => new Set(visibleMetrics.map((metric) => metric.column_key)),
    [visibleMetrics]
  )

  // Column-uniform percent presentation: matrix cells arrive on the
  // metric's canonical scale, so a percent-unit column whose values are
  // all fractions renders ×100 with a % suffix. Decided per column over
  // every row — a mixed column (old snapshot without canonical scores)
  // keeps raw values untouched rather than half-converting.
  const percentDisplayColumns = useMemo(() => {
    const out = new Set<string>()
    for (const metric of leaderboardMetrics) {
      if (!/percent|%|pct/i.test(metric.unit ?? "")) continue
      let sawValue = false
      let allFractions = true
      for (const row of leaderboardRows) {
        const v = row.values[metric.column_key]
        if (typeof v !== "number" || !Number.isFinite(v)) continue
        sawValue = true
        if (Math.abs(v) > 1.5) {
          allFractions = false
          break
        }
      }
      if (sawValue && allFractions) out.add(metric.column_key)
    }
    return out
  }, [leaderboardMetrics, leaderboardRows])

  // One number rendered the way its column renders it. The judge tooltip
  // reuses this so an alternate reading reads on the same scale as the cell
  // it hangs off.
  const formatMetricValue = (columnKey: string, value: number) =>
    percentDisplayColumns.has(columnKey)
      ? `${(value * 100).toFixed(1)}%`
      : formatRawScore(value, undefined)

  const numericMinParams = useMemo(() => paramStepToNumeric(minParamStep, "min"), [minParamStep])
  const numericMaxParams = useMemo(() => paramStepToNumeric(maxParamStep, "max"), [maxParamStep])
  const [showUnknownSize, setShowUnknownSize] = useState(true)

  const hasParameterData = useMemo(
    () => leaderboardRows.some((row) => getParamsBillionsFromModelInfo(row.model_info) != null),
    [leaderboardRows]
  )

  const filteredRows = useMemo(() => {
    return leaderboardRows.filter((row) => {
      const paramsBillions = getParamsBillionsFromModelInfo(row.model_info)

      if (paramsBillions == null) return showUnknownSize

      if (numericMinParams != null && paramsBillions < numericMinParams) return false
      if (numericMaxParams != null && paramsBillions > numericMaxParams) return false
      return true
    })
  }, [leaderboardRows, numericMaxParams, numericMinParams, showUnknownSize])

  const sortedRows = useMemo(() => {
    const rows = [...filteredRows]

    const compareNames = (left: LeaderboardMatrixRow, right: LeaderboardMatrixRow) =>
      left.model_info.name.localeCompare(right.model_info.name) ||
      (left.model_info.developer ?? "").localeCompare(right.model_info.developer ?? "")

    const compareTimestamps = (left: string, right: string) => {
      const leftNumeric = Number(left)
      const rightNumeric = Number(right)
      const leftTimestamp = !Number.isNaN(leftNumeric) && !left.includes("-")
        ? leftNumeric * 1000
        : new Date(left).getTime()
      const rightTimestamp = !Number.isNaN(rightNumeric) && !right.includes("-")
        ? rightNumeric * 1000
        : new Date(right).getTime()
      return leftTimestamp - rightTimestamp
    }

    rows.sort((left, right) => {
      if (sortKey === "model") {
        const comparison = compareNames(left, right)
        return sortDirection === "asc" ? comparison : -comparison
      }

      if (sortKey === "developer") {
        const comparison =
          (left.model_info.developer ?? "").localeCompare(right.model_info.developer ?? "") || compareNames(left, right)
        return sortDirection === "asc" ? comparison : -comparison
      }

      if (sortKey === "updated") {
        const comparison = compareTimestamps(left.evaluation_timestamp, right.evaluation_timestamp) || compareNames(left, right)
        return sortDirection === "asc" ? comparison : -comparison
      }

      if (sortKey === "released") {
        const lt = left.model_info.release_date
        const rt = right.model_info.release_date
        const lMissing = !lt
        const rMissing = !rt
        if (lMissing && rMissing) return compareNames(left, right)
        // Push unknown release dates to the bottom regardless of direction.
        if (lMissing) return 1
        if (rMissing) return -1
        const comparison = compareTimestamps(lt, rt) || compareNames(left, right)
        return sortDirection === "asc" ? comparison : -comparison
      }

      const metric = leaderboardMetricMap.get(sortKey)
      if (metric) {
        const leftValue = left.values[sortKey]
        const rightValue = right.values[sortKey]
        const leftHasValue = isNumericScore(leftValue)
        const rightHasValue = isNumericScore(rightValue)

        if (leftHasValue && rightHasValue) {
          const comparison = leftValue - rightValue || compareNames(left, right)
          return sortDirection === "asc" ? comparison : -comparison
        }

        if (leftHasValue !== rightHasValue) {
          return leftHasValue ? -1 : 1
        }
      }

      return compareNames(left, right)
    })

    return rows
  }, [filteredRows, leaderboardMetricMap, sortDirection, sortKey])

  useEffect(() => {
    setPage(1)
  }, [maxParamStep, minParamStep, sortDirection, sortKey])

  useEffect(() => {
    setVisibleMetricKeys(defaultVisibleMetricKeys)
  }, [defaultVisibleMetricKeys, summary.evaluation_id])

  useEffect(() => {
    setActiveSliceTab("all")
  }, [summary.evaluation_id])

  useEffect(() => {
    if (leaderboardMetricMap.has(sortKey) && !visibleMetricColumnKeySet.has(sortKey)) {
      // The currently-sorted metric was hidden — fall back to the primary
      // metric when it is still visible, then the first visible root-scope
      // metric, then the first visible metric overall, then the model name.
      const visibleRoot = leaderboardMetrics.find(
        (m) => m.scope === "root" && visibleMetricColumnKeySet.has(m.column_key),
      )
      const fallback = (primaryMetricKey && visibleMetricColumnKeySet.has(primaryMetricKey)
        ? primaryMetricKey
        : undefined)
        ?? visibleRoot?.column_key
        ?? leaderboardMetrics.find((m) => visibleMetricColumnKeySet.has(m.column_key))?.column_key
        ?? "model"
      setSortKey(fallback)
      setSortDirection(leaderboardMetricMap.get(fallback)?.lower_is_better ? "asc" : "desc")
    }
  }, [
    leaderboardMetricMap,
    leaderboardMetrics,
    primaryMetricKey,
    sortKey,
    visibleMetricColumnKeySet,
  ])

  useEffect(() => {
    if (!hasSliceTabs) {
      if (activeSliceTab !== "all") {
        setActiveSliceTab("all")
      }
      return
    }

    if (activeSliceTab === "all") {
      return
    }

    if (!sliceTabs.some((tab) => tab.key === activeSliceTab)) {
      setActiveSliceTab("all")
    }
  }, [activeSliceTab, hasSliceTabs, sliceTabs])

  const pagedRows = useMemo(
    () => sortedRows.slice(0, page * 50),
    [page, sortedRows]
  )

  const rankByModelId = useMemo(
    () => new Map(sortedRows.map((row, index) => [row.model_info.id, index + 1])),
    [sortedRows]
  )

  const setMetricVisibility = (metricKey: string, nextVisible: boolean) => {
    setVisibleMetricKeys((current) => {
      if (nextVisible) {
        return allMetricKeys.filter((key) => key === metricKey || current.includes(key))
      }

      return current.filter((key) => key !== metricKey)
    })
  }

  const getDefaultSortDirection = (key: string): "asc" | "desc" => {
    if (key === "model" || key === "developer") {
      return "asc"
    }

    if (key === "updated") {
      return "desc"
    }

    return leaderboardMetricMap.get(key)?.lower_is_better ? "asc" : "desc"
  }

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"))
      return
    }

    setSortKey(key)
    setSortDirection(getDefaultSortDirection(key))
  }

  const getSortIndicator = (key: string) => {
    if (sortKey !== key) {
      return ""
    }

    return sortDirection === "asc" ? " ▲" : " ▼"
  }


  return (
    <section>
      {/* The parent EvalDetail already renders the apples-to-apples
          banner before this leaderboard section — duplicating it here
          made the box appear twice on multi-metric evals like fibble. */}
      <div className="section-head mt-8">
        <h2>{isResearchView ? "Leaderboard" : "Reporting Comparison"}</h2>
        <span
          className="font-mono text-[10px] uppercase tracking-[0.12em]"
          style={{ color: "var(--fg-muted)" }}
        >
          {filteredRows.length === leaderboardRows.length
            ? `${leaderboardRows.length} models`
            : `${filteredRows.length} of ${leaderboardRows.length} models`}
          {" · "}
          {visibleMetrics.length === leaderboardMetrics.length
            ? `${leaderboardMetrics.length} measures`
            : `${visibleMetrics.length} of ${leaderboardMetrics.length} measures`}
        </span>
      </div>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between mb-4">
        <p
          className="text-[13px] leading-[1.6]"
          style={{ color: "var(--fg-muted)", maxWidth: 720 }}
        >
          {isResearchView
            ? "Each column is a reported benchmark measure."
            : "Each column is a separately reported measure so the benchmark can be read without flattening different results into one number."}
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="ec-pill inline-flex items-center gap-1.5 shrink-0">
              <SlidersHorizontal className="h-3 w-3" />
              Columns
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-80 rounded-none p-0"
            style={{
              border: "1px solid var(--border-soft)",
              background: "var(--bg)",
              boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
            }}
          >
            <DropdownMenuLabel
              className="font-mono uppercase"
              style={{
                fontSize: 10,
                letterSpacing: "0.14em",
                color: "var(--fg-subtle)",
                padding: "10px 12px 6px",
              }}
            >
              Visible measure columns
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => setVisibleMetricKeys(allMetricKeys)}
              className="rounded-none focus:bg-[color:var(--bg-warm)]"
              style={{ padding: "8px 12px", color: "var(--accent)" }}
            >
              Show all
            </DropdownMenuItem>
            <DropdownMenuSeparator
              className="my-0"
              style={{ background: "var(--border-soft)" }}
            />
            {leaderboardMetrics.map((metric) => {
              const isVisible = visibleMetricKeySet.has(metric.column_key)
              const isLastVisible = isVisible && visibleMetrics.length === 1
              const { label: visibleLabel, description: visibleDescription } =
                metricDropdownLabels.get(metric.column_key) ?? {
                  label: getMetricChipLabel(metric),
                  description: "",
                }

              return (
                <DropdownMenuCheckboxItem
                  key={metric.column_key}
                  checked={isVisible}
                  disabled={isLastVisible}
                  onCheckedChange={(checked) => setMetricVisibility(metric.column_key, checked === true)}
                  className="items-start rounded-none focus:bg-[color:var(--bg-warm)]"
                  style={{ padding: "8px 12px 8px 32px" }}
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span
                      className="font-semibold leading-tight"
                      style={{ color: "var(--fg)", fontSize: 13 }}
                    >
                      {visibleLabel}
                    </span>
                    {visibleDescription && (
                      <span
                        className="leading-tight"
                        style={{ color: "var(--fg-muted)", fontSize: 11 }}
                      >
                        {visibleDescription}
                      </span>
                    )}
                  </div>
                </DropdownMenuCheckboxItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {splitConfig && (
        <SplitPicker config={splitConfig} className="mb-4" />
      )}

      {/* Distribution panel — one curve, dropdown swaps between metrics */}
      {(() => {
        const distSeries = visibleMetrics
          .map((metric) => {
            // Same ×100 presentation as the leaderboard cells, so the
            // distribution axis and frontier labels match the table.
            const scale = percentDisplayColumns.has(metric.column_key) ? 100 : 1
            const points: Array<{ score: number; releaseDate: string | null; modelName: string }> = []
            for (const r of filteredRows) {
              const score = r.values[metric.column_key]
              if (!isNumericScore(score)) continue
              points.push({
                score: score * scale,
                releaseDate: r.model_info?.release_date ?? null,
                modelName: r.model_info?.name ?? "",
              })
            }
            if (points.length < 3) return null
            const label = getMetricChipLabel(metric)
            return {
              key: metric.column_key,
              label,
              caption: metric.unit ?? undefined,
              values: points.map((p) => p.score),
              unit: metric.unit ?? undefined,
              lowerIsBetter: metric.lower_is_better,
              points,
            }
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)

        if (distSeries.length === 0) return null
        return (
          <div className="mb-4">
            <div className="flex justify-end mb-2">
              <EmbedButton
                label="Score distribution"
                defaultHeight={420}
                size="sm"
                variants={[
                  {
                    id: "distribution",
                    label: "Distribution",
                    embedPath: `/embed/eval/distribution/${routeIdToPath(summary.evaluation_id)}`,
                  },
                  {
                    id: "frontier",
                    label: "Frontier",
                    embedPath: `/embed/eval/frontier/${routeIdToPath(summary.evaluation_id)}`,
                  },
                  {
                    id: "both",
                    label: "Both",
                    embedPath: `/embed/eval/distribution/${routeIdToPath(summary.evaluation_id)}?view=both`,
                  },
                ]}
              />
            </div>
            <ScoreDistribution
              series={distSeries}
              // Open on the metric the page ranks on, not the first column
              // that happened to have enough points to plot.
              initialKey={
                distSeries.some((entry) => entry.key === primaryMetricKey)
                  ? primaryMetricKey
                  : undefined
              }
            />
          </div>
        )
      })()}

      <div className="flex justify-end mb-2">
        <EmbedButton
          embedPath={`/embed/eval/leaderboard/${routeIdToPath(summary.evaluation_id)}`}
          label="Leaderboard"
          defaultHeight={560}
          size="sm"
        />
      </div>
      <div className="ec-card" style={{ padding: 0, overflow: "hidden" }}>
        {hasParameterData && (
          <div className="border-b bg-background px-5 py-4 sm:px-6">
            <ParamRangePicker
              variant="promo"
              headline="Parameter range"
              subline="Narrow the matrix to comparable model sizes."
              minStep={minParamStep}
              maxStep={maxParamStep}
              onMinChange={setMinParamStep}
              onMaxChange={setMaxParamStep}
              onReset={() => {
                setMinParamStep(0)
                setMaxParamStep(PARAM_RANGE_MAX_INDEX)
              }}
              showUnknownSize={showUnknownSize}
              onShowUnknownSizeChange={setShowUnknownSize}
            />
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="ec-htable" style={{ minWidth: 1080 }}>
            <thead>
              <tr>
                <th className="num" style={{ width: 64 }}>
                  Rank
                </th>
                <th
                  style={{ minWidth: 260, cursor: "pointer" }}
                  onClick={() => handleSort("model")}
                >
                  Model{getSortIndicator("model")}
                </th>
                <th
                  className="hidden lg:table-cell"
                  style={{ minWidth: 160, cursor: "pointer" }}
                  onClick={() => handleSort("developer")}
                >
                  {isResearchView ? "Developer" : "Provider"}
                  {getSortIndicator("developer")}
                </th>
                {visibleMetrics.map((metric) => {
                  // When a slice is active in the dropdown, the slice
                  // name is already shown above the table — no need to
                  // repeat it as a per-column topline.
                  const showSliceTopline = false
                  const mainLabel = getMetricChipLabel(metric)
                  return (
                    <th
                      key={metric.column_key}
                      className="num"
                      style={{ minWidth: 130, cursor: "pointer" }}
                      onClick={() => handleSort(metric.column_key)}
                      title={describeLeaderboardMetric(metric)}
                    >
                      {showSliceTopline && (
                        <div
                          className="font-mono normal-case"
                          style={{
                            fontSize: 9,
                            letterSpacing: "0.1em",
                            color: "var(--fg-subtle)",
                            marginBottom: 2,
                          }}
                        >
                          {metric.subtask_name}
                        </div>
                      )}
                      {mainLabel}
                      {getSortIndicator(metric.column_key)}
                    </th>
                  )
                })}
                <th className="hidden lg:table-cell" style={{ width: 110 }}>Evaluator</th>
                <th className="num hidden lg:table-cell" style={{ width: 100 }}>Source</th>
                <th
                  className="num hidden lg:table-cell"
                  style={{ width: 110, cursor: "pointer" }}
                  onClick={() => handleSort("released")}
                  title="Sort by model release date"
                >
                  Released{getSortIndicator("released")}
                </th>
              </tr>
            </thead>
            <tbody>
              {pagedRows.map((row) => {
                const rank = rankByModelId.get(row.model_info.id) ?? 0
                const expandKey = row.model_info.id
                const isExpanded = expandedRows[expandKey] ?? false
                const matchingResult = modelResultByModelId.get(row.model_info.id)
                const isTopRank = rank === 1
                const rankColor = rank === 1 ? "var(--accent)" : "var(--fg-muted)"
                const familyLabel = row.model_info.architecture ?? row.model_info.parameter_count ?? null

                return (
                <Fragment key={row.model_info.id}>
                <tr className={cn("align-top", isExpanded && "bg-[color:var(--bg-warm)]")}>
                  <td className="num align-top">
                    <span
                      className="font-mono tabular-nums"
                      style={{
                        fontSize: 14,
                        fontWeight: isTopRank ? 600 : 500,
                        color: rankColor,
                      }}
                    >
                      #{rank}
                    </span>
                  </td>
                  <td className="align-top whitespace-normal">
                    <div className="flex items-start gap-1.5 leading-tight">
                      {isResearchView && matchingResult && (
                        <button
                          type="button"
                          onClick={() => toggleExpandedRow(expandKey)}
                          aria-label={isExpanded ? "Hide reproducibility" : "Show reproducibility"}
                          aria-expanded={isExpanded}
                          className="-ml-1 mt-0.5 inline-flex h-4 w-4 items-center justify-center transition-colors hover:text-[color:var(--accent)]"
                          style={{ color: "var(--fg-muted)" }}
                        >
                          {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                        </button>
                      )}
                      <div className="min-w-0">
                        <Link
                          href={`/models/${routeIdToPath(row.model_route_id ?? routeIdFromModelId(row.model_group_id))}`}
                          className="font-semibold text-[14px] hover:text-[color:var(--accent)] transition-colors"
                          style={{ color: "var(--fg)" }}
                        >
                          {row.model_info.name}
                        </Link>
                        {familyLabel && (
                          <div
                            className="mt-0.5 font-mono uppercase truncate"
                            style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--fg-subtle)" }}
                          >
                            {familyLabel}
                          </div>
                        )}
                        <div
                          className="mt-0.5 lg:hidden text-[12px]"
                          style={{ color: "var(--fg-muted)" }}
                        >
                          {row.model_info.developer ?? "Unknown developer"}
                        </div>
                      </div>
                    </div>
                  </td>

                  <td className="hidden lg:table-cell align-top">
                    <div className="text-[13px] truncate" style={{ color: "var(--fg-muted)" }}>
                      {row.model_info.developer ?? "Unknown developer"}
                    </div>
                  </td>

                  {visibleMetrics.map((metric) => {
                    const score = row.values[metric.column_key]
                    const annotations = row.annotations_by_metric?.[metric.column_key]
                    const comparabilityStatus =
                      row.comparability_status_by_metric?.[metric.column_key]
                    const valid = isNumericScore(score)
                    const display = !valid ? "—" : formatMetricValue(metric.column_key, score)
                    // The pivot keeps one row per model, so a judged cell
                    // carries its panel — and the readings the producer's
                    // headline pick left out — here rather than as rows of
                    // its own.
                    const judgeCell = judgeCellSummary(
                      row.judge_condition_by_metric?.[metric.column_key],
                      row.judge_alternates_by_metric?.[metric.column_key],
                      judgeDisplayName,
                      (value) => formatMetricValue(metric.column_key, value),
                    )
                    return (
                      <td
                        key={metric.column_key}
                        className="num align-top tabular-nums"
                        style={{
                          fontSize: 13,
                          fontWeight: valid ? 600 : 400,
                          color: valid ? "var(--fg)" : "var(--fg-subtle)",
                        }}
                      >
                        <div>{display}</div>
                        {judgeCell && (
                          <div
                            className="truncate"
                            style={{ fontSize: 10, fontWeight: 400, color: "var(--fg-muted)" }}
                            title={judgeCell.tooltip}
                          >
                            {judgeCell.label}
                          </div>
                        )}
                        <SignalsRowBadges
                          annotations={annotations}
                          comparabilityStatus={comparabilityStatus}
                          variant="cell"
                        />
                      </td>
                    )
                  })}

                  <td className="hidden lg:table-cell align-top">
                    <span className="font-mono uppercase" style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                      {row.source_metadata?.evaluator_relationship === "first_party"
                        ? "SELF"
                        : row.source_metadata?.evaluator_relationship === "third_party"
                          ? "THIRD-PARTY"
                          : "—"}
                    </span>
                  </td>
                  <td className="num hidden lg:table-cell align-top">
                    {(() => {
                      const sourceLabel =
                        row.source_metadata?.source_name?.trim()
                        || row.source_metadata?.source_organization_name?.trim()
                      const sourceEvaluatorName =
                        resolveEvaluatorName(row.source_metadata?.source_organization_name)
                        ?? resolveEvaluatorName(row.source_metadata?.source_name)
                      return sourceLabel ? (
                      <span className="inline-flex items-center justify-end gap-1">
                        <EvaluatorName
                          display={sourceLabel}
                          linkName={sourceEvaluatorName}
                          className="font-mono lowercase"
                          style={{ fontSize: 11, color: "var(--fg-muted)" }}
                        />
                        <VerifiedBadge
                          verified={Object.values(row.verified ?? {}).some(Boolean)}
                          recognized={isRecognizedEvaluator(
                            row.source_metadata?.source_name
                              ?? row.source_metadata?.source_organization_name,
                          )}
                          size="sm"
                        />
                      </span>
                    ) : (
                      <span style={{ color: "var(--fg-subtle)" }}>—</span>
                    )
                    })()}
                  </td>

                  <td
                    className="num hidden lg:table-cell align-top font-mono tabular-nums"
                    style={{ fontSize: 11, color: "var(--fg-muted)" }}
                  >
                    {row.model_info.release_date
                      ? formatDate(row.model_info.release_date).split(",")[0]
                      : <span style={{ color: "var(--fg-subtle)" }}>—</span>}
                  </td>
                </tr>
                {isResearchView && isExpanded && matchingResult && (
                  <tr>
                    <td
                      colSpan={visibleMetrics.length + 7}
                      style={{ background: "var(--bg-warm)", padding: "20px 24px" }}
                    >
                      <div className="space-y-3">
                        <ResearcherReproducibilityCard
                          modelResult={matchingResult}
                          benchmarkKey={summary.benchmark_id ?? summary.composite_benchmark_key}
                          evalName={summary.evaluation_name}
                        />
                        <div className="flex justify-end">
                          <FlagScoreButton
                            modelName={matchingResult.model_info.name}
                            modelId={matchingResult.model_info.id}
                            benchmarkName={summary.evaluation_name}
                            benchmarkId={summary.evaluation_id}
                            score={formatRawScore(matchingResult.score, summary.metric_config.unit)}
                            sourceUrl={matchingResult.source_metadata.source_url}
                            sourceRecordUrl={matchingResult.source_record_url}
                            eeeRecordUrl={matchingResult.eee_record_url}
                          />
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              )})}

              {filteredRows.length === 0 && (
                <tr>
                  <td colSpan={visibleMetrics.length + 6} style={{ padding: "32px 16px", textAlign: "center", color: "var(--fg-muted)" }}>
                    No models match the selected parameter range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {pagedRows.length < filteredRows.length && (
          <div
            style={{
              borderTop: "1px solid var(--border-soft)",
              background: "var(--bg-warm)",
              padding: "16px",
              textAlign: "center",
            }}
          >
            <button
              type="button"
              className="btn-ec outline"
              onClick={() => setPage((current) => current + 1)}
            >
              Load more ({filteredRows.length - pagedRows.length} remaining)
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

function BenchmarkCardCollapsible({
  card,
  isResearchView,
  defaultOpen = true,
  defaultRisksOpen = false,
  evaluationName = "",
  sourceDataFallback = null,
  knownIssues = [],
}: {
  card: BenchmarkCard
  isResearchView: boolean
  defaultOpen?: boolean
  defaultRisksOpen?: boolean
  evaluationName?: string
  sourceDataFallback?: SourceData | null
  knownIssues?: KnownIssue[]
}) {
  // Decide whether the panel has any meaningful content. We hide the
  // whole collapsible — header and body — when it doesn't. Fallback
  // values that duplicate the eval title don't count.
  const meaningful = (v: string | undefined | null) =>
    Boolean(v && v.trim() && v.trim() !== "Not specified")
  const looksLikeEvalTitle = (v: string | undefined | null) =>
    Boolean(
      v &&
        evaluationName &&
        v.trim().toLowerCase() === evaluationName.trim().toLowerCase(),
    )
  const usefulFallback = (v: string | undefined | null) =>
    meaningful(v) && !looksLikeEvalTitle(v)

  const purpose = card.purpose_and_intended_users
  const methodology = card.methodology
  const data = card.data
  const ethical = card.ethical_and_legal_considerations
  const sd = sourceDataFallback
  const tasks = toStringArray(purpose.tasks)
  const audience = toStringArray(purpose.audience)
  const domains = toStringArray(card.benchmark_details?.domains)
  const languages = toStringArray(card.benchmark_details?.languages)
  const resources = (card.benchmark_details?.resources ?? []).filter(Boolean)
  const flaggedFieldsRaw = card.flagged_fields as unknown
  const hasFlaggedFields =
    typeof flaggedFieldsRaw === "string"
      ? flaggedFieldsRaw.length > 2
      : flaggedFieldsRaw != null &&
        typeof flaggedFieldsRaw === "object" &&
        Object.keys(flaggedFieldsRaw).length > 0
  const hasMissingFields = (card.missing_fields ?? []).length > 0

  const hasContent =
    knownIssues.length > 0 ||
    meaningful(purpose.goal) ||
    meaningful(methodology.interpretation) ||
    meaningful(purpose.limitations) ||
    (methodology.methods?.length ?? 0) > 0 ||
    meaningful(methodology.calculation) ||
    meaningful(methodology.validation) ||
    (methodology.metrics?.length ?? 0) > 0 ||
    tasks.length > 0 ||
    audience.length > 0 ||
    domains.length > 0 ||
    languages.length > 0 ||
    resources.length > 0 ||
    (card.possible_risks?.length ?? 0) > 0 ||
    meaningful(ethical?.data_licensing) ||
    meaningful(ethical?.compliance_with_regulations) ||
    meaningful(ethical?.privacy_and_anonymity) ||
    meaningful(data?.size) ||
    meaningful(data?.format) ||
    usefulFallback(data?.source) ||
    usefulFallback(sd?.hf_repo) ||
    usefulFallback(sd?.dataset_name) ||
    sd?.samples_number != null ||
    meaningful(sd?.source_type) ||
    (isResearchView && (Boolean(hasFlaggedFields) || hasMissingFields))

  if (!hasContent) return null

  const [open, setOpen] = useState(defaultOpen)
  const sectionLinks: { label: string; id: string }[] = [
    ...(methodology.metrics?.length || tasks.length || audience.length || meaningful(data?.size) || meaningful(data?.format) || usefulFallback(data?.source) || usefulFallback(sd?.hf_repo) || usefulFallback(sd?.dataset_name) || sd?.samples_number != null
      ? [{ label: "dataset", id: "bc-section-dataset" }, { label: "methodology", id: "bc-section-methodology" }]
      : []),
    ...(isResearchView && (card.possible_risks?.length ?? 0) > 0 ? [{ label: "risks", id: "bc-section-risks" }] : []),
    ...(resources.length > 0 ? [{ label: "resources", id: "bc-section-resources" }] : []),
  ]
  const handleSectionJump = (id: string) => {
    setOpen(true)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById(id)
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" })
      })
    })
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="ec-card flex w-full items-center justify-between text-left transition-colors hover:bg-[color:var(--bg-warm)]"
          style={{ padding: "14px 20px" }}
        >
          <div className="flex items-center gap-3 flex-wrap">
            <BookOpen className="h-4 w-4" style={{ color: "var(--fg-muted)" }} />
            <span className="kicker kicker-fg">Benchmark card</span>
            {sectionLinks.length > 0 && (
              <span className="flex items-center gap-1.5 flex-wrap">
                {sectionLinks.map((s, i) => (
                  <span key={s.id} className="inline-flex items-center gap-1.5">
                    {i > 0 && (
                      <span
                        className="font-mono text-[10px]"
                        style={{ color: "var(--fg-subtle)" }}
                        aria-hidden
                      >
                        ·
                      </span>
                    )}
                    <span
                      role="link"
                      tabIndex={0}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        handleSectionJump(s.id)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          e.stopPropagation()
                          handleSectionJump(s.id)
                        }
                      }}
                      className="font-mono text-[10px] uppercase tracking-[0.12em] cursor-pointer hover:underline"
                      style={{ color: "var(--fg-subtle)" }}
                    >
                      {s.label}
                    </span>
                  </span>
                ))}
              </span>
            )}
          </div>
          {open ? (
            <ChevronUp className="h-4 w-4" style={{ color: "var(--fg-muted)" }} />
          ) : (
            <ChevronDown className="h-4 w-4" style={{ color: "var(--fg-muted)" }} />
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <BenchmarkCardPanel
          card={card}
          isResearchView={isResearchView}
          defaultRisksOpen={defaultRisksOpen}
          sourceDataFallback={sourceDataFallback}
          knownIssues={knownIssues}
        />
      </CollapsibleContent>
    </Collapsible>
  )
}

function DetailPanel({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <div
      className="min-w-0"
      style={{
        padding: 16,
        border: "1px solid var(--border-soft)",
        background: "var(--bg)",
      }}
    >
      <div className="mb-3">
        <div
          className="font-mono uppercase mb-1"
          style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
        >
          {title}
        </div>
        <div className="text-[12px]" style={{ color: "var(--fg-muted)" }}>{subtitle}</div>
      </div>
      <div className="min-w-0 space-y-2">{children}</div>
    </div>
  )
}

function MetaRow({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}) {
  // Hide rows whose value is missing or a generic placeholder. This keeps
  // the detail panels focused on fields we actually have data for.
  if (value == null) return null
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (
      normalized === "" ||
      normalized === "unknown" ||
      normalized === "n/a" ||
      normalized === "not recorded" ||
      normalized === "not specified" ||
      normalized === "not linked"
    ) {
      return null
    }
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "8rem minmax(0, 1fr)",
        columnGap: "0.75rem",
        width: "100%",
        minWidth: 0,
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <div style={{ color: "var(--fg-muted)" }}>{label}</div>
      <div
        className="font-medium"
        style={{
          color: "var(--fg)",
          minWidth: 0,
          maxWidth: "100%",
          overflowWrap: "anywhere",
          wordBreak: "break-word",
        }}
      >
        {value}
      </div>
    </div>
  )
}

function toStringArray(value: unknown): string[] {
  const result = new Set<string>()

  const visit = (candidate: unknown) => {
    if (!candidate) {
      return
    }

    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item)
      }
      return
    }

    if (typeof candidate === "object") {
      for (const item of Object.values(candidate)) {
        visit(item)
      }
      return
    }

    if (typeof candidate !== "string") {
      return
    }

    const normalized = candidate.trim()
    if (!normalized || normalized === "Not specified") {
      return
    }

    for (const part of normalized.split(/[,;|]/)) {
      const token = part.trim()
      if (token && token !== "Not specified") {
        result.add(token)
      }
    }
  }

  visit(value)
  return Array.from(result)
}

function BenchmarkCardPanel({
  card,
  isResearchView,
  defaultRisksOpen = false,
  sourceDataFallback = null,
  knownIssues = [],
}: {
  card: BenchmarkCard
  isResearchView: boolean
  defaultRisksOpen?: boolean
  sourceDataFallback?: SourceData | null
  knownIssues?: KnownIssue[]
}) {
  const [risksOpen, setRisksOpen] = useState(defaultRisksOpen)
  const details = card.benchmark_details
  const purpose = card.purpose_and_intended_users
  const methodology = card.methodology
  const data = card.data
  const ethical = card.ethical_and_legal_considerations
  const risks = card.possible_risks ?? []
  // The backend currently emits `flagged_fields` as a JSON string
  // (DuckDB's `json_extract` typed as JSON, which crosses
  // @duckdb/node-api as a string). When the value lands as a string
  // here, `Object.entries(...)` would iterate it character by
  // character and render one `<li>` per character — what the user
  // saw on `/evals/vals-ai%2Fterminal-bench-2`. Parse first when
  // needed, fall back to {} on malformed JSON.
  const flaggedFieldsRaw = card.flagged_fields
  const flaggedFieldsObj: Record<string, string> = (() => {
    if (!flaggedFieldsRaw) return {}
    if (typeof flaggedFieldsRaw === "string") {
      try {
        const parsed = JSON.parse(flaggedFieldsRaw)
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, string>)
          : {}
      } catch {
        return {}
      }
    }
    return flaggedFieldsRaw as Record<string, string>
  })()
  const flaggedFields = Object.entries(flaggedFieldsObj)
  const missingFields = card.missing_fields ?? []

  const domains = toStringArray(details.domains)
  const languages = toStringArray(details.languages)
  const resources = (details.resources ?? []).filter(Boolean)
  const tasks = toStringArray(purpose.tasks)
  const audience = toStringArray(purpose.audience)

  const license = ethical.data_licensing ?? ""
  const shortLicense = license && license !== "Not specified" ? license : null

  // The outer collapsible trigger names the panel; the prominent top
  // strip surfaces what readers most often want at a glance — domain
  // and language tags, license, and any flagged/missing-field badge.
  const hasChipStrip =
    domains.length > 0 ||
    languages.length > 0 ||
    Boolean(shortLicense) ||
    flaggedFields.length > 0 ||
    missingFields.length > 0

  return (
    <div className="ec-card" style={{ padding: 0, overflow: "hidden" }}>
      {hasChipStrip && (
        <div
          className="flex flex-wrap items-center gap-2"
          style={{
            padding: "10px 20px",
            background: "var(--bg-warm)",
            borderBottom: "1px solid var(--border-soft)",
          }}
        >
          {domains.map((d) => (
            <Link
              key={`d-${d}`}
              href={`/evals?q=${encodeURIComponent(d)}`}
              className="ec-tag outline hover:bg-[color:var(--bg-surface)]"
              title={`Browse evaluations tagged "${d}"`}
            >
              <Tag className="h-3 w-3 shrink-0" />
              {d}
            </Link>
          ))}
          {languages.map((l) => (
            <Link
              key={`l-${l}`}
              href={`/evals?q=${encodeURIComponent(l)}`}
              className="ec-tag outline hover:bg-[color:var(--bg-surface)]"
              title={`Browse evaluations in ${l}`}
            >
              <Globe className="h-3 w-3 shrink-0" />
              {l}
            </Link>
          ))}
          {shortLicense && <span className="ec-tag outline">{shortLicense}</span>}
          {(flaggedFields.length > 0 || missingFields.length > 0) && (
            <span
              className="font-mono inline-flex items-center gap-1"
              style={{
                fontSize: 10,
                padding: "2px 8px",
                letterSpacing: "0.06em",
                background: "var(--bg)",
                color: "var(--accent)",
                border: "1px solid var(--accent)",
                textTransform: "uppercase",
              }}
            >
              <AlertTriangle className="h-3 w-3" />
              {flaggedFields.length} flagged · {missingFields.length} missing
            </span>
          )}
        </div>
      )}

      <div className="space-y-6 p-5 sm:p-6">
        {knownIssues.length > 0 && <KnownIssuesPanel issues={knownIssues} variant="full" />}

        {(() => {
          const meaningful = (v: string | undefined | null) =>
            Boolean(v && v.trim() && v.trim() !== "Not specified")
          const showGoal = meaningful(purpose.goal)
          const showInterp = meaningful(methodology.interpretation)
          const showLimitations = meaningful(purpose.limitations)
          if (!showGoal && !showInterp && !showLimitations) return null
          return (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {showGoal && (
                <div
                  style={{
                    padding: 16,
                    border: "1px solid var(--border-soft)",
                    background: "var(--bg)",
                  }}
                >
                  <div
                    className="mb-2 flex items-center gap-2 font-mono uppercase"
                    style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
                  >
                    <Scale className="h-3 w-3" /> Goal
                  </div>
                  <p className="text-[13px] leading-[1.55]" style={{ color: "var(--fg)" }}>{purpose.goal}</p>
                </div>
              )}

              {showInterp && (
                <div
                  style={{
                    padding: 16,
                    border: "1px solid var(--border-soft)",
                    background: "var(--bg)",
                  }}
                >
                  <div
                    className="mb-2 flex items-center gap-2 font-mono uppercase"
                    style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
                  >
                    <BarChart3 className="h-3 w-3" /> Score interpretation
                  </div>
                  <p className="text-[13px] leading-[1.55]" style={{ color: "var(--fg)" }}>{methodology.interpretation}</p>
                </div>
              )}

              {showLimitations && (
                <div
                  style={{
                    padding: 16,
                    border: "1px solid var(--accent)",
                    background: "var(--bg-warm)",
                  }}
                >
                  <div
                    className="mb-2 flex items-center gap-2 font-mono uppercase"
                    style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--accent)" }}
                  >
                    <AlertTriangle className="h-3 w-3" /> Limitations
                  </div>
                  <p className="text-[13px] leading-[1.55]" style={{ color: "var(--accent)" }}>{purpose.limitations}</p>
                </div>
              )}
            </div>
          )
        })()}

        {(methodology.methods?.length > 0 ||
          (methodology.calculation && methodology.calculation !== "Not specified") ||
          (methodology.validation && methodology.validation !== "Not specified")) && (
          <div
            style={{
              padding: 16,
              border: "1px solid var(--border-soft)",
              background: "var(--bg)",
            }}
          >
            <div
              className="mb-3 font-mono uppercase"
              style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
            >
              How tasks were sourced and scored
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {methodology.methods?.length > 0 && (
                <div>
                  <div className="mb-1.5 text-xs font-semibold text-foreground/80">
                    Task setup
                  </div>
                  <ol className="list-decimal space-y-1.5 pl-4 text-sm leading-5 text-muted-foreground">
                    {methodology.methods.map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ol>
                </div>
              )}
              <div className="space-y-3">
                {methodology.calculation && methodology.calculation !== "Not specified" && (
                  <div>
                    <div className="mb-1.5 text-xs font-semibold text-foreground/80">
                      Score calculation
                    </div>
                    <p className="text-sm leading-5 text-muted-foreground">
                      {methodology.calculation}
                    </p>
                  </div>
                )}
                {methodology.validation && methodology.validation !== "Not specified" && (
                  <div>
                    <div className="mb-1.5 text-xs font-semibold text-foreground/80">
                      Validation
                    </div>
                    <p className="text-sm leading-5 text-muted-foreground">
                      {methodology.validation}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Research-only: methodology + dataset details. Each tile
            falls back to whatever data is available — and hides
            entirely when nothing is. The card payload often arrives
            sparse for benchmarks that haven't been documented; the
            previous version rendered "Size / Format / Source" labels
            with empty values, which read as broken. */}
        {isResearchView &&
          (() => {
            const meaningful = (v: string | undefined | null) =>
              Boolean(v && v.trim() && v.trim() !== "Not specified")
            // Dataset row fallbacks pull from summary.source_data when
            // the card itself didn't fill those fields. The summary
            // payload almost always carries hf_repo / dataset_name even
            // for cards that are otherwise empty, so this turns a
            // blank tile into something useful.
            const sd = sourceDataFallback
            const datasetSize = meaningful(data.size)
              ? data.size
              : sd?.samples_number != null
                ? `${sd.samples_number.toLocaleString()} samples`
                : null
            const datasetFormat = meaningful(data.format)
              ? data.format
              : meaningful(sd?.source_type)
                ? sd!.source_type!
                : null
            const datasetSource = meaningful(data.source)
              ? data.source
              : meaningful(sd?.hf_repo)
                ? sd!.hf_repo!
                : meaningful(sd?.dataset_name)
                  ? sd!.dataset_name!
                  : null
            const showDataset = Boolean(datasetSize || datasetFormat || datasetSource)
            const showMethodology =
              methodology.metrics.length > 0 || tasks.length > 0 || audience.length > 0
            if (!showDataset && !showMethodology) return null
            return (
              <div
                className="grid gap-x-8 gap-y-5 sm:grid-cols-2 pt-4"
                style={{ borderTop: "1px solid var(--border-soft)" }}
              >
                {showDataset && (
                  <div id="bc-section-dataset" className="scroll-mt-24">
                    <div
                      className="mb-3 font-mono uppercase"
                      style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
                    >
                      Dataset
                    </div>
                    <dl className="space-y-2 text-[13px]">
                      {datasetSize && (
                        <div className="flex gap-2">
                          <dt className="w-20 shrink-0" style={{ color: "var(--fg-muted)" }}>Size</dt>
                          <dd className="font-medium">{datasetSize}</dd>
                        </div>
                      )}
                      {datasetFormat && (
                        <div className="flex gap-2">
                          <dt className="w-20 shrink-0" style={{ color: "var(--fg-muted)" }}>Format</dt>
                          <dd className="font-medium capitalize">{datasetFormat}</dd>
                        </div>
                      )}
                      {datasetSource && (
                        <div className="flex gap-2">
                          <dt className="w-20 shrink-0" style={{ color: "var(--fg-muted)" }}>Source</dt>
                          <dd className="font-medium break-all">{datasetSource}</dd>
                        </div>
                      )}
                    </dl>
                  </div>
                )}

                {showMethodology && (
                  <div id="bc-section-methodology" className="scroll-mt-24">
                    <div
                      className="mb-3 font-mono uppercase"
                      style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
                    >
                      Methodology
                    </div>
                    <dl className="space-y-2 text-[13px]">
                      {methodology.metrics.length > 0 && (
                        <div className="flex gap-2">
                          <dt className="w-20 shrink-0" style={{ color: "var(--fg-muted)" }}>Metrics</dt>
                          <dd className="font-medium">{methodology.metrics.join(", ")}</dd>
                        </div>
                      )}
                      {tasks.length > 0 && (
                        <div className="flex gap-2">
                          <dt className="w-20 shrink-0" style={{ color: "var(--fg-muted)" }}>Tasks</dt>
                          <dd className="font-medium">{tasks.join(", ")}</dd>
                        </div>
                      )}
                      {audience.length > 0 && (
                        <div className="flex gap-2">
                          <dt className="w-20 shrink-0" style={{ color: "var(--fg-muted)" }}>Audience</dt>
                          <dd className="font-medium">{audience.join("; ")}</dd>
                        </div>
                      )}
                    </dl>
                  </div>
                )}
              </div>
            )
          })()}

        {/* Generic IBM-style AI risks. These are boilerplate (per audit
            feedback: "least useful feature for policy users"), so in policy
            mode we hide them entirely — the curated known-issues panel above
            carries the benchmark-specific concerns. Researchers still get the
            full collapsible list. */}
        {risks.length > 0 && isResearchView && (
          <Collapsible open={risksOpen} onOpenChange={setRisksOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                id="bc-section-risks"
                className="flex w-full items-center justify-between text-left transition-colors hover:bg-[color:var(--bg-warm)] scroll-mt-24"
                style={{
                  padding: "12px 16px",
                  border: "1px solid var(--border-soft)",
                  background: "var(--bg)",
                }}
              >
                <div className="flex items-center gap-2">
                  <Shield className="h-4 w-4" style={{ color: "var(--fg-muted)" }} />
                  <span
                    className="font-mono uppercase"
                    style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--fg)" }}
                  >
                    Risk considerations ({risks.length})
                  </span>
                </div>
                {risksOpen ? (
                  <ChevronUp className="h-4 w-4" style={{ color: "var(--fg-muted)" }} />
                ) : (
                  <ChevronDown className="h-4 w-4" style={{ color: "var(--fg-muted)" }} />
                )}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul
                className="mt-2 grid sm:grid-cols-2"
                style={{
                  borderTop: "1px solid var(--border-soft)",
                  borderLeft: "1px solid var(--border-soft)",
                }}
              >
                {risks.map((risk, i) => (
                  <li
                    key={i}
                    style={{
                      padding: 14,
                      borderBottom: "1px solid var(--border-soft)",
                      borderRight: "1px solid var(--border-soft)",
                    }}
                  >
                    <div className="mb-1.5 flex items-start justify-between gap-2">
                      <span className="text-[13px] font-semibold">{risk.category}</span>
                      {risk.url && (
                        <a
                          href={risk.url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="shrink-0 hover:text-[color:var(--accent)]"
                          style={{ color: "var(--fg-muted)" }}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>
                    {risk.description?.[0] && (
                      <p
                        className="text-[12px] leading-[1.55] line-clamp-3"
                        style={{ color: "var(--fg-muted)" }}
                      >
                        {risk.description[0]}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Compliance / ethical notes (policy view emphasis). Hide the
            entire panel when none of the three fields are populated —
            otherwise the user sees an empty bordered box with just the
            section header. */}
        {!isResearchView &&
          (() => {
            const showCompliance =
              ethical.compliance_with_regulations &&
              ethical.compliance_with_regulations !== "Not specified"
            const showPrivacy =
              ethical.privacy_and_anonymity &&
              ethical.privacy_and_anonymity !== "Not specified"
            if (!shortLicense && !showCompliance && !showPrivacy) return null
            return (
              <div
                style={{
                  padding: 16,
                  border: "1px solid var(--border-soft)",
                  background: "var(--bg)",
                }}
              >
                <div
                  className="mb-3 font-mono uppercase"
                  style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
                >
                  Ethical &amp; legal
                </div>
                <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
                  {shortLicense && (
                    <div className="flex gap-2">
                      <dt className="w-28 shrink-0" style={{ color: "var(--fg-muted)" }}>License</dt>
                      <dd className="font-medium">{license}</dd>
                    </div>
                  )}
                  {showCompliance && (
                    <div className="flex gap-2">
                      <dt className="w-28 shrink-0" style={{ color: "var(--fg-muted)" }}>Compliance</dt>
                      <dd className="font-medium">{ethical.compliance_with_regulations}</dd>
                    </div>
                  )}
                  {showPrivacy && (
                    <div className="col-span-full flex gap-2">
                      <dt className="w-28 shrink-0" style={{ color: "var(--fg-muted)" }}>Privacy</dt>
                      <dd className="font-medium">{ethical.privacy_and_anonymity}</dd>
                    </div>
                  )}
                </dl>
              </div>
            )
          })()}

        {/* Flagged / missing fields warning */}
        {(flaggedFields.length > 0 || missingFields.length > 0) && isResearchView && (
          <div
            style={{
              padding: 14,
              border: "1px solid var(--accent)",
              background: "var(--bg-warm)",
            }}
          >
            <div
              className="mb-2 font-mono uppercase"
              style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--accent)" }}
            >
              Card quality notes
            </div>
            {flaggedFields.length > 0 && (
              <ul
                className="space-y-2"
                style={{ color: "var(--fg)" }}
              >
                {flaggedFields.map(([field, note]) => {
                  const { tag, body } = splitFlagNote(note)
                  return (
                    <li key={field} className="flex flex-col gap-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className="font-mono uppercase"
                          style={{
                            fontSize: 10,
                            letterSpacing: "0.12em",
                            color: "var(--fg-muted)",
                          }}
                        >
                          {humanizeCardFieldPath(field)}
                        </span>
                        {tag && (
                          <span
                            className="font-mono uppercase"
                            style={{
                              fontSize: 9,
                              letterSpacing: "0.12em",
                              padding: "1px 6px",
                              border: "1px solid var(--accent)",
                              color: "var(--accent)",
                              background: "var(--bg)",
                            }}
                          >
                            {tag}
                          </span>
                        )}
                      </div>
                      {body && (
                        <span className="text-[12px]" style={{ color: "var(--fg)" }}>
                          {body}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
            {missingFields.length > 0 && (
              <p className="mt-1 text-[12px]" style={{ color: "var(--fg-muted)" }}>
                Missing: {missingFields.join(", ")}
              </p>
            )}
          </div>
        )}

        {/* External resources */}
        {resources.length > 0 && (
          <div id="bc-section-resources" className="scroll-mt-24">
            <div
              className="mb-2 font-mono uppercase"
              style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
            >
              Resources
            </div>
            <div className="flex flex-wrap gap-2">
              {resources.map((url) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="ec-tag outline inline-flex items-center gap-1.5"
                  style={{ textDecoration: "none" }}
                >
                  <FileText className="h-3 w-3 shrink-0" />
                  {url.replace(/^https?:\/\//, "").replace(/\/.+/, "")}
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
