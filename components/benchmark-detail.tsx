"use client"

// Force recompile
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useAudienceMode } from "@/components/audience-mode-provider"
import { EmbedButton } from "@/components/embed-button"
import { formatDateISO, humanizeBenchmarkName, humanizeEvaluationId, routeIdFromModelId, routeIdToPath } from "@/lib/utils"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Progress } from "@/components/ui/progress"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  getRelationshipBadgeTone,
  getRelationshipDisplayName,
  getRelationshipShortLabel,
} from "@/components/signals/provenance-badge"
import { RowFlagSquares } from "@/components/signals/flag-squares"
import { SignalsRowBadges } from "@/components/signals/signals-row-badges"
import { SignalTooltip } from "@/components/signals/signal-tooltip"
import { VerifiedBadge } from "@/components/signals/verified-badge"
import { isRecognizedEvaluator } from "@/lib/evaluators"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ExternalLink, TrendingUp, Info, Database, Settings, FileCode, Building, Calendar, User, Server,
  ChevronDown, ChevronUp, BarChart3, Award, AlertTriangle, ArrowUpRight,
  Cpu, Tag, Globe, Network, Activity, MessageSquare, Clock, Hash, Layers, Search, FlaskConical, Scale, BookOpenText, Plus, X, List, LayoutGrid
} from "lucide-react"
import { RunProtocolSummary } from "@/components/protocol-axis-fields"
import type { BenchmarkCard, BenchmarkEvaluation, EvalTag, EvaluationResult } from "@/lib/benchmark-schema"
import { getTagColor as getCategoryTone, inferTagsFromBenchmark } from "@/lib/benchmark-schema"
import { formatTagLabel } from "@/lib/benchmark-tags"
import type { BenchmarkEvalSummary } from "@/lib/eval-processing"
import type { ModelSummaryCore } from "@/lib/benchmark-schema"
import { lookupBenchmarkCard } from "@/lib/benchmark-metadata-utils"
import type { BenchmarkEvaluationCardData } from "@/components/benchmark-evaluation-card"
import type {
  BenchmarkIndexEntry,
  ComparisonEvalEntry,
  ComparisonIndex,
  ComparisonMetricEntry,
  ComparisonScoreEntry,
  EvalHierarchy,
  PeerRanksMap,
  ScaleConversion,
  SubmissionAxis,
} from "@/lib/backend-artifacts"
import { fetchPeerRanks } from "@/lib/dashboard-data-client"
import {
  canonicalCellIsPercent,
  resolveCanonicalScaleGroup,
  scaleOnto,
  type CanonicalScaleCell,
} from "@/lib/score-scale"
import {
  buildOverlapRows,
  countMultiSourceRows,
  formatPlainUnitScore,
  type OverlapRow,
  type OverlapSummaryCandidate,
  type OverlapSummaryJoinRow,
} from "@/lib/overlaps"
import { ModelPolicyOverview } from "@/components/model-policy-overview"
import { buildModelPolicySummary } from "@/lib/policy-summaries"
import {
  buildHierarchyEvalIndex,
  type HierarchyEvalLocation,
} from "@/lib/hierarchy-lookup"
import {
  bestPerModel,
  buildBenchmarkEntryIndex,
  canonicalScoreOf,
  collectPeerObservationsFrom,
  competitionRank,
  excludedHoverTitle,
  matchesIdentity,
  normaliseSplitLabel,
  partitionPeers,
  peerCaption,
  CAPTION_SEPARATOR,
  type BenchmarkEntryIndex,
  type PeerCaptionFragments,
  type SplitLabel,
} from "@/lib/split-peers"
import { type CSSProperties, Fragment, useState, useEffect, useMemo } from "react"

interface BenchmarkDetailProps {
  summary: ModelSummaryCore
  benchmarkCards?: Record<string, BenchmarkCard>
  modelCards?: BenchmarkEvaluationCardData[]
  evalHierarchy?: EvalHierarchy | null
  comparisonIndex?: ComparisonIndex | null
  /** When set, render only the named surface — used by the /embed/...
   *  routes so an iframe can carry a single chart instead of the whole page.
   *  Supports:
   *  - "reported-metrics" (Summary §4)
   *  - "histogram" — render a single plotbox tile for the eval named in
   *    `embedTargetEvalId`, mirroring the on-page histogram (current model
   *    highlighted, peer rank, splits/slices, setup notes, cross-family
   *    whisker). */
  embedSurface?: "reported-metrics" | "histogram"
  /** Only used when embedSurface === "histogram". Selects which plotbox to
   *  render by matching this id against the tab.evalSummaryId of every
   *  plotbox unit. The matching view + metric tab become the initial
   *  selection so the embed lands on the same metric the user saw on the
   *  page. */
  embedTargetEvalId?: string
}

interface BenchmarkVariant {
  evaluation: BenchmarkEvaluation
  result: EvaluationResult
  label: string
  variantType: "setup" | "slice" | "setup+slice" | "default"
  metricLabel: string
  setupLabel: string | null
  sliceLabel: string | null
  displayScore: string
  normalizedScore: number
  rankPosition: number | null
  rankTotal: number | null
  rankRatio: number | null
  /** Companion sampling-error metric (e.g. `prompt_strict_stderr` next to
   *  `prompt_strict_acc`). Filtered out of primary listings — the value is
   *  surfaced only inside the deep-dive row's score cell. */
  auxStderr?: number
  auxStderrUnit?: string
}

interface BenchmarkGroup {
  key: string
  title: string
  canonicalTitle: string
  evalDetailHref: string
  category: EvalTag
  description: string
  scoreType: EvaluationResult["metric_config"]["score_type"] | "mixed"
  avgRawScore: number
  avgNormalizedScore: number
  avgDisplayScore: string
  bestRankPosition: number | null
  bestRankTotal: number | null
  bestRankRatio: number | null
  domains: string[]
  benchmarkCard?: BenchmarkCard
  variants: BenchmarkVariant[]
}

interface CompositeGroup {
  compositeKey: string
  compositeName: string
  benchmarks: BenchmarkGroup[]
  avgRawScore: number
  avgNormalizedScore: number
  avgDisplayScore: string
  bestRank: { position: number; total: number } | null
}

const INSTANCE_PREVIEW_LIMIT = 5

// The producer now ships curated display names for every family /
// composite / benchmark via prettify_display + the registry's
// display_overrides.yaml. This component reads the shipped name; the
// DISPLAY_TOKEN_OVERRIDES / DISPLAY_NAME_OVERRIDES below remain as a
// per-token polish layer (mostly for raw model identifier rendering,
// where the producer's metadata doesn't carry a curated display).

const DISPLAY_TOKEN_OVERRIDES: Record<string, string> = {
  ace: "ACE",
  apex: "APEX",
  api: "API",
  ai: "AI",
  ai2: "AI2",
  bbh: "BBH",
  diy: "DIY",
  gpt: "GPT",
  gpqa: "GPQA",
  helm: "HELM",
  hf: "HF",
  ibm: "IBM",
  ifeval: "IFEval",
  la: "LA",
  llm: "LLM",
  math: "MATH",
  md: "MD",
  mmlu: "MMLU",
  musr: "MUSR",
  oecd: "OECD",
  nist: "NIST",
  openai: "OpenAI",
  swe: "SWE",
  tau: "TAU",
  ui: "UI",
  ux: "UX",
  xai: "xAI",
}

const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  apex: "APEX",
  apex_agents: "APEX Agents",
  apex_v1: "APEX v1",
  openai: "OpenAI",
  xai: "xAI",
  nvidia: "NVIDIA",
  ibm: "IBM",
}

const AMBIGUOUS_GROUP_LABELS = new Set(["overall", "score", "accuracy"])

// Treat these as "no real name" when deciding whether to fall back to
// metric_summary_id derivation. Some sources (e.g. ifeval%2Fifeval,
// hfopenllm-v2 raw metrics) ship metric_name="" or a placeholder like
// "score" / "metric" while the meaningful name lives in the local
// segment of the metric_summary_id (`ifeval%3Aprompt_strict_acc`).
const GENERIC_METRIC_LABELS = new Set([
  "",
  "metric",
  "score",
  "accuracy",
  "value",
  "result",
])

// Sampling-error companion metrics travel alongside score metrics in some
// snapshots (`ifeval%3Aprompt_strict_stderr` next to `…_acc`). Surfacing
// them as their own rows / tabs makes IFEval-style benchmarks look like
// they ship 10 indistinguishable splits, so the renderer hides them from
// primary lists and folds the value into the score cell of the matching
// row in the deep dive (see BenchmarkVariant.auxStderr).
const STDERR_SUFFIX_PATTERN = /_(stderr|std_err|standard_error)$/i
const SCORE_SUFFIX_PATTERN = /_(acc|accuracy|score|value|result)$/i

function isStderrMetricId(id: string | null | undefined): boolean {
  if (!id) return false
  const local = id.split("%3A").pop() ?? id
  return STDERR_SUFFIX_PATTERN.test(local)
}

/**
 * Strip the trailing score / stderr suffix so a metric and its companion
 * stderr collapse onto the same key. Both `ifeval%3Aprompt_strict_acc`
 * and `ifeval%3Aprompt_strict_stderr` map to `ifeval%3Aprompt_strict`.
 */
function metricPairKey(id: string | null | undefined): string | null {
  if (!id) return null
  const trimmed = id.replace(STDERR_SUFFIX_PATTERN, "").replace(SCORE_SUFFIX_PATTERN, "")
  return trimmed.length > 0 ? trimmed : id
}

/**
 * Pick the most informative metric label available given the upstream
 * `metric_name` (which may be empty or generic) and `metric_summary_id`
 * (whose local part — e.g. `prompt_strict_acc` from
 * `ifeval%3Aprompt_strict_acc` — is the only carrier of identity for
 * sources that don't populate metric_name).
 */
function deriveMetricTabLabel(
  metricName: string | null | undefined,
  metricSummaryId: string | null | undefined,
): string {
  const trimmed = metricName?.trim() ?? ""
  if (trimmed && !GENERIC_METRIC_LABELS.has(trimmed.toLowerCase())) {
    return trimmed
  }
  const id = metricSummaryId ?? ""
  if (id) {
    const local = id.split("%3A").pop() ?? id
    if (local && !GENERIC_METRIC_LABELS.has(local.toLowerCase())) {
      return normalizeDisplayLabel(local)
    }
  }
  return trimmed || "Score"
}

function normalizeDisplayKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
}

function normalizeDisplayToken(token: string) {
  const prefixMatch = token.match(/^[^a-z0-9]*/i)
  const suffixMatch = token.match(/[^a-z0-9]*$/i)
  const prefix = prefixMatch?.[0] ?? ""
  const suffix = suffixMatch?.[0] ?? ""
  const core = token.slice(prefix.length, token.length - suffix.length)

  if (!core) {
    return token
  }

  const override = DISPLAY_TOKEN_OVERRIDES[normalizeDisplayKey(core)]
  if (override) {
    return `${prefix}${override}${suffix}`
  }

  if (/[A-Z]/.test(core.slice(1))) {
    return `${prefix}${core}${suffix}`
  }

  if (/^\d/.test(core)) {
    return `${prefix}${core}${suffix}`
  }

  return `${prefix}${core.charAt(0).toUpperCase()}${core.slice(1).toLowerCase()}${suffix}`
}

function normalizeDisplayLabel(value: string | null | undefined): string {
  if (!value) {
    return ""
  }

  const normalizedKey = normalizeDisplayKey(value)
  const override = DISPLAY_NAME_OVERRIDES[normalizedKey]
  if (override) {
    return override
  }

  return value
    .split("/")
    .map((segment) => {
      const cleaned = segment.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()
      if (!cleaned) {
        return ""
      }

      const cleanedOverride = DISPLAY_NAME_OVERRIDES[normalizeDisplayKey(cleaned)]
      if (cleanedOverride) {
        return cleanedOverride
      }

      return cleaned.split(" ").map(normalizeDisplayToken).join(" ")
    })
    .filter(Boolean)
    .join(" / ")
}

function formatRawScoreValue(score: number, unit?: string) {
  if (!Number.isFinite(score)) {
    return "N/A"
  }

  const precision = Math.abs(score) >= 100 ? 1 : Math.abs(score) >= 10 ? 2 : 3
  const value = score.toFixed(precision).replace(/0+$/g, "").replace(/\.$/, "")
  const normalizedUnit = normalizeDisplayLabel(unit)

  if (!normalizedUnit || normalizedUnit === "Accuracy" || normalizedUnit === "Pass@1" || normalizedUnit === "Score") {
    return value
  }

  return `${value} ${normalizedUnit}`
}

function getModelDisplayName(value: string | null | undefined) {
  return normalizeDisplayLabel(value) || "Unknown Model"
}

function getOrganizationDisplayName(value: string | null | undefined) {
  return normalizeDisplayLabel(value) || "Unknown Organization"
}

function getSourceTypeDisplayName(value: string | null | undefined) {
  return normalizeDisplayLabel(value?.replace(/_/g, " ")) || "Unknown"
}

function formatEvalLibrary(library: { name: string; version?: string }) {
  const version = library.version?.trim()
  return version && version.toLowerCase() !== "unknown"
    ? `${library.name} ${version}`
    : library.name
}

function normalizeCompositeKey(key: string): string {
  const k = key.toLowerCase().replace(/[-.\s]+/g, "_").replace(/^_+|_+$/g, "")
  if (/^fibble\d*_arena$/.test(k)) return "fibble_arena"
  if (/^arc_agi_v\d+/.test(k)) return "arc_agi"
  return k
}

function doesLabelMatchSuiteKey(label: string | null | undefined, compositeKey: string) {
  if (!label) {
    return false
  }

  return normalizeCompositeKey(normalizeDisplayKey(label)) === normalizeCompositeKey(compositeKey)
}

function getHierarchyLocation(
  group: BenchmarkGroup,
  hierarchyIndex: Map<string, HierarchyEvalLocation> | null,
): HierarchyEvalLocation | undefined {
  if (!hierarchyIndex) {
    return undefined
  }
  for (const variant of group.variants) {
    const evalSummaryId = variant.evaluation.eval_summary_id
    if (evalSummaryId) {
      const location = hierarchyIndex.get(evalSummaryId)
      if (location) {
        return location
      }
    }
  }
  return undefined
}

function getCompositeKey(
  group: BenchmarkGroup,
  hierarchyIndex: Map<string, HierarchyEvalLocation> | null,
): string {
  // Prefer the curated grouping from hierarchy.json. The eval row's own
  // family_id is null for some evals (e.g. CySE2 composites) and points
  // at the leaf for singleton families, so the hierarchy is the only
  // source that captures family→composite groupings authoritatively.
  const location = getHierarchyLocation(group, hierarchyIndex)
  if (location) {
    return normalizeCompositeKey(location.familyKey)
  }

  const evaluation = group.variants[0]?.evaluation
  const backendSuiteKey = evaluation?.family_id

  return normalizeCompositeKey(backendSuiteKey ?? group.key)
}

function getCompositeDisplayName(key: string): string {
  // Display names come from the shipped hierarchy.json. This helper
  // is used in fallback paths where only a raw key is in scope; it
  // applies the same per-token polish (DISPLAY_TOKEN_OVERRIDES) the
  // rest of the renderer uses.
  return normalizeDisplayLabel(key)
}

function getCompositeName(
  group: BenchmarkGroup,
  compositeKey: string,
  hierarchyIndex: Map<string, HierarchyEvalLocation> | null,
): string {
  const location = getHierarchyLocation(group, hierarchyIndex)
  if (location?.familyDisplayName) {
    return location.familyDisplayName
  }

  const evaluation = group.variants[0]?.evaluation
  const benchmarkCardName = group.benchmarkCard?.benchmark_details?.name
  const backendParentName = evaluation?.benchmark_parent_name
  const backendFamilyName = evaluation?.benchmark_family_name

  if (doesLabelMatchSuiteKey(backendParentName, compositeKey)) {
    return normalizeDisplayLabel(backendParentName)
  }

  if (doesLabelMatchSuiteKey(backendFamilyName, compositeKey)) {
    return normalizeDisplayLabel(backendFamilyName)
  }

  if (doesLabelMatchSuiteKey(benchmarkCardName, compositeKey)) {
    return normalizeDisplayLabel(benchmarkCardName)
  }

  return getCompositeDisplayName(compositeKey)
}

function groupByComposite(
  groups: BenchmarkGroup[],
  modelIds: string[],
  peerRanks: PeerRanksMap,
  hierarchyIndex: Map<string, HierarchyEvalLocation> | null
): CompositeGroup[] {
  const composites = new Map<string, BenchmarkGroup[]>()
  for (const group of groups) {
    const key = getCompositeKey(group, hierarchyIndex)
    const existing = composites.get(key) ?? []
    existing.push(group)
    composites.set(key, existing)
  }

  return Array.from(composites.entries()).map(([compositeKey, benchmarks]) => {
    const scores = benchmarks.map(b => b.avgNormalizedScore).filter(Number.isFinite)
    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
    const rawScores = benchmarks.map((benchmark) => benchmark.avgRawScore).filter(Number.isFinite)
    const avgRawScore = rawScores.length > 0 ? rawScores.reduce((a, b) => a + b, 0) / rawScores.length : 0

    // Find best rank across all benchmarks in the composite
    let bestRank: { position: number; total: number } | null = null
    for (const b of benchmarks) {
      const rank = getGroupPeerRank(b, modelIds, peerRanks)
      if (!rank) continue
      if (!bestRank || (rank.position / rank.total) < (bestRank.position / bestRank.total)) {
        bestRank = rank
      }
    }

    return {
      compositeKey,
      compositeName: benchmarks[0] ? getCompositeName(benchmarks[0], compositeKey, hierarchyIndex) : getCompositeDisplayName(compositeKey),
      benchmarks,
      avgRawScore,
      avgNormalizedScore: avgScore,
      avgDisplayScore: formatRawScoreValue(avgRawScore),
      bestRank,
    }
  }).sort((a, b) => {
    // Sort by best peer rank ratio (lower = better); unranked composites go to the bottom
    const aRatio = a.bestRank ? a.bestRank.position / (a.bestRank.total || a.bestRank.position) : Infinity
    const bRatio = b.bestRank ? b.bestRank.position / (b.bestRank.total || b.bestRank.position) : Infinity
    if (aRatio !== bRatio) return aRatio - bRatio
    return b.avgNormalizedScore - a.avgNormalizedScore
  })
}

interface VariantRowData {
  rowKey: string
  variant: BenchmarkVariant
  configMap: Record<string, string>
  configEntries: Array<[string, string]>
  sampleCount: number | null
}

interface DeepDiveVariantRow {
  rowKey: string
  variant: BenchmarkVariant
  evalSummaryId: string
  configMap: Record<string, string>
  configEntries: Array<[string, string]>
}

const GENERIC_RESULT_NAMES = new Set([
  "score",
  "accuracy",
  "mean win rate",
  "exact match",
  "f1",
  "pass@1",
])

function getResultBenchmarkName(
  evaluation: BenchmarkEvaluation,
  result: EvaluationResult
) {
  if (evaluation.display_name) {
    return evaluation.display_name
  }

  if (evaluation.slice_name) {
    return evaluation.slice_name
  }

  if (evaluation.benchmark_leaf_name) {
    return evaluation.benchmark_leaf_name
  }

  if (evaluation.benchmark_parent_name) {
    return evaluation.benchmark_parent_name
  }

  if (evaluation.benchmark) {
    return evaluation.benchmark
  }

  if (result.display_name) {
    return result.display_name
  }

  return result.evaluation_name
}

function getResultDisplayName(
  evaluation: BenchmarkEvaluation,
  result: EvaluationResult
) {
  if (result.canonical_display_name) {
    return result.canonical_display_name
  }

  if (evaluation.canonical_display_name) {
    return evaluation.canonical_display_name
  }

  const benchmarkName = evaluation.benchmark_parent_name || evaluation.benchmark || getResultBenchmarkName(evaluation, result)
  const metricName = result.display_name || result.evaluation_name

  if (GENERIC_RESULT_NAMES.has(metricName.toLowerCase())) {
    return `${benchmarkName} - ${metricName}`
  }

  return metricName
}

function getMetricDisplayLabel(result: EvaluationResult) {
  const candidates = [
    result.display_name,
    result.canonical_display_name,
    result.evaluation_name,
  ]
  let firstNonEmpty = ""
  for (const candidate of candidates) {
    const value = candidate?.trim()
    if (!value) continue
    const segments = value
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean)
    const leaf = segments[segments.length - 1] ?? value
    const normalised = normalizeDisplayLabel(leaf)
    if (!firstNonEmpty) firstNonEmpty = normalised
    if (
      normalised &&
      !GENERIC_METRIC_LABELS.has(normalised.toLowerCase())
    ) {
      return normalised
    }
  }

  // Last-ditch: derive from metric_summary_id local part. Some upstream
  // sources (e.g. ifeval%2Fifeval's 10 prompt/inst/strict/loose metrics)
  // ship empty or generic display fields, so the only meaningful
  // identity is the local segment of the summary id.
  const summaryId = result.metric_summary_id ?? ""
  if (summaryId) {
    const local = summaryId.split("%3A").pop() ?? summaryId
    if (local && !GENERIC_METRIC_LABELS.has(local.toLowerCase())) {
      return normalizeDisplayLabel(local)
    }
  }

  return firstNonEmpty || "Metric"
}

function getVariantDescriptor(
  evaluation: BenchmarkEvaluation,
  result: EvaluationResult
): Pick<BenchmarkVariant, "label" | "variantType" | "metricLabel" | "setupLabel" | "sliceLabel"> {
  const evaluationVariantRaw = getEvaluationVariantLabel(evaluation)
  const evaluationVariant = evaluationVariantRaw ? formatSetupDisplayLabel(evaluationVariantRaw) : null
  const metricLabel = getMetricDisplayLabel(result)
  const metricKey = normalizeDisplayKey(metricLabel)
  const metricIsAmbiguous = AMBIGUOUS_GROUP_LABELS.has(metricKey)
  const sliceLabel = evaluation.slice_name ? normalizeDisplayLabel(evaluation.slice_name) : null
  const setupLabel = evaluationVariant ? formatSetupDisplayLabel(evaluationVariant) : null
  const baseLabel = sliceLabel
    ? (metricIsAmbiguous ? sliceLabel : `${sliceLabel} · ${metricLabel}`)
    : metricLabel

  if (setupLabel && sliceLabel) {
    return {
      label: `${setupLabel} · ${baseLabel}`,
      variantType: "setup+slice",
      metricLabel,
      setupLabel,
      sliceLabel,
    }
  }

  if (setupLabel) {
    return {
      label: metricIsAmbiguous ? `Setup: ${setupLabel}` : `${setupLabel} · ${metricLabel}`,
      variantType: "setup",
      metricLabel,
      setupLabel,
      sliceLabel: null,
    }
  }

  if (sliceLabel || !metricIsAmbiguous) {
    return {
      label: baseLabel,
      variantType: sliceLabel ? "slice" : "default",
      metricLabel,
      setupLabel: null,
      sliceLabel: sliceLabel ?? null,
    }
  }

  return {
    label: metricLabel,
    variantType: "default",
    metricLabel,
    setupLabel: null,
    sliceLabel: null,
  }
}

function formatMetadataValue(value: unknown) {
  if (value == null) {
    return null
  }

  if (typeof value === "string") {
    return value
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value)
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function collectConfigEntries(
  source: Record<string, unknown>,
  prefix = "",
  depth = 0
): Array<[string, string]> {
  const entries: Array<[string, string]> = []

  for (const [key, value] of Object.entries(source)) {
    const nextKey = prefix ? `${prefix}.${key}` : key

    if (isPlainObject(value) && depth < 1) {
      entries.push(...collectConfigEntries(value, nextKey, depth + 1))
      continue
    }

    const formattedValue = formatMetadataValue(value)
    if (formattedValue) {
      entries.push([nextKey, formattedValue])
    }
  }

  return entries
}

function unquoteJsonString(value: string): string {
  // Values like "\"true\"" or "\"2048\"" are JSON-encoded strings — unwrap them
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed === "string") return parsed
    } catch { /* fall through */ }
  }
  return value
}

function getConfigDisplayValue(value: string) {
  let unquoted = unquoteJsonString(value)
  // Config values like setup paths arrive percent-encoded
  // ("mbpp%2Fmbpp-plus"); decode before truncating so users see
  // human-readable text.
  try { unquoted = decodeURIComponent(unquoted) } catch {}
  return unquoted.length > 40 ? `${unquoted.slice(0, 37)}…` : unquoted
}

/** Parse a HELM-style nested detail entry like '{"tab":"Efficiency","score":"106.9"}' */
function parseHelmDetailEntry(value: unknown): { tab?: string; score?: string; description?: string } | null {
  if (typeof value !== "string") return null
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === "object" && ("score" in parsed || "tab" in parsed)) {
      return parsed as { tab?: string; score?: string; description?: string }
    }
  } catch { /* not JSON */ }
  return null
}

function getTableConfigLabel(row: VariantRowData) {
  if (row.variant.setupLabel) {
    return row.variant.setupLabel
  }

  if (row.variant.variantType === "slice") {
    return "Default setup"
  }

  return "Default config"
}

function getComparisonScoreEntryForVariant(
  row: DeepDiveVariantRow,
  comparisonIndex?: ComparisonIndex | null
) {
  if (!comparisonIndex || !row.evalSummaryId) {
    return null
  }

  const metricSummaryId = row.variant.result.metric_summary_id
  if (!metricSummaryId) {
    return null
  }

  const metricEntry = comparisonIndex.evals[row.evalSummaryId]?.metrics.find(
    (metric) => metric.metric_summary_id === metricSummaryId
  )

  if (!metricEntry) {
    return null
  }

  const modelId = row.variant.evaluation.model_info.id
  return (
    metricEntry.scores.find(
      (score) => score.model_route_id === modelId || score.model_group_id === modelId
    ) ?? null
  )
}

function getVariantRunLabels(
  row: DeepDiveVariantRow,
  comparisonIndex?: ComparisonIndex | null
) {
  const comparisonScoreEntry = getComparisonScoreEntryForVariant(row, comparisonIndex)
  const submissions = comparisonScoreEntry?.submissions ?? []
  const targetScore = row.variant.result.score_details.score

  const matchingSubmissions = submissions.filter(
    (submission) => Math.abs(submission.score - targetScore) <= 1e-6
  )
  const candidateSubmissions =
    matchingSubmissions.length > 0
      ? matchingSubmissions
      : submissions.length === 1
        ? submissions
        : []

  const runLabels = Array.from(
    new Set(
      candidateSubmissions
        .map((submission) => normalizeDisplayLabel(submission.run_label))
        .filter(Boolean)
    )
  )

  if (runLabels.length > 0) {
    return runLabels
  }

  const headlineRunLabel = normalizeDisplayLabel(comparisonScoreEntry?.headline_run_label)
  return headlineRunLabel ? [headlineRunLabel] : []
}

function getVariantConfigDisambiguation(
  row: DeepDiveVariantRow,
  similarRows: DeepDiveVariantRow[]
) {
  const differingKeys = Array.from(
    new Set(
      similarRows.flatMap((candidate) =>
        Object.keys(candidate.configMap).filter((key) => key.toLowerCase() !== "setup")
      )
    )
  )
    .filter((key) => {
      const values = new Set(similarRows.map((candidate) => candidate.configMap[key]).filter(Boolean))
      return values.size > 1
    })
    .sort((a, b) => a.localeCompare(b))

  return differingKeys
    .map((key) => [key, row.configMap[key]] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
    .slice(0, 2)
    .map(([key, value]) => `${formatConfigLabel(key)}=${getConfigDisplayValue(value)}`)
}

// Compact date formatter — alias of the shared YYYY-MM-DD formatter so
// every "Updated" / "Released" / per-row date in this component reads
// consistently. Kept as a separate name for the existing call sites.
const formatCompactDate = formatDateISO

function formatParamsBillions(value: unknown) {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN

  if (!Number.isFinite(numericValue)) {
    return null
  }

  if (numericValue >= 100) {
    return `${Math.round(numericValue)}B`
  }

  if (numericValue >= 10) {
    return `${numericValue.toFixed(1)}B`
  }

  return `${numericValue.toFixed(1)}B`
}

function getModelScaleDescription(value: unknown) {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN

  if (!Number.isFinite(numericValue)) {
    return null
  }

  const rounded = numericValue >= 100 ? Math.round(numericValue) : Number.parseFloat(numericValue.toFixed(1))
  const scaleLabel =
    numericValue < 10 ? "Small model" : numericValue < 70 ? "Mid-size model" : "Large model"

  return `${scaleLabel} (${rounded} billion parameters)`
}

function getPolicyBenchmarkNarrative(name: string) {
  const value = name.toLowerCase()

  if (value.includes("ifeval")) {
    return {
      label: "Following instructions",
      description: "Can the model follow detailed formatting and content rules?",
    }
  }

  if (value.includes("bbh")) {
    return {
      label: "Reasoning and logic",
      description: "Multi-step reasoning across diverse tasks.",
    }
  }

  if (value.includes("math")) {
    return {
      label: "Advanced math",
      description: "Hard competition-level mathematics.",
    }
  }

  if (value.includes("gpqa")) {
    return {
      label: "Expert knowledge",
      description: "Graduate-level science questions across biology, physics, and chemistry.",
    }
  }

  if (value.includes("musr")) {
    return {
      label: "Complex narrative reasoning",
      description: "Reasoning over stories and real-world scenarios.",
    }
  }

  if (value.includes("mmlu")) {
    return {
      label: "Broad knowledge",
      description: "Professional and academic knowledge across many subject areas.",
    }
  }

  if (value.includes("tau-bench")) {
    return {
      label: "Agentic task completion",
      description: "Multi-step task execution in realistic workflow settings.",
    }
  }

  if (value.includes("swe-bench")) {
    return {
      label: "Software engineering",
      description: "Issue resolution and code-change performance on real repositories.",
    }
  }

  if (value.includes("rewardbench")) {
    return {
      label: "Preference alignment",
      description: "How well the model matches preference-style judgments.",
    }
  }

  return {
    label: name,
    description: "Reported benchmark evidence for this model.",
  }
}

function getPolicySignalLevel(score: number) {
  if (score >= 0.7) {
    return {
      label: "Good",
      tone: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
    }
  }

  if (score >= 0.4) {
    return {
      label: "Moderate",
      tone: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
    }
  }

  return {
    label: "Low",
    tone: "bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300",
  }
}

function getBenchmarkSpread(group: BenchmarkGroup) {
  if (group.variants.length <= 1) {
    return 0
  }

  return group.variants[0].normalizedScore - group.variants[group.variants.length - 1].normalizedScore
}

function getBenchmarkSourceCount(group: BenchmarkGroup) {
  return new Set(group.variants.map((variant) => getOrganizationDisplayName(variant.evaluation.source_metadata.source_organization_name))).size
}

function getVariantTypeTone(variantType: BenchmarkVariant["variantType"]) {
  switch (variantType) {
    case "setup":
      return "bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300"
    case "slice":
      return "bg-violet-100 text-violet-800 dark:bg-violet-950/50 dark:text-violet-300"
    case "setup+slice":
      return "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
    default:
      return "bg-muted text-muted-foreground"
  }
}

function getVariantTypeLabel(variantType: BenchmarkVariant["variantType"]) {
  switch (variantType) {
    case "setup":
      return "Setup change"
    case "slice":
      return "Benchmark slice"
    case "setup+slice":
      return "Setup + slice"
    default:
      return "Single run"
  }
}

function formatSetupDisplayLabel(setupLabel: string | null) {
  if (!setupLabel) {
    return "Default setup"
  }

  // Setup labels arrive as percent-encoded slug strings (e.g.
  // "mbpp%2Fmbpp-plus") because they're synthesized from the
  // evaluation_id route. Decode before display so users don't see
  // %2F on screen.
  let raw = setupLabel.trim()
  try { raw = decodeURIComponent(raw) } catch {}

  if (!raw || raw.toLowerCase() === "default" || raw.endsWith("__default")) {
    return "Default setup"
  }

  const cleaned = raw
    .replace(/^setup[:=]\s*/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (!cleaned) {
    return "Default setup"
  }

  return normalizeDisplayLabel(cleaned)
}

function getVariantPrimaryLabel(variant: BenchmarkVariant, groupTitle: string) {
  if (variant.sliceLabel) {
    return variant.sliceLabel
  }

  if (variant.metricLabel) {
    const normalizedMetricKey = normalizeDisplayKey(variant.metricLabel)
    if (!AMBIGUOUS_GROUP_LABELS.has(normalizedMetricKey)) {
      return variant.metricLabel
    }
  }

  if (variant.variantType === "default" || variant.variantType === "setup") {
    return groupTitle
  }

  return variant.label
}

function getGroupSliceLabels(group: BenchmarkGroup) {
  return Array.from(
    new Set(
      group.variants
        .map((variant) => variant.sliceLabel?.trim())
        .filter((label): label is string => Boolean(label))
    )
  )
}

function getGroupSliceCount(group: BenchmarkGroup) {
  return getGroupSliceLabels(group).length
}

function getBenchmarkGroupHeading(group: BenchmarkGroup) {
  return group.canonicalTitle
}

function getCompositeBadgeMeta(composite: CompositeGroup) {
  if (composite.benchmarks.length > 1) {
    return {
      count: composite.benchmarks.length,
      label: `sub-benchmark${composite.benchmarks.length === 1 ? "" : "s"}`,
      className:
        "border-sky-200/80 bg-sky-50/70 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-300",
    }
  }

  const singleGroup = composite.benchmarks[0]
  if (!singleGroup) {
    return null
  }

  const compositeMatchesBenchmark = normalizeCompositeKey(composite.compositeName) === normalizeCompositeKey(singleGroup.title)
  if (!compositeMatchesBenchmark) {
    return {
      count: 1,
      label: "sub-benchmark",
      className:
        "border-sky-200/80 bg-sky-50/70 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-300",
    }
  }

  const sliceCount = getGroupSliceCount(singleGroup)
  if (sliceCount > 0) {
    return {
      count: sliceCount,
      label: `slice${sliceCount === 1 ? "" : "s"}`,
      className:
        "border-emerald-200/70 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300",
    }
  }

  return null
}

interface ScoreRange {
  min: number
  max: number
}

const DEFAULT_SCORE_RANGE: ScoreRange = { min: 0, max: 1 }

function getScoreRange(values: number[]): ScoreRange {
  const finiteValues = values.filter((value) => Number.isFinite(value))
  if (finiteValues.length === 0) {
    return DEFAULT_SCORE_RANGE
  }

  return {
    min: Math.min(...finiteValues),
    max: Math.max(...finiteValues),
  }
}

function normalizeWithinRange(value: number, range: ScoreRange): number {
  if (!Number.isFinite(value)) {
    return 0.5
  }

  const span = range.max - range.min
  if (span <= 0) {
    return 0.5
  }

  return Math.max(0, Math.min(1, (value - range.min) / span))
}

function formatNormalizedPercent(value: number) {
  if (!Number.isFinite(value)) {
    return "N/A"
  }

  return `${(value * 100).toFixed(1)}%`
}

function isRangeEdge(value: number, range: ScoreRange, edge: "min" | "max") {
  const span = range.max - range.min
  if (!Number.isFinite(value) || span <= 0) {
    return false
  }

  const target = edge === "max" ? range.max : range.min
  const tolerance = Math.max(1e-4, span * 0.005)
  return Math.abs(value - target) <= tolerance
}

function getRangeLabels<T>(
  items: T[],
  getValue: (item: T) => number,
  getLabel: (item: T) => string
) {
  const finiteItems = items.filter((item) => Number.isFinite(getValue(item)))

  if (finiteItems.length === 0) {
    return { minLabel: "N/A", maxLabel: "N/A" }
  }

  const minItem = [...finiteItems].sort((a, b) => getValue(a) - getValue(b))[0]
  const maxItem = [...finiteItems].sort((a, b) => getValue(b) - getValue(a))[0]

  return {
    minLabel: getLabel(minItem),
    maxLabel: getLabel(maxItem),
  }
}

function ScoreRail({
  meanValue,
  meanLabel,
  range,
  minLabel,
  maxLabel,
}: {
  meanValue: number
  meanLabel: string
  range: ScoreRange
  minLabel: string
  maxLabel: string
}) {
  const meanPercent = normalizeWithinRange(meanValue, range) * 100
  const globalMinTitle = `Min: ${minLabel}`
  const globalMaxTitle = `Max: ${maxLabel}`

  return (
    <div className="relative h-1.5 flex-1 overflow-visible rounded-full bg-muted">
      <div className="h-full rounded-full bg-foreground/25" style={{ width: `${Math.max(meanPercent, 2)}%` }} />

      <span
        className="absolute top-1/2 h-3.5 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-rose-500"
        style={{ left: "0%" }}
        title={globalMinTitle}
        aria-hidden="true"
      />
      <span
        className="absolute top-1/2 h-3.5 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-500"
        style={{ left: "100%" }}
        title={globalMaxTitle}
        aria-hidden="true"
      />

      <span
        className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background bg-foreground shadow-sm"
        style={{ left: `${meanPercent}%` }}
        title={meanLabel}
        aria-hidden="true"
      />
    </div>
  )
}

function parseNumericRank(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/[^0-9.]/g, ""))
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function parseRankFraction(value: unknown) {
  if (typeof value !== "string") {
    return null
  }

  const match = value.match(/(\d+)\s*\/\s*(\d+)/)
  if (!match) {
    return null
  }

  const position = Number.parseInt(match[1], 10)
  const total = Number.parseInt(match[2], 10)
  if (!Number.isFinite(position) || !Number.isFinite(total) || total <= 0) {
    return null
  }

  return { position, total }
}

function findRankFromObject(value: unknown, depth = 0): { position: number; total: number | null } | null {
  if (depth > 4 || value == null) {
    return null
  }

  const fraction = parseRankFraction(value)
  if (fraction) {
    return fraction
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  const lowered = Object.fromEntries(keys.map((key) => [key.toLowerCase(), record[key]]))

  const positionCandidates = ["rank", "position", "place", "standing"]
  const totalCandidates = ["total", "out_of", "num_models", "model_count", "total_models", "population"]

  let position: number | null = null
  let total: number | null = null

  for (const key of positionCandidates) {
    if (key in lowered) {
      position = parseNumericRank(lowered[key])
      if (position != null) {
        break
      }
    }
  }

  for (const key of totalCandidates) {
    if (key in lowered) {
      total = parseNumericRank(lowered[key])
      if (total != null) {
        break
      }
    }
  }

  if (position != null) {
    return { position, total }
  }

  for (const nestedValue of Object.values(record)) {
    const nested = findRankFromObject(nestedValue, depth + 1)
    if (nested) {
      return nested
    }
  }

  return null
}

function getVariantPeerRank(result: EvaluationResult) {
  const fromDetails = findRankFromObject(result.score_details.details)
  if (fromDetails?.position != null) {
    return fromDetails
  }

  const fromSource = findRankFromObject(result.source_data)
  if (fromSource?.position != null) {
    return fromSource
  }

  if (result.evaluation_name.toLowerCase().includes("rank")) {
    const scoreRank = parseNumericRank(result.score_details.score)
    if (scoreRank != null) {
      return { position: scoreRank, total: null }
    }
  }

  return null
}

function buildVariantStructuredSections(variant: BenchmarkVariant) {
  const detailEntries = variant.result.score_details.details
    ? Object.entries(variant.result.score_details.details)
    : []

  const numericBreakdown: Array<[string, unknown]> = []
  const helmMetrics: Array<{ label: string; tab: string; score: string }> = []
  const structuredBreakdown: Array<[string, unknown]> = []

  for (const [key, value] of detailEntries) {
    if (typeof value === "number") {
      numericBreakdown.push([key, value])
      continue
    }
    const parsed = parseHelmDetailEntry(value)
    if (parsed?.score != null && parsed.score !== "") {
      helmMetrics.push({ label: key, tab: parsed.tab ?? "", score: parsed.score })
      continue
    }
    // Skip internal HELM meta-fields that add no user value
    if (key === "description" || key === "tab") continue
    structuredBreakdown.push([key, value])
  }

  return { numericBreakdown, helmMetrics, structuredBreakdown }
}

function formatConfigLabel(key: string) {
  return key
    .split(".")
    .slice(-2)
    .join(" ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function getVariantConfigMap(variant: BenchmarkVariant) {
  const configMap: Record<string, string> = {}
  const setup = getEvaluationVariantLabel(variant.evaluation)

  if (setup) {
    configMap.setup = setup
  }

  // Prefer result-level generation config, fall back to eval-level
  const genConfig = variant.result.generation_config ?? variant.evaluation.generation_config

  if (genConfig?.generation_args) {
    for (const [key, value] of collectConfigEntries(genConfig.generation_args)) {
      configMap[key] = value
    }
  }

  if (genConfig?.additional_details) {
    const ad = genConfig.additional_details
    if (typeof ad === "string") {
      configMap.additional_details = ad
    } else if (typeof ad === "object") {
      for (const [key, value] of collectConfigEntries(ad)) {
        configMap[key] = value
      }
    }
  }

  if (genConfig?.prompt_template) {
    configMap.prompt_template = genConfig.prompt_template
  }

  return configMap
}

function normalizeScoreForDisplay(result: EvaluationResult) {
  const minScore = result.metric_config.min_score ?? 0
  const maxScore = result.metric_config.max_score ?? 1
  const range = maxScore - minScore

  if (range <= 0) {
    return 0
  }

  const rawNormalized = (result.score_details.score - minScore) / range
  const normalized = result.metric_config.lower_is_better ? 1 - rawNormalized : rawNormalized
  return Math.max(0, Math.min(1, normalized))
}

function slugifyEvalSummaryId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
}

function getEvalDetailHref(
  evaluation: BenchmarkEvaluation,
  result: EvaluationResult,
  returnTo?: string
) {
  const baseHref = evaluation.eval_summary_id
    ? `/evals/${routeIdToPath(evaluation.eval_summary_id)}`
    : `/evals/${slugifyEvalSummaryId(`${evaluation.benchmark || getResultBenchmarkName(evaluation, result)}__${result.evaluation_name}`)}`

  if (!returnTo) {
    return baseHref
  }

  const params = new URLSearchParams({ from: returnTo })
  return `${baseHref}?${params.toString()}`
}

function getEvalSummaryIdFromHref(href: string) {
  const [, id = ""] = href.split("/evals/")
  return id.split("?")[0]?.split("#")[0] ?? ""
}

function getGroupPeerRank(
  group: BenchmarkGroup,
  modelIds: string[],
  peerRanks: PeerRanksMap
): { position: number; total: number } | null {
  let best: { position: number; total: number } | null = null

  for (const variant of group.variants) {
    const evalSummaryId =
      variant.evaluation.eval_summary_id ??
      getEvalSummaryIdFromHref(getEvalDetailHref(variant.evaluation, variant.result))
    const evalRanks = peerRanks[evalSummaryId]
    if (!evalRanks) continue

    // Try all known model IDs for this model family
    for (const mid of modelIds) {
      const rank = evalRanks[mid]
      if (rank == null) continue

      if (best == null) {
        best = rank
      } else {
        const rankRatio = rank.total > 0 ? rank.position / rank.total : rank.position
        const bestRatio = best.total > 0 ? best.position / best.total : best.position
        if (rankRatio < bestRatio) {
          best = rank
        }
      }
    }
  }

  return best ?? (group.bestRankPosition != null ? { position: group.bestRankPosition, total: group.bestRankTotal ?? 0 } : null)
}

// peer-ranks.json now ships as a sidecar inside the pinned `SNAPSHOT_URL`
// snapshot (Stage J emits it alongside hierarchy.json / comparison-index.json).
// Routing through the
// same `/api/peer-ranks` endpoint as the other sidecars keeps peer ranks
// pinned to the snapshot the rest of the page is reading from, instead of
// drifting to the unversioned `main`-branch copy at the dataset root.
let peerRanksPromise: Promise<PeerRanksMap> | null = null

function loadPeerRanks(): Promise<PeerRanksMap> {
  if (!peerRanksPromise) {
    peerRanksPromise = fetchPeerRanks().catch(() => ({} as PeerRanksMap))
  }
  return peerRanksPromise
}

async function fetchPeerRankForModel(evalSummaryId: string, modelId: string) {
  const ranks = await loadPeerRanks()
  return ranks[evalSummaryId]?.[modelId] ?? null
}

function formatResultDisplayScore(result: EvaluationResult) {
  return formatRawScoreValue(result.score_details.score, result.metric_config.unit)
}

function toComparableTimestamp(timestamp: string) {
  const numericTimestamp = Number.parseFloat(timestamp)
  if (Number.isFinite(numericTimestamp)) {
    return numericTimestamp
  }

  const parsedTimestamp = new Date(timestamp).getTime()
  return Number.isFinite(parsedTimestamp) ? parsedTimestamp : Number.NEGATIVE_INFINITY
}

function getVariantDedupKey(variant: BenchmarkVariant) {
  const configEntries = Object.entries(getVariantConfigMap(variant)).sort(([a], [b]) => a.localeCompare(b))
  const sourceDataName =
    !Array.isArray(variant.result.source_data) && variant.result.source_data?.dataset_name
      ? variant.result.source_data.dataset_name
      : !Array.isArray(variant.evaluation.source_data) && variant.evaluation.source_data?.dataset_name
        ? variant.evaluation.source_data.dataset_name
        : ""

  return JSON.stringify({
    label: variant.label,
    metricSummaryId: variant.result.metric_summary_id,
    metricKey: variant.result.metric_key,
    metricLabel: variant.metricLabel,
    variantType: variant.variantType,
    setupLabel: variant.setupLabel,
    sliceLabel: variant.sliceLabel,
    displayScore: variant.displayScore,
    sourceOrganization: getOrganizationDisplayName(variant.evaluation.source_metadata.source_organization_name),
    sourceName: normalizeDisplayLabel(variant.evaluation.source_metadata.source_name ?? ""),
    sourceType: variant.evaluation.source_metadata.source_type,
    sourceDataName,
    configEntries,
  })
}

function buildBenchmarkGroups(
  entries: Array<{ evaluation: BenchmarkEvaluation; result: EvaluationResult; category: EvalTag }>,
  benchmarkCards: Record<string, BenchmarkCard> | undefined,
  returnTo?: string
): BenchmarkGroup[] {
  const groups = new Map<string, BenchmarkGroup>()

  // Pre-pass: bucket stderr companion values keyed by (groupKey, pairKey)
  // so the second pass can attach each stderr's value to the matching
  // score variant via `auxStderr`. Stderr entries themselves are dropped
  // from the variant list to avoid showing them as standalone rows.
  const stderrByPair = new Map<string, { score: number; unit?: string }>()
  for (const entry of entries) {
    const summaryId = entry.result.metric_summary_id ?? ""
    if (!isStderrMetricId(summaryId)) continue
    const groupKey =
      entry.evaluation.eval_summary_id ??
      entry.evaluation.parent_benchmark_id ??
      entry.evaluation.family_id ??
      "benchmark"
    const pairKey = metricPairKey(summaryId)
    if (!pairKey) continue
    const score = entry.result.score_details.score
    if (!Number.isFinite(score)) continue
    stderrByPair.set(`${groupKey}::${pairKey}`, {
      score,
      unit: entry.result.metric_config.unit,
    })
  }

  for (const entry of entries) {
    if (isStderrMetricId(entry.result.metric_summary_id)) continue
    const rawBenchmarkName = entry.evaluation.benchmark || entry.evaluation.benchmark_parent_name || getResultBenchmarkName(entry.evaluation, entry.result)
    // Slice evals (e.g. AIR-Bench's ~30 per-category cells, all
    // `is_slice=true` with `parent_benchmark_id="air-bench-2024"`)
    // collapse into ONE BenchmarkGroup keyed on the parent's
    // eval_summary_id (`<source>%2Fair-bench-2024`). The slices then
    // populate the plotbox view dropdown instead of fanning out into
    // ~30 look-alike plotboxes. Title prefers the parent name so the
    // grouped card reads "AIR-Bench 2024" rather than "Confidentiality".
    const isFoldableSlice = Boolean(
      entry.evaluation.is_slice && entry.evaluation.parent_benchmark_id,
    )
    const sliceParentEvalSummaryId = (() => {
      if (!isFoldableSlice) return null
      const evalId = entry.evaluation.eval_summary_id ?? ""
      const sourcePrefix = evalId.includes("%2F") ? evalId.split("%2F")[0] : null
      if (!sourcePrefix) return null
      return `${sourcePrefix}%2F${entry.evaluation.parent_benchmark_id}`
    })()
    // benchmark_parent_name carries the producer's real parent display name
    // when the snapshot ships parent_benchmark_display_name; on older
    // snapshots it falls back to the composite display name, which for
    // cross-benchmark suites (llm-stats) is the SUITE label, not the parent
    // benchmark — so still prefer the family display name when the family
    // root is the parent itself (air-bench, tau2-bench, mmmu hit this path).
    const sliceParentDisplayName =
      isFoldableSlice &&
      entry.evaluation.family_id === entry.evaluation.parent_benchmark_id
        ? entry.evaluation.benchmark_family_name
        : undefined
    const title = isFoldableSlice
      ? (sliceParentDisplayName ||
          entry.evaluation.benchmark_parent_name ||
          entry.evaluation.parent_benchmark_id ||
          entry.evaluation.display_name ||
          entry.evaluation.benchmark ||
          getResultBenchmarkName(entry.evaluation, entry.result))
      : (entry.evaluation.display_name || entry.evaluation.slice_name || entry.evaluation.benchmark_leaf_name || entry.evaluation.benchmark_parent_name || entry.evaluation.benchmark || getResultBenchmarkName(entry.evaluation, entry.result))
    const canonicalTitle = isFoldableSlice
      ? title
      : (entry.evaluation.canonical_display_name ||
          (entry.evaluation.slice_name && (entry.evaluation.benchmark_parent_name || entry.evaluation.benchmark)
            ? `${entry.evaluation.benchmark_parent_name || entry.evaluation.benchmark} / ${entry.evaluation.slice_name}`
            : title))
    // eval_summary_id is producer-shipped on every v3 entry; the
    // remaining ?? tiers are for legacy snapshots without that field.
    const groupKey =
      sliceParentEvalSummaryId ??
      entry.evaluation.eval_summary_id ??
      entry.evaluation.parent_benchmark_id ??
      entry.evaluation.family_id ??
      "benchmark"
    const card = benchmarkCards
      ? lookupBenchmarkCard(benchmarkCards, rawBenchmarkName)
      : undefined
    const normalizedScore = normalizeScoreForDisplay(entry.result)
    const displayScore = formatResultDisplayScore(entry.result)
    const rawScore = entry.result.score_details.score
    const rankInfo = getVariantPeerRank(entry.result)
    const rankPosition = rankInfo?.position ?? null
    const rankTotal = rankInfo?.total ?? null
    const rankRatio =
      rankPosition != null && rankTotal != null && rankTotal > 0
        ? rankPosition / rankTotal
        : rankPosition != null
          ? rankPosition
          : null
    const descriptor = getVariantDescriptor(entry.evaluation, entry.result)
    const pairKey = metricPairKey(entry.result.metric_summary_id ?? "")
    const auxStderrEntry = pairKey ? stderrByPair.get(`${groupKey}::${pairKey}`) : undefined
    const variant: BenchmarkVariant = {
      evaluation: entry.evaluation,
      result: entry.result,
      label: descriptor.label,
      variantType: descriptor.variantType,
      metricLabel: descriptor.metricLabel,
      setupLabel: descriptor.setupLabel,
      sliceLabel: descriptor.sliceLabel,
      displayScore,
      normalizedScore,
      rankPosition,
      rankTotal,
      rankRatio,
      ...(auxStderrEntry
        ? { auxStderr: auxStderrEntry.score, auxStderrUnit: auxStderrEntry.unit }
        : {}),
    }

    const existing = groups.get(groupKey)

    if (!existing) {
      groups.set(groupKey, {
        key: groupKey,
        title,
        canonicalTitle,
        evalDetailHref: getEvalDetailHref(entry.evaluation, entry.result, returnTo),
        category: entry.category,
        description: entry.result.metric_config.evaluation_description ?? "",
        scoreType: entry.result.metric_config.score_type ?? "continuous",
        avgRawScore: rawScore,
        avgNormalizedScore: normalizedScore,
        avgDisplayScore: formatRawScoreValue(rawScore, entry.result.metric_config.unit),
        bestRankPosition: rankPosition,
        bestRankTotal: rankTotal,
        bestRankRatio: rankRatio,
        domains: card?.benchmark_details?.domains ?? [],
        benchmarkCard: card,
        variants: [variant],
      })
      continue
    }

    existing.variants.push(variant)
    const newDesc = entry.result.metric_config.evaluation_description ?? ""
    if ((existing.description ?? "").length < newDesc.length) {
      existing.description = newDesc
    }
    if (existing.scoreType !== entry.result.metric_config.score_type) {
      existing.scoreType = "mixed"
    }
  }

  return Array.from(groups.values())
    .map((group) => {
      const dedupedVariants = new Map<string, BenchmarkVariant>()

      // --- BEGIN PATCH: Auto-detect and renormalize mixed scales ---
      // Group by metric_summary_id (or metric_key) for scale detection
      const metricGroups = new Map<string, BenchmarkVariant[]>()
      for (const variant of group.variants) {
        const key = variant.result.metric_summary_id || variant.result.metric_key || "default"
        if (!metricGroups.has(key)) metricGroups.set(key, [])
        metricGroups.get(key)!.push(variant)
      }

      let scaleWarning = false
      for (const [metricKey, variants] of metricGroups.entries()) {
        // Collect all min/max for this metric
        const mins = variants.map(v => v.result.metric_config.min_score ?? null).filter(x => x !== null)
        const maxs = variants.map(v => v.result.metric_config.max_score ?? null).filter(x => x !== null)
        // If any variant is missing min/max, skip normalization for this group
        if (mins.length !== variants.length || maxs.length !== variants.length) continue
        const uniqueMins = Array.from(new Set(mins))
        const uniqueMaxs = Array.from(new Set(maxs))
        // If there are multiple scales, renormalize all to the most common (or largest span)
        if (uniqueMins.length > 1 || uniqueMaxs.length > 1) {
          scaleWarning = true
          // Pick the most common (min, max) pair, or the one with the largest range
          const rangeCounts = new Map<string, number>()
          for (const v of variants) {
            const k = `${v.result.metric_config.min_score}|${v.result.metric_config.max_score}`
            rangeCounts.set(k, (rangeCounts.get(k) || 0) + 1)
          }
          let canonical = Array.from(rangeCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0]
          if (!canonical) canonical = `${Math.min(...mins)}|${Math.max(...maxs)}`
          const [canonicalMin, canonicalMax] = canonical.split("|").map(Number)
          for (const v of variants) {
            const min = v.result.metric_config.min_score ?? 0
            const max = v.result.metric_config.max_score ?? 1
            // Only renormalize if different from canonical
            if (min !== canonicalMin || max !== canonicalMax) {
              // Renormalize score to canonical scale
              const oldScore = v.result.score_details.score
              const normalized = (oldScore - min) / (max - min)
              v.result.score_details.score = normalized * (canonicalMax - canonicalMin) + canonicalMin
              v.result.metric_config.min_score = canonicalMin
              v.result.metric_config.max_score = canonicalMax
            }
          }
        }
      }

      for (const variant of group.variants) {
        const variantKey = getVariantDedupKey(variant)
        const existingVariant = dedupedVariants.get(variantKey)

        if (!existingVariant) {
          dedupedVariants.set(variantKey, variant)
          continue
        }

        if (
          toComparableTimestamp(variant.evaluation.retrieved_timestamp) >=
          toComparableTimestamp(existingVariant.evaluation.retrieved_timestamp)
        ) {
          dedupedVariants.set(variantKey, variant)
        }
      }

      group.variants = Array.from(dedupedVariants.values())
      group.variants.sort((a, b) => {
        const aIsSlice = Boolean(a.evaluation.slice_key)
        const bIsSlice = Boolean(b.evaluation.slice_key)
        if (aIsSlice !== bIsSlice) {
          return aIsSlice ? 1 : -1
        }

        const aPrimaryLabel = getVariantPrimaryLabel(a, group.title)
        const bPrimaryLabel = getVariantPrimaryLabel(b, group.title)
        if (aPrimaryLabel !== bPrimaryLabel) {
          return aPrimaryLabel.localeCompare(bPrimaryLabel)
        }

        return b.normalizedScore - a.normalizedScore
      })
      group.avgRawScore =
        group.variants.reduce((sum, variant) => sum + variant.result.score_details.score, 0) / group.variants.length
      group.avgNormalizedScore =
        group.variants.reduce((sum, variant) => sum + variant.normalizedScore, 0) / group.variants.length
      group.avgDisplayScore = formatRawScoreValue(group.avgRawScore)

      const rankedVariants = group.variants
        .filter((variant) => variant.rankRatio != null)
        .sort((a, b) => (a.rankRatio ?? Number.POSITIVE_INFINITY) - (b.rankRatio ?? Number.POSITIVE_INFINITY))

      group.bestRankPosition = rankedVariants[0]?.rankPosition ?? null
      group.bestRankTotal = rankedVariants[0]?.rankTotal ?? null
      group.bestRankRatio = rankedVariants[0]?.rankRatio ?? null
      // Attach a warning if scales were mixed
      if (scaleWarning) {
        // Patch: extend group with a warning property for UI
        (group as any).__scaleWarning = true
      }
      return group
    })
    .sort((a, b) => b.avgNormalizedScore - a.avgNormalizedScore)
}

function getEvaluationVariantLabel(evaluation: BenchmarkEvaluation) {
  const evaluationIdWithoutTimestamp = evaluation.evaluation_id.replace(/\/[^/]+$/, "")
  const modelSlug = evaluation.model_info.id.replace(/\//g, "_")

  let evaluationPrefix = evaluationIdWithoutTimestamp

  if (evaluationPrefix.endsWith(`__${modelSlug}`)) {
    evaluationPrefix = evaluationPrefix.slice(0, -(`__${modelSlug}`.length))
  } else if (evaluationPrefix.endsWith(`/${modelSlug}`)) {
    evaluationPrefix = evaluationPrefix.slice(0, -(`/${modelSlug}`.length))
  }

  const benchmarkName = evaluation.benchmark

  if (benchmarkName && evaluationPrefix.startsWith(`${benchmarkName}/`)) {
    const variant = evaluationPrefix.slice(benchmarkName.length + 1)
    return variant.split("/").filter(Boolean).pop() || null
  }

  if (benchmarkName && evaluationPrefix === benchmarkName) {
    return null
  }

  return evaluationPrefix.split("/").filter(Boolean).pop() || null
}

type HistogramBar = {
  modelId: string
  modelName: string
  score: number
  isCurrent: boolean
  isDefault: boolean
  submissionCount: number
  submissionAxis: SubmissionAxis
  headlineRunLabel?: string
  submissions?: ComparisonScoreEntry["submissions"]
  variantKey?: string
}

export type BenchmarkHistogram = {
  histKey: string
  evalSummaryId: string
  metricSummaryId: string
  metricName: string
  metricGroup: ComparisonMetricEntry["group"]
  lowerIsBetter: boolean
  unit: string | null
  bars: HistogramBar[]
  availableModels: Array<{
    id: string
    name: string
    score: number
    submissionCount: number
    submissionAxis: SubmissionAxis
  }>
  defaultIds: Set<string>
  currentModelRank: { position: number; total: number } | null
  /** Producer-resolved display scale: non-null when every score
   *  cell for this metric carried usable canonical-scale fields. Bars are
   *  then on this exact scale (true ⇒ 0-100) and the legacy `>1.5 ⇒
   *  percent` guesses are skipped; null keeps them byte-identical. */
  resolvedIsPercent: boolean | null
  /** Split-aware peer caption, kept as fragments so the render can put the
   *  reported-label caveat hover on the excluded clauses only. Only set on the cross-source path
   *  (`comparison_index_version >= 2`); absent keeps the source-only output. */
  caption?: PeerCaptionFragments
  /** Distinct models dropped per reported split label, same path. */
  excludedByLabel?: Record<string, number>
  /** The current model's own reported split, for the excluded-fragment hover. */
  currentSplitLabel?: SplitLabel | null
  /** The current model's rank on its own source page, kept as secondary text
   *  when that page holds more than one model. */
  sourceRank?: { position: number; total: number; sourceDisplayName: string }
}

const histKeyFor = (evalSummaryId: string, metricSummaryId: string) =>
  `${evalSummaryId}::${metricSummaryId}`

type SplitPeerResolution = {
  peerRows: ComparisonScoreEntry[]
  rank: { position: number; total: number }
  caption: PeerCaptionFragments
  currentLabel: SplitLabel | null
  excludedByLabel: Record<string, number>
  sourceRank?: { position: number; total: number; sourceDisplayName: string }
}

/** The split-aware caption line. Only the excluded clauses carry the
 *  reported-label caveat hover. */
export function PeerCaption({
  caption,
  currentLabel,
}: {
  caption: PeerCaptionFragments
  currentLabel: SplitLabel | null
}) {
  return (
    <>
      <span>{caption.base}</span>
      {caption.unknown && (
        <>
          {CAPTION_SEPARATOR}
          <span>{caption.unknown}</span>
        </>
      )}
      {caption.excluded.map((fragment) => (
        <Fragment key={fragment.label}>
          {CAPTION_SEPARATOR}
          <span title={excludedHoverTitle(currentLabel)}>{fragment.text}</span>
        </Fragment>
      ))}
    </>
  )
}

// Split-aware cross-source peer pool. Returns null whenever the
// source-only histogram must stand: no capability gate, no current row, no
// canonical benchmark/metric identity, or no other source with a bucket on
// the same effective metric and direction.
function resolveSplitPeers({
  benchmarkEntryIndex,
  evalId,
  evalEntry,
  metric,
  currentRow,
  currentModelIdentityKeys,
  lowerIsBetter,
}: {
  benchmarkEntryIndex: BenchmarkEntryIndex | null
  evalId: string
  evalEntry: ComparisonEvalEntry
  metric: ComparisonMetricEntry
  currentRow: ComparisonScoreEntry | undefined
  currentModelIdentityKeys: Set<string>
  lowerIsBetter: boolean
}): SplitPeerResolution | null {
  if (benchmarkEntryIndex == null) return null
  if (currentRow == null) return null
  const benchmarkId = evalEntry.benchmark_id
  const metricId = metric.metric_id
  if (!benchmarkId || !metricId) return null
  const currentScore = canonicalScoreOf(currentRow)
  if (currentScore == null) return null

  const observations = collectPeerObservationsFrom(
    benchmarkEntryIndex,
    benchmarkId,
    metricId,
    lowerIsBetter,
    currentModelIdentityKeys,
  )
  if (observations.every((o) => o.sourceEvalId === evalId)) return null

  const currentLabel = normaliseSplitLabel(currentRow.split)
  const partition = partitionPeers(currentLabel, observations)
  const eligible = bestPerModel(
    [...partition.compared, ...partition.unknown],
    lowerIsBetter,
  )
  const rank = competitionRank(currentScore, eligible, lowerIsBetter)

  const sourceSlug = evalEntry.composite_slug ?? evalEntry.family_id ?? evalId
  const sourceDisplayName =
    evalEntry.composite_display_name ??
    evalEntry.family_display_name ??
    evalEntry.display_name ??
    sourceSlug
  const caption = peerCaption({
    ...rank,
    sourceCount: new Set([sourceSlug, ...eligible.map((o) => o.sourceSlug)]).size,
    currentLabel,
    unknownCount: eligible.filter((o) => o.label == null).length,
    anyPeerLabelled: observations.some((o) => o.rawLabel != null),
    excludedByLabel: partition.excludedByLabel,
  })

  return {
    peerRows: eligible.map((o) => o.entry),
    rank,
    caption,
    currentLabel,
    excludedByLabel: partition.excludedByLabel,
    sourceRank:
      currentRow.total > 1
        ? { position: currentRow.rank, total: currentRow.total, sourceDisplayName }
        : undefined,
  }
}

// Per-(eval, metric) leaderboards sourced from comparison-index.json.
export function buildBenchmarkHistograms({
  comparisonIndex,
  wantedEvalIds,
  currentModelIdentityKeys,
  currentModelRouteId,
  currentModelName,
  extraModelsByBenchmark,
}: {
  comparisonIndex: ComparisonIndex | null | undefined
  wantedEvalIds: Set<string>
  currentModelIdentityKeys: Set<string>
  currentModelRouteId: string
  currentModelName: string
  extraModelsByBenchmark: Record<string, string[]>
}): Map<string, BenchmarkHistogram> {
  const result = new Map<string, BenchmarkHistogram>()
  if (!comparisonIndex) return result

  const byModelForCurrent =
    comparisonIndex.by_model?.[currentModelRouteId] ?? {}

  // One pass over the index per build; the gate decides whether it is needed
  // at all, so old snapshots pay nothing.
  const benchmarkEntryIndex =
    (comparisonIndex.comparison_index_version ?? 0) >= 2
      ? buildBenchmarkEntryIndex(comparisonIndex)
      : null

  for (const evalId of wantedEvalIds) {
    const evalEntry = comparisonIndex.evals[evalId]
    if (!evalEntry) continue

    for (const metric of evalEntry.metrics) {
      if (isStderrMetricId(metric.metric_summary_id)) continue
      const histKey = histKeyFor(evalId, metric.metric_summary_id)
      const lowerIsBetter = Boolean(metric.lower_is_better)

      // The current model's own row (if present) lives both in scores[] and
      // in by_model. We look it up by any of the known identity keys and
      // pull out its score/rank/submission info.
      let currentRow: ComparisonScoreEntry | undefined
      for (const s of metric.scores) {
        if (matchesIdentity(s, currentModelIdentityKeys)) {
          currentRow = s
          break
        }
      }
      const byModelRow =
        byModelForCurrent[evalId]?.[metric.metric_summary_id]

      const currentScore = currentRow?.score ?? byModelRow?.score
      if (currentScore == null || !Number.isFinite(currentScore)) {
        // We don't have a score on this (eval, metric) — skip the histogram.
        // The tab will just not render.
        continue
      }
      const splitPeers = resolveSplitPeers({
        benchmarkEntryIndex,
        evalId,
        evalEntry,
        metric,
        currentRow,
        currentModelIdentityKeys,
        lowerIsBetter,
      })

      const currentModelRank =
        splitPeers != null
          ? splitPeers.rank
          : currentRow != null
            ? { position: currentRow.rank, total: currentRow.total }
            : byModelRow != null
              ? { position: byModelRow.rank, total: byModelRow.total }
              : null

      // Peer rows = everything in scores[] that isn't us. Backend already
      // sorts best-first in the metric's own direction; we preserve that.
      // On the split-aware path the pool is instead one eligible observation
      // per model across every source on the same metric and direction.
      const peerRows =
        splitPeers?.peerRows ??
        metric.scores.filter((s) => !matchesIdentity(s, currentModelIdentityKeys))

      // Producer-canonical path: when the current model's cell
      // and every peer row carry usable canonical-scale fields, plot the
      // canonical values — all bars land on one exact scale and the
      // legacy `>1.5 ⇒ percent` guesses downstream are skipped. Any
      // old-snapshot cell or bounds-less metric in the group keeps the
      // raw scores byte-identical to legacy. The display scale mirrors
      // the legacy majority-vote convention (percent wins ties), so
      // wherever the old guess was right the plotted numbers are
      // unchanged; flagged rows (score_canonical null) fall back to the
      // per-row guess inside toDisplay and stay plotted, like legacy.
      const scaleCellOf = (cell: {
        score: number
        score_canonical?: number | null
        scale_conversion?: ScaleConversion | null
      }): CanonicalScaleCell => ({
        score: cell.score,
        scoreCanonical: cell.score_canonical,
        scaleConversion: cell.scale_conversion,
        unit: metric.unit ?? null,
      })
      const currentCell = currentRow ?? byModelRow
      const scaleGroup = resolveCanonicalScaleGroup(
        [...(currentCell ? [currentCell] : []), ...peerRows].map(scaleCellOf),
        // Metric-level registry bounds (the scale score_canonical sits
        // on): resolve anchor-neutral (all-curated) groups exactly.
        { min: metric.canonical_min_score, max: metric.canonical_max_score },
      )
      const resolvedIsPercent = scaleGroup
        ? scaleGroup.percentSourceCount >= scaleGroup.fractionSourceCount
        : null
      const displayScoreOf = (cell: {
        score: number
        score_canonical?: number | null
        scale_conversion?: ScaleConversion | null
      }): number =>
        scaleGroup && resolvedIsPercent != null
          ? scaleGroup.toDisplay(scaleCellOf(cell), resolvedIsPercent)
          : cell.score
      const currentDisplayScore = currentCell
        ? displayScoreOf(currentCell)
        : currentScore

      const defaults = new Set<string>()
      if (peerRows.length > 0) {
        // Best and worst come straight off the pre-sorted list.
        defaults.add(peerRows[0].model_route_id)
        defaults.add(peerRows[peerRows.length - 1].model_route_id)
        // Two peers closest to the current score.
        const closest = [...peerRows]
          .sort(
            (a, b) =>
              Math.abs(displayScoreOf(a) - currentDisplayScore) -
              Math.abs(displayScoreOf(b) - currentDisplayScore)
          )
          .filter((p) => !defaults.has(p.model_route_id))
          .slice(0, 2)
        for (const p of closest) defaults.add(p.model_route_id)
      }

      const extras = extraModelsByBenchmark[histKey] ?? []
      const selectedIds = new Set<string>([...defaults, ...extras])

      const peerBars: HistogramBar[] = peerRows
        .filter((p) => selectedIds.has(p.model_route_id))
        .map((p) => ({
          modelId: p.model_route_id,
          // Most comparison score rows carry an empty model_family_name, so
          // fall back to model_family_id (always present, and already
          // human-readable in this codebase, e.g. "anthropic/sonnet-4.5").
          // Without this the peer bars all read "Unknown Model".
          modelName: getModelDisplayName(p.model_family_name || p.model_family_id),
          score: displayScoreOf(p),
          isCurrent: false,
          isDefault: defaults.has(p.model_route_id),
          submissionCount: p.submission_count,
          submissionAxis: p.submission_axis,
          headlineRunLabel: p.headline_run_label,
          submissions: p.submissions,
          variantKey: p.variant_key,
        }))

      const currentBar: HistogramBar = {
        modelId: currentModelRouteId,
        modelName: currentModelName,
        score: currentDisplayScore,
        isCurrent: true,
        isDefault: true,
        submissionCount: currentRow?.submission_count ?? byModelRow?.submission_count ?? 1,
        submissionAxis:
          currentRow?.submission_axis ?? byModelRow?.submission_axis ?? "default",
        headlineRunLabel: currentRow?.headline_run_label,
        submissions: currentRow?.submissions,
        variantKey: currentRow?.variant_key,
      }

      const bars = [currentBar, ...peerBars].sort((a, b) =>
        lowerIsBetter ? a.score - b.score : b.score - a.score
      )

      const availableModels = peerRows
        .filter((p) => !selectedIds.has(p.model_route_id))
        .map((p) => ({
          id: p.model_route_id,
          // Same fallback as the rendered bar (peerBars above): score rows
          // usually have an empty model_family_name, so fall back to
          // model_family_id (always present, human-readable). Without this the
          // dropdown label resolves to "Unknown Model".
          name: p.model_family_name || p.model_family_id,
          score: displayScoreOf(p),
          submissionCount: p.submission_count,
          submissionAxis: p.submission_axis,
        }))

      result.set(histKey, {
        histKey,
        evalSummaryId: evalId,
        metricSummaryId: metric.metric_summary_id,
        metricName: metric.metric_name,
        metricGroup: metric.group,
        lowerIsBetter,
        unit: metric.unit,
        bars,
        availableModels,
        defaultIds: defaults,
        currentModelRank,
        resolvedIsPercent,
        ...(splitPeers != null
          ? {
              caption: splitPeers.caption,
              excludedByLabel: splitPeers.excludedByLabel,
              sourceRank: splitPeers.sourceRank,
              currentSplitLabel: splitPeers.currentLabel,
            }
          : {}),
      })
    }
  }

  return result
}

export function BenchmarkDetail({
  summary,
  benchmarkCards,
  modelCards,
  evalHierarchy,
  comparisonIndex,
  embedSurface,
  embedTargetEvalId,
}: BenchmarkDetailProps) {
  const { mode } = useAudienceMode()
  const isResearchView = mode === "research"
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [benchmarkSearch, setBenchmarkSearch] = useState("")
  // Sort dropdown was removed — ordering is driven by the source/category
  // grouping itself, not a user-selected sort.
  const [selectedCategories, setSelectedCategories] = useState<EvalTag[]>([])
  const [selectedFamilies, setSelectedFamilies] = useState<string[]>([])
  const [expandedSuites, setExpandedSuites] = useState<Set<string>>(new Set())
  const [activeBenchmarkGroupKey, setActiveBenchmarkGroupKey] = useState<string | null>(null)
  const [benchmarkViewMode, setBenchmarkViewMode] = useState<"grid" | "list">("grid")
  // Tri-state view selector. "source" = the warehouse's natural shape:
  // family-rooted plotboxes / family-grouped accordions, no cross-family
  // collapse. "category" = same composite/standalone units, but the top-
  // level grouping switches to the curated category tag (data/benchmarks/
  // categories.json) so similarly-tagged benchmarks cluster across
  // families. "overlaps" = cross-family duplicates only, rendered as a
  // table (no plotbox/list toggle) with mean and 95% CI for the model's
  // score across each canonical's appearances.
  // `null` until the user explicitly picks a view; the effective default is
  // derived from the data (overlaps when this model has any cross-suite
  // overlaps, else source) — see `groupingMode` just after `overlapsRows`.
  const [pickedGroupingMode, setGroupingMode] = useState<"source" | "category" | "overlaps" | null>(null)
  const [overlapsFilter, setOverlapsFilter] = useState<"all" | "multi">("all")
  const [expandedOverlapRows, setExpandedOverlapRows] = useState<Set<string>>(new Set())
  const toggleOverlapRow = (key: string) =>
    setExpandedOverlapRows((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const [expandedFamilies, setExpandedFamilies] = useState<Set<string>>(new Set())
  const toggleFamily = (key: string) =>
    setExpandedFamilies((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const currentDetailHref = useMemo(() => {
    const query = searchParams.toString()
    return query ? `${pathname}?${query}` : pathname
  }, [pathname, searchParams])
  const modelId = summary.model_info.id
  // Collect all known model IDs for peer rank lookup (family ID + raw variant IDs)
  const modelIds = useMemo(() => {
    const ids = new Set<string>([modelId])
    if ('raw_model_ids' in summary) {
      for (const id of (summary as any).raw_model_ids ?? []) {
        ids.add(id)
      }
    }
    // Also add IDs from individual evaluations, including pipeline-computed family_id
    for (const evals of Object.values(summary.evaluations_by_tag)) {
      for (const e of evals) {
        if (e.model_info?.id) ids.add(e.model_info.id)
        const familyId = (e.model_info as any)?.family_id
        if (familyId) ids.add(familyId)
      }
    }
    return Array.from(ids)
  }, [modelId, summary])

  const [peerRanks, setPeerRanks] = useState<PeerRanksMap>({})

  // Load peer-ranks.json once and store in state so the table can use them
  useEffect(() => {
    loadPeerRanks().then(setPeerRanks)
  }, [])

  // Build an eval_summary_id → family/composite lookup from hierarchy.json.
  // Some constituent_evaluation_ids appear in multiple families (e.g. mmlu-pro under
  // both `mmlu` and `artificial-analysis`); use the eval row's own family_id
  // as the disambiguating preference when present.
  const hierarchyIndex = useMemo(() => {
    if (!evalHierarchy) {
      return null
    }
    const familyIdByEvalSummaryId = new Map<string, string>()
    for (const evals of Object.values(summary.evaluations_by_tag)) {
      for (const evaluation of evals) {
        if (evaluation.eval_summary_id && evaluation.family_id) {
          familyIdByEvalSummaryId.set(evaluation.eval_summary_id, evaluation.family_id)
        }
      }
    }
    return buildHierarchyEvalIndex(
      evalHierarchy,
      (evalSummaryId) => familyIdByEvalSummaryId.get(evalSummaryId) ?? null,
    )
  }, [evalHierarchy, summary.evaluations_by_tag])

  // Source-prefix → hierarchy-family lookup. The producer ships
  // benchmark-canonical `family_id`s on each comparison-index entry
  // (e.g. `family_id="aime"` for every AIME variant across sources)
  // alongside source-leaderboard families in hierarchy.json (e.g.
  // `artificial-analysis`, `vals-ai`, `llm-stats`). Most evals are
  // listed in `family.constituent_evaluation_ids` and resolve via
  // `hierarchyIndex` directly, but variant rows the producer
  // emits under the same canonical (e.g. `aime-2025`, `aime-2024`)
  // are NOT enumerated at family level — they fall back to
  // `evalEntry.family_id` and synthesise a phantom "aime" parent
  // section. This map provides a second fallback: pick the
  // hierarchy family whose own listed eval ids share this id's
  // source prefix.
  const sourcePrefixFamily = useMemo(() => {
    const out = new Map<string, { key: string; displayName: string }>()
    for (const fam of evalHierarchy?.families ?? []) {
      for (const id of fam.constituent_evaluation_ids ?? []) {
        const prefix = id.includes("%2F") ? id.split("%2F")[0] : null
        if (!prefix) continue
        if (!out.has(prefix)) {
          out.set(prefix, { key: fam.key, displayName: fam.display_name })
        }
      }
    }
    return out
  }, [evalHierarchy])

  // Lookup eval_summary_id -> canonical benchmark info from hierarchy.json's
  // `benchmark_index[]`. Used by the "group duplicates" toggle in the
  // list view AND by the histogram cross-family whisker overlay.
  //
  // The hierarchy is pre-cleaned by `cleanHierarchy` (lib/clean-hierarchy.ts)
  // server-side: family-rollup entries are dropped, (family_key,
  // eval_summary_id) pairs deduped, degenerate entries filtered out. So
  // we can iterate the entries directly here without per-entry filtering.
  const benchmarkIndexLookup = useMemo(() => {
    const out = new Map<
      string,
      { canonicalKey: string; canonicalDisplayName: string; siblingEvalIds: string[] }
    >()
    // benchmark_index has two flavors of entries:
    //   - benchmark canonicals (e.g. "MMLU-Pro") whose appearances all
    //     point at the same benchmark_key — these are the dedup targets.
    //   - umbrellas (suites like "artificial analysis", aggregators like
    //     "llm stats") whose appearances span many benchmark_keys.
    // First-wins on raw iteration order let the umbrellas claim
    // constituent_evaluation_ids that should map to the benchmark canonical (e.g.
    // `artificial-analysis-llms/mmlu-pro` → "artificial analysis"
    // instead of "mmlu-pro"), which left 3 distinct MMLU-Pro tiles in
    // category view. Process benchmark canonicals first so they win
    // regardless of JSON ordering.
    const isBenchmarkCanonical = (
      entry: BenchmarkIndexEntry,
    ): boolean => {
      const apps = entry.appearances ?? []
      if (apps.length === 0) return false
      for (const app of apps) {
        if (app.benchmark_key && app.benchmark_key !== entry.key) return false
      }
      return true
    }
    const ordered = [...(evalHierarchy?.benchmark_index ?? [])].sort(
      (a, b) => Number(isBenchmarkCanonical(b)) - Number(isBenchmarkCanonical(a)),
    )
    for (const entry of ordered) {
      const idSet = new Set<string>()
      for (const app of entry.appearances ?? []) {
        for (const id of app.constituent_evaluation_ids ?? []) idSet.add(id)
      }
      const ids = Array.from(idSet)
      for (const id of ids) {
        if (!out.has(id)) {
          out.set(id, {
            canonicalKey: entry.key,
            canonicalDisplayName: entry.display_name,
            siblingEvalIds: ids,
          })
        }
      }
    }
    return out
  }, [evalHierarchy])

  // List-view-only consolidation state. Active when `groupingMode === "benchmark"`.
  // `mergedRowState` precomputes (across families in display order) which
  // rows render as the consolidated representative ("merged"), which collapse
  // into a previously-rendered representative ("skip"), and which stay as
  // single per-eval rows. Aggregates carry mean/min/max + per-source
  // breakdown (one entry per contributing variant) for the hover tooltip.
  type MergedRowAggregate = {
    canonicalKey: string
    canonicalDisplayName: string
    mean: number
    min: number
    max: number
    sources: Array<{
      familyKey: string
      familyName: string
      score: number
      displayScore: string
      group: BenchmarkGroup
      variant: BenchmarkVariant
    }>
  }
  type RowDisposition = "single" | "merged" | "skip"

  // Composite relevance score for benchmark ordering
  // relevance = population × 0.4 + rank_extremity × 0.3 + has_metadata × 0.2 + recency × 0.1
  const getRelevanceScore = useMemo(() => {
    // Find max population across all peer-ranked benchmarks
    let maxPop = 1
    for (const evalRanks of Object.values(peerRanks)) {
      const pop = Object.keys(evalRanks).length
      if (pop > maxPop) maxPop = pop
    }

    // Find latest timestamp across all evaluations for recency normalization
    const allTimestamps: number[] = []
    for (const evals of Object.values(summary.evaluations_by_tag)) {
      for (const e of evals) {
        const ts = parseFloat(e.retrieved_timestamp)
        if (Number.isFinite(ts)) allTimestamps.push(ts)
      }
    }
    const maxTs = allTimestamps.length > 0 ? Math.max(...allTimestamps) : 0
    const minTs = allTimestamps.length > 0 ? Math.min(...allTimestamps) : 0
    const tsRange = maxTs - minTs || 1

    return (group: BenchmarkGroup): number => {
      const rank = getGroupPeerRank(group, modelIds, peerRanks)

      // Population: how many models were compared (0-1)
      const population = rank ? Math.min(rank.total / maxPop, 1) : 0

      // Rank extremity: how far from median — |0.5 - percentile| × 2 (0-1)
      const percentile = rank ? rank.position / rank.total : 0.5
      const rankExtremity = Math.abs(0.5 - percentile) * 2

      // Rich metadata: has benchmark card (0 or 1)
      const hasMetadata = group.benchmarkCard ? 1 : 0

      // Recency: how recent is the latest evaluation (0-1)
      let latestTs = 0
      for (const v of group.variants) {
        const ts = parseFloat(v.evaluation.retrieved_timestamp)
        if (Number.isFinite(ts) && ts > latestTs) latestTs = ts
      }
      const recency = maxTs > minTs ? (latestTs - minTs) / tsRange : 0.5

      return population * 0.4 + rankExtremity * 0.3 + hasMetadata * 0.2 + recency * 0.1
    }
  }, [peerRanks, modelIds, summary.evaluations_by_tag])

  const allEvaluations = useMemo(
    () => Object.values(summary.evaluations_by_tag).flat(),
    [summary.evaluations_by_tag]
  )
  
  const reportingStats = useMemo(() => {
    const organizations = new Set<string>()
    const sourceTypes = new Set<string>()
    const libraries = new Set<string>()
    let missingGenerationConfigs = 0
    let thirdPartyEvaluations = 0

    allEvaluations.forEach((evaluation) => {
      organizations.add(getOrganizationDisplayName(evaluation.source_metadata.source_organization_name))
      sourceTypes.add(evaluation.source_metadata.source_type)
      if (evaluation.eval_library?.name) {
        libraries.add(formatEvalLibrary(evaluation.eval_library))
      }
      if (evaluation.source_metadata.evaluator_relationship === "third_party") {
        thirdPartyEvaluations += 1
      }
      missingGenerationConfigs += evaluation.evaluation_results.filter((result) => !result.generation_config).length
    })

    return {
      organizationNames: Array.from(organizations).sort((a, b) => a.localeCompare(b)),
      organizationCount: organizations.size,
      sourceTypeCount: sourceTypes.size,
      libraryCount: libraries.size,
      libraryList: Array.from(libraries).sort((a, b) => a.localeCompare(b)),
      missingGenerationConfigs,
      thirdPartyEvaluations,
    }
  }, [allEvaluations])
  const reproducibilityGapCount =
    summary.reproducibility_summary?.has_reproducibility_gap_count ?? reportingStats.missingGenerationConfigs
  const reproducibilityResultsTotal =
    summary.reproducibility_summary?.results_total ?? summary.total_evaluations

  const allCategoryResults = useMemo(
    () =>
      Object.entries(summary.evaluations_by_tag).flatMap(([fallbackCategory, evals]) =>
        evals.flatMap((evaluation) => {
          // Re-bucket by curated tag from data/benchmarks/categories.json.
          // The hierarchy lookup gives us the leaf benchmark's derivedTags;
          // the first tag becomes the displayed category. Fall back to the
          // legacy 5-bucket category only when no tag is found, so existing
          // ordering / filter wiring still works.
          //
          // Normalise both branches into the lowercase-snake_case form used
          // by categories.json so visually-identical categories (the
          // legacy "General" fallback and the curated "general" tag, the
          // legacy "Safety" and "safety", etc.) collapse to the same
          // EvalTag — otherwise downstream surfaces show two
          // adjacent rows / pills with the same label.
          const evalSummaryId = evaluation.eval_summary_id
          const tags = evalSummaryId ? hierarchyIndex?.get(evalSummaryId)?.tags : undefined
          const primaryTag = tags && tags.length > 0 ? tags[0] : null
          const normalisedFallback = fallbackCategory
            .toLowerCase()
            .trim()
            .replace(/\s+/g, "_")
          const category = (primaryTag ?? normalisedFallback) as EvalTag
          return evaluation.evaluation_results.map((result) => ({
            evaluation,
            result,
            category,
          }))
        })
      ),
    [summary.evaluations_by_tag, hierarchyIndex]
  )

  const policyHighlights = useMemo(() => {
    const groups = buildBenchmarkGroups(allCategoryResults, benchmarkCards)
    const seenLabels = new Set<string>()

    return groups
      .filter((group) => {
        const narrative = getPolicyBenchmarkNarrative(group.title)

        if (seenLabels.has(narrative.label)) {
          return false
        }

        seenLabels.add(narrative.label)
        return true
      })
      .slice(0, 6)
      .map((group) => {
      const narrative = getPolicyBenchmarkNarrative(group.title)
      const level = getPolicySignalLevel(group.avgNormalizedScore)

      return {
        key: group.key,
        title: group.canonicalTitle,
        label: narrative.label,
        description: narrative.description,
        scoreText: group.avgDisplayScore,
        level,
      }
    })
  }, [allCategoryResults, benchmarkCards])

  const policySummary = useMemo(() => {
    const benchmarkCount = new Set(
      allCategoryResults.map((entry) => entry.evaluation.benchmark || entry.evaluation.benchmark_parent_name || entry.evaluation.eval_summary_id || getResultBenchmarkName(entry.evaluation, entry.result))
    ).size
    const allThirdParty =
      allEvaluations.length > 0 && reportingStats.thirdPartyEvaluations === allEvaluations.length
    const leadOrganization = reportingStats.organizationNames[0]
    const modelScaleDescription = getModelScaleDescription(summary.model_info.additional_details?.params_billions)
    const compactParamCount = formatParamsBillions(summary.model_info.additional_details?.params_billions)
    const normalizedModelName = getModelDisplayName(summary.model_info.name)
    const compactModelName = compactParamCount ? `${normalizedModelName} · ${compactParamCount}` : normalizedModelName

    let testedByCopy = `Reported across ${benchmarkCount} standardized benchmark${benchmarkCount === 1 ? "" : "s"}.`
    if (leadOrganization && reportingStats.organizationCount === 1) {
      testedByCopy = allThirdParty
        ? `Tested independently by ${leadOrganization} (a third party, distinct from the model's developer) using ${benchmarkCount} standardized benchmark${benchmarkCount === 1 ? "" : "s"}.`
        : `Reported by ${leadOrganization} using ${benchmarkCount} standardized benchmark${benchmarkCount === 1 ? "" : "s"}.`
    } else if (leadOrganization) {
      testedByCopy = allThirdParty
        ? `Tested by ${leadOrganization} and ${reportingStats.organizationCount - 1} other reporting organization${reportingStats.organizationCount - 1 === 1 ? "" : "s"} using ${benchmarkCount} standardized benchmark${benchmarkCount === 1 ? "" : "s"}.`
        : `Reported by ${reportingStats.organizationCount} organizations using ${benchmarkCount} benchmark views.`
    }

    const reproducibilityCopy =
      reproducibilityGapCount === 0
        ? null
        : reproducibilityGapCount === reproducibilityResultsTotal
          ? "How this model was prompted during testing is not documented. Scores cannot be independently confirmed."
          : `${reproducibilityGapCount} of ${reproducibilityResultsTotal} reported scores are missing enough setup detail to be re-run as-is.`

    const comparabilityCopy =
      reproducibilityGapCount > 0
        ? `${benchmarkCount > 0 ? `These results cover ${benchmarkCount} benchmark${benchmarkCount === 1 ? "" : "s"},` : "These results"} but missing prompting details mean apparent score gaps may partly reflect setup differences as well as capability.`
        : "Shared benchmark coverage helps, but evaluator choices, benchmark mix, and model size can still limit direct apples-to-apples comparison."

    const sizeCaveat =
      modelScaleDescription
        ? `${modelScaleDescription}. Comparisons against much smaller or larger systems should be interpreted with care.`
        : null

    return {
      compactModelName,
      modelScaleDescription,
      testedByCopy,
      reproducibilityCopy,
      comparabilityCopy,
      sizeCaveat,
      independentlyVerified: allThirdParty || reportingStats.thirdPartyEvaluations > 0,
      benchmarkCount,
    }
  }, [
    allCategoryResults,
    allEvaluations.length,
    reportingStats,
    reproducibilityGapCount,
    reproducibilityResultsTotal,
    summary.model_info.additional_details?.params_billions,
    summary.model_info.name,
  ])

  /**
   * Structured plain-language summary used by <ModelPolicyOverview>.
   * Pure rule-based templating — see lib/policy-summaries.ts. No LLM is
   * invoked at runtime, so the same input always produces the same prose.
   */
  const modelPolicySummary = useMemo(() => {
    const reportedCategories = Array.from(
      new Set(allCategoryResults.map((entry) => entry.category as unknown as string)),
    )
    const benchmarkCount = new Set(
      allCategoryResults.map(
        (entry) =>
          entry.evaluation.benchmark ||
          entry.evaluation.benchmark_parent_name ||
          entry.evaluation.eval_summary_id ||
          getResultBenchmarkName(entry.evaluation, entry.result),
      ),
    ).size
    return buildModelPolicySummary({
      summary,
      thirdPartyEvaluations: reportingStats.thirdPartyEvaluations,
      reportedEvaluationCount: allEvaluations.length,
      organizationCount: reportingStats.organizationCount,
      organizationNames: reportingStats.organizationNames,
      benchmarkCount,
      reportedCategories,
    })
  }, [
    allCategoryResults,
    allEvaluations.length,
    reportingStats.thirdPartyEvaluations,
    reportingStats.organizationCount,
    reportingStats.organizationNames,
    summary,
  ])

  const benchmarkGroups = useMemo(
    () => buildBenchmarkGroups(allCategoryResults, benchmarkCards, currentDetailHref),
    [allCategoryResults, benchmarkCards, currentDetailHref]
  )

  // Categories actually present in this model's benchmark groups, derived
  // from the curated tag bucketing in `allCategoryResults`. We no longer
  // trust `summary.categories_covered` (legacy 5-bucket) for ordering /
  // filtering; build the list locally so the new tag vocabulary surfaces.
  // Sorted alphabetically by display label for stable filter-pill order.
  const availableCategories = useMemo(() => {
    const seen = new Set<string>()
    const cats: string[] = []
    for (const group of benchmarkGroups) {
      const cat = group.category as unknown as string
      if (!seen.has(cat)) {
        seen.add(cat)
        cats.push(cat)
      }
    }
    cats.sort((a, b) => formatTagLabel(a).localeCompare(formatTagLabel(b)))
    return cats as unknown as EvalTag[]
  }, [benchmarkGroups])

  // Family names present in this model's benchmark groups — used for
  // the Source-view filter chips. Sorted alphabetically by display name.
  const availableFamilies = useMemo(() => {
    const seen = new Map<string, string>()
    for (const group of benchmarkGroups) {
      const evalId = group.variants.find((v) => v.evaluation.eval_summary_id)?.evaluation.eval_summary_id
      const hierarchyLocation = evalId ? hierarchyIndex?.get(evalId) ?? null : null
      const sourcePrefix = evalId?.includes("%2F") ? evalId.split("%2F")[0] : null
      const inferred = !hierarchyLocation && sourcePrefix ? sourcePrefixFamily.get(sourcePrefix) ?? null : null
      const famKey = hierarchyLocation?.familyKey ?? inferred?.key ?? (sourcePrefix ?? group.key)
      const famName = hierarchyLocation?.familyDisplayName || inferred?.displayName || group.title
      if (!seen.has(famKey)) seen.set(famKey, famName)
    }
    return Array.from(seen.entries())
      .map(([key, name]) => ({ key, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [benchmarkGroups, hierarchyIndex, sourcePrefixFamily])

  // First-party vs third-party split per category (for the donut + bars).
  const evaluatorMix = useMemo(() => {
    // Bucket counts per category, then re-bucket by display label so
    // visually-identical labels collapse: the curated tag vocab can
    // produce two distinct EvalTag strings ("general" vs
    // "general_other") that both render as "General". Without this the
    // donut shows two "General" / "Safety" rows.
    const byCat = new Map<EvalTag, { first: number; third: number; collab: number; other: number }>()
    let firstTotal = 0
    let thirdTotal = 0
    let collabTotal = 0
    let otherTotal = 0
    for (const group of benchmarkGroups) {
      const slot = byCat.get(group.category) ?? { first: 0, third: 0, collab: 0, other: 0 }
      for (const variant of group.variants) {
        const rel = variant.evaluation.source_metadata.evaluator_relationship
        if (rel === "first_party") { slot.first++; firstTotal++ }
        else if (rel === "third_party") { slot.third++; thirdTotal++ }
        else if (rel === "collaborative") { slot.collab++; collabTotal++ }
        else { slot.other++; otherTotal++ }
      }
      byCat.set(group.category, slot)
    }
    type Row = {
      category: EvalTag
      label: string
      first: number
      third: number
      collab: number
      other: number
      total: number
    }
    const byLabel = new Map<string, Row>()
    for (const [category, counts] of byCat) {
      const label = formatTagLabel(category as unknown as string)
      const existing = byLabel.get(label) ?? {
        category,
        label,
        first: 0,
        third: 0,
        collab: 0,
        other: 0,
        total: 0,
      }
      existing.first += counts.first
      existing.third += counts.third
      existing.collab += counts.collab
      existing.other += counts.other
      existing.total =
        existing.first + existing.third + existing.collab + existing.other
      byLabel.set(label, existing)
    }
    const rows = Array.from(byLabel.values())
      .filter((row) => row.total > 0)
      .sort((a, b) => a.label.localeCompare(b.label))
    const grand = firstTotal + thirdTotal + collabTotal + otherTotal
    return {
      rows,
      firstTotal,
      thirdTotal,
      collabTotal,
      otherTotal,
      grand,
    }
  }, [benchmarkGroups])

  const filteredBenchmarkGroups = useMemo(() => {
    const query = benchmarkSearch.trim().toLowerCase()
    const filtered = benchmarkGroups.filter((group) => {
      if (selectedCategories.length > 0 && !selectedCategories.includes(group.category)) {
        return false
      }

      if (selectedFamilies.length > 0) {
        const evalId = group.variants.find((v) => v.evaluation.eval_summary_id)?.evaluation.eval_summary_id
        const hierarchyLocation = evalId ? hierarchyIndex?.get(evalId) ?? null : null
        const sourcePrefix = evalId?.includes("%2F") ? evalId.split("%2F")[0] : null
        const inferred = !hierarchyLocation && sourcePrefix ? sourcePrefixFamily.get(sourcePrefix) ?? null : null
        const famKey = hierarchyLocation?.familyKey ?? inferred?.key ?? (sourcePrefix ?? group.key)
        if (!selectedFamilies.includes(famKey)) return false
      }

      if (!query) {
        return true
      }

      return (
        group.title.toLowerCase().includes(query) ||
        group.canonicalTitle.toLowerCase().includes(query) ||
        group.description.toLowerCase().includes(query) ||
        group.variants.some((variant) => variant.label.toLowerCase().includes(query))
      )
    })

    // Default ordering: relevance score (most-reported / most-extreme rank /
    // richest metadata / most recent first). The source / category grouping
    // applied downstream may regroup but doesn't re-sort within a group.
    filtered.sort((a, b) => getRelevanceScore(b) - getRelevanceScore(a))

    return filtered
  }, [benchmarkGroups, benchmarkSearch, selectedCategories, selectedFamilies, hierarchyIndex, sourcePrefixFamily, modelId, peerRanks, getRelevanceScore])

  const groupedFilteredBenchmarkGroups = useMemo(() => {
    const order = new Map(availableCategories.map((category, index) => [category, index]))
    const groups = new Map<EvalTag, BenchmarkGroup[]>()

    for (const benchmarkGroup of filteredBenchmarkGroups) {
      const bucket = groups.get(benchmarkGroup.category) ?? []
      bucket.push(benchmarkGroup)
      groups.set(benchmarkGroup.category, bucket)
    }

    return Array.from(groups.entries())
      .sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999))
      .map(([category, groups]) => ({ category, groups }))
  }, [filteredBenchmarkGroups, availableCategories])

  // Family-bucketed groups for the list view, mirroring plotboxUnits logic.
  // When comparisonIndex is available we use the backend-authoritative
  // family_id; otherwise we fall back to the group's own key so each
  // BenchmarkGroup forms its own family.
  type ListFamily = {
    familyKey: string
    familyName: string
    kind: "single-eval" | "multi-eval"
    groups: BenchmarkGroup[]
    totalRows: number
  }
  const listFamiliesByCategory = useMemo(() => {
    const order = new Map(
      availableCategories.map((category, index) => [category, index])
    )
    const byCategory = new Map<EvalTag, Map<string, ListFamily>>()

    for (const group of filteredBenchmarkGroups) {
      const evalId = group.variants.find((v) => v.evaluation.eval_summary_id)
        ?.evaluation.eval_summary_id
      const evalEntry =
        evalId && comparisonIndex ? comparisonIndex.evals[evalId] : null
      const hierarchyLocation = evalId
        ? hierarchyIndex?.get(evalId) ?? null
        : null
      const sourcePrefix = evalId && evalId.includes("%2F")
        ? evalId.split("%2F")[0]
        : null
      const inferredSourceFamily = !hierarchyLocation && sourcePrefix
        ? sourcePrefixFamily.get(sourcePrefix) ?? null
        : null
      const famKey =
        hierarchyLocation?.familyKey ??
        inferredSourceFamily?.key ??
        evalEntry?.family_id ??
        group.key
      const famName =
        hierarchyLocation?.familyDisplayName ||
        inferredSourceFamily?.displayName ||
        evalEntry?.family_display_name ||
        evalEntry?.display_name ||
        group.title

      const catBucket = byCategory.get(group.category) ?? new Map<string, ListFamily>()
      const family = catBucket.get(famKey) ?? {
        familyKey: famKey,
        familyName: famName,
        kind: "single-eval" as const,
        groups: [] as BenchmarkGroup[],
        totalRows: 0,
      }
      family.groups.push(group)
      family.totalRows += group.variants.length
      catBucket.set(famKey, family)
      byCategory.set(group.category, catBucket)
    }

    return Array.from(byCategory.entries())
      .sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999))
      .map(([category, fams]) => ({
        category,
        families: Array.from(fams.values()).map((f) => ({
          ...f,
          kind: f.groups.length > 1 ? "multi-eval" as const : "single-eval" as const,
        })),
      }))
  }, [filteredBenchmarkGroups, comparisonIndex, hierarchyIndex, sourcePrefixFamily, availableCategories])

  // Precompute "merged" / "skip" / "single" disposition per row when the
  // list-view duplicate-grouping toggle is on. Walks the categories →
  // families → groups → variants in display order; the first variant we
  // encounter for each canonical benchmark renders the merged
  // representative (showing mean + range + per-source breakdown), and
  // every later variant of the same canonical benchmark is suppressed.
  // The aggregate contains contributions from every sibling regardless of
  // family, so the merged row is a true cross-family consolidation.
  // Cross-family duplicate consolidation in the source/category list views
  // is gone — overlaps now have their own dedicated table view. The list
  // view always renders one row per (family, group, variant) so this
  // returns null and the renderRow path treats every row as `single`.
  // The variables below are referenced by `listFamiliesByCategory`'s
  // useMemo deps but kept for type compatibility.
  void benchmarkIndexLookup
  type _Unused = { a: MergedRowAggregate; r: RowDisposition }
  const mergedRowState = null as null | {
    aggregates: Map<string, MergedRowAggregate>
    rowDisposition: Map<string, RowDisposition>
  }

  const compositeGroups = useMemo(() => {
    const groups = groupByComposite(filteredBenchmarkGroups, modelIds, peerRanks, hierarchyIndex)
    // Re-sort composites by max relevance of their benchmarks
    return groups.sort((a, b) => {
      const aMax = Math.max(...a.benchmarks.map(getRelevanceScore))
      const bMax = Math.max(...b.benchmarks.map(getRelevanceScore))
      return bMax - aMax
    })
  }, [filteredBenchmarkGroups, modelIds, peerRanks, getRelevanceScore, hierarchyIndex])

  const categoryCompositeSections = useMemo(
    () =>
      groupedFilteredBenchmarkGroups
        .map(({ category, groups }) => ({
          category,
          composites: groupByComposite(groups, modelIds, peerRanks, hierarchyIndex).sort((a, b) => {
            const aMax = Math.max(...a.benchmarks.map(getRelevanceScore))
            const bMax = Math.max(...b.benchmarks.map(getRelevanceScore))
            return bMax - aMax
          }),
        }))
        .filter((section) => section.composites.length > 0),
    [groupedFilteredBenchmarkGroups, modelIds, peerRanks, getRelevanceScore, hierarchyIndex]
  )

  const categoryScoreRanges = useMemo(() => {
    const ranges = new Map<EvalTag, ScoreRange>()

    for (const section of categoryCompositeSections) {
      ranges.set(
        section.category,
        getScoreRange(section.composites.map((composite) => composite.avgNormalizedScore))
      )
    }

    return ranges
  }, [categoryCompositeSections])

  const compositeBenchmarkScoreRanges = useMemo(() => {
    const ranges = new Map<string, ScoreRange>()

    for (const section of categoryCompositeSections) {
      for (const composite of section.composites) {
        ranges.set(
          composite.compositeKey,
          getScoreRange(composite.benchmarks.map((group) => group.avgNormalizedScore))
        )
      }
    }

    return ranges
  }, [categoryCompositeSections])

  const benchmarkGroupLookup = useMemo(
    () => new Map(benchmarkGroups.map((group) => [group.key, group] as const)),
    [benchmarkGroups]
  )
  const activeBenchmarkGroup = activeBenchmarkGroupKey
    ? benchmarkGroupLookup.get(activeBenchmarkGroupKey) ?? null
    : null

  // Deep-link support: `/models/<id>?deepDive=<groupKey>` opens the matching
  // benchmark deep-dive on load. Used by the histogram embed's "View deep
  // dive" link (the modal can't render inside the small embed iframe, so the
  // embed opens the full card with the deep dive already expanded) and works
  // as a shareable link standalone. Only fires when the param/lookup change,
  // so closing the dialog doesn't re-open it.
  const deepDiveParam = searchParams.get("deepDive")
  useEffect(() => {
    if (!deepDiveParam) return
    if (benchmarkGroupLookup.has(deepDiveParam)) {
      setActiveBenchmarkGroupKey(deepDiveParam)
    }
  }, [deepDiveParam, benchmarkGroupLookup])

  const toggleSuite = (compositeKey: string) => {
    setExpandedSuites((prev) => {
      const next = new Set(prev)
      if (next.has(compositeKey)) next.delete(compositeKey)
      else next.add(compositeKey)
      return next
    })
  }

  const overviewBenchmarkGroups =
    selectedCategories.length > 0 || benchmarkSearch.trim()
      ? filteredBenchmarkGroups
      : benchmarkGroups

  // Only groups with actual sidecar ordinal rank data (total > 0) qualify
  // for the "ranks high / low in" summary. Fallback bestRankPosition values
  // are raw scores (0–1), not ordinal positions, so they must be excluded.
  const rankedBenchmarkGroups = useMemo(
    () =>
      overviewBenchmarkGroups.filter((group) => {
        const rank = getGroupPeerRank(group, modelIds, peerRanks)
        return rank != null && rank.total > 0
      }),
    [overviewBenchmarkGroups, modelId, peerRanks]
  )
  const strongRankedBenchmarks = useMemo(() => {
    const sorted = [...rankedBenchmarkGroups].sort((a, b) => {
      const aRank = getGroupPeerRank(a, modelIds, peerRanks)!
      const bRank = getGroupPeerRank(b, modelIds, peerRanks)!
      return aRank.position / aRank.total - bRank.position / bRank.total
    })
    return sorted.slice(0, 3)
  }, [rankedBenchmarkGroups, modelId, peerRanks])

  const weakRankedBenchmarks = useMemo(() => {
    const strongKeys = new Set(strongRankedBenchmarks.map((g) => g.key))
    const sorted = [...rankedBenchmarkGroups]
      .filter((g) => !strongKeys.has(g.key))
      .sort((a, b) => {
        const aRank = getGroupPeerRank(a, modelIds, peerRanks)!
        const bRank = getGroupPeerRank(b, modelIds, peerRanks)!
        return bRank.position / bRank.total - aRank.position / aRank.total
      })
    return sorted.slice(0, 3)
  }, [rankedBenchmarkGroups, strongRankedBenchmarks, modelId, peerRanks])
  const repeatedBenchmarkCount = overviewBenchmarkGroups.filter((group) => group.variants.length > 1).length
  const setupDrivenBenchmarkCount = overviewBenchmarkGroups.filter((group) =>
    group.variants.some((variant) => variant.variantType === "setup" || variant.variantType === "setup+slice")
  ).length
  const sliceDrivenBenchmarkCount = overviewBenchmarkGroups.filter((group) =>
    group.variants.some((variant) => variant.variantType === "slice" || variant.variantType === "setup+slice")
  ).length

  useEffect(() => {
    setSelectedCategories((current) =>
      current.filter((category) => availableCategories.includes(category))
    )
  }, [availableCategories])

  useEffect(() => {
    const keys = new Set(availableFamilies.map((f) => f.key))
    setSelectedFamilies((current) => current.filter((k) => keys.has(k)))
  }, [availableFamilies])

  // Shared YYYY-MM-DD formatter (lib/utils#formatDateISO). Used for the
  // "Updated" <dd>, the "Released" line, and any other
  // date-cell render in this component. Other surfaces (eval-detail
  // table, model-table summary) use the same helper so the corpus
  // renders one consistent date style.
  const formatDate = formatDateISO

  const jumpToDeepDive = (groupKey: string) => {
    if (benchmarkGroupLookup.has(groupKey)) {
      setActiveBenchmarkGroupKey(groupKey)
    }
  }

  // Model comparison logic
  const comparisonModels = useMemo(() => {
    if (!modelCards || modelCards.length === 0) return []
    // Exclude the current model
    return modelCards.filter(m => m.id !== modelId)
  }, [modelCards, modelId])

  // Per-benchmark extras added via the "+" button on each histogram.
  const [extraModelsByBenchmark, setExtraModelsByBenchmark] = useState<Record<string, string[]>>({})
  // All histogram data now comes from `comparisonIndex` (comparison-index.json),
  // the backend-authoritative per-(eval, metric) leaderboard artifact. The old
  // `top_scores`-on-model-cards and per-eval-detail fan-out paths are retired.

  // Every identifier the current model may appear under in comparison-index.
  // Used to (a) pull our own score out of `by_model` and (b) drop ourselves
  // out of the peer score list.
  const currentModelIdentityKeys = useMemo(() => {
    const id = summary.model_info.id || ""
    // Include BOTH the plain id and its encoded (route_id) form: comparison
    // score rows are keyed by the percent-encoded route, while the summary
    // exposes the plain `id`. Without the encoded forms the current model
    // never matches its own score row (so it isn't excluded from peers).
    const keys = new Set<string>(
      [
        id,
        id && encodeURIComponent(id),
        (summary as any).model_route_id,
        (summary as any).variant_key,
        (summary as any).model_group_id,
        (summary as any).model_group_id && encodeURIComponent((summary as any).model_group_id),
        (summary.model_info as any).family_id,
        (summary.model_info as any).model_route_id,
        ...((summary as any).raw_model_ids ?? []),
      ].filter(Boolean) as string[]
    )
    return keys
  }, [summary])

  // The model_route_id that keys into comparison-index.by_model (which is keyed
  // by the GROUP route_id). The page renders the selected variant as `summary`,
  // so prefer its carried-through model_route_id, then variant_key, and finally
  // encode the plain id — never the legacy `__` form, which the v2 backend's
  // percent-encoded keys don't use.
  const currentModelRouteId = useMemo(() => {
    const explicit =
      (summary as any).model_route_id ||
      (summary.model_info as any).model_route_id ||
      (summary as any).variant_key
    if (typeof explicit === "string" && explicit.length > 0) return explicit
    const id = summary.model_info.id || ""
    return id ? encodeURIComponent(id) : ""
  }, [summary])

  // Inputs for the overlaps builder sourced from the model's own summary
  // payload: one candidate per benchmark group (merged in when the benchmark
  // has no benchmark_index entry) and one join row per result row (backfills
  // generation params / annotations onto comparison-index appearances).
  const overlapSummaryInputs = useMemo(() => {
    const candidates: OverlapSummaryCandidate[] = []
    const joinRows: OverlapSummaryJoinRow[] = []
    for (const group of benchmarkGroups) {
      const ids: string[] = []
      for (const variant of group.variants) {
        const id = variant.evaluation.eval_summary_id
        if (!id) continue
        if (!ids.includes(id)) ids.push(id)
        const gc = variant.result.generation_config ?? variant.evaluation.generation_config
        joinRows.push({
          evalSummaryId: id,
          temperature: gc?.generation_args?.temperature ?? null,
          maxTokens: gc?.generation_args?.max_tokens ?? null,
          collectionId: variant.evaluation.collection_id ?? null,
          protocolCondition: variant.evaluation.protocol_condition ?? null,
          studyFamilyKey: variant.evaluation.composite_slug ?? null,
          annotations: variant.result.evalcards?.annotations ?? null,
        })
      }
      const primary = group.variants[0]
      if (!primary) continue
      const score = primary.result.score_details.score
      if (!Number.isFinite(score)) continue
      const gc = primary.result.generation_config ?? primary.evaluation.generation_config
      candidates.push({
        groupKey: group.key,
        displayName: group.title,
        evalSummaryIds: ids,
        familyKey:
          primary.evaluation.family_id ??
          primary.evaluation.source_metadata.source_organization_name ??
          "source",
        familyName:
          primary.evaluation.benchmark_family_name ||
          getOrganizationDisplayName(primary.evaluation.source_metadata.source_organization_name),
        score,
        unit: primary.result.metric_config.unit ?? null,
        metricSummaryId: primary.result.metric_summary_id ?? "",
        metricName: primary.metricLabel,
        temperature: gc?.generation_args?.temperature ?? null,
        maxTokens: gc?.generation_args?.max_tokens ?? null,
        collectionId: primary.evaluation.collection_id ?? null,
        protocolCondition: primary.evaluation.protocol_condition ?? null,
        studyFamilyKey: primary.evaluation.composite_slug ?? null,
        annotations: primary.result.evalcards?.annotations ?? null,
      })
    }
    return { candidates, joinRows }
  }, [benchmarkGroups])

  // The family keys /evals?family= can actually resolve: the cleaned
  // hierarchy nests and drops composites, and the listing matches
  // top-level keys exactly, so a study name only links where its key is
  // one of these. Empty while the hierarchy loads, which costs the link
  // and nothing else.
  const topLevelFamilyKeys = useMemo(
    () => new Set((evalHierarchy?.families ?? []).map((family) => family.key)),
    [evalHierarchy],
  )

  // Cross-suite overlaps table data — see lib/overlaps.ts for the row
  // semantics (multi-family rows via benchmark_index + comparison-index,
  // single-family rows merged from the summary payload, stats, dedup).
  const overlapsRows = useMemo<OverlapRow[]>(() => {
    const familyDisplayByKey = new Map<string, string>()
    for (const fam of evalHierarchy?.families ?? []) {
      familyDisplayByKey.set(fam.key, fam.display_name)
    }
    return buildOverlapRows({
      benchmarkIndex: evalHierarchy?.benchmark_index,
      comparisonIndex,
      currentModelRouteId,
      currentModelIdentityKeys,
      familyDisplayByKey,
      summaryCandidates: overlapSummaryInputs.candidates,
      summaryJoinRows: overlapSummaryInputs.joinRows,
    })
  }, [
    evalHierarchy,
    comparisonIndex,
    currentModelRouteId,
    currentModelIdentityKeys,
    overlapSummaryInputs,
  ])

  // Effective view: honour the user's explicit pick; otherwise default to
  // overlaps (cross-suite comparison) when this model has any, falling back to
  // source when it has none so the section never opens empty. Source remains
  // one click away for the full result set.
  const groupingMode = pickedGroupingMode ?? (overlapsRows.length > 0 ? "overlaps" : "source")

  // Overlaps rows after the Show toggle + search box — shared by the §4
  // header count and the overlaps table so the two never disagree.
  const visibleOverlapsRows = useMemo(() => {
    const query = benchmarkSearch.trim().toLowerCase()
    const toggled =
      overlapsFilter === "multi"
        ? overlapsRows.filter((r) => r.appearances.length >= 2)
        : overlapsRows
    if (!query) return toggled
    return toggled.filter(
      (r) =>
        r.canonicalDisplayName.toLowerCase().includes(query) ||
        r.canonicalKey.toLowerCase().includes(query) ||
        r.appearances.some((a) => a.familyName.toLowerCase().includes(query)),
    )
  }, [overlapsRows, overlapsFilter, benchmarkSearch])

  // Per-(eval, metric) leaderboards sourced from comparison-index.json.
  const benchmarkHistograms = useMemo<Map<string, BenchmarkHistogram>>(() => {
    // Resolve every eval_summary_id we care about from the current model's
    // benchmarkGroups — this is the intersection of "what this model reports"
    // and "what comparison-index covers".
    const wantedEvalIds = new Set<string>()
    for (const group of benchmarkGroups) {
      for (const variant of group.variants) {
        if (variant.evaluation.eval_summary_id) {
          wantedEvalIds.add(variant.evaluation.eval_summary_id)
        }
      }
    }
    return buildBenchmarkHistograms({
      comparisonIndex,
      wantedEvalIds,
      currentModelIdentityKeys,
      currentModelRouteId,
      currentModelName: getModelDisplayName(summary.model_info.name),
      extraModelsByBenchmark,
    })
  }, [
    benchmarkGroups,
    comparisonIndex,
    currentModelIdentityKeys,
    currentModelRouteId,
    extraModelsByBenchmark,
    summary.model_info.name,
  ])


  // A plotbox can expose a top-level "view" selector (slices, child
  // benchmarks, components) and an optional metric tab rail beneath the chart.
  // Plotbox grouping is driven entirely by comparison-index's own
  // family_id so it stays in sync with the backend.
  type PlotboxMetricTab = {
    tabKey: string
    label: string
    histKey: string
    evalSummaryId: string
    metricSummaryId: string
    evalDisplayName: string
    evalEntry: ComparisonEvalEntry
    metricEntry: ComparisonMetricEntry
    isRollup: boolean
    group: BenchmarkGroup
    variant: BenchmarkVariant
  }

  type PlotboxView = {
    viewKey: string
    label: string
    evalDisplayName: string
    evalEntry: ComparisonEvalEntry
    isRollup: boolean
    group: BenchmarkGroup
    tabs: PlotboxMetricTab[]
  }

  type PlotboxUnit = {
    unitKey: string
    /** Plotbox-scope key. Composite key for composite-rooted plotboxes,
     *  otherwise the benchmark / family key. Drives the dropdown and
     *  the in-card title. */
    familyKey: string
    /** Plotbox-scope display name (composite name for composites,
     *  benchmark/family name for standalone benchmarks). */
    familyName: string
    /** Outer family that owns this plotbox in the hierarchy. The grid
     *  render groups composite plotboxes by `parentFamilyKey` so the
     *  HELM family header sits above its `HELM Classic` / `HELM Safety`
     *  plotboxes. Falls back to `familyKey` for standalone families. */
    parentFamilyKey: string
    parentFamilyDisplayName: string
    category: EvalTag
    kind: "single-eval" | "multi-eval"
    childKindLabel: "metric" | "benchmark" | "component" | "slice" | null
    views: PlotboxView[]
    primaryGroup: BenchmarkGroup
  }

  // Strip the family name from a child's display so tabs read "Korean" rather
  // than "Global MMLU Lite Korean" and "Math" rather than "Reward Bench 2 Math".
  const stripFamilyPrefix = (label: string, familyName: string): string => {
    if (!familyName) return label
    const trimmed = label.trim()
    const fam = familyName.trim()
    if (trimmed.toLowerCase() === fam.toLowerCase()) return "Overall"
    if (trimmed.toLowerCase().startsWith(fam.toLowerCase() + " ")) {
      return trimmed.slice(fam.length).trim()
    }
    return trimmed
  }

  const plotboxUnits = useMemo<PlotboxUnit[]>(() => {
    if (!comparisonIndex) return []

    type ResolvedGroup = {
      group: BenchmarkGroup
      evalEntry: ComparisonEvalEntry
    }
    type Bucket = {
      bucketKey: string
      parentFamilyKey: string
      parentFamilyDisplayName: string
      compositeKey: string | null
      compositeDisplayName: string | null
      bucketDisplayName: string
      category: EvalTag
      resolved: ResolvedGroup[]
    }
    // Composite-level bucketing. For evals that hierarchy.json places under a
    // composite (e.g. HELM Classic, HELM Safety), all evals in the same
    // composite share a bucket. Evals with no composite (standalone
    // benchmarks like AIME, MATH-500) each get their own bucket. The
    // grid render then groups bucket plotboxes by `parentFamilyKey`, so a
    // family like HELM shows one section header with N composite plotboxes
    // beneath it; singleton families show one plotbox under their own
    // header.
    const buckets = new Map<string, Bucket>()

    for (const group of filteredBenchmarkGroups) {
      const evalId = group.variants.find((v) => v.evaluation.eval_summary_id)
        ?.evaluation.eval_summary_id
      if (!evalId) continue
      const evalEntry = comparisonIndex.evals[evalId]
      if (!evalEntry) continue

      // Prefer hierarchy.json grouping. The comparison-index family_id is
      // null for some evals (e.g. CySE2 composites) and points at the
      // leaf for singleton families, so the hierarchy is the only source
      // that captures family→composite groupings authoritatively.
      // For evals not enumerated in any family's `constituent_evaluation_ids`
      // (e.g. `artificial-analysis-llms%2Faime-2025`, where only the
      // base `…%2Faime` variant is listed at family level), prefer
      // source-prefix inference over `evalEntry.family_id` so the
      // variant lands under the correct organizational family
      // (`artificial-analysis`) instead of synthesising a phantom
      // `aime` parent section.
      const hierarchyLocation = hierarchyIndex?.get(evalId) ?? null
      const sourcePrefix = evalId.includes("%2F") ? evalId.split("%2F")[0] : null
      const inferredSourceFamily = !hierarchyLocation && sourcePrefix
        ? sourcePrefixFamily.get(sourcePrefix) ?? null
        : null
      const parentFamilyKey =
        hierarchyLocation?.familyKey ??
        inferredSourceFamily?.key ??
        evalEntry.family_id ??
        evalId
      const parentFamilyDisplayName =
        hierarchyLocation?.familyDisplayName ||
        inferredSourceFamily?.displayName ||
        evalEntry.family_display_name ||
        evalEntry.display_name ||
        parentFamilyKey
      const compositeKey = hierarchyLocation?.compositeKey ?? null
      const compositeDisplayName = hierarchyLocation?.compositeDisplayName ?? null
      // Bucketing precedence:
      //   composite > hierarchy benchmark > group key
      // Standalone benchmarks with N split eval rows (Fibble Arena's
      // 1-/2-/3-/4-/5-lies, AgentHarm's category siblings) all resolve
      // to the same `benchmarkKey` post-cleanHierarchy, so bucketing on
      // it groups every split into one plotbox. Without this they each
      // get their own group key and render as N separate plotboxes,
      // which contradicts the cleaned hierarchy's standalone-with-
      // splits intent.
      const benchmarkKey = hierarchyLocation?.benchmarkKey ?? null
      const benchmarkDisplayName =
        hierarchyLocation?.benchmarkDisplayName ?? null
      const bucketKey = compositeKey
        ? `${parentFamilyKey}::comp::${compositeKey}`
        : benchmarkKey
          ? `${parentFamilyKey}::bench::${benchmarkKey}`
          : `${parentFamilyKey}::bench::${group.key}`
      const bucketDisplayName =
        compositeDisplayName ??
        benchmarkDisplayName ??
        evalEntry.display_name ??
        group.title ??
        parentFamilyDisplayName
      const bucket = buckets.get(bucketKey) ?? {
        bucketKey,
        parentFamilyKey,
        parentFamilyDisplayName,
        compositeKey,
        compositeDisplayName,
        bucketDisplayName,
        category: group.category,
        resolved: [] as ResolvedGroup[],
      }
      bucket.resolved.push({ group, evalEntry })
      buckets.set(bucketKey, bucket)
    }

    const variantFor = (
      group: BenchmarkGroup,
      metricSummaryId: string
    ): BenchmarkVariant => {
      return (
        group.variants.find(
          (v) => v.result.metric_summary_id === metricSummaryId
        ) ?? group.variants[0]
      )
    }

    const metricTabFor = (
      group: BenchmarkGroup,
      evalEntry: ComparisonEvalEntry,
      metric: ComparisonMetricEntry,
      variant: BenchmarkVariant,
      isRollup: boolean
    ): PlotboxMetricTab => ({
      tabKey: `${evalEntry.evaluation_id}::${metric.metric_summary_id}`,
      label: deriveMetricTabLabel(metric.metric_name, metric.metric_summary_id),
      histKey: histKeyFor(evalEntry.evaluation_id, metric.metric_summary_id),
      evalSummaryId: evalEntry.evaluation_id,
      metricSummaryId: metric.metric_summary_id,
      evalDisplayName: evalEntry.display_name || group.title,
      evalEntry,
      metricEntry: metric,
      isRollup,
      group,
      variant,
    })

    const units: PlotboxUnit[] = []
    for (const bucket of buckets.values()) {
      const {
        bucketKey,
        parentFamilyKey,
        parentFamilyDisplayName,
        bucketDisplayName,
        category,
        resolved,
      } = bucket

      if (resolved.length === 1) {
        // One eval in scope — slices/splits become the view selector while
        // metrics move to a compact tab rail beneath the chart.
        const { group, evalEntry } = resolved[0]
        const evalDisplay = evalEntry.display_name || group.title

        // `buildBenchmarkGroups` folds is_slice siblings under a
        // synthesized parent groupKey so all of e.g. CapArena's 5 split
        // evals live in ONE group. The producer doesn't always carry a
        // `slice_name`, so each variant's sliceLabel can be null even
        // though they're conceptually distinct splits — the eval page
        // surfaces them via hierarchy `constituent_evaluation_ids` instead. Mirror
        // that here: when the folded group's variants span multiple
        // constituent_evaluation_ids, treat each eval as its own split view (the
        // dropdown matches the eval-page split selector).
        const distinctEvalIds = new Set<string>()
        for (const v of group.variants) {
          if (v.evaluation.eval_summary_id) distinctEvalIds.add(v.evaluation.eval_summary_id)
        }
        const isMultiEvalSliceFold =
          distinctEvalIds.size > 1 &&
          group.variants.every((v) => v.sliceLabel == null)

        const views: PlotboxView[] = []

        if (isMultiEvalSliceFold) {
          const variantsByEvalId = new Map<string, BenchmarkVariant[]>()
          for (const v of group.variants) {
            const evId = v.evaluation.eval_summary_id ?? evalEntry.evaluation_id
            const list = variantsByEvalId.get(evId) ?? []
            list.push(v)
            variantsByEvalId.set(evId, list)
          }
          for (const [evId, vars] of variantsByEvalId) {
            const childEvalEntry = comparisonIndex.evals[evId] ?? evalEntry
            const childDisplay = humanizeBenchmarkName(
              childEvalEntry.display_name ||
                vars[0]?.evaluation.display_name ||
                evId,
            )
            const tabs = childEvalEntry.metrics
              .filter((metric) => !isStderrMetricId(metric.metric_summary_id))
              .map((metric) => {
                const variant =
                  vars.find((v) => v.result.metric_summary_id === metric.metric_summary_id) ??
                  vars[0]
                if (!variant) return null
                return metricTabFor(group, childEvalEntry, metric, variant, false)
              })
              .filter((tab): tab is PlotboxMetricTab => tab != null)
            if (tabs.length === 0) continue
            views.push({
              viewKey: evId,
              label: childDisplay,
              evalDisplayName: childDisplay,
              evalEntry: childEvalEntry,
              isRollup: false,
              group,
              tabs,
            })
          }
          views.sort((a, b) => a.label.localeCompare(b.label))
        } else {
          const singleEvalViewBuckets = new Map<
            string,
            { viewKey: string; label: string; variants: BenchmarkVariant[] }
          >()
          for (const variant of group.variants) {
            const viewKey = variant.sliceLabel
              ? `slice:${normalizeDisplayKey(variant.sliceLabel)}`
              : "default"
            const label = variant.sliceLabel || "Overall"
            const bucketForView = singleEvalViewBuckets.get(viewKey) ?? {
              viewKey,
              label,
              variants: [],
            }
            bucketForView.variants.push(variant)
            singleEvalViewBuckets.set(viewKey, bucketForView)
          }
          for (const viewBucket of singleEvalViewBuckets.values()) {
            const tabs = evalEntry.metrics
              .filter((metric) => !isStderrMetricId(metric.metric_summary_id))
              .map((metric) => {
                const metricVariants = viewBucket.variants.filter(
                  (variant) =>
                    variant.result.metric_summary_id === metric.metric_summary_id,
                )
                const variant =
                  metricVariants.find((candidate) => !candidate.setupLabel) ??
                  metricVariants[0] ??
                  null
                if (!variant) return null
                return metricTabFor(group, evalEntry, metric, variant, false)
              })
              .filter((tab): tab is PlotboxMetricTab => tab != null)
            if (tabs.length === 0) continue
            views.push({
              viewKey: viewBucket.viewKey,
              label: viewBucket.label,
              evalDisplayName: evalDisplay,
              evalEntry,
              isRollup: viewBucket.viewKey === "default",
              group,
              tabs,
            })
          }
          views.sort((a, b) => {
            if (a.viewKey === "default") return -1
            if (b.viewKey === "default") return 1
            return a.label.localeCompare(b.label)
          })
        }

        if (views.length === 0) continue
        // For multi-eval slice folds (CapArena, Tau-Bench, AIME, …) the
        // bucket aggregates N sibling slice evals. Each of those has
        // its own benchmark.display_name in the hierarchy (e.g.
        // "CapArena-Auto Score (avg)", "Tau2-Bench Airline") — so
        // bucketDisplayName picks one of those slice names at random.
        // The variants' shared `parent_benchmark_id` ("tau-bench",
        // "caparena", …) is the actual benchmark identity; resolve it
        // to a hierarchy family display_name when one matches, else
        // humanize the slug. We don't fall back to parentFamilyDisplayName
        // here because the hierarchy sometimes nests these under the
        // *evaluator* family (llm-stats puts tau-bench slices under
        // "LLM Stats"), which would mislabel the tile.
        const sharedParentBenchId = (() => {
          const ids = new Set<string>()
          for (const v of group.variants) {
            const pid = v.evaluation.parent_benchmark_id
            if (pid) ids.add(pid)
          }
          return ids.size === 1 ? Array.from(ids)[0] : null
        })()
        const parentBenchTitle = sharedParentBenchId
          ? evalHierarchy?.families?.find((f) => f.key === sharedParentBenchId)?.display_name ??
            humanizeBenchmarkName(sharedParentBenchId)
          : null
        const tileTitle = isMultiEvalSliceFold
          ? parentBenchTitle || parentFamilyDisplayName || bucketDisplayName
          : evalDisplay
        units.push({
          unitKey: `eval:${bucketKey}`,
          familyKey: bucketKey,
          familyName: tileTitle,
          parentFamilyKey,
          parentFamilyDisplayName,
          category,
          kind: "single-eval",
          childKindLabel: views.length > 1 ? "slice" : null,
          views,
          primaryGroup: group,
        })
        continue
      }

      // Multi-eval composite — the view selector chooses among child evals
      // and each view exposes that eval's metrics in the bottom tab rail.
      // Rollup row = this eval IS the family root, i.e. its benchmark id
      // matches the family id. For multi-benchmark composites this is rare
      // (HELM Classic has no "helm-classic" benchmark), so rollup typically
      // stays null and the children render as siblings.
      const rollup =
        resolved.find(
          (r) =>
            r.evalEntry.benchmark_id != null &&
            r.evalEntry.benchmark_id === r.evalEntry.family_id,
        ) ?? null
      const children = rollup ? resolved.filter((r) => r !== rollup) : resolved
      const ordered: ResolvedGroup[] = rollup ? [rollup, ...children] : children

      const views: PlotboxView[] = ordered
        .map((r) => {
          const rawLabel = r.evalEntry.display_name || r.group.title
          const label =
            r === rollup ? "Overall" : stripFamilyPrefix(rawLabel, bucketDisplayName)
          const tabs = r.evalEntry.metrics
            .filter((metric) => !isStderrMetricId(metric.metric_summary_id))
            .map((metric) => {
              const variant = variantFor(r.group, metric.metric_summary_id)
              if (!variant) return null
              return metricTabFor(
                r.group,
                r.evalEntry,
                metric,
                variant,
                r === rollup
              )
            })
            .filter((tab): tab is PlotboxMetricTab => tab != null)

          if (tabs.length === 0) return null

          return {
            viewKey: r.evalEntry.evaluation_id,
            label: label || rawLabel,
            evalDisplayName: rawLabel,
            evalEntry: r.evalEntry,
            isRollup: r === rollup,
            group: r.group,
            tabs,
          }
        })
        .filter((view): view is PlotboxView => view != null)
      if (views.length === 0) continue

      let hasComponent = false
      let hasSlice = false
      let hasDistinctLeaves = false
      for (const r of children) {
        // "Distinct leaf" = this child has an identity distinct from the
        // family root. Two cases:
        //   1. Non-slice child (e.g. HELM/MMLU under HELM family).
        //   2. Slice whose parent benchmark is not the family itself
        //      (e.g. HELM/MMLU/anatomy — slice of MMLU under HELM, where
        //      parent="mmlu" ≠ family="helm"). In a singleton family the
        //      slice's parent equals the family and this case collapses
        //      back to "slice", as expected.
        const evalEntry = r.evalEntry
        const isDistinctLeaf =
          evalEntry.is_slice === false ||
          (evalEntry.parent_benchmark_id != null &&
            evalEntry.parent_benchmark_id !== evalEntry.family_id)
        if (isDistinctLeaf) {
          hasDistinctLeaves = true
        }
        if (r.group.variants[0]?.evaluation.benchmark_component_key ?? null) {
          hasComponent = true
        } else {
          hasSlice = true
        }
      }
      const childKindLabel: PlotboxUnit["childKindLabel"] =
        hasComponent && hasSlice
          ? "component"
          : hasComponent
            ? "metric"
            : hasDistinctLeaves
              ? "benchmark"
              : "slice"

      units.push({
        unitKey: `composite:${bucketKey}`,
        familyKey: bucketKey,
        familyName: bucketDisplayName,
        parentFamilyKey,
        parentFamilyDisplayName,
        category,
        kind: "multi-eval",
        childKindLabel,
        views,
        primaryGroup: (rollup ?? children[0] ?? resolved[0]).group,
      })
    }

    return units
  }, [comparisonIndex, filteredBenchmarkGroups, hierarchyIndex, sourcePrefixFamily])

  // Category-mode units: dedupe `plotboxUnits` by benchmark_index
  // canonical so that a benchmark reported by N evaluators (e.g. MMLU-Pro
  // under helm-capabilities, vals-ai, openeval, …) collapses into ONE
  // plotbox. The remaining sources re-enter as cross-family whisker
  // overlays inside `renderPlotbox` when `enableWhisker=true` (the
  // category view passes that flag). Source view preserves the
  // per-evaluator tiles — that's intentional, since source view is
  // exactly where the per-source breakdown lives.
  //
  // Splits never merge across suites — only benchmark-level identities
  // collapse here.
  const categoryPlotboxUnits = useMemo<PlotboxUnit[]>(() => {
    if (plotboxUnits.length === 0) return []
    const evalIdsForUnit = (unit: PlotboxUnit): string[] => {
      const out: string[] = []
      for (const view of unit.views) {
        for (const tab of view.tabs) {
          if (tab.evalSummaryId) out.push(tab.evalSummaryId)
        }
      }
      return out
    }
    const canonicalForUnit = (unit: PlotboxUnit): string | null => {
      // Poll each eval id under the unit; first benchmark_index hit
      // defines the unit's canonical identity. Composites often carry
      // several near-canonical variants (helm-classic has both `mmlu`
      // and `mmlu-pro`); first wins.
      for (const evalId of evalIdsForUnit(unit)) {
        const indexEntry = benchmarkIndexLookup.get(evalId)
        if (indexEntry) return indexEntry.canonicalKey
      }
      return null
    }
    const seenCanonical = new Set<string>()
    const out: PlotboxUnit[] = []
    for (const unit of plotboxUnits) {
      const canonical = canonicalForUnit(unit)
      if (canonical) {
        if (seenCanonical.has(canonical)) continue
        seenCanonical.add(canonical)
      }
      out.push(unit)
    }
    return out
  }, [plotboxUnits, benchmarkIndexLookup])

  const [activeViewByUnit, setActiveViewByUnit] = useState<Record<string, string>>({})
  const [activeMetricByUnit, setActiveMetricByUnit] = useState<Record<string, string>>({})
  const [expandedCategoriesByUnit, setExpandedCategoriesByUnit] = useState<Record<string, boolean>>({})

  const getActiveView = (unit: PlotboxUnit): PlotboxView => {
    const explicit = activeViewByUnit[unit.unitKey]
    if (explicit) {
      const match = unit.views.find((view) => view.viewKey === explicit)
      if (match) return match
    }
    return unit.views[0]
  }

  const getActiveMetricTab = (
    unit: PlotboxUnit,
    view: PlotboxView
  ): PlotboxMetricTab => {
    const explicit = activeMetricByUnit[unit.unitKey]
    if (explicit) {
      const match = view.tabs.find((tab) => tab.tabKey === explicit)
      if (match) return match
    }
    return view.tabs[0]
  }

  const submissionChipCopy = (
    axis: SubmissionAxis,
    count: number,
    headlineLabel?: string
  ): { short: string; long: string } | null => {
    if (count <= 1 || axis === "default") return null
    const others = count - 1
    const variantNoun = (n: number) => (n === 1 ? "variant" : "variants")
    switch (axis) {
      case "harness":
        return {
          short: `+${others} harness${others === 1 ? "" : "es"}`,
          long: headlineLabel
            ? `${headlineLabel} · +${others} harness${others === 1 ? "" : "es"}`
            : `+${others} harness${others === 1 ? "" : "es"}`,
        }
      case "variant":
        return {
          short: `+${others} ${variantNoun(others)}`,
          long: headlineLabel
            ? `${headlineLabel} · +${others} ${variantNoun(others)}`
            : `+${others} ${variantNoun(others)}`,
        }
      case "rerun":
        return {
          short: `+${others} re-run${others === 1 ? "" : "s"}`,
          long: headlineLabel
            ? `${headlineLabel} · +${others} re-run${others === 1 ? "" : "s"}`
            : `+${others} re-run${others === 1 ? "" : "s"}`,
        }
      case "mixed":
        return {
          short: `+${others} submissions`,
          long: `+${others} submissions`,
        }
    }
  }

  const reconcileHistogramScales = (
    hist: BenchmarkHistogram
  ): { hist: BenchmarkHistogram; rescaled: boolean; averaged: boolean } => {
    // Collect every numeric score (primary bar + per-submission re-runs) so we
    // can tell whether some records come in on a 0-1 scale while others are
    // on a 0-100 scale.
    const allScores: number[] = []
    for (const bar of hist.bars) {
      if (Number.isFinite(bar.score)) allScores.push(bar.score)
      for (const sub of bar.submissions ?? []) {
        if (Number.isFinite(sub.score)) allScores.push(sub.score)
      }
    }

    // Only reconcile score-like metrics (accuracy / proportion / percentage /
    // bare-number). Leave physical units like seconds, USD, ranks alone.
    const unitLc = (hist.unit ?? "").trim().toLowerCase()
    const isScoreLikeUnit =
      !unitLc ||
      unitLc === "percentage" ||
      unitLc === "percent" ||
      unitLc === "%" ||
      unitLc === "pct" ||
      unitLc === "accuracy" ||
      unitLc === "proportion" ||
      unitLc === "pass@1" ||
      unitLc === "score" ||
      unitLc === "rate"

    const lowCount = allScores.filter((s) => s > 0 && s <= 1).length
    const highCount = allScores.filter((s) => s > 1).length
    const needsRescale =
      isScoreLikeUnit && allScores.length >= 2 && lowCount > 0 && highCount > 0

    // Rescale the minority to match the majority. Break ties in favour of the
    // 0-100 scale since that's the app's default display.
    const rescaleLowTo100 = highCount >= lowCount
    const rescale = (score: number) => {
      if (!needsRescale || !Number.isFinite(score)) return score
      if (rescaleLowTo100 && score > 0 && score <= 1) return score * 100
      if (!rescaleLowTo100 && score > 1) return score / 100
      return score
    }

    let averaged = false
    const bars = hist.bars.map((bar) => {
      const rescaledSubmissions = bar.submissions?.map((sub) => ({
        ...sub,
        score: rescale(sub.score),
      }))
      const rescaledHeadline = rescale(bar.score)

      // If the model has more than one submission after rescaling, use their
      // mean as the headline bar value. Readers can still see the per-run
      // spread through the whisker and the dropdown.
      const submissionValues = (rescaledSubmissions ?? [])
        .map((sub) => sub.score)
        .filter((score) => Number.isFinite(score))
      const headlineScore =
        submissionValues.length > 1
          ? submissionValues.reduce((sum, s) => sum + s, 0) / submissionValues.length
          : rescaledHeadline
      if (submissionValues.length > 1) averaged = true

      return {
        ...bar,
        score: headlineScore,
        submissions: rescaledSubmissions,
      }
    })

    if (!needsRescale && !averaged) {
      return { hist, rescaled: false, averaged: false }
    }

    return { hist: { ...hist, bars }, rescaled: needsRescale, averaged }
  }

  const renderPlotbox = (unit: PlotboxUnit, enableWhisker: boolean = false) => {
    const activeView = getActiveView(unit)
    const activeTab = getActiveMetricTab(unit, activeView)
    if (!activeView || !activeTab) return null

    const hist = benchmarkHistograms.get(activeTab.histKey)

    // Fallback: no comparison rows loaded yet, or the metric has zero peers.
    // Still draw the current model's own bar from BenchmarkGroup data.
    const rawHist: BenchmarkHistogram = hist ?? {
      histKey: activeTab.histKey,
      evalSummaryId: activeTab.evalSummaryId,
      metricSummaryId: activeTab.metricSummaryId,
      metricName: activeTab.metricEntry.metric_name,
      metricGroup: activeTab.metricEntry.group,
      lowerIsBetter: Boolean(activeTab.metricEntry.lower_is_better),
      unit: activeTab.metricEntry.unit,
      bars: [
        {
          modelId: currentModelRouteId,
          modelName: getModelDisplayName(summary.model_info.name),
          score: activeTab.variant.result.score_details.score,
          isCurrent: true,
          isDefault: true,
          submissionCount: 1,
          submissionAxis: "default",
        },
      ],
      availableModels: [],
      defaultIds: new Set<string>(),
      currentModelRank: null,
      resolvedIsPercent: null,
    }

    // When a benchmark is reported on both 0-1 and 0-100 scales (e.g. Wordle
    // Arena's win_rate surfaces as 76.9 in one submission and 0.409 in another),
    // plotting raw scores squashes the 0-1 submissions to a flat zero. Rescale
    // the minority scale onto the majority before computing the chart domain.
    const { hist: activeHist, rescaled, averaged } = reconcileHistogramScales(rawHist)

    const scores = activeHist.bars.map((b) => b.score)
    const rawMax = Math.max(...scores)
    const rawMin = Math.min(...scores)
    const hasSpread = rawMax !== rawMin
    // Snap the auto-zoom domain to a coarse grid so plots with similar
    // ranges across the category-view grid land on the same boundaries
    // and look aligned. Step depends on the scale: 0.05 on proportion,
    // 5 on percent. Pad outward (floor below, ceil above) so the bars
    // never spill over the chart frame. Scale comes from the producer
    // when resolved (spec F5); the magnitude guess covers old snapshots.
    const isPercentScale =
      activeHist.resolvedIsPercent ??
      Math.max(Math.abs(rawMin), Math.abs(rawMax)) > 1.5
    const snapStep = isPercentScale ? 5 : 0.05
    const padBelow = hasSpread ? (rawMax - rawMin) * 0.15 : 0
    const padAbove = hasSpread ? (rawMax - rawMin) * 0.15 : 0
    const rawDomainMin = hasSpread ? rawMin - padBelow : Math.min(0, rawMin)
    const rawDomainMax = hasSpread
      ? rawMax + padAbove
      : rawMax === 0
        ? 1
        : rawMax * 1.2
    const domainMin = Math.floor(rawDomainMin / snapStep) * snapStep
    const domainMax = Math.ceil(rawDomainMax / snapStep) * snapStep
    const range = domainMax - domainMin || 1

    const bestScore = activeHist.lowerIsBetter ? rawMin : rawMax
    const worstScore = activeHist.lowerIsBetter ? rawMax : rawMin
    let bestBarId: string | null = null
    let worstBarId: string | null = null
    if (hasSpread) {
      for (const b of activeHist.bars) {
        if (!bestBarId && b.score === bestScore) bestBarId = b.modelId
        if (!worstBarId && b.score === worstScore) worstBarId = b.modelId
      }
    }

    // Cross-family score range: when this benchmark also reports under
    // sibling families (per hierarchy.json's `benchmark_index[]`), look up
    // this model's score on each sibling and treat the resulting set as a
    // whisker overlay on the current bar. The match is by metric_name —
    // sibling evals use different metric_summary_ids but the same metric
    // (e.g. "accuracy" on AIME shows up in both artificial-analysis and
    // llm-stats). Best-effort: any sibling without a name-matching metric
    // simply doesn't contribute.
    const crossFamilyContribs = (() => {
      if (!enableWhisker) return [] as Array<{ familyName: string; score: number }>
      if (!comparisonIndex) return [] as Array<{ familyName: string; score: number }>
      const indexEntry = benchmarkIndexLookup.get(activeTab.evalSummaryId)
      if (!indexEntry) return []
      const targetMetricName = activeTab.metricEntry.metric_name?.toLowerCase().trim() ?? ""
      // Producers label the same metric differently across families
      // ("Score" / "Accuracy" / "Acc" all refer to AIME's pass rate). To
      // make the whisker fire across these, match siblings in priority:
      //   1. exact metric_name (case-insensitive)
      //   2. metric_summary_id local-part (e.g. both end in `:score`)
      //   3. fall back to the sibling's first metric — best-effort, the
      //      benchmark_index already vouches for canonical equality.
      const targetMetricLocal = activeTab.metricEntry.metric_summary_id
        ?.split("%3A")
        .pop()
        ?.toLowerCase()
        .trim()
      // `by_model` is keyed by URL-encoded model_route_id (`anthropic%2F…`)
      // but the page-level fallback for `currentModelRouteId` produces the
      // underscore form when no explicit route id is in `summary.model_info`.
      // Mirror the histogram-builder's two-pronged identity match so the
      // whisker fires even when the by_model lookup misses: scan the
      // sibling metric's `scores[]` and accept any row whose route or family
      // id is in `currentModelIdentityKeys`.
      const byModel = comparisonIndex.by_model?.[currentModelRouteId] ?? {}
      const familyDisplayByKey = new Map<string, string>()
      for (const fam of evalHierarchy?.families ?? []) {
        familyDisplayByKey.set(fam.key, fam.display_name)
      }

      // Cross-family scores often arrive on different scales: vals-ai
      // reports AIME accuracy as a 0–100 percent (22.292) while
      // artificial-analysis reports the same benchmark as a 0–1 proportion
      // (0.355). Reconcile to the active histogram's scale before
      // computing the whisker so the band reflects real spread, not unit
      // mismatch. Same heuristic the bar-rescaler uses: if the active
      // histogram's bars are mostly >1, treat sibling raw scores ≤1 as
      // proportions and bump them up to match.
      const histScores = activeHist.bars
        .map((b) => b.score)
        .filter((s) => Number.isFinite(s))
      const histMaxAbs = histScores.length ? Math.max(...histScores.map(Math.abs)) : 1
      // Producer-resolved scale when available (spec F5); magnitude guess
      // only for old snapshots / bounds-less metrics.
      const histIsPercent = activeHist.resolvedIsPercent ?? histMaxAbs > 1.5
      const reconcileSibling = (score: number, siblingMetricUnit: string | null | undefined): number => {
        const u = (siblingMetricUnit ?? "").toLowerCase().trim()
        const siblingIsPercent =
          u === "percent" || u === "percentage" || u === "%" || u === "pct" ||
          (!["proportion", "rate"].includes(u) && Math.abs(score) > 1.5)
        if (histIsPercent === siblingIsPercent) return score
        return histIsPercent ? score * 100 : score / 100
      }

      const collected: Array<{ familyKey: string; familyName: string; score: number }> = []
      for (const siblingId of indexEntry.siblingEvalIds) {
        if (siblingId === activeTab.evalSummaryId) continue
        const siblingEval = comparisonIndex.evals[siblingId]
        if (!siblingEval || siblingEval.metrics.length === 0) continue
        const matchByName = siblingEval.metrics.find(
          (m) => m.metric_name?.toLowerCase().trim() === targetMetricName,
        )
        const matchByLocal = !matchByName && targetMetricLocal
          ? siblingEval.metrics.find(
              (m) => m.metric_summary_id?.split("%3A").pop()?.toLowerCase().trim() === targetMetricLocal,
            )
          : null
        const siblingMetric = matchByName ?? matchByLocal ?? siblingEval.metrics[0]
        let siblingCell: CanonicalScaleCell | null = null
        const byModelCell = byModel[siblingId]?.[siblingMetric.metric_summary_id]
        if (byModelCell != null && Number.isFinite(byModelCell.score)) {
          siblingCell = {
            score: byModelCell.score,
            scoreCanonical: byModelCell.score_canonical,
            scaleConversion: byModelCell.scale_conversion,
            unit: siblingMetric.unit ?? null,
          }
        } else {
          // Fallback: scan scores[] for a row matching any of the model's
          // identity keys. Covers route-id encoding mismatches.
          for (const row of siblingMetric.scores) {
            if (
              currentModelIdentityKeys.has(row.model_route_id) ||
              currentModelIdentityKeys.has(row.model_group_id)
            ) {
              if (Number.isFinite(row.score)) {
                siblingCell = {
                  score: row.score,
                  scoreCanonical: row.score_canonical,
                  scaleConversion: row.scale_conversion,
                  unit: siblingMetric.unit ?? null,
                }
                break
              }
            }
          }
        }
        if (siblingCell == null) continue
        // Exact path (spec F5): when the active histogram's scale is
        // producer-resolved and the sibling cell carries a usable canonical
        // value, map it onto the histogram scale directly — no guessing.
        // Flagged or old-snapshot sibling cells keep the legacy heuristic
        // for that row.
        const siblingCellScale =
          activeHist.resolvedIsPercent != null
            ? canonicalCellIsPercent(siblingCell, {
                min: siblingMetric.canonical_min_score,
                max: siblingMetric.canonical_max_score,
              })
            : null
        const reconciledScore =
          siblingCellScale != null && siblingCell.scoreCanonical != null
            ? scaleOnto(siblingCell.scoreCanonical, siblingCellScale, histIsPercent)
            : reconcileSibling(siblingCell.score, siblingMetric.unit)
        const familyKey = siblingId.split("%2F")[0]
        const familyName = familyDisplayByKey.get(familyKey) ?? familyKey
        collected.push({ familyKey, familyName, score: reconciledScore })
      }
      // Aggregator-only dedup: llm-stats republishes canonical sources'
      // numbers, so when its score byte-equals an independent
      // evaluator's (or matches the active bar) we drop the llm-stats
      // copy. Two independent evaluators that happen to land on the
      // same number both count toward the whisker — that's confirming
      // signal worth surfacing.
      const isAggregator = (familyKey: string) => familyKey === "llm-stats"
      collected.sort((a, b) => {
        const aAgg = isAggregator(a.familyKey) ? 1 : 0
        const bAgg = isAggregator(b.familyKey) ? 1 : 0
        return aAgg - bAgg
      })
      const ownScoreNum = activeTab.variant.result.score_details.score
      const seenScores = new Set<string>(
        Number.isFinite(ownScoreNum) ? [ownScoreNum.toFixed(8)] : [],
      )
      const deduped: Array<{ familyName: string; score: number }> = []
      for (const c of collected) {
        const key = c.score.toFixed(8)
        if (isAggregator(c.familyKey) && seenScores.has(key)) continue
        seenScores.add(key)
        deduped.push({ familyName: c.familyName, score: c.score })
      }
      return deduped
    })()
    const ownScore = activeTab.variant.result.score_details.score
    const crossFamilyScores = [
      ...crossFamilyContribs.map((c) => c.score),
      ...(Number.isFinite(ownScore) ? [ownScore] : []),
    ]
    const hasCrossFamilyWhisker = crossFamilyContribs.length > 0
    const crossFamilyMin = hasCrossFamilyWhisker ? Math.min(...crossFamilyScores) : null
    const crossFamilyMax = hasCrossFamilyWhisker ? Math.max(...crossFamilyScores) : null

    // Stderr-based whisker for the current model's bar. With cross-family
    // overlays moved into the dedicated Overlaps view, stderr (when the
    // producer ships a paired `_stderr` metric) is the more useful
    // statistical cue here: it's the metric's own sampling-error,
    // independent of how many other suites also report this benchmark.
    // Reconciles to the histogram's display scale exactly like the
    // primary bar does so the whisker doesn't shrink when the score is
    // rescaled from 0-1 to 0-100.
    const stderrRaw = activeTab.variant.auxStderr
    const stderrUnit = activeTab.variant.auxStderrUnit
    const stderrIsPercent = (() => {
      const u = (stderrUnit ?? "").toLowerCase().trim()
      if (u === "percent" || u === "percentage" || u === "%" || u === "pct") return true
      if (u === "proportion" || u === "rate") return false
      return null
    })()
    const stderrReconciled = (() => {
      if (stderrRaw == null || !Number.isFinite(stderrRaw)) return null
      // Match the active histogram's scale: if bars are mostly 0-100 and the
      // stderr looks like a 0-1 proportion, scale up. Same heuristic as the
      // sibling reconciler, applied to a single value.
      const histScores = activeHist.bars
        .map((b) => b.score)
        .filter((s) => Number.isFinite(s))
      const histMaxAbs = histScores.length ? Math.max(...histScores.map(Math.abs)) : 1
      // Producer-resolved scale when available (spec F5). The stderr value
      // itself comes from the summary payload (no canonical fields), so
      // its own scale below still relies on unit / magnitude fallbacks.
      const histIsPercent = activeHist.resolvedIsPercent ?? histMaxAbs > 1.5
      let isPercent = stderrIsPercent
      if (isPercent == null) {
        // Fallback: assume stderr matches the bar's score scale.
        isPercent = Math.abs(activeTab.variant.result.score_details.score) > 1.5
      }
      if (histIsPercent === isPercent) return stderrRaw
      return histIsPercent ? stderrRaw * 100 : stderrRaw / 100
    })()
    const hasStderrWhisker =
      stderrReconciled != null &&
      Number.isFinite(stderrReconciled) &&
      stderrReconciled > 0 &&
      Number.isFinite(ownScore)
    const stderrLow = hasStderrWhisker ? ownScore - stderrReconciled! : null
    const stderrHigh = hasStderrWhisker ? ownScore + stderrReconciled! : null
    void enableWhisker

    const rank = activeHist.currentModelRank
    const plotboxKey = unit.unitKey
    const hasViewSelector = unit.views.length > 1
    const hasMetricTabs = activeView.tabs.length > 1
    const activeViewIndex = Math.max(
      0,
      unit.views.findIndex((view) => view.viewKey === activeView.viewKey)
    )
    const childKindCount = unit.views.length - (unit.views.some((view) => view.isRollup) ? 1 : 0)
    const showChildKindBadge =
      hasViewSelector && unit.childKindLabel != null && childKindCount > 0
    const childKindPlural =
      unit.childKindLabel === "metric"
        ? childKindCount === 1 ? "metric" : "metrics"
        : unit.childKindLabel === "slice"
          ? childKindCount === 1 ? "slice" : "slices"
          : unit.childKindLabel === "benchmark"
            ? childKindCount === 1 ? "benchmark" : "benchmarks"
            : childKindCount === 1 ? "component" : "components"
    const setPlotboxActiveView = (nextViewKey: string) =>
      setActiveViewByUnit((prev) => ({
        ...prev,
        [unit.unitKey]: nextViewKey,
      }))
    const setPlotboxActiveMetric = (nextTabKey: string) =>
      setActiveMetricByUnit((prev) => ({
        ...prev,
        [unit.unitKey]: nextTabKey,
      }))

    return (
      <div
        key={plotboxKey}
        className="flex h-full flex-col border-r border-b border-[color:var(--border-soft)] bg-[color:var(--bg)] p-5 transition-colors hover:bg-[color:var(--bg-warm)]"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {(() => {
                // Surface every curated category tag the benchmark
                // carries (same list `categoriesForUnit` uses to bucket
                // the unit into multiple sections in category-mode), not
                // just the primary. Falls back to the unit's own
                // category when no tags exist. Truncates to the top 2
                // with a "+N" pill that expands inline — Helm Lite has
                // 7+ tags and was wrapping past the unit width.
                const seen = new Set<string>()
                const tagList: string[] = []
                for (const view of unit.views) {
                  for (const tab of view.tabs) {
                    const evalId = tab.evalSummaryId
                    if (!evalId) continue
                    const tags = hierarchyIndex?.get(evalId)?.tags
                    if (!tags) continue
                    for (const t of tags) {
                      const k = t.toLowerCase().trim().replace(/\s+/g, "_")
                      if (!seen.has(k)) {
                        seen.add(k)
                        tagList.push(k)
                      }
                    }
                  }
                }
                const categories = tagList.length > 0
                  ? tagList
                  : [unit.category as unknown as string]
                const VISIBLE = 2
                const expanded = expandedCategoriesByUnit[unit.unitKey] ?? false
                const showAll = expanded || categories.length <= VISIBLE
                const visible = showAll ? categories : categories.slice(0, VISIBLE)
                const hiddenCount = categories.length - visible.length
                return (
                  <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)] font-semibold">
                    {visible.map((c, i) => (
                      <span key={c}>
                        {i > 0 && <span className="mx-1 text-[color:var(--fg-subtle)] opacity-60">·</span>}
                        {formatTagLabel(c)}
                      </span>
                    ))}
                    {hiddenCount > 0 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setExpandedCategoriesByUnit((prev) => ({
                            ...prev,
                            [unit.unitKey]: true,
                          }))
                        }}
                        className="ml-1 inline-flex items-center px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.15em] text-[color:var(--accent)] border border-[color:var(--accent)] hover:bg-[color:var(--accent)] hover:text-[color:var(--bg)] transition-colors"
                        title={`Show all ${categories.length} categories`}
                      >
                        +{hiddenCount}
                      </button>
                    )}
                    {expanded && categories.length > VISIBLE && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setExpandedCategoriesByUnit((prev) => ({
                            ...prev,
                            [unit.unitKey]: false,
                          }))
                        }}
                        className="ml-1 inline-flex items-center px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)] hover:text-[color:var(--fg)] transition-colors"
                        title="Show fewer categories"
                      >
                        ↑
                      </button>
                    )}
                  </span>
                )
              })()}
              {showChildKindBadge && (
                <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]">
                  · {childKindCount} {childKindPlural}
                </span>
              )}
              {rank && (
                <span className="font-mono text-[10px] tabular-nums text-[color:var(--fg)] font-semibold">
                  #{rank.position}{rank.total ? `/${rank.total}` : ""}
                </span>
              )}
              {(() => {
                const relationship =
                  activeTab.variant.evaluation.source_metadata.evaluator_relationship
                if (!relationship) return null
                const isFirst = relationship === "first_party"
                return (
                  <span
                    className={`font-mono text-[9px] uppercase tracking-[0.15em] ${isFirst ? "text-[color:var(--fg-muted)]" : "text-[color:var(--accent)]"}`}
                    title={
                      relationship === "first_party"
                        ? "Reported by the model's developer (first-party)."
                        : relationship === "third_party"
                          ? "Reported by an independent third party."
                          : relationship === "collaborative"
                            ? "Collaborative report by the developer and a third party."
                            : undefined
                    }
                  >
                    · {getRelationshipShortLabel(relationship)}
                  </span>
                )
              })()}
            </div>
            <button
              type="button"
              onClick={() => jumpToDeepDive(activeView.group.key)}
              className="mt-2 block w-full truncate text-left text-[15px] font-semibold tracking-[-0.01em] text-[color:var(--fg)] hover:text-[color:var(--accent)] transition-colors"
              title={humanizeBenchmarkName(unit.familyName)}
            >
              {humanizeBenchmarkName(unit.familyName)}
            </button>
            <div className="mt-1 flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]">
              <span>{activeHist.lowerIsBetter ? "Lower is better" : "Higher is better"}</span>
              {hasStderrWhisker && (
                <span
                  className="ml-1 inline-flex items-center gap-1 border border-[color:var(--accent)] px-1.5 py-px text-[color:var(--accent)]"
                  title={`Whisker = ±1 stderr (σ ${formatRawScoreValue(stderrReconciled!, activeHist.unit ?? undefined)})`}
                >
                  · ↕ ±σ
                </span>
              )}
              {!hasStderrWhisker && hasCrossFamilyWhisker && (
                <span
                  className="ml-1 inline-flex items-center gap-1 border border-[color:var(--accent)] px-1.5 py-px text-[color:var(--accent)]"
                  title={`Whisker spans this model's score across ${crossFamilyContribs.length + 1} source${crossFamilyContribs.length === 0 ? "" : "s"} after exact-score dedup.`}
                >
                  · ↕ {crossFamilyContribs.length + 1} sources
                </span>
              )}
              {(averaged || rescaled) && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="Chart notes"
                      className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-muted-foreground/70 hover:text-foreground"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Info className="h-3 w-3" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="max-w-[18rem] p-3 text-[11px] normal-case tracking-normal text-muted-foreground"
                  >
                    <div className="space-y-2">
                      {averaged && (
                        <div>
                          <div className="font-semibold text-foreground">Bar = mean of re-runs</div>
                          <div>
                            Bars show the mean across submissions for each model. Whiskers and the
                            dropdown show individual re-runs.
                          </div>
                        </div>
                      )}
                      {rescaled && (
                        <div>
                          <div className="font-semibold text-foreground">Scales aligned</div>
                          <div>
                            Submissions arrived on different scales (e.g. 0-1 and 0-100). The
                            minority scale was auto-rescaled to match the majority.
                          </div>
                        </div>
                      )}
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>
          {activeHist.availableModels.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-7 shrink-0 rounded-full p-0"
                  aria-label="Add a model to this histogram"
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="max-h-72 w-64 overflow-y-auto"
              >
                <DropdownMenuLabel className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  Add model
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {activeHist.availableModels.slice(0, 80).map((m) => (
                  <DropdownMenuItem
                    key={m.id}
                    onSelect={() => {
                      setExtraModelsByBenchmark((prev) => {
                        const current = prev[activeHist.histKey] ?? []
                        if (current.includes(m.id)) return prev
                        return { ...prev, [activeHist.histKey]: [...current, m.id] }
                      })
                    }}
                    className="flex items-center justify-between gap-4 text-xs"
                  >
                    <span className="truncate">{getModelDisplayName(m.name)}</span>
                    <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                      {formatRawScoreValue(m.score)}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* Suppress the embed-this affordance when we're already
              rendering inside an embed iframe — otherwise the embedded
              histogram shows its own "embed this" button, which links
              back to itself. */}
          {activeTab.evalSummaryId && !embedHistogramOnly && (
            <EmbedButton
              embedPath={`/embed/eval/histogram/${routeIdToPath(activeTab.evalSummaryId)}?model=${encodeURIComponent(routeIdToPath(summary.model_info.id))}`}
              label="Histogram"
              defaultHeight={360}
              size="sm"
            />
          )}
        </div>

        {/* View selector */}
        {hasViewSelector && (
          <div className="mt-3 border-t border-[color:var(--border-soft)] pt-2">
            <div className="flex items-center justify-between gap-3">
              <span className="kicker">View</span>
              <span className="font-mono text-[9px] tabular-nums text-[color:var(--fg-subtle)]">
                {activeViewIndex + 1}/{unit.views.length}
              </span>
            </div>
            <div className="mt-1.5">
              <select
                className="ec-select w-full"
                value={activeView.viewKey}
                onChange={(e) => setPlotboxActiveView(e.target.value)}
              >
                {unit.views.map((view) => (
                  <option key={view.viewKey} value={view.viewKey}>
                    {normalizeDisplayLabel(view.label.replace(/^artificial_analysis\.?/i, ""))}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Metric tabs live above the chart (next to the view selector)
            rather than below it. Keeping all variable-height controls on
            the same side of the chart means the only thing between the
            chart and the card bottom is the deep-dive link, which is
            constant — so bar baselines align across the grid. */}
        {hasMetricTabs && (
          <div className="mt-3 flex flex-wrap gap-1">
            {activeView.tabs.map((tab) => (
              <button
                key={tab.tabKey}
                type="button"
                onClick={() => setPlotboxActiveMetric(tab.tabKey)}
                className={`ec-pill ${tab.tabKey === activeTab.tabKey ? "on" : ""}`}
                style={{ fontSize: 9, padding: "4px 9px", letterSpacing: "0.08em" }}
              >
                {normalizeDisplayLabel(tab.label.replace(/^artificial_analysis\.?/i, ""))}
              </button>
            ))}
          </div>
        )}

        {hasSpread && domainMin > 0.0001 && (
          <div className="mt-2 flex items-center justify-center gap-1.5 text-[9px] text-muted-foreground/80">
            <svg
              aria-hidden
              width="14"
              height="8"
              viewBox="0 0 14 8"
              className="shrink-0"
            >
              <path
                d="M0 4 L3 4 L5 1 L7 7 L9 1 L11 7 L14 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
            <span className="font-mono tabular-nums">
              axis zoomed: {formatRawScoreValue(domainMin, activeHist.unit ?? undefined)} –{" "}
              {formatRawScoreValue(domainMax, activeHist.unit ?? undefined)}
            </span>
          </div>
        )}

        {/* Spacer pushes the chart to the bottom of the card so bar baselines
            align across plotboxes regardless of whether a tab row is present. */}
        <div className="flex-1" />

        {/* Chart */}
        <div
          className="relative mt-4 grid gap-1.5"
          style={{
            gridTemplateColumns: `repeat(${activeHist.bars.length}, minmax(0, 1fr))`,
          }}
        >
          {activeHist.bars.map((bar) => {
            const normalized = (bar.score - domainMin) / range
            const clampedNorm = Math.max(Math.min(normalized, 1), 0)
            const heightPct = Math.max(clampedNorm * 100, 4)
            const isExtra = !activeHist.defaultIds.has(bar.modelId) && !bar.isCurrent
            const isBest = bar.modelId === bestBarId && !bar.isCurrent
            const isWorst =
              bar.modelId === worstBarId && !bar.isCurrent && bestBarId !== worstBarId
            const submissionScores = (bar.submissions ?? [])
              .map((submission) => submission.score)
              .filter((score) => Number.isFinite(score))
            const minSubmissionScore = submissionScores.length >= 2 ? Math.min(...submissionScores) : null
            const maxSubmissionScore = submissionScores.length >= 2 ? Math.max(...submissionScores) : null
            const minSubmissionPct =
              minSubmissionScore != null
                ? Math.max(0, Math.min(100, ((minSubmissionScore - domainMin) / range) * 100))
                : null
            const maxSubmissionPct =
              maxSubmissionScore != null
                ? Math.max(0, Math.min(100, ((maxSubmissionScore - domainMin) / range) * 100))
                : null
            const submissionSpanPct =
              minSubmissionPct != null && maxSubmissionPct != null
                ? Math.max(maxSubmissionPct - minSubmissionPct, 0.8)
                : 0

            return (
              <div
                key={bar.modelId}
                data-model-bar={bar.modelId}
                data-bar-current={bar.isCurrent ? "1" : "0"}
                className="group flex min-w-0 flex-col items-center"
              >
                <div className="relative flex h-44 w-full items-end">
                  <div
                    className={`w-full rounded-t-sm transition-all duration-300 ${
                      bar.isCurrent
                        ? "shadow-[0_1px_0_rgba(90,170,209,0.18)]"
                        : isExtra
                          ? "bg-amber-300/70 dark:bg-amber-400/60"
                          : isBest
                            ? "bg-muted-foreground/60"
                            : isWorst
                              ? "bg-muted-foreground/15"
                              : "bg-muted-foreground/30"
                    }`}
                    style={{
                      height: `${heightPct}%`,
                      ...(bar.isCurrent
                        ? {
                            background:
                              "linear-gradient(to top, #5aaad1, #9bcbe3)",
                          }
                        : {}),
                    }}
                  />
                  {minSubmissionPct != null && maxSubmissionPct != null && (
                    <div
                      className="absolute inset-x-0"
                      style={{
                        bottom: `${minSubmissionPct}%`,
                        height: `${submissionSpanPct}%`,
                      }}
                      title={`Reported run range: ${formatRawScoreValue(minSubmissionScore!, activeHist.unit ?? undefined)} to ${formatRawScoreValue(maxSubmissionScore!, activeHist.unit ?? undefined)}`}
                      aria-hidden="true"
                    >
                      <span className="absolute bottom-0 left-1/2 h-full w-px -translate-x-1/2 rounded-full bg-foreground/35" />
                      <span className="absolute bottom-0 left-1/2 h-px w-3 -translate-x-1/2 rounded-full bg-foreground/35" />
                      <span className="absolute left-1/2 top-0 h-px w-3 -translate-x-1/2 rounded-full bg-foreground/35" />
                    </div>
                  )}
                  {bar.isCurrent && hasStderrWhisker && (() => {
                    const minPct = Math.max(
                      0,
                      Math.min(100, ((stderrLow! - domainMin) / range) * 100),
                    )
                    const maxPct = Math.max(
                      0,
                      Math.min(100, ((stderrHigh! - domainMin) / range) * 100),
                    )
                    const spanPct = Math.max(maxPct - minPct, 0.8)
                    const tooltip =
                      `±1 stderr: ${formatRawScoreValue(stderrLow!, activeHist.unit ?? undefined)}` +
                      ` – ${formatRawScoreValue(stderrHigh!, activeHist.unit ?? undefined)}` +
                      ` (σ ${formatRawScoreValue(stderrReconciled!, activeHist.unit ?? undefined)})`
                    return (
                      <div
                        className="absolute inset-x-0"
                        style={{ bottom: `${minPct}%`, height: `${spanPct}%`, color: "var(--accent)" }}
                        title={tooltip}
                        aria-hidden="true"
                      >
                        <span className="absolute bottom-0 left-1/2 h-full w-px -translate-x-1/2 rounded-full bg-current" />
                        <span className="absolute bottom-0 left-1/2 h-px w-4 -translate-x-1/2 rounded-full bg-current" />
                        <span className="absolute left-1/2 top-0 h-px w-4 -translate-x-1/2 rounded-full bg-current" />
                      </div>
                    )
                  })()}
                  {bar.isCurrent && !hasStderrWhisker && hasCrossFamilyWhisker && (() => {
                    const minPct = Math.max(
                      0,
                      Math.min(100, ((crossFamilyMin! - domainMin) / range) * 100),
                    )
                    const maxPct = Math.max(
                      0,
                      Math.min(100, ((crossFamilyMax! - domainMin) / range) * 100),
                    )
                    const spanPct = Math.max(maxPct - minPct, 0.8)
                    const tooltip =
                      `Cross-family range: ${formatRawScoreValue(crossFamilyMin!, activeHist.unit ?? undefined)}` +
                      ` – ${formatRawScoreValue(crossFamilyMax!, activeHist.unit ?? undefined)}` +
                      ` across ${crossFamilyContribs.length + 1} family appearance${crossFamilyContribs.length === 0 ? "" : "s"}: ` +
                      crossFamilyContribs
                        .map((c) => `${c.familyName} ${formatRawScoreValue(c.score, activeHist.unit ?? undefined)}`)
                        .join(", ")
                    return (
                      <div
                        className="absolute inset-x-0"
                        style={{ bottom: `${minPct}%`, height: `${spanPct}%`, color: "var(--accent)" }}
                        title={tooltip}
                        aria-hidden="true"
                      >
                        <span className="absolute bottom-0 left-1/2 h-full w-px -translate-x-1/2 rounded-full bg-current" />
                        <span className="absolute bottom-0 left-1/2 h-px w-4 -translate-x-1/2 rounded-full bg-current" />
                        <span className="absolute left-1/2 top-0 h-px w-4 -translate-x-1/2 rounded-full bg-current" />
                      </div>
                    )
                  })()}
                  <div
                    className="pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-semibold tabular-nums text-foreground/80"
                    style={{ bottom: `calc(${heightPct}% + 2px)` }}
                    title={formatRawScoreValue(bar.score, activeHist.unit ?? undefined)}
                  >
                    {formatRawScoreValue(bar.score)}
                  </div>
                  {isExtra && (
                    <button
                      type="button"
                      aria-label={`Remove ${bar.modelName}`}
                      onClick={() => {
                        setExtraModelsByBenchmark((prev) => {
                          const next = (prev[activeHist.histKey] ?? []).filter(
                            (id) => id !== bar.modelId
                          )
                          const copy = { ...prev }
                          if (next.length === 0) delete copy[activeHist.histKey]
                          else copy[activeHist.histKey] = next
                          return copy
                        })
                      }}
                      className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-border/80 bg-background text-muted-foreground shadow-sm transition hover:text-destructive group-hover:flex"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  )}
                </div>
                <div
                  className={`mt-1.5 w-full truncate text-center text-[10px] leading-tight ${
                    bar.isCurrent
                      ? "font-semibold text-foreground"
                      : "text-muted-foreground"
                  }`}
                  title={bar.modelName}
                >
                  {bar.modelName}
                </div>
                {(() => {
                  const chip = submissionChipCopy(
                    bar.submissionAxis,
                    bar.submissionCount,
                    bar.headlineRunLabel
                  )
                  if (!chip) return null
                  const submissions = bar.submissions ?? []
                  const trigger = (
                    <button
                      type="button"
                      className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate rounded-full border border-border/60 bg-muted/20 px-1.5 py-[1px] text-[9px] font-medium text-muted-foreground hover:text-foreground"
                      title={chip.long}
                    >
                      {chip.short}
                    </button>
                  )
                  if (submissions.length === 0) return trigger
                  return (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
                      <DropdownMenuContent align="center" className="max-h-72 w-72 overflow-y-auto">
                        <DropdownMenuLabel className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                          <span>{bar.modelName}</span>
                          <span className="font-mono tabular-nums">{chip.short}</span>
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {submissions.map((s, i) => (
                          <DropdownMenuItem
                            key={`${s.run_kind}::${s.run_label}::${i}`}
                            className="flex items-center justify-between gap-3 text-xs"
                            onSelect={(e) => e.preventDefault()}
                          >
                            <span className="min-w-0 flex-1 truncate">
                              <span className="mr-1 rounded bg-muted px-1 py-[1px] text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                                {s.run_kind}
                              </span>
                              {s.run_label}
                            </span>
                            <span className="font-mono tabular-nums">
                              {formatRawScoreValue(s.score, activeHist.unit ?? undefined)}
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )
                })()}
              </div>
            )
          })}
        </div>

        {/* Split-aware peer caption. Only present on snapshots that
            declare comparison_index_version >= 2. */}
        {activeHist.caption && (
          <div className="mt-2 text-[10px] leading-relaxed text-[color:var(--fg-muted)]">
            <PeerCaption
              caption={activeHist.caption}
              currentLabel={activeHist.currentSplitLabel ?? null}
            />
            {activeHist.sourceRank && (
              <span className="text-[color:var(--fg-subtle)]">
                {" · "}
                {activeHist.sourceRank.position} of {activeHist.sourceRank.total} on{" "}
                {activeHist.sourceRank.sourceDisplayName}
              </span>
            )}
          </div>
        )}

        {/* Axis-zoomed caption + metric tabs moved above the chart —
            see the matching blocks next to the view selector. Anything
            that would push the bar baseline up belongs above the chart
            so the deep-dive link is the only thing below it. */}

        <div className="mt-3 border-t border-[color:var(--border-soft)] pt-3">
          {embedHistogramOnly ? (
            // Inside the embed iframe the deep-dive modal has no host to
            // mount into (the dialog lives in the main return block, which
            // the embed early-return skips) and wouldn't fit the tiny frame
            // anyway. Link out to the full card with the deep dive
            // pre-opened via ?deepDive=, in a new tab so we don't navigate
            // the third-party host page.
            <a
              href={`/models/${routeIdToPath(summary.model_info.id)}?deepDive=${encodeURIComponent(activeView.group.key)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--fg-muted)] hover:text-[color:var(--accent)] transition-colors"
            >
              View deep dive ↗
            </a>
          ) : (
            <button
              type="button"
              onClick={() => jumpToDeepDive(activeView.group.key)}
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--fg-muted)] hover:text-[color:var(--accent)] transition-colors"
            >
              View deep dive →
            </button>
          )}
        </div>

        {!hist && (
          <div className="mt-2 font-mono text-[9px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]">
            {comparisonIndex ? "No peer scores for this metric." : "Loading comparison data…"}
          </div>
        )}
      </div>
    )
  }

  const documentedPct = Math.round(
    (summary.total_evaluations > 0 && reproducibilityResultsTotal > 0
      ? Math.max(0, reproducibilityResultsTotal - reproducibilityGapCount) / reproducibilityResultsTotal
      : 1) * 100
  )

  // When embedSurface is set the page renders just that one block
  // (e.g. "reported-metrics" → only §4). Used by /embed/.../...
  // routes so an iframe carries a single chart with no chrome.
  const embedReportedMetricsOnly = embedSurface === "reported-metrics"
  const embedHistogramOnly = embedSurface === "histogram"

  // Histogram embed — find the plotbox unit + view + metric tab whose
  // tab.evalSummaryId matches the requested target. Category-mode units
  // get first dibs so the embed picks up the cross-family whisker (the
  // same dedupe the on-page Category view performs). Falls back to the
  // raw plotboxUnits when no category match is found.
  const embedHistogramTarget = useMemo(() => {
    if (!embedHistogramOnly || !embedTargetEvalId) return null
    const search = (units: PlotboxUnit[]) => {
      for (const unit of units) {
        for (const view of unit.views) {
          for (const tab of view.tabs) {
            if (tab.evalSummaryId === embedTargetEvalId) {
              return { unit, view, tab }
            }
          }
        }
      }
      return null
    }
    return search(categoryPlotboxUnits) ?? search(plotboxUnits) ?? null
  }, [embedHistogramOnly, embedTargetEvalId, categoryPlotboxUnits, plotboxUnits])

  // Drive the unit's view/metric selection to the matched tab so the
  // initial render lands on the same metric the user saw on the page.
  useEffect(() => {
    if (!embedHistogramTarget) return
    const { unit, view, tab } = embedHistogramTarget
    setActiveViewByUnit((prev) =>
      prev[unit.unitKey] === view.viewKey ? prev : { ...prev, [unit.unitKey]: view.viewKey },
    )
    setActiveMetricByUnit((prev) =>
      prev[unit.unitKey] === tab.tabKey ? prev : { ...prev, [unit.unitKey]: tab.tabKey },
    )
  }, [embedHistogramTarget])

  // Histogram embed renders just the matched plotbox tile and nothing
  // else — no header, no §1-4. We use a thin shell that keeps the
  // plotbox sized to fill the iframe.
  if (embedHistogramOnly) {
    if (!embedHistogramTarget) {
      return (
        <div className="font-mono" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
          No histogram available for this model/benchmark pair.
        </div>
      )
    }
    // The plotbox tile draws its own right + bottom borders assuming the
    // grid container supplies the top + left. Wrap with a single-cell
    // grid that adds the missing borders so the tile has a clean frame
    // when it's the only thing on the page.
    return (
      <div className="grid grid-cols-1 border-t border-l border-[color:var(--border-soft)]">
        {renderPlotbox(embedHistogramTarget.unit, true)}
      </div>
    )
  }

  return (
    <div className="space-y-12">
      {!embedReportedMetricsOnly && (
      <>
      {/* ============================================================
         Header — paper-style document hero
         ============================================================ */}
      <header className="border-b border-[color:var(--fg)] pb-6">
        <div className="kicker">Evaluation Card</div>
        <div className="mt-3 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h1 className="ec-page-h1">{getModelDisplayName(summary.model_info.name)}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-[color:var(--fg-muted)]">
              <span>{getOrganizationDisplayName(summary.model_info.developer)}</span>
              {summary.model_info.release_date && (
                <>
                  <span className="text-[color:var(--fg-subtle)]">·</span>
                  <span>Released {formatDate(summary.model_info.release_date).split(",")[0]}</span>
                </>
              )}
              {summary.model_info.additional_details?.deployment_context && (
                <>
                  <span className="text-[color:var(--fg-subtle)]">·</span>
                  <span>{summary.model_info.additional_details.deployment_context}</span>
                </>
              )}
              {formatParamsBillions(summary.model_info.additional_details?.params_billions) && (
                <>
                  <span className="text-[color:var(--fg-subtle)]">·</span>
                  <span>{formatParamsBillions(summary.model_info.additional_details?.params_billions)}</span>
                </>
              )}
              {/* model-resolution-rework: served-by inference platform (nullable). */}
              {summary.model_info.inference_platform && (
                <>
                  <span className="text-[color:var(--fg-subtle)]">·</span>
                  <span>Served by {summary.model_info.inference_platform}</span>
                </>
              )}
            </div>
          </div>

          <div className="lg:w-[280px]">
            <div className="kicker mb-2">Identifier</div>
            <div className="font-mono text-[12px] text-[color:var(--fg)] break-all">
              ec/models/{summary.model_info.id}
            </div>
            <div className="mt-4 flex items-center gap-2">
              <span className="kicker shrink-0">Documented</span>
              <div className="relative h-[3px] flex-1 bg-[color:var(--bg-surface)]">
                <div
                  className="absolute inset-y-0 left-0 bg-[color:var(--accent)]"
                  style={{ width: `${documentedPct}%` }}
                />
              </div>
              <span className="font-mono text-[11px] tabular-nums text-[color:var(--fg)]">
                {documentedPct}%
              </span>
            </div>
            <div className="mt-1 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]">
              {Math.max(0, reproducibilityResultsTotal - reproducibilityGapCount)} / {reproducibilityResultsTotal} reported
            </div>

            {/* model-resolution-rework: lineage + resolution provenance.
                All fields are nullable (server-provided); the block only
                renders rows that are present. */}
            {(summary.lineage_origin_model_id ||
              summary.resolution_source ||
              summary.resolution_granularity) && (
              <dl className="mt-4 space-y-1 text-[11px] text-[color:var(--fg-muted)]">
                {summary.lineage_origin_model_id && (
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="kicker shrink-0">Base model</dt>
                    <dd className="min-w-0 truncate text-right">
                      <Link
                        href={`/models/${routeIdToPath(routeIdFromModelId(summary.lineage_origin_model_id))}`}
                        className="font-mono hover:text-[color:var(--accent)]"
                      >
                        {summary.lineage_origin_model_id}
                      </Link>
                    </dd>
                  </div>
                )}
                {summary.resolution_source && (
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="kicker shrink-0">Resolved via</dt>
                    <dd className="font-mono">{summary.resolution_source}</dd>
                  </div>
                )}
                {summary.resolution_granularity && (
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="kicker shrink-0">Granularity</dt>
                    <dd className="font-mono">{summary.resolution_granularity}</dd>
                  </div>
                )}
              </dl>
            )}
          </div>
        </div>
      </header>

      {/* ============================================================
         Lede — paper-style abstract
         ============================================================ */}
      <section>
        {isResearchView ? (
          <div className="space-y-3 max-w-[64rem]">
            <p className="text-[16px] leading-[1.7] text-[color:var(--fg)]">
              <strong>{getModelDisplayName(summary.model_info.name)}</strong> reports{" "}
              <strong>{summary.total_evaluations}</strong> result{summary.total_evaluations === 1 ? "" : "s"} across{" "}
              <strong>{benchmarkGroups.length}</strong> benchmark{benchmarkGroups.length === 1 ? "" : "s"}, sourced from{" "}
              <strong>{reportingStats.organizationCount}</strong> reporting organization{reportingStats.organizationCount === 1 ? "" : "s"} ({reportingStats.sourceTypeCount} source type{reportingStats.sourceTypeCount === 1 ? "" : "s"}).{" "}
              {reportingStats.missingGenerationConfigs > 0
                ? `${reportingStats.missingGenerationConfigs} entries are missing generation config, limiting cross-slice comparability.`
                : "Generation configuration is present across the result set."}
            </p>
            {(setupDrivenBenchmarkCount > 0 || sliceDrivenBenchmarkCount > 0) && (
              <p className="text-[13px] leading-[1.7] text-[color:var(--fg-muted)]">
                Of the reported benchmarks,{" "}
                <span
                  className="text-[color:var(--fg)]"
                  title="The reporter recorded distinct setup variants (e.g. with vs. without chain-of-thought) for this benchmark"
                >
                  {setupDrivenBenchmarkCount}
                </span>{" "}
                break out by setup variant and{" "}
                <span
                  className="text-[color:var(--fg)]"
                  title="The reporter recorded distinct slices (e.g. subject-level or difficulty-level sub-scores)"
                >
                  {sliceDrivenBenchmarkCount}
                </span>{" "}
                break out by slice.
                {reportingStats.libraryList.length > 0 && (
                  <>
                    {" "}Scores come from these evaluation harnesses:{" "}
                    <span className="text-[color:var(--fg)]">{reportingStats.libraryList.join(", ")}</span>.
                  </>
                )}
              </p>
            )}
          </div>
        ) : (
          <div className="max-w-[64rem]">
            <ModelPolicyOverview
              modelName={getModelDisplayName(summary.model_info.name)}
              policySummary={modelPolicySummary}
              scaleNote={policySummary.sizeCaveat}
            />
          </div>
        )}
      </section>

      {/* ============================================================
         §1 Identification — hairline data list
         ============================================================ */}
      <section>
        <div className="section-head">
          <h2>
            <span className="font-mono text-[12px] tracking-[0.1em] text-[color:var(--accent)] mr-3">§1</span>
            Identification
          </h2>
          <span className="micro-meta-link font-mono text-[11px] tracking-[0.1em]">Model record</span>
        </div>
        <dl className="ec-datalist max-w-[64rem]">
          <dt>Model name</dt>
          <dd>{getModelDisplayName(summary.model_info.name)}</dd>

          <dt>Developer</dt>
          <dd>{getOrganizationDisplayName(summary.model_info.developer)}</dd>

          {summary.model_info.model_version && (
            <>
              <dt>Version</dt>
              <dd>{summary.model_info.model_version}</dd>
            </>
          )}

          {summary.model_info.release_date && (
            <>
              <dt>Released</dt>
              <dd>{formatDate(summary.model_info.release_date).split(",")[0]}</dd>
            </>
          )}

          {formatParamsBillions(summary.model_info.additional_details?.params_billions) && (
            <>
              <dt>Parameters</dt>
              <dd>{formatParamsBillions(summary.model_info.additional_details?.params_billions)}</dd>
            </>
          )}

          {(summary.model_info.architecture || summary.model_info.inference_engine) && (
            <>
              <dt>Architecture</dt>
              <dd>{summary.model_info.architecture || summary.model_info.inference_engine}</dd>
            </>
          )}

          {((summary.model_info.modalities?.input?.length ?? 0) > 0 || (summary.model_info.modalities?.output?.length ?? 0) > 0) && (
            <>
              <dt>Modalities</dt>
              <dd>
                {(summary.model_info.modalities?.input?.join(", ") || "Text")} → {(summary.model_info.modalities?.output?.join(", ") || "Text")}
              </dd>
            </>
          )}

          {summary.model_info.additional_details?.deployment_context && (
            <>
              <dt>Access</dt>
              <dd>{summary.model_info.additional_details.deployment_context}</dd>
            </>
          )}

          <dt>System ID</dt>
          <dd className="font-mono text-[13px]">{summary.model_info.id}</dd>

          {summary.model_info.model_url && (
            <>
              <dt>Reference</dt>
              <dd>
                <a
                  href={summary.model_info.model_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[color:var(--accent)] hover:text-[color:var(--accent-hover)]"
                >
                  {summary.model_info.model_url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </dd>
            </>
          )}

          <dt>Updated</dt>
          <dd>{formatDate(summary.last_updated).split(",")[0]}</dd>
        </dl>
      </section>

      {/* ============================================================
         §2 Benchmark coverage
         ============================================================ */}
      <section>
        <div className="section-head">
          <h2>
            <span className="font-mono text-[12px] tracking-[0.1em] text-[color:var(--accent)] mr-3">§2</span>
            Benchmark coverage
          </h2>
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]">
            {filteredBenchmarkGroups.length} shown · {benchmarkGroups.length} reported
          </span>
        </div>

        <p className="text-[14px] leading-[1.7] text-[color:var(--fg-muted)] max-w-[64rem] mb-6">
          {isResearchView
            ? "Benchmark-first view of this model's reported results, grouped by category."
            : "The public evidence behind this model, grouped by category. The strongest and most variable signals are listed first."}
          {policyHighlights.length > 0 && !isResearchView && (
            <>
              {" "}
              <span className="text-[color:var(--fg)]">{policyHighlights.length} headline finding{policyHighlights.length === 1 ? "" : "s"}.</span>
            </>
          )}
        </p>

        {/* Strong / Weak / Spread — hairline rows */}
        {(strongRankedBenchmarks.length > 0 || weakRankedBenchmarks.length > 0 || repeatedBenchmarkCount > 0) && (
          <dl className="ec-datalist max-w-[64rem] mb-8">
            {strongRankedBenchmarks.length > 0 && (
              <>
                <dt>Ranks high in</dt>
                <dd>
                  <div className="flex flex-wrap gap-1.5">
                    {strongRankedBenchmarks.map((group) => {
                      const rank = getGroupPeerRank(group, modelIds, peerRanks)
                      return (
                        <button
                          key={`strong-${group.key}`}
                          type="button"
                          onClick={() => jumpToDeepDive(group.key)}
                          className="ec-tag outline hover:border-[color:var(--accent)] hover:text-[color:var(--accent)] transition-colors"
                          title={group.title}
                        >
                          <span className="truncate max-w-[14rem] normal-case tracking-normal text-[12px] font-medium text-[color:var(--fg)]">
                            {group.title}
                          </span>
                          {rank && rank.total > 0 && (
                            <span className="font-mono tabular-nums text-[color:var(--fg-muted)]">
                              #{rank.position}/{rank.total}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </dd>
              </>
            )}
            {weakRankedBenchmarks.length > 0 && (
              <>
                <dt>Ranks low in</dt>
                <dd>
                  <div className="flex flex-wrap gap-1.5">
                    {weakRankedBenchmarks.map((group) => {
                      const rank = getGroupPeerRank(group, modelIds, peerRanks)
                      return (
                        <button
                          key={`weak-${group.key}`}
                          type="button"
                          onClick={() => jumpToDeepDive(group.key)}
                          className="ec-tag outline hover:border-[color:var(--accent)] hover:text-[color:var(--accent)] transition-colors"
                          title={group.title}
                        >
                          <span className="truncate max-w-[14rem] normal-case tracking-normal text-[12px] font-medium text-[color:var(--fg)]">
                            {group.title}
                          </span>
                          {rank && rank.total > 0 && (
                            <span className="font-mono tabular-nums text-[color:var(--fg-muted)]">
                              #{rank.position}/{rank.total}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </dd>
              </>
            )}
            {repeatedBenchmarkCount > 0 && (
              <>
                <dt>Slice spread</dt>
                <dd>
                  {repeatedBenchmarkCount} benchmark{repeatedBenchmarkCount === 1 ? "" : "s"} include multiple slices or setups.
                </dd>
              </>
            )}
            {benchmarkGroups.some((g) => (g as { __scaleWarning?: boolean }).__scaleWarning) && (
              <>
                <dt>Scale notes</dt>
                <dd className="text-[color:var(--fg-muted)]">
                  Some scores were auto-renormalized due to mixed scales (e.g., 0–1 vs 0–100).
                </dd>
              </>
            )}
          </dl>
        )}
      </section>

      {/* ============================================================
         §3 Who reports what — Researcher view gets the donut + per-
         category bars; Summary view gets a single plain-language
         sentence so the section exists in both views without burying
         non-technical readers in provenance breakdowns.
         ============================================================ */}
      {evaluatorMix.grand > 0 && (
        <section>
          <div className="section-head">
            <h2>
              <span className="font-mono text-[12px] tracking-[0.1em] text-[color:var(--accent)] mr-3">§3</span>
              Who reports what
            </h2>
            <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]">
              {isResearchView ? "First-party · third-party · per category" : "Source of these scores"}
            </span>
          </div>
          {isResearchView ? (
            <EvaluatorMix mix={evaluatorMix} />
          ) : (
            <EvaluatorMixSummary mix={evaluatorMix} />
          )}
        </section>
      )}
      </>
      )}

      {/* ============================================================
         §4 Reported metrics — Summary view shows a flat normalized bar
         list; Researcher view keeps the full grid/category/overlaps grid.
         ============================================================ */}
      <section>
        <div className="section-head">
          {embedReportedMetricsOnly ? (
            // Standalone embed: the document header (with the model name) is
            // suppressed, so name the model here — otherwise the iframe gives
            // no clue which model these reported metrics belong to.
            <div className="min-w-0">
              <div className="kicker mb-1">Reported metrics</div>
              <h2 className="truncate">{getModelDisplayName(summary.model_info.name)}</h2>
              <div className="text-[12px] text-[color:var(--fg-muted)] mt-0.5">
                {getOrganizationDisplayName(summary.model_info.developer)}
              </div>
            </div>
          ) : (
            <h2>
              <span className="font-mono text-[12px] tracking-[0.1em] text-[color:var(--accent)] mr-3">§4</span>
              Reported metrics
            </h2>
          )}
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]">
              {isResearchView
                ? `${groupingMode === "overlaps" ? visibleOverlapsRows.length : filteredBenchmarkGroups.length} shown`
                : `${benchmarkGroups.length} reported`}
            </span>
            {!embedReportedMetricsOnly && (
              <EmbedButton
                embedPath={`/embed/model/reported-metrics/${routeIdToPath(summary.model_info.id)}`}
                label="Reported metrics"
                defaultHeight={680}
                size="sm"
              />
            )}
            {isResearchView && (
              <div
                className="ec-mode-toggle"
                title={
                  groupingMode === "source"
                    ? "View by source: family-rooted plotboxes / accordions, no cross-family collapse."
                    : groupingMode === "category"
                      ? "View by category: same composite/standalone units, grouped by curated tag."
                      : "Scores: one row per benchmark, merged across sources, with mean and 95% CI."
                }
              >
                <button
                  type="button"
                  className={groupingMode === "overlaps" ? "on" : ""}
                  onClick={() => setGroupingMode("overlaps")}
                  aria-label="Scores"
                  title="Score table, one row per benchmark, merged across sources"
                >
                  Scores
                </button>
                <button
                  type="button"
                  className={groupingMode === "source" ? "on" : ""}
                  onClick={() => setGroupingMode("source")}
                  aria-label="Plots by source"
                  title="Plots grouped by source"
                >
                  Plots by source
                </button>
                <button
                  type="button"
                  className={groupingMode === "category" ? "on" : ""}
                  onClick={() => setGroupingMode("category")}
                  aria-label="Plots by category"
                  title="Plots grouped by category"
                >
                  Plots by category
                </button>
              </div>
            )}
          </div>
        </div>

        {isResearchView && !embedReportedMetricsOnly && (
          <p className="text-[14px] leading-[1.7] text-[color:var(--fg-muted)] max-w-[64rem] mb-6">
            {groupingMode === "overlaps"
              ? "One row per benchmark, with the mean and 95% CI across this model's appearances when more than one source reports it. Expand a row for per-source scores, generation settings, and flags. Filter to Overlaps only for cross-suite duplicates."
              : groupingMode === "category"
                ? "This model's results in the context of other reported evaluations. Plots are grouped by benchmark categories."
                : "This model's results in the context of other reported evaluations. Plots are grouped by benchmark family."}
          </p>
        )}

        {/* SUMMARY VIEW — text-only list grouped by family, ranked
            best→worst, with the category pill bar so non-technical
            readers can filter without diving into Researcher view. */}
        {!isResearchView && (
          <>
            {availableCategories.length > 0 && (
              <div className="mb-5 flex flex-wrap items-center gap-2">
                <span className="kicker mr-2">Category</span>
                <button
                  type="button"
                  onClick={() => setSelectedCategories([])}
                  className={`ec-pill ${selectedCategories.length === 0 ? "on" : ""}`}
                >
                  All
                </button>
                {availableCategories.map((category) => {
                  const isSelected = selectedCategories.includes(category)
                  return (
                    <button
                      key={category}
                      type="button"
                      onClick={() =>
                        setSelectedCategories((current) =>
                          current.includes(category)
                            ? current.filter((item) => item !== category)
                            : [...current, category]
                        )
                      }
                      className={`ec-pill ${isSelected ? "on" : ""}`}
                    >
                      {formatTagLabel(category as unknown as string)}
                    </button>
                  )
                })}
              </div>
            )}
            <SummaryMetricsList
              groups={
                selectedCategories.length === 0
                  ? benchmarkGroups
                  : benchmarkGroups.filter((g) => selectedCategories.includes(g.category))
              }
              currentDetailHref={currentDetailHref}
              hierarchyIndex={hierarchyIndex}
              sourcePrefixFamily={sourcePrefixFamily}
              modelIds={modelIds}
              peerRanks={peerRanks}
            />
          </>
        )}

        {/* Researcher view: full controls + grid/category/overlaps rendering. */}
        {isResearchView && (<>
        {/* Filter bar */}
        <div className="mb-5 flex flex-wrap items-center gap-3 border-b border-[color:var(--border-soft)] pb-5">
          <div className="relative w-full sm:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--fg-subtle)]" />
            <input
              className="ec-input pl-9"
              value={benchmarkSearch}
              onChange={(event) => setBenchmarkSearch(event.target.value)}
              placeholder="Search benchmarks or setups…"
            />
          </div>

          <div className="grow" />

          {/* Grid/list toggle lives here so it can be hidden in Overlaps
              mode without yanking layout in the section header above. */}
          {groupingMode !== "overlaps" && (
            <div className="ec-mode-toggle">
              <button
                type="button"
                className={`inline-flex items-center gap-1.5 ${benchmarkViewMode === "grid" ? "on" : ""}`}
                onClick={() => setBenchmarkViewMode("grid")}
                aria-label="Plots view"
                title="Plots"
              >
                <LayoutGrid className="h-3 w-3" />
                Plots
              </button>
              <button
                type="button"
                className={`inline-flex items-center gap-1.5 ${benchmarkViewMode === "list" ? "on" : ""}`}
                onClick={() => setBenchmarkViewMode("list")}
                aria-label="Table view"
                title="Table"
              >
                <List className="h-3 w-3" />
                Table
              </button>
            </div>
          )}
        </div>

        {groupingMode === "source" && availableFamilies.length > 0 && (
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <span className="kicker mr-2">Family</span>
            <button
              type="button"
              onClick={() => setSelectedFamilies([])}
              className={`ec-pill ${selectedFamilies.length === 0 ? "on" : ""}`}
            >
              All
            </button>
            {availableFamilies.map(({ key, name }) => {
              const isSelected = selectedFamilies.includes(key)
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() =>
                    setSelectedFamilies((current) =>
                      current.includes(key)
                        ? current.filter((k) => k !== key)
                        : [...current, key]
                    )
                  }
                  className={`ec-pill ${isSelected ? "on" : ""}`}
                >
                  {name}
                </button>
              )
            })}
          </div>
        )}

        {groupingMode === "category" && availableCategories.length > 0 && (
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <span className="kicker mr-2">Category</span>
            <button
              type="button"
              onClick={() => setSelectedCategories([])}
              className={`ec-pill ${selectedCategories.length === 0 ? "on" : ""}`}
            >
              All
            </button>
            {availableCategories.map((category) => {
              const isSelected = selectedCategories.includes(category)
              return (
                <button
                  key={category}
                  type="button"
                  onClick={() =>
                    setSelectedCategories((current) =>
                      current.includes(category)
                        ? current.filter((item) => item !== category)
                        : [...current, category]
                    )
                  }
                  className={`ec-pill ${isSelected ? "on" : ""}`}
                >
                  {formatTagLabel(category as unknown as string)}
                </button>
              )
            })}
          </div>
        )}

        {groupingMode === "overlaps" && overlapsRows.length > 0 && (
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <span className="kicker mr-2">Show</span>
            <button
              type="button"
              onClick={() => setOverlapsFilter("all")}
              className={`ec-pill ${overlapsFilter === "all" ? "on" : ""}`}
            >
              All ({overlapsRows.length})
            </button>
            <button
              type="button"
              onClick={() => setOverlapsFilter("multi")}
              className={`ec-pill ${overlapsFilter === "multi" ? "on" : ""}`}
            >
              Overlaps only ({countMultiSourceRows(overlapsRows)})
            </button>
          </div>
        )}

        {groupingMode === "overlaps" ? (() => {
          const query = benchmarkSearch.trim().toLowerCase()
          const visibleOverlaps = visibleOverlapsRows
          return visibleOverlaps.length === 0 ? (
            <div className="border border-dashed border-[color:var(--border-soft)] bg-[color:var(--bg-warm)] py-12 px-6 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-[color:var(--fg-subtle)]">
              {query
                ? "No overlaps match your search"
                : overlapsFilter === "multi"
                  ? "No benchmarks with multiple sources. Switch to All to see single-source results."
                  : "No benchmark results found for this model"}
            </div>
          ) : (
            <div className="overflow-hidden border border-[color:var(--border-soft)]">
              <div className="grid grid-cols-[minmax(0,2.2fr)_56px_minmax(0,1.6fr)_minmax(0,1.4fr)_minmax(0,1.6fr)] items-baseline gap-3 border-b border-[color:var(--border-strong)] bg-[color:var(--bg-warm)] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]">
                <div>Benchmark</div>
                <div className="text-center">N</div>
                <div>Mean (95% CI)</div>
                <div>Range</div>
                <div>Sources</div>
              </div>
              {visibleOverlaps.map((row, idx) => {
                const fmtNum = (v: number) =>
                  row.plainUnit
                    ? formatPlainUnitScore(v, row.plainUnit).split(" ")[0]
                    : row.isPercentScale
                      ? v.toFixed(1)
                      : (v * 100).toFixed(1)
                const fmt = (v: number) =>
                  row.plainUnit ? formatPlainUnitScore(v, row.plainUnit) : `${fmtNum(v)}%`
                const isSingle = row.appearances.length < 2
                const isOpen = expandedOverlapRows.has(row.canonicalKey)
                const isLast = idx === visibleOverlaps.length - 1
                const ciLabel = row.ci95
                  ? row.appearances.length === 2
                    ? `±${(((row.ci95.high - row.ci95.low) / 2) || 0).toFixed(1)} (n=2, wide)`
                    : `[${fmt(row.ci95.low)}, ${fmt(row.ci95.high)}]`
                  : "—"
                const strongText = isSingle
                  ? "text-[color:var(--fg-muted)]"
                  : "text-[color:var(--fg)]"
                return (
                  <Fragment key={`overlap-${row.canonicalKey}`}>
                    <button
                      type="button"
                      onClick={() => toggleOverlapRow(row.canonicalKey)}
                      aria-expanded={isOpen}
                      className="grid w-full grid-cols-[minmax(0,2.2fr)_56px_minmax(0,1.6fr)_minmax(0,1.4fr)_minmax(0,1.6fr)] items-baseline gap-3 px-3 py-3 text-left transition-colors hover:bg-[color:var(--bg-warm)]"
                      style={{
                        borderBottom:
                          isLast && !isOpen ? "none" : "1px solid var(--border-soft)",
                      }}
                    >
                      <div className="min-w-0">
                        <div className={`truncate text-[13px] font-semibold ${strongText}`}>
                          {row.canonicalDisplayName}
                        </div>
                        <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--fg-subtle)]">
                          {row.canonicalKey}
                        </div>
                      </div>
                      <div className={`text-center font-mono text-[12px] tabular-nums ${strongText}`}>
                        {row.appearances.length}
                      </div>
                      <div className={`font-mono text-[12px] tabular-nums ${strongText}`}>
                        {fmt(row.mean)}
                        <div className="mt-0.5 font-mono text-[10px] tabular-nums text-[color:var(--fg-subtle)]">
                          {ciLabel}
                        </div>
                      </div>
                      <div className={`font-mono text-[11px] tabular-nums ${isSingle ? "text-[color:var(--fg-subtle)]" : "text-[color:var(--fg-muted)]"}`}>
                        {isSingle
                          ? `${fmtNum(row.min)} to ${fmt(row.max)}`
                          : `${fmt(row.min)} – ${fmt(row.max)}`}
                        {!isSingle && (
                          <div className="mt-0.5 font-mono text-[10px] tabular-nums text-[color:var(--fg-subtle)]">
                            Δ {fmt(row.max - row.min)}
                          </div>
                        )}
                      </div>
                      <div className={`flex items-center gap-1.5 font-mono text-[11px] tabular-nums ${isSingle ? "text-[color:var(--fg-subtle)]" : "text-[color:var(--fg-muted)]"}`}>
                        {row.appearances.length} source{row.appearances.length === 1 ? "" : "s"}
                        <ChevronDown
                          className="h-3.5 w-3.5 shrink-0 self-center text-[color:var(--fg-muted)] transition-transform"
                          style={{ transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)" }}
                        />
                      </div>
                    </button>
                    {isOpen && (
                      <div
                        className="bg-[color:var(--bg-warm)] px-3 py-2"
                        style={{
                          borderBottom: isLast ? "none" : "1px solid var(--border-soft)",
                        }}
                      >
                        <div className="hidden grid-cols-[minmax(0,1.8fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.6fr)] items-center gap-3 px-1 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)] sm:grid">
                          <div>Source</div>
                          <div>Score</div>
                          <div>Temperature</div>
                          <div>Max tokens</div>
                          <div>Flags</div>
                        </div>
                        {row.appearances.map((app) => {
                          const notReported = (
                            <span className="text-[color:var(--fg-subtle)]">not reported</span>
                          )
                          const sourceNode =
                            app.sourceKind === "comparison-index" ? (
                              <Link
                                href={`/evals/${routeIdToPath(app.evalSummaryId)}?from=${encodeURIComponent(currentDetailHref)}`}
                                className="ec-tag outline hover:border-[color:var(--accent)] hover:text-[color:var(--accent)] transition-colors"
                                style={{ fontSize: 10 }}
                                title={`${app.familyName} · ${app.metricName} — view eval`}
                              >
                                {app.familyName}
                              </Link>
                            ) : (
                              <span
                                className="text-[12px] text-[color:var(--fg-muted)]"
                                title={`${app.familyName} · ${app.metricName}`}
                              >
                                {app.familyName}
                              </span>
                            )
                          const scoreNode = fmt(app.score)
                          const temperatureNode =
                            app.temperature != null
                              ? Number.isInteger(app.temperature)
                                ? app.temperature.toFixed(1)
                                : app.temperature
                              : notReported
                          const maxTokensNode =
                            app.maxTokens != null ? app.maxTokens : notReported
                          const flagsNode = (
                            <RowFlagSquares annotations={app.annotations} />
                          )
                          return (
                            <div
                              key={`${row.canonicalKey}::${app.familyKey}::${app.evalSummaryId}`}
                              className="border-t border-[color:var(--border-soft)]"
                            >
                              {/* Wide layout: single-row grid */}
                              <div className="hidden grid-cols-[minmax(0,1.8fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.6fr)] items-center gap-3 px-1 py-2 sm:grid">
                                <div className="min-w-0">{sourceNode}</div>
                                <div className="font-mono text-[12px] tabular-nums text-[color:var(--fg)]">
                                  {scoreNode}
                                </div>
                                <div className="font-mono text-[11px] tabular-nums text-[color:var(--fg-muted)]">
                                  {temperatureNode}
                                </div>
                                <div className="font-mono text-[11px] tabular-nums text-[color:var(--fg-muted)]">
                                  {maxTokensNode}
                                </div>
                                <div className="flex flex-wrap items-center gap-1">
                                  {flagsNode}
                                </div>
                              </div>
                              {/* Narrow layout: stacked label/value block */}
                              <div className="px-1 py-2 sm:hidden">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">{sourceNode}</div>
                                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                                    {flagsNode}
                                  </div>
                                </div>
                                <dl className="mt-1.5 grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1">
                                  <dt className="font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]">
                                    Score
                                  </dt>
                                  <dd className="font-mono text-[12px] tabular-nums text-[color:var(--fg)]">
                                    {scoreNode}
                                  </dd>
                                  <dt className="font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]">
                                    Temperature
                                  </dt>
                                  <dd className="font-mono text-[11px] tabular-nums text-[color:var(--fg-muted)]">
                                    {temperatureNode}
                                  </dd>
                                  <dt className="font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]">
                                    Max tokens
                                  </dt>
                                  <dd className="font-mono text-[11px] tabular-nums text-[color:var(--fg-muted)]">
                                    {maxTokensNode}
                                  </dd>
                                </dl>
                              </div>
                              <RunProtocolSummary
                                collectionId={app.collectionId}
                                protocolCondition={app.protocolCondition}
                                familyKey={
                                  app.studyFamilyKey && topLevelFamilyKeys.has(app.studyFamilyKey)
                                    ? app.studyFamilyKey
                                    : null
                                }
                                evalSummaryId={app.evalSummaryId}
                                collections={summary.collections}
                              />
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </Fragment>
                )
              })}
            </div>
          )
        })() : filteredBenchmarkGroups.length === 0 ||
        (benchmarkViewMode === "grid" && plotboxUnits.length === 0) ? (
          <div className="border border-dashed border-[color:var(--border-soft)] bg-[color:var(--bg-warm)] py-12 px-6 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-[color:var(--fg-subtle)]">
            No benchmarks match the current search or category filters.
          </div>
        ) : benchmarkViewMode === "grid" && groupingMode === "source" ? (
          /* Hierarchy mode — section per family, one plotbox per composite
             (or per standalone benchmark) under it. Inside each plotbox the
             view selector still drills into the composite's benchmarks /
             slices. No cross-family whisker. */
          (() => {
            const byFamily = new Map<
              string,
              {
                familyKey: string
                familyDisplayName: string
                category: EvalTag
                units: PlotboxUnit[]
              }
            >()
            for (const unit of plotboxUnits) {
              const entry = byFamily.get(unit.parentFamilyKey) ?? {
                familyKey: unit.parentFamilyKey,
                familyDisplayName: unit.parentFamilyDisplayName,
                category: unit.category,
                units: [] as PlotboxUnit[],
              }
              entry.units.push(unit)
              byFamily.set(unit.parentFamilyKey, entry)
            }
            const families = Array.from(byFamily.values())
            return (
              <div className="space-y-6">
                {families.map((fam) => {
                  const compositeCount = fam.units.length
                  const totalBenchmarks = fam.units.reduce(
                    (sum, u) =>
                      sum +
                      u.views.reduce((vs, view) => vs + view.tabs.length, 0),
                    0,
                  )
                  return (
                    <section
                      key={`hierarchy-fam-${fam.familyKey}`}
                      className="space-y-4"
                    >
                      <div className="flex items-baseline justify-between gap-3 border-b border-[color:var(--border-soft)] pb-2">
                        <div className="flex items-baseline gap-3">
                          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[color:var(--accent)] font-semibold">
                            {fam.familyDisplayName}
                          </span>
                          <span
                            className="font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]"
                            title={compositeCount === 1 ? "One score distribution chart" : `${compositeCount} score distribution charts`}
                          >
                            {compositeCount}{" "}
                            {compositeCount === 1 ? "chart" : "charts"}
                            {totalBenchmarks !== compositeCount && (
                              <>
                                {" "}· {totalBenchmarks} benchmark
                                {totalBenchmarks === 1 ? "" : "s"}
                              </>
                            )}
                          </span>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-0 border-t border-l border-[color:var(--border-soft)] sm:grid-cols-2 lg:grid-cols-3">
                        {fam.units.map((unit) => renderPlotbox(unit, false))}
                      </div>
                    </section>
                  )
                })}
              </div>
            )
          })()
        ) : benchmarkViewMode === "grid" ? (
          /* Category mode — composite/standalone units bucketed by curated
             category tag, with a cross-family canonical-dedupe pass on top.
             A benchmark reported by N evaluators (e.g. 8x MMLU-Pro across
             helm/vals-ai/openeval/…) collapses to ONE tile here; the
             remaining sources fold into the cross-family whisker overlay
             so the spread is still visible. Per-source detail lives in
             Source view and the deep dive. */
          (() => {
            const categoryOrder = new Map(
              availableCategories.map((cat, i) => [cat, i])
            )
            // A benchmark with multiple curated tags should surface in
            // each of those category sections, not just its primary.
            // Pull the full tag list off the curated hierarchy index;
            // fall back to the unit's primary category when no tags are
            // available (legacy 5-bucket fallback).
            const normaliseCategory = (raw: string): EvalTag =>
              raw.toLowerCase().trim().replace(/\s+/g, "_") as EvalTag
            const categoriesForUnit = (unit: PlotboxUnit): EvalTag[] => {
              const seen = new Set<EvalTag>()
              const out: EvalTag[] = []
              for (const view of unit.views) {
                for (const tab of view.tabs) {
                  const evalId = tab.evalSummaryId
                  if (!evalId) continue
                  const tags = hierarchyIndex?.get(evalId)?.tags
                  if (!tags) continue
                  for (const t of tags) {
                    const cat = normaliseCategory(t)
                    if (!seen.has(cat)) {
                      seen.add(cat)
                      out.push(cat)
                    }
                  }
                }
              }
              if (out.length === 0) return [unit.category]
              return out
            }
            const byCategory = new Map<EvalTag, PlotboxUnit[]>()
            for (const unit of categoryPlotboxUnits) {
              for (const cat of categoriesForUnit(unit)) {
                const list = byCategory.get(cat) ?? []
                list.push(unit)
                byCategory.set(cat, list)
              }
            }
            const orderedCategories = Array.from(byCategory.keys()).sort(
              (a, b) =>
                (categoryOrder.get(a) ?? 999) - (categoryOrder.get(b) ?? 999)
            )

            return (
              <div className="space-y-6">
                {orderedCategories.map((category) => {
                  const units = byCategory.get(category) ?? []
                  const totalBenchmarks = units.length

                  return (
                    <section
                      key={`category-section-${category}`}
                      className="space-y-4"
                    >
                      <div className="flex items-baseline justify-between gap-3 border-b border-[color:var(--border-soft)] pb-2">
                        <div className="flex items-baseline gap-3">
                          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[color:var(--accent)] font-semibold">
                            {formatTagLabel(category)}
                          </span>
                          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]">
                            {totalBenchmarks} benchmark{totalBenchmarks === 1 ? "" : "s"}
                          </span>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-0 border-t border-l border-[color:var(--border-soft)] sm:grid-cols-2 lg:grid-cols-3">
                        {units.map((unit) => renderPlotbox(unit, true))}
                      </div>
                    </section>
                  )
                })}
              </div>
            )
          })()
        ) : (
          /* List view — accordions per benchmark family, grouped by category.
             Family bucketing mirrors the grid view's plotboxUnits logic. */
          <div className="space-y-10">
            {(() => {
              const allFamilyKeys = listFamiliesByCategory.flatMap(({ families }) =>
                families.map((f) => f.familyKey)
              )
              const allExpanded =
                allFamilyKeys.length > 0 && allFamilyKeys.every((k) => expandedFamilies.has(k))
              return (
                <div className="-mt-2 mb-2 flex items-center justify-end gap-4">
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedFamilies(allExpanded ? new Set() : new Set(allFamilyKeys))
                    }
                    className="font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--fg-muted)] hover:text-[color:var(--accent)] transition-colors"
                  >
                    {allExpanded ? "Collapse all ↑" : "Expand all ↓"}
                  </button>
                </div>
              )
            })()}

            {listFamiliesByCategory.map(({ category, families }) => {
              const totalRows = families.reduce((sum, f) => sum + f.totalRows, 0)
              const totalBenchmarks = families.reduce((sum, f) => sum + f.groups.length, 0)

              type ListRow = {
                group: BenchmarkGroup
                variant: BenchmarkVariant
                /** Present when this row is the consolidated representative
                 *  for a multi-source canonical benchmark — see the
                 *  `groupDuplicatesInList` toggle. */
                aggregate?: MergedRowAggregate
              }

              const renderRow = (row: ListRow, isLast: boolean) => {
                const unit = row.variant.result.metric_config.unit
                const lower = row.variant.result.metric_config.lower_is_better
                const variantLabel = getVariantPrimaryLabel(row.variant, row.group.title)
                const rel = row.variant.evaluation.source_metadata.evaluator_relationship
                const agg = row.aggregate
                const meanDisplay = agg
                  ? `${(agg.mean * 100).toFixed(1)}%`
                  : row.variant.displayScore
                const rangeDisplay = agg
                  ? `${(agg.min * 100).toFixed(1)}–${(agg.max * 100).toFixed(1)}%`
                  : null

                const button = (
                  <button
                    type="button"
                    onClick={() => jumpToDeepDive(row.group.key)}
                    className="grid w-full items-center gap-4 px-1 py-2.5 text-left transition-colors hover:bg-[color:var(--bg-warm)] sm:grid-cols-[1fr_90px_110px_100px]"
                    style={{ borderBottom: isLast ? "none" : "1px solid var(--border-soft)" }}
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] truncate text-[color:var(--fg)]">
                        {agg
                          ? agg.canonicalDisplayName
                          : variantLabel && variantLabel !== row.group.title
                            ? variantLabel
                            : row.group.canonicalTitle}
                      </div>
                      {agg ? (
                        <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[10.5px] text-[color:var(--fg-subtle)]">
                          <span>{agg.sources.length} sources</span>
                          <span>· range {rangeDisplay}</span>
                        </div>
                      ) : isResearchView && (
                        <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[10.5px] text-[color:var(--fg-subtle)]">
                          {row.variant.result.generation_config?.num_few_shot != null && (
                            <span>{row.variant.result.generation_config.num_few_shot}-shot</span>
                          )}
                          {row.variant.setupLabel && <span>· {row.variant.setupLabel}</span>}
                          {row.variant.sliceLabel && <span>· {row.variant.sliceLabel}</span>}
                        </div>
                      )}
                    </div>
                    <div>
                      <span className="ec-tag" style={{ fontSize: 9.5 }}>
                        {unit || "score"}
                        {lower != null && (
                          <span style={{ color: "var(--accent)", fontWeight: 600, marginLeft: 4 }}>
                            {lower ? "↓" : "↑"}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="text-right font-mono text-[14px] tabular-nums text-[color:var(--fg)]">
                      {meanDisplay}
                      {agg && (
                        <div className="mt-0.5 font-mono text-[9.5px] tabular-nums text-[color:var(--fg-subtle)]">
                          {rangeDisplay}
                        </div>
                      )}
                    </div>
                    <div className="flex justify-end">
                      <span
                        className="font-mono text-[9.5px] uppercase tracking-[0.12em]"
                        style={{
                          color: agg
                            ? "var(--accent)"
                            : rel === "first_party"
                              ? "var(--fg-muted)"
                              : rel === "third_party"
                                ? "var(--accent)"
                                : "var(--fg-subtle)",
                        }}
                      >
                        {agg
                          ? `${agg.sources.length} reports`
                          : rel === "first_party"
                            ? "first-party"
                            : rel === "third_party"
                              ? "third-party"
                              : rel === "collaborative"
                                ? "collaborative"
                                : "—"}
                      </span>
                    </div>
                  </button>
                )
                if (!agg) return (
                  <div key={`${row.group.key}::${row.variant.evaluation.evaluation_id}::${row.variant.label}`}>
                    {button}
                  </div>
                )
                return (
                  <div key={`${row.group.key}::${row.variant.evaluation.evaluation_id}::${row.variant.label}`}>
                    <SignalTooltip
                      content={
                        <div className="flex min-w-[260px] flex-col gap-1">
                          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--fg-subtle)]">
                            Per-source breakdown
                          </div>
                          {agg.sources.map((src, i) => (
                            <div
                              key={`${src.familyKey}::${i}`}
                              className="flex items-baseline justify-between gap-3"
                            >
                              <span className="text-[12px] text-[color:var(--fg)] truncate">
                                {src.familyName}
                              </span>
                              <span className="font-mono text-[12px] tabular-nums text-[color:var(--fg-muted)]">
                                {src.displayScore}
                              </span>
                            </div>
                          ))}
                          <div className="mt-1 border-t border-[color:var(--border-soft)] pt-1 flex items-baseline justify-between gap-3">
                            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--fg-subtle)]">
                              Mean (range)
                            </span>
                            <span className="font-mono text-[12px] tabular-nums text-[color:var(--fg)]">
                              {meanDisplay} ({rangeDisplay})
                            </span>
                          </div>
                        </div>
                      }
                    >
                      {button}
                    </SignalTooltip>
                  </div>
                )
              }

              const partyRowsFor = (rowsAll: ListRow[]) => ({
                firstParty: rowsAll.filter(
                  (r) => r.variant.evaluation.source_metadata.evaluator_relationship === "first_party"
                ),
                thirdParty: rowsAll.filter(
                  (r) => r.variant.evaluation.source_metadata.evaluator_relationship === "third_party"
                ),
                otherRows: rowsAll.filter((r) => {
                  const rel = r.variant.evaluation.source_metadata.evaluator_relationship
                  return rel !== "first_party" && rel !== "third_party"
                }),
              })

              const renderPartyBreakdown = (rowsAll: ListRow[]) => {
                const { firstParty, thirdParty, otherRows } = partyRowsFor(rowsAll)
                return (
                  <>
                    {firstParty.length > 0 && (
                      <>
                        <div
                          className="flex items-baseline justify-between pb-1.5 pt-2"
                          style={{ borderBottom: "1px solid var(--border-soft)" }}
                        >
                          <span className="font-mono text-[10px] uppercase tracking-[0.15em] font-semibold text-[color:var(--fg-subtle)]">
                            First-party
                          </span>
                          <span className="font-mono text-[10px] tracking-[0.1em] text-[color:var(--fg-subtle)]">
                            · {firstParty.length} row{firstParty.length === 1 ? "" : "s"}
                          </span>
                        </div>
                        <div>
                          {firstParty.map((row, i) => renderRow(row, i === firstParty.length - 1))}
                        </div>
                      </>
                    )}
                    {thirdParty.length > 0 && (
                      <>
                        <div
                          className="flex items-baseline justify-between pb-1.5 pt-2"
                          style={{ borderBottom: "1px solid var(--border-soft)" }}
                        >
                          <span className="font-mono text-[10px] uppercase tracking-[0.15em] font-semibold" style={{ color: "var(--accent)" }}>
                            Third-party · independent evaluators
                          </span>
                          <span className="font-mono text-[10px] tracking-[0.1em] text-[color:var(--fg-subtle)]">
                            · {thirdParty.length} row{thirdParty.length === 1 ? "" : "s"}
                          </span>
                        </div>
                        <div>
                          {thirdParty.map((row, i) => renderRow(row, i === thirdParty.length - 1))}
                        </div>
                      </>
                    )}
                    {otherRows.length > 0 && (
                      <>
                        <div
                          className="flex items-baseline justify-between pb-1.5 pt-2"
                          style={{ borderBottom: "1px solid var(--border-soft)" }}
                        >
                          <span className="font-mono text-[10px] uppercase tracking-[0.15em] font-semibold text-[color:var(--fg-subtle)]">
                            Other / unspecified
                          </span>
                          <span className="font-mono text-[10px] tracking-[0.1em] text-[color:var(--fg-subtle)]">
                            · {otherRows.length} row{otherRows.length === 1 ? "" : "s"}
                          </span>
                        </div>
                        <div>
                          {otherRows.map((row, i) => renderRow(row, i === otherRows.length - 1))}
                        </div>
                      </>
                    )}
                  </>
                )
              }

              return (
                <section key={`list-cat-${category}`}>
                  <div className="mb-3 flex items-baseline justify-between gap-3 border-b border-[color:var(--fg)] pb-2">
                    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[color:var(--accent)] font-semibold">
                      {formatTagLabel(category as unknown as string)}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]">
                      {families.length} {families.length === 1 ? "family" : "families"} · {totalBenchmarks} benchmark{totalBenchmarks === 1 ? "" : "s"} · {totalRows} row{totalRows === 1 ? "" : "s"}
                    </span>
                  </div>

                  <div>
                    {families.map((family) => {
                      const isOpen = expandedFamilies.has(family.familyKey)
                      // Build the per-family row list, then apply duplicate
                      // grouping when the toggle is on. "skip" rows drop out
                      // entirely (they're absorbed into a representative row
                      // shown earlier in display order, possibly under a
                      // different family). "merged" rows carry a
                      // MergedRowAggregate so renderRow knows to display the
                      // mean + range + tooltip breakdown.
                      const allRows: ListRow[] = []
                      for (const g of family.groups) {
                        for (const v of g.variants) {
                          if (mergedRowState) {
                            const rowKey = `${family.familyKey}::${g.key}::${v.evaluation.evaluation_id}::${v.label}`
                            const disposition = mergedRowState.rowDisposition.get(rowKey)
                            if (disposition === "skip") continue
                            if (disposition === "merged") {
                              const evalId = v.evaluation.eval_summary_id
                              const indexEntry = evalId ? benchmarkIndexLookup.get(evalId) : undefined
                              const aggregate = indexEntry
                                ? mergedRowState.aggregates.get(indexEntry.canonicalKey)
                                : undefined
                              allRows.push({ group: g, variant: v, aggregate })
                              continue
                            }
                          }
                          allRows.push({ group: g, variant: v })
                        }
                      }
                      // Skip empty families when grouping is on (every row
                      // got absorbed into an earlier family's merged row).
                      if (allRows.length === 0) return null
                      const { firstParty, thirdParty } = partyRowsFor(allRows)
                      // Family-level summary score = avg of avgs across child groups
                      const avgScores = family.groups
                        .map((g) => g.avgNormalizedScore)
                        .filter((v) => Number.isFinite(v) && v >= 0)
                      const familyAvg = avgScores.length
                        ? avgScores.reduce((s, v) => s + v, 0) / avgScores.length
                        : null
                      const familyAvgDisplay = familyAvg != null
                        ? `${(familyAvg * 100).toFixed(1)}%`
                        : family.groups[0]?.avgDisplayScore ?? "–"
                      // Best peer rank across this family's groups
                      let bestRank: { position: number; total: number } | null = null
                      for (const g of family.groups) {
                        const r = getGroupPeerRank(g, modelIds, peerRanks)
                        if (!r) continue
                        if (!bestRank || r.position < bestRank.position) bestRank = r
                      }

                      return (
                        <div
                          key={`fam-${family.familyKey}`}
                          style={{ borderBottom: "1px solid var(--border-soft)" }}
                        >
                          <button
                            type="button"
                            onClick={() => toggleFamily(family.familyKey)}
                            className="grid w-full grid-cols-[16px_1fr_auto_auto] items-center gap-3 px-1 py-3 text-left transition-colors hover:bg-[color:var(--bg-warm)]"
                            aria-expanded={isOpen}
                          >
                            <ChevronDown
                              className="h-3.5 w-3.5 text-[color:var(--fg-muted)] transition-transform"
                              style={{ transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)" }}
                            />
                            <div className="min-w-0">
                              <div className="flex items-baseline gap-2">
                                <div className="truncate text-[14px] font-semibold tracking-[-0.01em] text-[color:var(--fg)]">
                                  {family.familyName}
                                </div>
                                {family.kind === "multi-eval" && (
                                  <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-[color:var(--accent)] font-semibold">
                                    {family.groups.length} evals
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--fg-subtle)]">
                                <span>{allRows.length} row{allRows.length === 1 ? "" : "s"}</span>
                                {firstParty.length > 0 && (
                                  <span>· {firstParty.length} first-party</span>
                                )}
                                {thirdParty.length > 0 && (
                                  <span style={{ color: "var(--accent)" }}>
                                    · {thirdParty.length} third-party
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="font-mono text-[13px] tabular-nums text-[color:var(--fg)]">
                              {familyAvgDisplay}
                            </div>
                            <div className="font-mono text-[10.5px] tabular-nums text-[color:var(--fg-muted)] min-w-[60px] text-right">
                              {bestRank
                                ? `#${bestRank.position}${bestRank.total ? `/${bestRank.total}` : ""}`
                                : "—"}
                            </div>
                          </button>

                          {isOpen && (
                            <div className="pl-7 pr-1 pb-3 pt-1">
                              {family.kind === "single-eval" ? (
                                renderPartyBreakdown(allRows)
                              ) : (
                                /* Multi-eval — sub-section per child eval. */
                                <div className="space-y-3">
                                  {family.groups.map((childGroup) => {
                                    const childRows = childGroup.variants.map((v) => ({
                                      group: childGroup,
                                      variant: v,
                                    }))
                                    const childRank = getGroupPeerRank(childGroup, modelIds, peerRanks)
                                    return (
                                      <div key={`fam-${family.familyKey}-eval-${childGroup.key}`}>
                                        <div className="flex items-baseline justify-between gap-3 pb-1.5 pt-1">
                                          <button
                                            type="button"
                                            onClick={() => jumpToDeepDive(childGroup.key)}
                                            className="text-left text-[13px] font-semibold tracking-[-0.005em] text-[color:var(--fg)] hover:text-[color:var(--accent)] transition-colors"
                                          >
                                            {childGroup.canonicalTitle}
                                          </button>
                                          <span className="font-mono text-[10px] tabular-nums text-[color:var(--fg-muted)]">
                                            {childGroup.avgDisplayScore}
                                            {childRank && (
                                              <span className="ml-2 text-[color:var(--fg-subtle)]">
                                                #{childRank.position}{childRank.total ? `/${childRank.total}` : ""}
                                              </span>
                                            )}
                                          </span>
                                        </div>
                                        {renderPartyBreakdown(childRows)}
                                      </div>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </div>
        )}
        </>)}
      </section>

      <Dialog
        open={activeBenchmarkGroup != null}
        onOpenChange={(open) => {
          if (!open) {
            setActiveBenchmarkGroupKey(null)
          }
        }}
      >
        <DialogContent className="!rounded-none max-h-[88dvh] max-w-[94vw] grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-0 sm:max-w-5xl border-[color:var(--fg)] [&_[data-slot=dialog-close]]:!rounded-none [&_[data-slot=dialog-close]]:top-3 [&_[data-slot=dialog-close]]:right-3 [&_[data-slot=dialog-close]]:border [&_[data-slot=dialog-close]]:border-[color:var(--border-soft)] [&_[data-slot=dialog-close]]:p-1 [&_[data-slot=dialog-close]]:opacity-100 [&_[data-slot=badge]]:!rounded-none [&_[data-slot=badge]]:border-[color:var(--border-strong)] [&_[data-slot=badge]]:bg-transparent [&_[data-slot=badge]]:font-mono [&_[data-slot=badge]]:text-[10px] [&_[data-slot=badge]]:uppercase [&_[data-slot=badge]]:tracking-[0.12em] [&_[data-slot=badge]]:text-[color:var(--fg-muted)] [&_[data-slot=badge]]:font-medium">
          {activeBenchmarkGroup && (
            <BenchmarkDeepDiveDialogPanel
              group={activeBenchmarkGroup}
              comparisonIndex={comparisonIndex}
              evalHierarchy={evalHierarchy}
              hierarchyIndex={hierarchyIndex}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SampleDataDialog({
  samples: initialSamples,
  evaluationName,
  fullDataUrl,
}: {
  samples: any[],
  evaluationName: string
  fullDataUrl?: string
}) {
  const [open, setOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [currentPage, setCurrentPage] = useState(1)
  const [allSamples, setAllSamples] = useState<any[]>(initialSamples)
  const [isLoadingAll, setIsLoadingAll] = useState(false)
  const [hasLoadedAll, setHasLoadedAll] = useState(false)
  const itemsPerPage = 10

  const filteredSamples = allSamples.filter(sample => {
    const term = searchTerm.toLowerCase()
    return (
      (sample.input ?? "").toLowerCase().includes(term) ||
      (sample.response ?? "").toLowerCase().includes(term) ||
      (sample.ground_truth ?? "").toLowerCase().includes(term)
    )
  })

  const totalPages = Math.ceil(filteredSamples.length / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const currentSamples = filteredSamples.slice(startIndex, startIndex + itemsPerPage)

  // Reset page when search changes
  useEffect(() => {
    setCurrentPage(1)
  }, [searchTerm])

  const [loadError, setLoadError] = useState<string | null>(null)

  const handleLoadAll = async () => {
    if (!fullDataUrl) {
      setLoadError("No data URL available for this benchmark")
      return
    }
    if (hasLoadedAll) return
    setIsLoadingAll(true)
    setLoadError(null)
    try {
      const res = await fetch(`/api/instance-data?url=${encodeURIComponent(fullDataUrl)}`)
      const data = await res.json()
      if (data.error) {
        setLoadError(data.error)
      } else if (data.samples && data.samples.length > 0) {
        setAllSamples(data.samples)
        setHasLoadedAll(true)
      } else {
        setLoadError("No samples found in the full dataset")
      }
    } catch (err) {
      setLoadError(`Failed to load: ${err instanceof Error ? err.message : "unknown error"}`)
    } finally {
      setIsLoadingAll(false)
    }
  }

  const handleOpenToggle = () => {
    const nextOpen = !open
    setOpen(nextOpen)

    if (nextOpen && fullDataUrl && !hasLoadedAll && !isLoadingAll) {
      void handleLoadAll()
    }
  }

  return (
    <>
      <button type="button" className="btn-ec outline inline-flex items-center gap-2" onClick={handleOpenToggle}>
        <Database className="h-3.5 w-3.5" />
        {open ? "Hide instances" : "View all instances"}
      </button>
      {open && (
      <div className="rounded-xl border bg-background p-4 space-y-3">
        <div>
          <div className="font-semibold">Sample Level Data</div>
          <div className="text-sm text-muted-foreground">
            {hasLoadedAll
              ? `All ${allSamples.length} samples from ${evaluationName}`
              : `Showing ${allSamples.length} preview samples from ${evaluationName}`}
          </div>
        </div>

        <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:gap-4">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search samples..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-8"
            />
          </div>
          {isLoadingAll && (
            <div className="text-xs text-muted-foreground">Loading all instances…</div>
          )}
          {loadError && (
            <div className="text-xs text-destructive">{loadError}</div>
          )}
          <div className="text-sm text-muted-foreground whitespace-nowrap sm:ml-auto">
            Showing {filteredSamples.length > 0 ? startIndex + 1 : 0}-{Math.min(startIndex + itemsPerPage, filteredSamples.length)} of {filteredSamples.length}
          </div>
        </div>

        <div className="flex-1 border rounded-md overflow-hidden">
          <div className="h-full overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[80px]">ID</TableHead>
                  <TableHead className="min-w-[300px]">Input</TableHead>
                  <TableHead className="min-w-[300px]">Model Response</TableHead>
                  <TableHead className="min-w-[300px]">Ground Truth</TableHead>
                  <TableHead className="w-[100px] text-right">Score</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {currentSamples.length > 0 ? (
                  currentSamples.map((sample, idx) => (
                    <TableRow key={idx}>
                      <TableCell className="font-mono text-xs align-top">
                        {sample.sample_id || idx}
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="whitespace-pre-wrap text-xs font-mono max-h-[200px] overflow-y-auto">
                          {sample.input}
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="whitespace-pre-wrap text-xs text-blue-600 dark:text-blue-400 max-h-[200px] overflow-y-auto">
                          {sample.response}
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="whitespace-pre-wrap text-xs text-green-600 dark:text-green-400 max-h-[200px] overflow-y-auto">
                          {sample.ground_truth}
                        </div>
                      </TableCell>
                      <TableCell className="align-top text-right">
                        <div className="font-semibold text-sm">
                          {typeof sample.score === 'number' ? formatRawScoreValue(sample.score) : sample.score || 'N/A'}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center">
                      No results found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        <div className="flex items-center justify-end space-x-2 py-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            disabled={currentPage === 1}
          >
            Previous
          </Button>
          <div className="text-sm font-medium">
            Page {currentPage} of {totalPages || 1}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages || totalPages === 0}
          >
            Next
          </Button>
        </div>
      </div>
      )}
    </>
  )
}

function BenchmarkResultCard({
  evaluation,
  result,
  titleOverride,
  showSetupBadge = true,
}: {
  evaluation: BenchmarkEvaluation,
  result: EvaluationResult
  titleOverride?: string
  showSetupBadge?: boolean
}) {
  const [isOpen, setIsOpen] = useState(false)
  // Inline samples from the dataset are shown immediately
  const inlineSamples = evaluation.detailed_evaluation_results_per_samples
  const detailedUrl = result.detailed_evaluation_results_url

  const randomSample = useMemo(() => {
    if (!inlineSamples || inlineSamples.length === 0) return null;
    const randomIndex = Math.floor(Math.random() * inlineSamples.length);
    return inlineSamples[randomIndex];
  }, [inlineSamples]);

  const formatDate = formatDateISO

  const { score } = result.score_details
  const { min_score = 0, max_score = 1, unit, lower_is_better } = result.metric_config
  const detailEntries = result.score_details.details
    ? Object.entries(result.score_details.details)
    : []
  const numericBreakdown = detailEntries.filter(([, value]) => typeof value === "number")
  const structuredBreakdown = detailEntries.filter(([, value]) => typeof value !== "number")
  
  // Normalize to 0-1 for color coding
  let normalized = (score - min_score) / (max_score - min_score)
  if (lower_is_better) normalized = 1 - normalized
  
  const isHigh = normalized >= 0.8
  const isMedium = normalized >= 0.6
  
    let displayScore = formatRawScoreValue(score)
    let displayUnit = normalizeDisplayLabel(unit) || "Score"
  const evaluationVariant = getEvaluationVariantLabel(evaluation)
  
    if (unit === 'points') {
      displayScore = score.toFixed(1)
      displayUnit = "/ 10"
    } else if (unit === 'accuracy' || unit === 'pass@1' || !unit) {
      displayUnit = normalizeDisplayLabel(unit) || "Accuracy"
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card className="overflow-hidden border-l-4 border-l-primary">
        <div className="bg-card p-4 flex justify-between items-center">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold">{titleOverride || getResultDisplayName(evaluation, result)}</h3>
              <Badge variant="outline" className="text-xs font-normal text-muted-foreground">
                {result.metric_config.score_type}
              </Badge>
              {showSetupBadge && evaluationVariant && (
                <Badge variant="secondary" className="text-xs font-normal">
                  Setup: {evaluationVariant}
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground text-sm mt-1 line-clamp-1">{result.metric_config.evaluation_description}</p>
          </div>
          
          <div className="flex items-center gap-6">
            <div className="text-right">
              <div className="text-2xl font-bold">{displayScore}</div>
              <div className="text-xs text-muted-foreground">{displayUnit}</div>
            </div>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="w-9 p-0">
                {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                <span className="sr-only">Toggle details</span>
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>

        <CollapsibleContent>
          <Separator />
          <CardContent className="p-6 space-y-6 bg-muted/5">
            {/* Source Provenance */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Database className="h-4 w-4 text-primary" />
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Source Provenance</div>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-muted/10 p-4 rounded-lg border">
                {/* Source Metadata */}
                <div className="space-y-3">
                  <h4 className="text-sm font-semibold text-primary/80">Evaluator Metadata</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Organization:</span>
                      <span className="font-medium">{getOrganizationDisplayName(evaluation.source_metadata.source_organization_name)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Relationship:</span>
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${getRelationshipBadgeTone(evaluation.source_metadata.evaluator_relationship)}`}>
                        {getRelationshipShortLabel(evaluation.source_metadata.evaluator_relationship)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Source Type:</span>
                      <span>{getSourceTypeDisplayName(evaluation.source_metadata.source_type)}</span>
                    </div>
                    {evaluationVariant && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Evaluation Setup:</span>
                        <span>{evaluationVariant}</span>
                      </div>
                    )}
                    {evaluation.source_metadata.source_url && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">URL:</span>
                        <a href={evaluation.source_metadata.source_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline flex items-center gap-1">
                          Link <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Date:</span>
                      <span>{formatDate(evaluation.retrieved_timestamp)}</span>
                    </div>
                  </div>
                </div>

                {/* Source Data */}
                <div className="space-y-3">
                  <h4 className="text-sm font-semibold text-primary/80">Dataset Information</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Name:</span>
                      <span className="font-medium">
                        {Array.isArray(evaluation.source_data) ? 'Multiple Sources' : evaluation.source_data.dataset_name}
                      </span>
                    </div>
                    {!Array.isArray(evaluation.source_data) && (
                      <>
                        {evaluation.source_data.hf_repo && (
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">HuggingFace:</span>
                            <a href={`https://huggingface.co/${evaluation.source_data.hf_repo}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline flex items-center gap-1">
                              {evaluation.source_data.hf_repo.split('/')[1] || evaluation.source_data.hf_repo} <ExternalLink className="h-3 w-3" />
                            </a>
                          </div>
                        )}
                        {evaluation.source_data.hf_split && (
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Split:</span>
                            <code className="bg-muted px-1 rounded text-xs">{evaluation.source_data.hf_split}</code>
                          </div>
                        )}
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Samples:</span>
                          <span>{evaluation.source_data.samples_number?.toLocaleString()}</span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <Separator />

            {/* Evaluation Results */}
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Evaluation Results</div>
              
              <div className="bg-background rounded-lg p-4 border">
                <div className="flex justify-between items-end mb-2">
                  <div>
                    <div className="font-medium text-lg">Overall Score</div>
                    <div className="text-xs text-muted-foreground">
                      {result.metric_config.score_type} • {result.metric_config.min_score}-{result.metric_config.max_score} • {result.metric_config.lower_is_better ? 'Lower is better' : 'Higher is better'}
                    </div>
                  </div>
                  <div className="text-2xl font-bold text-primary">{displayScore}</div>
                </div>
                <Progress value={normalized * 100} className="h-2 mb-4" />
                
                {detailEntries.length > 0 && (
                  <>
                    <Separator className="my-4" />
                    <div className="mb-2">
                      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Detailed Breakdown</div>
                      <div className="text-xs text-muted-foreground mt-1">Scores and structured metadata for individual slices or metrics.</div>
                    </div>

                    {numericBreakdown.length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                        {numericBreakdown.map(([key, value]) => {
                        let valDisplay = typeof value === 'number' ? value.toFixed(2) : value;
                        let normalized_slice = 0;
                        
                        if (typeof value === 'number') {
                            if (unit === 'accuracy' || !unit || unit === 'pass@1') {
                                valDisplay = formatRawScoreValue(value);
                                normalized_slice = value;
                            } else {
                                valDisplay = value.toFixed(2);
                                normalized_slice = (value - min_score) / (max_score - min_score);
                            }
                        }
                        
                        // Format the key nicely
                        const formattedKey = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                        
                        return (
                        <div key={key} className="bg-muted/30 p-3 rounded border min-w-0">
                          <div className="text-xs text-muted-foreground mb-1 truncate" title={formattedKey}>{formattedKey}</div>
                          <div className="font-semibold text-lg">
                            {valDisplay}
                          </div>
                          {typeof value === 'number' && (
                            <Progress value={normalized_slice * 100} className="h-1 mt-2" />
                          )}
                        </div>
                      )})}
                      </div>
                    )}

                    {structuredBreakdown.length > 0 && (
                      <div className="mt-4 space-y-3">
                        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                          Structured Detail Fields
                        </div>
                        <div className="rounded-lg border overflow-hidden">
                          <Table>
                            <TableHeader>
                              <TableRow className="hover:bg-transparent">
                                <TableHead className="w-[240px]">Field</TableHead>
                                <TableHead>Value</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {structuredBreakdown.map(([key, value]) => {
                                const formattedKey = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                                const formattedValue = formatMetadataValue(value) ?? "N/A"

                                return (
                                  <TableRow key={key}>
                                    <TableCell className="align-top whitespace-normal text-sm font-medium">
                                      {formattedKey}
                                    </TableCell>
                                    <TableCell className="align-top whitespace-normal">
                                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-xs leading-5">
                                        {formattedValue}
                                      </pre>
                                    </TableCell>
                                  </TableRow>
                                )
                              })}
                            </TableBody>
                          </Table>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Generation Configuration */}
            {result.generation_config && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Settings className="h-4 w-4 text-primary" />
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Generation Configuration</div>
                </div>
                
                <div className="bg-slate-950 text-slate-200 p-4 rounded-lg font-mono text-sm overflow-x-auto">
                  {result.generation_config.additional_details && (
                    <div className="mb-4 pb-4 border-b border-slate-800">
                      <div className="text-slate-500 text-xs uppercase mb-1">Description</div>
                      <div className="whitespace-pre-wrap">
                        {formatMetadataValue(result.generation_config.additional_details)}
                      </div>
                    </div>
                  )}
                  
                  {result.generation_config.generation_args && (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      {Object.entries(result.generation_config.generation_args).map(([key, value]) => (
                        <div key={key}>
                          <div className="text-slate-500 text-xs">{key}</div>
                          <div className="text-emerald-400 whitespace-pre-wrap break-words">
                            {formatMetadataValue(value)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Sample Level Data — inline samples from the dataset show immediately */}
            {inlineSamples && inlineSamples.length > 0 && randomSample && (
              <div>
                <Separator className="my-6" />
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <FileCode className="h-4 w-4 text-primary" />
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Sample Level Data (Random Sample)</div>
                  </div>
                  <Badge variant="outline">{inlineSamples.length} Samples</Badge>
                </div>

                <div className="space-y-4">
                  <div className="bg-muted/10 border rounded-lg p-4 text-sm">
                    <div className="flex justify-between items-start mb-2">
                      <Badge variant="secondary" className="font-mono text-xs">ID: {randomSample.sample_id}</Badge>
                    </div>

                    <div className="grid gap-4">
                      <div>
                        <div className="text-xs font-semibold text-muted-foreground uppercase mb-1">Input</div>
                        <div className="bg-muted/30 p-3 rounded whitespace-pre-wrap font-mono text-xs max-h-60 overflow-y-auto">{randomSample.input}</div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <div className="text-xs font-semibold text-muted-foreground uppercase mb-1">Model Response</div>
                          <div className="bg-blue-50/50 dark:bg-blue-900/10 p-3 rounded whitespace-pre-wrap text-blue-900 dark:text-blue-100 max-h-60 overflow-y-auto">
                            {randomSample.response}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-muted-foreground uppercase mb-1">Ground Truth</div>
                          <div className="bg-green-50/50 dark:bg-green-900/10 p-3 rounded whitespace-pre-wrap text-green-900 dark:text-green-100 max-h-60 overflow-y-auto">
                            {randomSample.ground_truth}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="text-center pt-2">
                    <SampleDataDialog
                      samples={inlineSamples}
                      evaluationName={result.evaluation_name}
                      fullDataUrl={detailedUrl}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Footer Links */}
            <div className="flex gap-3 pt-2">
              {result.detailed_evaluation_results_url && (
                <a 
                  href={result.detailed_evaluation_results_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-primary hover:underline"
                >
                  <Database className="h-4 w-4" />
                  View detailed per-sample results <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}

function BenchmarkDeepDiveDialogPanel({
  group,
  comparisonIndex,
  evalHierarchy,
  hierarchyIndex,
}: {
  group: BenchmarkGroup
  comparisonIndex?: ComparisonIndex | null
  evalHierarchy?: EvalHierarchy | null
  hierarchyIndex?: Map<string, HierarchyEvalLocation> | null
}) {
  const { mode } = useAudienceMode()
  const isResearchView = mode === "research"
  const [resolvedRanks, setResolvedRanks] = useState<Record<string, { position: number; total: number | null }>>({})
  const [isResolvingRanks, setIsResolvingRanks] = useState(false)
  const compactDomains = group.domains.slice(0, 2)
  const sliceCount = getGroupSliceCount(group)
  const hasSliceMatrix = sliceCount > 0
  const sourceOrganizations = useMemo(
    () => new Set(group.variants.map((variant) => getOrganizationDisplayName(variant.evaluation.source_metadata.source_organization_name))),
    [group.variants]
  )
  const rankedVariants = useMemo(
    () =>
      [...group.variants].sort((a, b) => {
        const aRank = a.rankRatio ?? Number.POSITIVE_INFINITY
        const bRank = b.rankRatio ?? Number.POSITIVE_INFINITY

        if (aRank !== bRank) {
          return aRank - bRank
        }

        return b.normalizedScore - a.normalizedScore
      }),
    [group.variants]
  )

  // Cross-family appearances: hierarchy.json's `benchmark_index[]` cross-links
  // a canonical benchmark across multiple families (e.g. AIME appears in
  // artificial-analysis, llm-stats, and vals-ai). When any of this group's
  // variant constituent_evaluation_ids show up in a benchmark_index entry, surface the
  // other appearances as a "this benchmark also reports as" panel so the
  // reader sees the duplication without leaving the dialog.
  const crossFamilyAppearances = useMemo(() => {
    const benchmarkIndex = evalHierarchy?.benchmark_index
    if (!benchmarkIndex || benchmarkIndex.length === 0) return [] as Array<{
      canonicalDisplayName: string
      appearances: Array<{
        familyKey: string
        familyDisplayName: string
        evalSummaryId: string
        isCurrent: boolean
      }>
    }>

    const groupEvalIds = new Set(
      group.variants
        .map((v) => v.evaluation.eval_summary_id)
        .filter((id): id is string => Boolean(id)),
    )
    if (groupEvalIds.size === 0) return []

    const familyDisplayByKey = new Map<string, string>()
    for (const fam of evalHierarchy?.families ?? []) {
      familyDisplayByKey.set(fam.key, fam.display_name)
    }

    const seen = new Set<string>()
    const out: Array<{
      canonicalDisplayName: string
      appearances: Array<{
        familyKey: string
        familyDisplayName: string
        evalSummaryId: string
        isCurrent: boolean
      }>
    }> = []
    // benchmark_index is pre-cleaned server-side (cleanHierarchy):
    // family-rollup entries are dropped, (family, eval_id) pairs are
    // deduped, degenerate entries are filtered. So we just walk it.
    for (const entry of benchmarkIndex) {
      const flat: Array<{ familyKey: string; evalSummaryId: string }> = []
      for (const app of entry.appearances ?? []) {
        for (const id of app.constituent_evaluation_ids ?? []) {
          flat.push({ familyKey: app.family_key, evalSummaryId: id })
        }
      }
      const matches = flat.some((f) => groupEvalIds.has(f.evalSummaryId))
      if (!matches) continue
      if (seen.has(entry.key)) continue
      seen.add(entry.key)
      out.push({
        canonicalDisplayName: entry.display_name,
        appearances: flat.map((f) => ({
          familyKey: f.familyKey,
          familyDisplayName: familyDisplayByKey.get(f.familyKey) ?? f.familyKey,
          evalSummaryId: f.evalSummaryId,
          isCurrent: groupEvalIds.has(f.evalSummaryId),
        })),
      })
    }
    return out
  }, [evalHierarchy, group.variants])

  void hierarchyIndex

  const variantRows = useMemo<DeepDiveVariantRow[]>(
    () =>
      rankedVariants.map((variant, index) => {
        const rowKey = `${variant.evaluation.evaluation_id}-${index}`
        const evalHref = getEvalDetailHref(variant.evaluation, variant.result)
        const evalSummaryId = variant.evaluation.eval_summary_id ?? getEvalSummaryIdFromHref(evalHref)
        const configMap = getVariantConfigMap(variant)

        return {
          rowKey,
          variant,
          evalSummaryId,
          configMap,
          configEntries: Object.entries(configMap),
        }
      }),
    [rankedVariants]
  )

  const rowsByPrimaryLabel = useMemo(() => {
    const groupedRows = new Map<string, DeepDiveVariantRow[]>()

    for (const row of variantRows) {
      const primaryLabel = getVariantPrimaryLabel(row.variant, group.title)
      const existing = groupedRows.get(primaryLabel) ?? []
      existing.push(row)
      groupedRows.set(primaryLabel, existing)
    }

    return groupedRows
  }, [group.title, variantRows])

  const hasAmbiguousPrimaryLabels = useMemo(
    () => Array.from(rowsByPrimaryLabel.values()).some((rows) => rows.length > 1),
    [rowsByPrimaryLabel]
  )

  const rowDisambiguationLabels = useMemo(() => {
    const labels = new Map<string, string>()

    for (const [primaryLabel, rows] of rowsByPrimaryLabel.entries()) {
      if (rows.length <= 1) {
        continue
      }

      const runLabelsByRow = new Map<string, string>()
      const distinctRunLabels = new Set<string>()

      for (const row of rows) {
        const runLabel = getVariantRunLabels(row, comparisonIndex)[0]
        if (!runLabel) {
          continue
        }

        runLabelsByRow.set(row.rowKey, runLabel)
        distinctRunLabels.add(runLabel)
      }

      if (distinctRunLabels.size === rows.length) {
        for (const row of rows) {
          const runLabel = runLabelsByRow.get(row.rowKey)
          if (runLabel) {
            labels.set(row.rowKey, runLabel)
          }
        }
        continue
      }

      const configLabelsByRow = new Map<string, string>()
      const distinctConfigLabels = new Set<string>()

      for (const row of rows) {
        const configLabel = getVariantConfigDisambiguation(row, rows).join(" · ")
        if (!configLabel) {
          continue
        }

        configLabelsByRow.set(row.rowKey, configLabel)
        distinctConfigLabels.add(configLabel)
      }

      if (distinctConfigLabels.size === rows.length) {
        for (const row of rows) {
          const configLabel = configLabelsByRow.get(row.rowKey)
          if (configLabel) {
            labels.set(row.rowKey, configLabel)
          }
        }
        continue
      }

      rows.forEach((row, index) => {
        labels.set(row.rowKey, `${primaryLabel} run ${index + 1}`)
      })
    }

    return labels
  }, [comparisonIndex, rowsByPrimaryLabel])

  const bestResolvedRank = useMemo(() => {
    const candidates = variantRows
      .map((row) => {
        const resolved = resolvedRanks[row.rowKey]
        if (resolved) return resolved
        if (row.variant.rankPosition != null) {
          return { position: row.variant.rankPosition, total: row.variant.rankTotal }
        }
        return null
      })
      .filter((r): r is { position: number; total: number | null } => r != null)
      .sort((a, b) => {
        const aRatio = a.total != null && a.total > 0 ? a.position / a.total : a.position
        const bRatio = b.total != null && b.total > 0 ? b.position / b.total : b.position
        return aRatio - bRatio
      })
    return candidates[0] ?? null
  }, [resolvedRanks, variantRows])

  // Kept only to drive the single-setup overview: when every reported row is
  // reported under the same setup, the detail table collapses into a compact
  // view that drops the redundant "Reporting setup" column.
  const sliceSetups = useMemo(() => {
    if (!hasSliceMatrix) return null
    const setupOrder: string[] = []
    for (const row of variantRows) {
      const setupDisplayLabel = formatSetupDisplayLabel(row.variant.setupLabel)
      if (!setupOrder.includes(setupDisplayLabel)) setupOrder.push(setupDisplayLabel)
    }
    return { setupOrder }
  }, [hasSliceMatrix, variantRows])

  const useSingleSetupOverview = Boolean(sliceSetups && sliceSetups.setupOrder.length === 1)
  const singleSetupDisplayLabel = useSingleSetupOverview ? sliceSetups?.setupOrder[0] ?? null : null

  useEffect(() => {
    const pendingRows = variantRows.filter(
      (row) => row.variant.rankPosition == null && !resolvedRanks[row.rowKey] && row.evalSummaryId
    )

    if (pendingRows.length === 0) {
      return
    }

    let isCancelled = false

    const resolveRanks = async () => {
      setIsResolvingRanks(true)

      const nextResolvedEntries = await Promise.all(
        pendingRows.map(async (row) => {
          const rank = await fetchPeerRankForModel(row.evalSummaryId, row.variant.evaluation.model_info.id)
          return rank ? ([row.rowKey, rank] as const) : null
        })
      )

      if (isCancelled) {
        return
      }

      setResolvedRanks((current) => {
        const patch: Record<string, { position: number; total: number | null }> = {}

        for (const entry of nextResolvedEntries) {
          if (!entry) {
            continue
          }

          patch[entry[0]] = entry[1]
        }

        return Object.keys(patch).length > 0 ? { ...current, ...patch } : current
      })

      setIsResolvingRanks(false)
    }

    resolveRanks()

    return () => {
      isCancelled = true
    }
  }, [resolvedRanks, variantRows])

  return (
    <>
      <DialogHeader className="gap-0 border-b border-[color:var(--fg)] px-6 py-5 text-left">
        <div className="flex items-start justify-between gap-4 pr-6">
          <div className="min-w-0 flex-1">
            <div className="kicker mb-2">
              <span className="text-[color:var(--accent)] font-semibold mr-2">{formatTagLabel(group.category as unknown as string)}</span>
              <span className="text-[color:var(--fg-subtle)]">· Benchmark deep dive</span>
            </div>
            <DialogTitle className="text-[28px] leading-[1.05] tracking-[-0.02em] font-bold text-[color:var(--fg)]">
              {getBenchmarkGroupHeading(group)}
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-[13px] leading-[1.5] text-[color:var(--fg-muted)]">
              {isResearchView
                ? "Inspect setup slices, score details, and source provenance in one focused view."
                : "Inspect reporting setup and evidence details before interpreting benchmark position."}
            </DialogDescription>
            {(compactDomains.length > 0 || group.benchmarkCard) && (
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]">
                {compactDomains.map((domain) => (
                  <span key={`${group.key}-${domain}`}>{domain}</span>
                ))}
                {group.domains.length > compactDomains.length && (
                  <span>+{group.domains.length - compactDomains.length}</span>
                )}
                {group.benchmarkCard && <span>· Card available</span>}
              </div>
            )}
          </div>

          <div className="text-right shrink-0">
            <div className="kicker mb-1">Avg score</div>
            <div className="text-[24px] font-semibold tabular-nums leading-none">
              {group.avgDisplayScore}
            </div>
            {group.bestRankPosition != null && (
              <div className="mt-2 font-mono text-[11px] tabular-nums text-[color:var(--fg-muted)]">
                #{group.bestRankPosition}{group.bestRankTotal ? `/${group.bestRankTotal}` : ""}
              </div>
            )}
          </div>
        </div>
      </DialogHeader>

      <div className="flex min-h-0 flex-col gap-6 overflow-y-auto px-6 py-5">
        {/* Stat strip — paper-style hairline grid */}
        <div className="grid grid-cols-3 border-t border-l border-[color:var(--border-soft)]">
          <div className="border-r border-b border-[color:var(--border-soft)] px-4 py-3">
            <div className="kicker">Reported rows</div>
            <div className="mt-1 text-[18px] font-semibold tabular-nums">{group.variants.length}</div>
          </div>
          <div className="border-r border-b border-[color:var(--border-soft)] px-4 py-3">
            <div className="kicker">Best rank</div>
            <div className="mt-1 text-[18px] font-semibold tabular-nums">
              {bestResolvedRank != null
                ? `#${bestResolvedRank.position}${bestResolvedRank.total ? `/${bestResolvedRank.total}` : ""}`
                : isResolvingRanks
                  ? "…"
                  : "N/A"}
            </div>
          </div>
          <div className="border-r border-b border-[color:var(--border-soft)] px-4 py-3">
            <div className="kicker">Sources</div>
            <div className="mt-1 text-[18px] font-semibold tabular-nums">
              {sourceOrganizations.size}
              {hasSliceMatrix && (
                <span className="ml-2 font-mono text-[10px] tracking-[0.12em] uppercase text-[color:var(--fg-subtle)]">
                  · {sliceCount} slice{sliceCount === 1 ? "" : "s"}
                </span>
              )}
            </div>
          </div>
        </div>

        {group.benchmarkCard && (
          <div>
            <div className="kicker mb-2">Benchmark context</div>
            <p className="text-[14px] leading-[1.65] text-[color:var(--fg-muted)] line-clamp-3 max-w-[60rem]">
              {group.benchmarkCard.benchmark_details.overview}
            </p>
          </div>
        )}

        {/* Sources — distinct reporting orgs and dataset links for this group.
            Pulled up to the top of the deep-dive so the per-row table can
            stay focused on slice / setup / score. */}
        {(() => {
          type SourceEntry = {
            key: string
            orgName: string
            orgHref: string | null
            relationship: string | null | undefined
            datasetHref: string | null
          }
          const entries: SourceEntry[] = []
          const seen = new Set<string>()
          for (const variant of group.variants) {
            const meta = variant.evaluation.source_metadata
            const orgName = getOrganizationDisplayName(meta.source_organization_name)
            const orgHref = meta.source_organization_url || null
            const rawSource = variant.result.source_data ?? variant.evaluation.source_data
            const sourceData = !Array.isArray(rawSource) ? rawSource : null
            const datasetHref =
              sourceData?.dataset_url ||
              (Array.isArray(sourceData?.url) ? sourceData?.url?.[0] : sourceData?.url) ||
              (sourceData?.hf_repo ? `https://huggingface.co/datasets/${sourceData.hf_repo}` : null) ||
              null
            const relationship = meta.evaluator_relationship
            const key = `${orgName}::${orgHref ?? ""}::${relationship ?? ""}::${datasetHref ?? ""}`
            if (seen.has(key)) continue
            seen.add(key)
            entries.push({ key, orgName, orgHref, relationship, datasetHref })
          }
          if (entries.length === 0) return null
          return (
            <div>
              <div className="kicker mb-3">Sources</div>
              <ul className="flex flex-col">
                {entries.map((entry, i) => {
                  const showDataset = Boolean(entry.datasetHref) && entry.datasetHref !== entry.orgHref
                  const isFirst = entry.relationship === "first_party"
                  const isThird = entry.relationship === "third_party"
                  return (
                    <li
                      key={entry.key}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2"
                      style={{ borderBottom: i < entries.length - 1 ? "1px solid var(--border-soft)" : "none" }}
                    >
                      {entry.orgHref ? (
                        <a
                          href={entry.orgHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[14px] font-medium text-[color:var(--fg)] hover:text-[color:var(--accent)]"
                        >
                          {entry.orgName}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-[14px] font-medium text-[color:var(--fg)]">{entry.orgName}</span>
                      )}
                      <span
                        className="font-mono text-[10px] uppercase tracking-[0.15em]"
                        style={{
                          color: isFirst
                            ? "var(--fg-muted)"
                            : isThird
                              ? "var(--accent)"
                              : "var(--fg-subtle)",
                        }}
                        title={
                          entry.relationship === "first_party"
                            ? "Reported by the model's developer (first-party)."
                            : entry.relationship === "third_party"
                              ? "Reported by an independent third party."
                              : entry.relationship === "collaborative"
                                ? "Collaborative report by the developer and a third party."
                                : undefined
                        }
                      >
                        · {getRelationshipShortLabel(entry.relationship)}
                      </span>
                      {showDataset && (
                        <a
                          href={entry.datasetHref!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--fg-muted)] hover:text-[color:var(--accent)]"
                        >
                          · Dataset
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })()}

        {crossFamilyAppearances.length > 0 && (
          <section>
            <div className="section-head">
              <h2>Also reports this benchmark</h2>
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]">
                {crossFamilyAppearances.reduce((sum, e) => sum + e.appearances.length, 0)} entries
              </span>
            </div>
            <p className="mb-3 max-w-[60rem] text-[13px] leading-[1.65] text-[color:var(--fg-muted)]">
              The same canonical benchmark appears under multiple families. Each
              entry below is a separate eval row; scores from these siblings can
              be compared but are recorded independently.
            </p>
            <div className="border-t border-l border-[color:var(--border-soft)]">
              {crossFamilyAppearances.flatMap((entry) =>
                entry.appearances.map((app) => (
                  <Link
                    key={`${entry.canonicalDisplayName}::${app.evalSummaryId}`}
                    href={`/evals/${routeIdToPath(app.evalSummaryId)}`}
                    className="flex items-center justify-between gap-4 border-r border-b border-[color:var(--border-soft)] px-3 py-2 transition-colors hover:bg-[color:var(--bg-warm)]"
                    style={{
                      background: app.isCurrent ? "var(--bg-warm)" : "var(--bg)",
                    }}
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-[color:var(--fg)]">
                        {app.familyDisplayName}
                        {app.isCurrent && (
                          <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--accent)]">
                            · current
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[10.5px] text-[color:var(--fg-subtle)]">
                        {humanizeEvaluationId(app.evalSummaryId)}
                      </div>
                    </div>
                    <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--accent)] shrink-0">
                      Open <ArrowUpRight className="inline h-3 w-3 align-text-top" aria-hidden />
                    </span>
                  </Link>
                )),
              )}
            </div>
          </section>
        )}

        {useSingleSetupOverview ? (
          <section>
            <div className="section-head">
              <h2>{hasAmbiguousPrimaryLabels ? "Reported runs" : "Slice overview"}</h2>
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]">
                {singleSetupDisplayLabel ? `${singleSetupDisplayLabel} · ` : ""}
                {variantRows.length} row{variantRows.length === 1 ? "" : "s"}
              </span>
            </div>

            <p className="mb-4 max-w-[60rem] text-[13px] leading-[1.65] text-[color:var(--fg-muted)]">
              {hasAmbiguousPrimaryLabels
                ? isResearchView
                  ? "These rows share the same benchmark label, so run names or differing config fields are surfaced to show what changed across reports."
                  : "These rows describe the same benchmark view, so the table surfaces the reported run name or setup differences that separate them."
                : isResearchView
                  ? "This benchmark reports one setup, so slices, scores, and provenance are merged into one comparison view."
                  : "This benchmark only reports one setup, so the slice evidence is consolidated into a single view."}
            </p>

            <div className="min-h-0 overflow-auto">
              <table className="ec-htable table-fixed">
                <thead>
                  <tr>
                    <th className="w-[60%]">
                      {hasAmbiguousPrimaryLabels ? "Reported row" : "Slice"}
                    </th>
                    <th className="w-[20%]">Setup detail</th>
                    <th className="num w-[10%]">Score</th>
                    <th className="num w-[10%]">Rank</th>
                  </tr>
                </thead>
                <tbody>
                  {variantRows.map((row, index) => {
                    const { rowKey, variant, configEntries } = row
                    const resolvedRank = resolvedRanks[rowKey]
                    const primaryLabel = getVariantPrimaryLabel(variant, group.title)
                    const filteredConfigEntries = configEntries.filter(([key]) => key.toLowerCase() !== "setup")
                    const disambiguationLabel = rowDisambiguationLabels.get(rowKey)
                    const leadLabel = hasAmbiguousPrimaryLabels
                      ? disambiguationLabel ?? `Reported run ${index + 1}`
                      : primaryLabel
                    const supportingLabel = hasAmbiguousPrimaryLabels
                      ? primaryLabel
                      : disambiguationLabel && disambiguationLabel !== primaryLabel
                        ? disambiguationLabel
                        : null

                    return (
                      <tr key={rowKey} className="align-top">
                        <td className="align-top">
                          <div className="text-[14px] font-medium leading-[1.4]">{leadLabel}</div>
                          {supportingLabel && (
                            <div className="mt-0.5 text-[12px] text-[color:var(--fg-muted)]">{supportingLabel}</div>
                          )}
                          {(!variant.evaluation.slice_key || variant.variantType !== "default") && (
                            <div className="mt-1 flex flex-wrap gap-x-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--fg-subtle)]">
                              {!variant.evaluation.slice_key && <span>Benchmark-level metric</span>}
                              {variant.variantType !== "default" && <span>· {getVariantTypeLabel(variant.variantType)}</span>}
                            </div>
                          )}
                          <SignalsRowBadges
                            annotations={variant.result.evalcards?.annotations}
                            className="justify-start mt-1"
                          />
                        </td>
                        <td className="align-top text-[12px] text-[color:var(--fg-muted)]">
                          <div>{singleSetupDisplayLabel}</div>
                          {filteredConfigEntries.length > 0 && (
                            <div className="mt-0.5 line-clamp-2 font-mono text-[10.5px] text-[color:var(--fg-subtle)]">
                              {filteredConfigEntries
                                .slice(0, 2)
                                .map(([key, value]) => `${formatConfigLabel(key)}=${getConfigDisplayValue(value)}`)
                                .join(" · ")}
                            </div>
                          )}
                        </td>
                        <td className="num align-top font-semibold tabular-nums">
                          <div>{variant.displayScore}</div>
                        </td>
                        <td className="num align-top tabular-nums text-[color:var(--fg-muted)]">
                          {variant.rankPosition != null || resolvedRank ? (
                            `#${resolvedRank?.position ?? variant.rankPosition}${
                              (resolvedRank?.total ?? variant.rankTotal)
                                ? `/${resolvedRank?.total ?? variant.rankTotal}`
                                : ""
                            }`
                          ) : (
                            <span className="text-[color:var(--fg-subtle)]">—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {!useSingleSetupOverview && (
        <section>
          <div className="section-head">
            <h2>Benchmark breakdown</h2>
            <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]">
              {variantRows.length} row{variantRows.length === 1 ? "" : "s"}
            </span>
          </div>
          <p className="mb-4 max-w-[60rem] text-[13px] leading-[1.65] text-[color:var(--fg-muted)]">
            Primary row labels show the benchmark split or setup variant. Setup and source details sit alongside each row.
          </p>

          <div className="min-h-0 overflow-auto">
            <table className="ec-htable table-fixed">
              <thead>
                <tr>
                  <th className="w-[46%]">Split</th>
                  <th className="w-[36%]">Reporting setup</th>
                  <th className="num w-[9%]">Score</th>
                  <th className="num w-[9%]">Rank</th>
                </tr>
              </thead>
              <tbody>
                {variantRows.map((row) => {
                  const { rowKey, variant, configEntries } = row
                  const resolvedRank = resolvedRanks[rowKey]
                  const rawPrimaryLabel = getVariantPrimaryLabel(variant, group.title)
                  const primaryLabel = humanizeBenchmarkName(rawPrimaryLabel)
                  const setupDisplayLabel = formatSetupDisplayLabel(variant.setupLabel)
                  const rawVariantLabel = (() => {
                    if (variant.label === rawPrimaryLabel) return null
                    let v = variant.label
                    try { v = decodeURIComponent(v) } catch {}
                    return v
                  })()

                  return (
                    <tr key={rowKey} className="align-top">
                      <td className="align-top">
                        <div className="text-[14px] font-medium leading-[1.4]">{primaryLabel}</div>
                        <div className="mt-1 flex flex-wrap gap-x-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--fg-subtle)]">
                          <span>{getVariantTypeLabel(variant.variantType)}</span>
                          {rawVariantLabel && <span className="line-clamp-1 normal-case tracking-normal text-[color:var(--fg-muted)] text-[12px]">· {rawVariantLabel}</span>}
                        </div>
                        <SignalsRowBadges
                          annotations={variant.result.evalcards?.annotations}
                          className="justify-start mt-1"
                        />
                      </td>
                      <td className="align-top text-[12px] text-[color:var(--fg-muted)]">
                        <div className="text-[14px] text-[color:var(--fg)] font-medium">{setupDisplayLabel}</div>
                        {configEntries.length > 0 && (
                          <div className="mt-0.5 line-clamp-2 font-mono text-[10.5px] text-[color:var(--fg-subtle)]">
                            {configEntries.slice(0, 3).map(([key, value]) => `${formatConfigLabel(key)}=${getConfigDisplayValue(value)}`).join(" · ")}
                          </div>
                        )}
                      </td>
                      <td className="num align-top font-semibold tabular-nums">
                        <div>{variant.displayScore}</div>
                      </td>
                      <td className="num align-top tabular-nums text-[color:var(--fg-muted)]">
                        {variant.rankPosition != null || resolvedRank ? (
                          `#${resolvedRank?.position ?? variant.rankPosition}${
                            (resolvedRank?.total ?? variant.rankTotal)
                              ? `/${resolvedRank?.total ?? variant.rankTotal}`
                              : ""
                          }`
                        ) : (
                          <span className="text-[color:var(--fg-subtle)]">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
        )}

        {(() => {
          const variantWithSamples = group.variants.find(v => v.evaluation.detailed_evaluation_results_per_samples && v.evaluation.detailed_evaluation_results_per_samples.length > 0)
          if (!variantWithSamples) return null
          const samples = variantWithSamples.evaluation.detailed_evaluation_results_per_samples!
          const fullDataUrl = variantWithSamples.result.detailed_evaluation_results_url
            ?? variantWithSamples.evaluation.evaluation_results.find(r => r.detailed_evaluation_results_url)?.detailed_evaluation_results_url
          return (
            <section>
              <div className="section-head">
                <h2>Sample data preview</h2>
                <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[color:var(--fg-subtle)]">
                  {samples.length} example{samples.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="flex flex-col">
                {samples.slice(0, INSTANCE_PREVIEW_LIMIT).map((sample, idx) => (
                  <div
                    key={idx}
                    className="py-3"
                    style={{ borderBottom: idx < Math.min(INSTANCE_PREVIEW_LIMIT, samples.length) - 1 ? "1px solid var(--border-soft)" : "none" }}
                  >
                    {sample.input && (
                      <div className="mb-2">
                        <div className="kicker mb-1">Input</div>
                        <div className="max-h-28 overflow-y-auto whitespace-pre-wrap text-[12px] leading-[1.55]">
                          {sample.input.slice(0, 400)}{sample.input.length > 400 ? "..." : ""}
                        </div>
                      </div>
                    )}
                    {sample.response && (
                      <div className="mb-2">
                        <div className="kicker mb-1">Response</div>
                        <div className="max-h-20 overflow-y-auto whitespace-pre-wrap text-[12px] leading-[1.55]">
                          {sample.response.slice(0, 300)}{sample.response.length > 300 ? "..." : ""}
                        </div>
                      </div>
                    )}
                    {sample.ground_truth && (
                      <div>
                        <div className="kicker kicker-accent mb-1">Ground truth</div>
                        <div className="whitespace-pre-wrap text-[12px] leading-[1.55] text-[color:var(--fg)]">
                          {sample.ground_truth.slice(0, 200)}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {(samples.length > INSTANCE_PREVIEW_LIMIT || fullDataUrl) && (
                <div className="mt-3">
                  <SampleDataDialog
                    samples={samples}
                    evaluationName={variantWithSamples.result.evaluation_name}
                    fullDataUrl={fullDataUrl}
                  />
                </div>
              )}
            </section>
          )
        })()}

        <div className="flex justify-end border-t border-[color:var(--border-soft)] pt-4">
          <Link href={group.evalDetailHref} className="btn-ec outline">
            View full leaderboard
          </Link>
        </div>
      </div>
    </>
  )
}

function VariantExpandedDetail({
  row,
  group,
  mode,
}: {
  row: VariantRowData
  group: BenchmarkGroup
  mode: "research" | "policy"
}) {
  const isResearchView = mode === "research"
  const { variant, configEntries, sampleCount } = row
  const { numericBreakdown, helmMetrics, structuredBreakdown } = buildVariantStructuredSections(variant)
  const sourceTypeLabel = getSourceTypeDisplayName(variant.evaluation.source_metadata.source_type)
  const sourceData = !Array.isArray(variant.result.source_data ?? variant.evaluation.source_data)
    ? (variant.result.source_data ?? variant.evaluation.source_data) as import("@/lib/benchmark-schema").SourceData
    : null
  const evalLibrary = variant.evaluation.eval_library
  const uncertainty = (variant.result.score_details as any).uncertainty as { standard_error?: { value: number }; num_samples?: number } | undefined
  const confidenceInterval = variant.result.score_details.confidence_interval
  const numSamples = uncertainty?.num_samples ?? variant.result.score_details.sample_size ?? sourceData?.samples_number ?? sampleCount
  const stdError = uncertainty?.standard_error?.value
  const inferencePlatform = variant.evaluation.model_info.inference_platform
  // Source URLs for linking
  const sourceUrls: string[] = Array.isArray(sourceData?.url)
    ? (sourceData.url as string[])
    : sourceData?.url
      ? [sourceData.url as string]
      : sourceData?.dataset_url
        ? [sourceData.dataset_url]
        : []

  return (
    <div className="space-y-4 rounded-xl border bg-background/80 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="font-semibold">{variant.label}</div>
            <Badge className={getVariantTypeTone(variant.variantType)}>
              {getVariantTypeLabel(variant.variantType)}
            </Badge>
            <Badge variant="outline" className="font-normal">
              {group.title}
            </Badge>
          <Badge variant="secondary" className="font-normal">
            {variant.displayScore}
          </Badge>
          <SignalsRowBadges
            annotations={variant.result.evalcards?.annotations}
            className="mt-0 justify-start"
            hideOnMobile={false}
          />
        </div>
          <div className="text-sm text-muted-foreground">{variant.result.metric_config.evaluation_description}</div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">{formatCompactDate(variant.evaluation.retrieved_timestamp)}</Badge>
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${getRelationshipBadgeTone(variant.evaluation.source_metadata.evaluator_relationship)}`}>
            {getRelationshipShortLabel(variant.evaluation.source_metadata.evaluator_relationship)}
          </span>
          {numSamples != null && <Badge variant="outline">{Number(numSamples).toLocaleString()} samples</Badge>}
          {evalLibrary && (
            <Badge variant="outline">
              {formatEvalLibrary(evalLibrary)}
            </Badge>
          )}
        </div>
      </div>

      <div className={`grid gap-4 ${isResearchView ? "2xl:grid-cols-[1.1fr_0.9fr]" : "2xl:grid-cols-[0.95fr_1.05fr]"}`}>
        <div className="rounded-xl border bg-muted/10 p-4">
          <div className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            {isResearchView ? "Provenance & Dataset" : "Reporting Context"}
          </div>
          <div className="grid gap-3 md:grid-cols-2 text-sm">
            <InlineMeta label="Organization" value={getOrganizationDisplayName(variant.evaluation.source_metadata.source_organization_name)} />
            <InlineMeta label="Source Type" value={sourceTypeLabel} />
            <InlineMeta label="Relationship" value={getRelationshipDisplayName(variant.evaluation.source_metadata.evaluator_relationship)} />
            <InlineMeta
              label={isResearchView ? "Dataset" : "Benchmark"}
              value={normalizeDisplayLabel(sourceData?.dataset_name ?? group.title)}
            />
            {sourceData?.hf_repo && (
              <InlineMeta label="HF Repo" value={
                <a href={`https://huggingface.co/datasets/${sourceData.hf_repo}`} target="_blank" rel="noopener noreferrer"
                   className="text-primary hover:underline">{sourceData.hf_repo}</a>
              } />
            )}
            {sourceData?.dataset_version && <InlineMeta label="Dataset Version" value={sourceData.dataset_version} />}
            {sourceData?.hf_split && <InlineMeta label="Split" value={sourceData.hf_split} />}
            {variant.sliceLabel && <InlineMeta label="Slice" value={normalizeDisplayLabel(variant.sliceLabel)} />}
            {variant.setupLabel && <InlineMeta label="Setup" value={formatSetupDisplayLabel(variant.setupLabel)} />}
            {inferencePlatform && <InlineMeta label="Inference Platform" value={inferencePlatform} />}
            {variant.evaluation.source_metadata.source_name && (
              <InlineMeta label="Source Name" value={normalizeDisplayLabel(variant.evaluation.source_metadata.source_name)} />
            )}
            <InlineMeta label="Reported" value={formatCompactDate(variant.evaluation.retrieved_timestamp)} />
            <InlineMeta label="Score" value={variant.displayScore} />
            {numSamples != null && <InlineMeta label="Sample Count" value={Number(numSamples).toLocaleString()} />}
            {stdError != null && <InlineMeta label="Std Error" value={`±${stdError}`} />}
            {confidenceInterval && (
              <InlineMeta
                label="Confidence Interval"
                value={`[${confidenceInterval.lower.toFixed(3)}, ${confidenceInterval.upper.toFixed(3)}] @ ${(confidenceInterval.confidence_level * 100).toFixed(0)}%`}
              />
            )}
            {sourceUrls.length > 0 && (
              <InlineMeta label="Source URL" value={
                <div className="flex flex-col gap-0.5">
                  {sourceUrls.map((url, i) => (
                    <a key={i} href={url} target="_blank" rel="noopener noreferrer"
                       className="truncate text-primary hover:underline text-xs"
                       title={url}>{url.replace(/^https?:\/\//, "").slice(0, 50)}{url.length > 57 ? "…" : ""}</a>
                  ))}
                </div>
              } />
            )}
          </div>
        </div>

        <div className="rounded-xl border bg-muted/10 p-4">
          <div className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            {isResearchView ? "Config Snapshot" : "Evaluation Setup"}
          </div>
          <div className="flex flex-wrap gap-2">
            {configEntries.length > 0 ? (
              configEntries.map(([key, value]) => (
                <Badge
                  key={`${row.rowKey}-${key}`}
                  variant="outline"
                  className="max-w-[260px] font-normal"
                  title={`${formatConfigLabel(key)}: ${value}`}
                >
                  {formatConfigLabel(key)}: {getConfigDisplayValue(value)}
                </Badge>
              ))
            ) : (
              <span className="text-sm text-muted-foreground">No explicit config recorded</span>
            )}
          </div>

        </div>
      </div>

      {numericBreakdown.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            {isResearchView ? "Slice Scores" : "Reported Metrics"}
          </div>
          <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {numericBreakdown.map(([key, value]) => {
              const numericValue = value as number
              const minScore = variant.result.metric_config.min_score ?? 0
              const maxScore = variant.result.metric_config.max_score ?? 1
              const range = maxScore - minScore
              const normalizedValue = range > 0 ? ((numericValue - minScore) / range) * 100 : numericValue * 100

              return (
                <div key={key} className="rounded-xl border bg-background p-3">
                  <div className="mb-2 text-xs text-muted-foreground">{formatConfigLabel(key)}</div>
                  <div className="mb-2 text-lg font-semibold">{formatRawScoreValue(numericValue, variant.result.metric_config.unit)}</div>
                  <Progress value={Math.max(0, Math.min(100, normalizedValue))} className="h-1.5" />
                </div>
              )
            })}
          </div>
        </div>
      )}

      {helmMetrics.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Additional Metrics
          </div>
          <div className="rounded-xl border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Metric</TableHead>
                  <TableHead className="w-[100px]">Category</TableHead>
                  <TableHead className="text-right w-[100px]">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {helmMetrics.map(({ label, tab, score }) => {
                  const numericScore = Number.parseFloat(score)
                  return (
                    <TableRow key={label}>
                      <TableCell className="whitespace-normal text-sm">{label}</TableCell>
                      <TableCell className="text-xs text-muted-foreground capitalize">{tab}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums text-sm">
                        {Number.isFinite(numericScore) ? numericScore.toFixed(3) : score}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {structuredBreakdown.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Supporting Detail
          </div>
          <div className="rounded-xl border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[220px]">Field</TableHead>
                  <TableHead>Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {structuredBreakdown.map(([key, value]) => (
                  <TableRow key={key}>
                    <TableCell className="align-top whitespace-normal text-sm font-medium">
                      {formatConfigLabel(key)}
                    </TableCell>
                    <TableCell className="align-top whitespace-normal">
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-xs leading-5">
                        {formatMetadataValue(value)}
                      </pre>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Instance-level sample data */}
      {variant.evaluation.detailed_evaluation_results_per_samples &&
        variant.evaluation.detailed_evaluation_results_per_samples.length > 0 && (
        <div className="space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Sample data ({variant.evaluation.detailed_evaluation_results_per_samples.length} examples)
          </div>
          <div className="space-y-2">
            {variant.evaluation.detailed_evaluation_results_per_samples.slice(0, INSTANCE_PREVIEW_LIMIT).map((sample, idx) => (
              <div key={idx} className="rounded-lg border bg-muted/10 p-3 text-sm">
                {sample.input && (
                  <div className="mb-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Input</span>
                    <div className="mt-0.5 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs">{sample.input.slice(0, 500)}</div>
                  </div>
                )}
                {sample.response && (
                  <div className="mb-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Response</span>
                    <div className="mt-0.5 max-h-24 overflow-y-auto whitespace-pre-wrap text-xs">{sample.response.slice(0, 500)}</div>
                  </div>
                )}
                {sample.ground_truth && (
                  <div className="mb-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-green-700 dark:text-green-400">Ground truth</span>
                    <div className="mt-0.5 max-h-20 overflow-y-auto whitespace-pre-wrap text-xs text-green-900 dark:text-green-100">{sample.ground_truth.slice(0, 300)}</div>
                  </div>
                )}
                {sample.is_correct != null && (
                  <div className="mt-1 text-[10px] font-medium text-muted-foreground">
                    {sample.is_correct ? "Correct" : "Incorrect"}
                  </div>
                )}
              </div>
            ))}
          </div>
          {(variant.evaluation.detailed_evaluation_results_per_samples.length > INSTANCE_PREVIEW_LIMIT ||
            variant.result.detailed_evaluation_results_url ||
            variant.evaluation.evaluation_results.find(r => r.detailed_evaluation_results_url)?.detailed_evaluation_results_url) && (
            <SampleDataDialog
              samples={variant.evaluation.detailed_evaluation_results_per_samples}
              evaluationName={variant.result.evaluation_name}
              fullDataUrl={variant.result.detailed_evaluation_results_url ?? variant.evaluation.evaluation_results.find(r => r.detailed_evaluation_results_url)?.detailed_evaluation_results_url}
            />
          )}
        </div>
      )}

      {variant.evaluation.source_metadata.source_url && (
        <div className="pt-1">
          <a
            href={variant.evaluation.source_metadata.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
          >
            <ExternalLink className="h-4 w-4" />
            View source
          </a>
        </div>
      )}
    </div>
  )
}

function InlineMeta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      <div className="text-sm font-medium break-words">{value}</div>
    </div>
  )
}

/**
 * Compact inline metadata pair used in the model header strip.
 * Renders nothing when children is empty / null.
 */
function MetaFact({
  label,
  children,
  mono = false,
}: {
  label: string
  children: React.ReactNode
  mono?: boolean
}) {
  if (children == null || children === "") return null
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </dt>
      <dd className={`mt-0.5 ${mono ? "font-mono text-[13px]" : "text-sm font-medium"} break-words`}>
        {children}
      </dd>
    </div>
  )
}

/**
 * Compact hero stat cell used in the model header.
 * Tones are subtle backgrounds; cells share a single bordered container.
 */
function HeroStat({
  label,
  value,
  tone,
}: {
  label: string
  value: number | string
  tone: "amber" | "emerald" | "sky" | "slate"
}) {
  const toneClass = {
    amber:
      "bg-amber-50/70 text-amber-900 dark:bg-amber-950/25 dark:text-amber-100",
    emerald:
      "bg-emerald-50/70 text-emerald-900 dark:bg-emerald-950/25 dark:text-emerald-100",
    sky: "bg-sky-50/70 text-sky-900 dark:bg-sky-950/25 dark:text-sky-100",
    slate: "bg-muted/30 text-foreground",
  }[tone]
  return (
    <div
      className={`flex flex-col justify-center border-b border-r border-border/60 px-3.5 py-2.5 last:border-r-0 sm:border-b-0 ${toneClass}`}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] opacity-75">
        {label}
      </div>
      <div className="mt-0.5 text-[1.55rem] font-semibold leading-none tabular-nums">
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
    </div>
  )
}

type EvaluatorMixData = {
  rows: Array<{
    category: EvalTag
    label: string
    first: number
    third: number
    collab: number
    other: number
    total: number
  }>
  firstTotal: number
  thirdTotal: number
  collabTotal: number
  otherTotal: number
  grand: number
}

/**
 * Plain-language scoreboard for Summary view. Renders every reported
 * benchmark as a text-only row — raw score on the right, a medal emoji
 * (🥇🥈🥉) for top-3 peer ranks. No charts; non-technical readers can
 * scan the list quickly without parsing per-benchmark plots.
 *
 * Rows group by family (Vals.ai · BFCL · HELM …). Within each family,
 * rows order by peer rank (best first) and fall back to score when rank
 * is unavailable. Each row links to the benchmark detail page; the
 * eval_summary_id appears as a small "on …" subline so the source of
 * the number is obvious.
 */
function SummaryMetricsList({
  groups,
  currentDetailHref,
  hierarchyIndex,
  sourcePrefixFamily,
  modelIds,
  peerRanks,
}: {
  groups: BenchmarkGroup[]
  currentDetailHref?: string
  hierarchyIndex: Map<string, HierarchyEvalLocation> | null
  sourcePrefixFamily: Map<string, { key: string; displayName: string }>
  modelIds: string[]
  peerRanks: PeerRanksMap
}) {
  const router = useRouter()

  // Eval IDs ship as "<source>%2F<bench-path>". The source prefix is
  // the section header; the bench-path determines the row identity.
  // Branching: variants whose bench-paths share an identifier before
  // any `.` separator (e.g. "swebench.>4 hours" and "swebench.1-4 hours")
  // collapse into one row with sub-variants. Variants whose bench-paths
  // are genuinely distinct ("arc-agi" vs "arc-agi-2") stay separate.
  const humanizeSlug = (slug: string): string => {
    const ACRONYMS = new Set([
      "agi", "ai", "aime", "api", "arc", "bbh", "bfcl", "ctf", "cve",
      "gaia", "gdm", "gpqa", "gsm8k", "helm", "hf", "hle", "ifbench",
      "ifeval", "llm", "math", "ml", "mmlu", "mmlu-pro", "mmmu", "musr",
      "nlp", "rl", "swe", "vals", "wasp", "ace", "scicode", "usaco",
      "vqa", "qa",
    ])
    return slug
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((seg) => {
        if (ACRONYMS.has(seg.toLowerCase())) return seg.toUpperCase()
        if (/^\d/.test(seg)) return seg
        return seg.charAt(0).toUpperCase() + seg.slice(1)
      })
      .join(" ")
  }

  const parseEvalId = (evalId: string | null | undefined): { source: string; benchPath: string; benchKey: string } | null => {
    if (!evalId) return null
    // Accept both encoded (%2F) and decoded (/) forms.
    const decoded = decodeURIComponent(evalId)
    const slashIdx = decoded.indexOf("/")
    if (slashIdx < 0) return null
    const source = decoded.slice(0, slashIdx)
    const benchPath = decoded.slice(slashIdx + 1)
    if (!source || !benchPath) return null
    // benchKey = bench-path up to the first "." — same benchKey across
    // variants collapses them into one row.
    const dotIdx = benchPath.indexOf(".")
    const benchKey = dotIdx >= 0 ? benchPath.slice(0, dotIdx) : benchPath
    return { source, benchPath, benchKey }
  }

  // Pull a usable benchmark label from a variant when the parsed benchKey
  // is degenerate (equals the source name) — happens for rows that come
  // in as variants under a source-level group with no per-bench title.
  const deriveBenchLabel = (v: BenchmarkVariant, fallback: string): string => {
    const candidates = [
      v.label,
      v.metricLabel,
      (v.result as { evaluation_name?: string } | undefined)?.evaluation_name,
      (v.evaluation as { benchmark?: string } | undefined)?.benchmark,
    ].filter(
      (s): s is string =>
        typeof s === "string" && s.trim().length > 0 && s.trim().toLowerCase() !== fallback.toLowerCase(),
    )
    return candidates[0] ?? fallback
  }

  // Flatten every variant of every group into a single list, paired
  // with the parsed source/benchKey. Variants without a usable eval
  // id fall back to the group's title.
  type FlatVariant = {
    group: BenchmarkGroup
    variant: BenchmarkVariant
    source: string
    sourceKey: string
    benchKey: string
    benchPath: string
    benchLabel: string
    rawScore: number
    unit?: string
    lowerIsBetter: boolean
    rankPosition: number | null
    rankTotal: number | null
  }
  const flat: FlatVariant[] = []
  for (const g of groups) {
    for (const v of g.variants ?? []) {
      const raw = v.result?.score_details?.score
      if (!Number.isFinite(raw)) continue
      // Resolve eval_summary_id, falling back to the detail-href derivation
      // (mirrors getGroupPeerRank). Without this, variants whose
      // eval_summary_id is null still register correctly with peerRanks.
      const resolvedEvalIdRaw =
        v.evaluation?.eval_summary_id ??
        getEvalSummaryIdFromHref(getEvalDetailHref(v.evaluation, v.result))
      const resolvedEvalId = resolvedEvalIdRaw || null
      const parsed = parseEvalId(resolvedEvalId)
      const source = parsed?.source ?? "other"
      const benchKey = parsed?.benchKey ?? g.key
      const benchPath = parsed?.benchPath ?? g.title
      // Pick a row label: usually the humanized benchKey, but when
      // benchKey collides with the source slug (group fell back to the
      // family key), use evaluation_name / variant label instead.
      const benchKeySlug = benchKey.toLowerCase()
      const sourceSlug = source.toLowerCase()
      // Always pass through humanizeSlug so labels match the "Tau2 Telecom"
      // style regardless of whether they came from benchKey or a fallback.
      const labelFallback = humanizeSlug(
        benchKeySlug === sourceSlug
          ? deriveBenchLabel(v, benchKey)
          : benchKey,
      )
      // Sidecar rank lookup. The sidecar ships eval keys AND model
      // keys in URL-encoded form (e.g. `llm-stats%2Faa-index`,
      // `openai%2Fgpt-5.5`); the runtime `modelIds` carries the decoded
      // slash form (`openai/gpt-5.5`). Try both encodings on both
      // dimensions before falling back to the in-record rank.
      let rankPosition: number | null = null
      let rankTotal: number | null = null
      const tryRankLookup = (eid: string | null | undefined): boolean => {
        if (!eid) return false
        const evalRanks = peerRanks[eid]
        if (!evalRanks) return false
        for (const mid of modelIds) {
          const candidates = [mid, encodeURIComponent(mid), mid.replace(/\//g, "%2F")]
          for (const cand of candidates) {
            const r = evalRanks[cand]
            if (r != null) {
              rankPosition = r.position
              rankTotal = r.total
              return true
            }
          }
        }
        return false
      }
      if (!tryRankLookup(resolvedEvalId)) {
        if (resolvedEvalId) {
          const decoded = decodeURIComponent(resolvedEvalId)
          if (decoded !== resolvedEvalId) tryRankLookup(decoded)
          const reencoded = resolvedEvalId.replace(/\//g, "%2F")
          if (reencoded !== resolvedEvalId) tryRankLookup(reencoded)
        }
        if (rankPosition == null && v.rankPosition != null) {
          rankPosition = v.rankPosition
          rankTotal = v.rankTotal
        }
      }
      // Use the label-derived benchKey when we fell back, so two variants
      // with the same evaluation_name still collapse into one row.
      const effectiveBenchKey =
        benchKeySlug === sourceSlug
          ? labelFallback.toLowerCase().replace(/\s+/g, "-")
          : benchKeySlug
      flat.push({
        group: g,
        variant: v,
        source,
        sourceKey: source.toLowerCase(),
        benchKey: effectiveBenchKey,
        benchPath,
        benchLabel: labelFallback,
        rawScore: raw as number,
        unit: v.result?.metric_config?.unit,
        lowerIsBetter: Boolean(v.result?.metric_config?.lower_is_better),
        rankPosition,
        rankTotal,
      })
    }
  }

  type Row = {
    benchKey: string
    benchName: string
    group: BenchmarkGroup
    variants: FlatVariant[]
    avgRaw: number
    unit?: string
    lowerIsBetter: boolean
    rankPosition: number | null
    rankTotal: number | null
    rankRatio: number | null
    evalSummaryId: string | null
    category: EvalTag
  }
  type Bucket = { key: string; name: string; rows: Row[] }
  const buckets = new Map<string, Bucket>()
  for (const fv of flat) {
    let bucket = buckets.get(fv.sourceKey)
    if (!bucket) {
      bucket = { key: fv.sourceKey, name: humanizeSlug(fv.source), rows: [] }
      buckets.set(fv.sourceKey, bucket)
    }
    let row = bucket.rows.find((r) => r.benchKey === fv.benchKey)
    if (!row) {
      row = {
        benchKey: fv.benchKey,
        benchName: fv.benchLabel,
        group: fv.group,
        variants: [],
        avgRaw: 0,
        unit: fv.unit,
        lowerIsBetter: fv.lowerIsBetter,
        rankPosition: null,
        rankTotal: null,
        rankRatio: null,
        evalSummaryId: fv.variant.evaluation?.eval_summary_id ?? null,
        category: fv.group.category,
      }
      bucket.rows.push(row)
    }
    row.variants.push(fv)
  }

  // Finalize each row: avg raw, best rank across variants. As a final
  // fallback delegate to getGroupPeerRank (same call Researcher view
  // makes) so we never miss a rank Researcher view surfaces.
  for (const bucket of buckets.values()) {
    for (const row of bucket.rows) {
      const scores = row.variants.map((v) => v.rawScore)
      row.avgRaw = scores.reduce((a, b) => a + b, 0) / scores.length
      let best: { p: number; t: number } | null = null
      for (const v of row.variants) {
        if (v.rankPosition == null || v.rankTotal == null || v.rankTotal <= 0) continue
        const ratio = v.rankPosition / v.rankTotal
        if (!best || ratio < best.p / best.t) best = { p: v.rankPosition, t: v.rankTotal }
      }
      if (!best) {
        const groupRank = getGroupPeerRank(row.group, modelIds, peerRanks)
        if (groupRank && groupRank.total > 0) best = { p: groupRank.position, t: groupRank.total }
      }
      if (best) {
        row.rankPosition = best.p
        row.rankTotal = best.t
        row.rankRatio = best.p / best.t
      }
    }
  }

  const orderedBuckets = Array.from(buckets.values())
    .map((b) => ({
      ...b,
      rows: b.rows.slice().sort((a, b) => {
        const ar = a.rankRatio == null ? Infinity : a.rankRatio
        const br = b.rankRatio == null ? Infinity : b.rankRatio
        if (ar !== br) return ar - br
        if (a.lowerIsBetter && b.lowerIsBetter) return a.avgRaw - b.avgRaw
        return b.avgRaw - a.avgRaw
      }),
    }))
    .sort((a, b) => {
      const ar = Math.min(...a.rows.map((r) => r.rankRatio ?? Infinity))
      const br = Math.min(...b.rows.map((r) => r.rankRatio ?? Infinity))
      if (ar !== br) return ar - br
      return a.name.localeCompare(b.name)
    })

  if (orderedBuckets.length === 0) {
    return (
      <p className="text-[14px] text-[color:var(--fg-muted)] py-6">
        No reported metrics for this model yet.
      </p>
    )
  }

  return (
    <div className="space-y-8 mx-auto" style={{ maxWidth: "72rem" }}>
      <p className="text-[13px] leading-[1.65] text-[color:var(--fg-muted)]">
        Reported benchmarks grouped by source (the prefix of the eval ID, e.g., wasp, vals-ai, reward-bench-2), ordered best peer rank first. The number on the right is the model's
        raw score; <em className="not-italic font-mono text-[12px]">12 / 107</em> next to it is
        its peer rank. A medal (🥇 🥈 🥉) marks a top-3 finish. Switch to{" "}
        <em className="text-[color:var(--fg)] not-italic font-medium">Researcher view</em>{" "}
        for per-benchmark plots, setup variants, and cross-suite comparisons.
      </p>

      {orderedBuckets.map((bucket) => (
        <SummaryBucketBlock
          key={bucket.key}
          bucketName={bucket.name}
          rows={bucket.rows}
          router={router}
          currentDetailHref={currentDetailHref}
        />
      ))}
    </div>
  )
}

type SummaryFlatVariant = {
  group: BenchmarkGroup
  variant: BenchmarkVariant
  source: string
  sourceKey: string
  benchKey: string
  benchPath: string
  rawScore: number
  unit?: string
  lowerIsBetter: boolean
  rankPosition: number | null
  rankTotal: number | null
}

type SummaryRow = {
  benchKey: string
  benchName: string
  group: BenchmarkGroup
  variants: SummaryFlatVariant[]
  avgRaw: number
  unit?: string
  lowerIsBetter: boolean
  rankPosition: number | null
  rankTotal: number | null
  rankRatio: number | null
  evalSummaryId: string | null
  category: EvalTag
}

function SummaryBucketBlock({
  bucketName,
  rows,
  router,
  currentDetailHref,
}: {
  bucketName: string
  rows: SummaryRow[]
  router: ReturnType<typeof useRouter>
  currentDetailHref?: string
}) {
  return (
    <div>
      <div
        className="mb-3 flex items-baseline justify-between gap-3 pb-2"
        style={{ borderBottom: "1px solid var(--border-soft)" }}
      >
        <h3
          className="font-mono uppercase"
          style={{ fontSize: 12, letterSpacing: "0.14em", color: "var(--fg)" }}
        >
          {bucketName}
        </h3>
        <span
          className="font-mono uppercase"
          style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--fg-subtle)" }}
        >
          {rows.length} benchmark{rows.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="m-0 p-0 list-none">
        {rows.map((row) => (
          <SummaryBenchRow
            key={`${row.benchKey}-${row.evalSummaryId ?? ""}`}
            row={row}
            router={router}
            currentDetailHref={currentDetailHref}
          />
        ))}
      </ul>
    </div>
  )
}

function SummaryBenchRow({
  row,
  router,
  currentDetailHref,
}: {
  row: SummaryRow
  router: ReturnType<typeof useRouter>
  currentDetailHref?: string
}) {
  const isBranched = row.variants.length > 1
  const detailHref = row.group.evalDetailHref
  const navigate = () => {
    if (!detailHref) return
    const href = currentDetailHref
      ? `${detailHref}${detailHref.includes("?") ? "&" : "?"}from=${encodeURIComponent(currentDetailHref)}`
      : detailHref
    router.push(href)
  }
  const interactive = Boolean(detailHref)
  const hasRank = row.rankPosition != null && row.rankTotal != null && row.rankTotal > 0
  const parentScore = formatSummaryScore(row.avgRaw, row.unit)
  const categoryLabel = formatTagLabel(row.category as unknown as string)
  const primaryEvalId = row.variants[0]?.variant.evaluation?.eval_summary_id ?? null

  return (
    <>
      <li
        className="grid items-baseline gap-3 py-1.5"
        style={{
          gridTemplateColumns: "1fr auto",
          borderBottom: "1px solid var(--border-soft)",
          cursor: interactive ? "pointer" : "default",
        }}
        role={interactive ? "link" : undefined}
        tabIndex={interactive ? 0 : -1}
        onClick={interactive ? navigate : undefined}
        onKeyDown={
          interactive
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  navigate()
                }
              }
            : undefined
        }
      >
        <div className="min-w-0">
          <div className="flex items-baseline flex-wrap gap-x-2 gap-y-0.5">
            <span
              className="text-[15px] truncate"
              style={{ color: "var(--fg)", fontWeight: 500 }}
              title={row.benchName}
            >
              {row.benchName}
            </span>
            {categoryLabel && (
              <span
                className="inline-flex items-center font-mono text-[10px] uppercase tracking-[0.12em] border px-1.5 py-0.5 shrink-0"
                style={{
                  color: "var(--fg-muted)",
                  borderColor: "var(--border-soft)",
                  background: "var(--bg)",
                }}
                title={`Category: ${categoryLabel}`}
              >
                {categoryLabel}
              </span>
            )}
            <span
              className="inline-flex items-center font-mono text-[10px] uppercase tracking-[0.12em] border px-1.5 py-0.5 shrink-0"
              style={{
                color: row.lowerIsBetter ? "var(--accent)" : "var(--fg-muted)",
                borderColor: row.lowerIsBetter ? "var(--accent)" : "var(--border-soft)",
                background: "var(--bg)",
              }}
              title={
                row.lowerIsBetter
                  ? "Lower raw score is better on this benchmark."
                  : "Higher raw score is better on this benchmark."
              }
            >
              {row.lowerIsBetter ? "↓ Lower is better" : "↑ Higher is better"}
            </span>
            {isBranched && (
              <span
                className="font-mono"
                style={{ fontSize: 10, color: "var(--fg-subtle)" }}
                title={`Average across ${row.variants.length} reported variants.`}
              >
                · avg of {row.variants.length}
              </span>
            )}
          </div>
          {!isBranched && primaryEvalId && (
            <div
              className="mt-0.5 font-mono truncate"
              style={{
                fontSize: 11,
                color: "var(--fg-subtle)",
                letterSpacing: "0.02em",
              }}
              title={`Source: ${decodeURIComponent(primaryEvalId)}`}
            >
              on {decodeURIComponent(primaryEvalId)}
            </div>
          )}
        </div>
        <div className="flex items-baseline justify-end gap-2.5 whitespace-nowrap">
          {hasRank && (
            <RankBadge
              position={row.rankPosition!}
              total={row.rankTotal!}
              size="md"
            />
          )}
          <span
            className="font-mono tabular-nums text-[15px]"
            style={{ color: "var(--fg)", fontWeight: 500 }}
            title={isBranched ? "Average across reported variants" : "Raw score"}
          >
            {parentScore}
          </span>
        </div>
      </li>

      {isBranched &&
        row.variants.map((v, idx) => {
          const vEvalId = v.variant.evaluation?.eval_summary_id ?? null
          const vScoreText = formatSummaryScore(v.rawScore, v.unit)
          const vHasRank = v.rankPosition != null && v.rankTotal != null && v.rankTotal > 0
          const setupOrSlice = v.variant.setupLabel || v.variant.sliceLabel
          return (
            <li
              key={`${row.benchKey}-variant-${idx}`}
              className="grid items-baseline gap-3 py-1"
              style={{
                gridTemplateColumns: "1fr auto",
                borderBottom: "1px solid var(--border-soft)",
                paddingLeft: 18,
              }}
            >
              <div className="min-w-0 flex items-baseline gap-1.5">
                <span
                  className="font-mono shrink-0"
                  style={{ fontSize: 11, color: "var(--fg-subtle)" }}
                  aria-hidden
                >
                  └
                </span>
                <div className="min-w-0">
                  {vEvalId && (
                    <span
                      className="font-mono truncate"
                      style={{
                        fontSize: 12,
                        color: "var(--fg-muted)",
                        letterSpacing: "0.02em",
                      }}
                      title={`Source: ${decodeURIComponent(vEvalId)}`}
                    >
                      on {decodeURIComponent(vEvalId)}
                    </span>
                  )}
                  {setupOrSlice && (
                    <span
                      className="ml-2 font-mono"
                      style={{ fontSize: 11, color: "var(--fg-subtle)" }}
                    >
                      · {setupOrSlice}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-baseline justify-end gap-2.5 whitespace-nowrap">
                {vHasRank && (
                  <RankBadge
                    position={v.rankPosition!}
                    total={v.rankTotal!}
                    size="sm"
                  />
                )}
                <span
                  className="font-mono tabular-nums"
                  style={{ fontSize: 13.5, color: "var(--fg)" }}
                >
                  {vScoreText}
                </span>
              </div>
            </li>
          )
        })}
    </>
  )
}

function RankBadge({
  position,
  total,
  size,
}: {
  position: number
  total: number
  size: "sm" | "md"
}) {
  const tone = rankBadgeColor(position)
  const fontSize = size === "md" ? 12 : 11
  const padding = size === "md" ? "1px 6px" : "0 5px"
  return (
    <span
      className="font-mono tabular-nums inline-flex items-baseline"
      style={{ fontSize, color: "var(--fg-muted)" }}
      title={`Ranked ${position} of ${total} models reported on this benchmark.`}
    >
      <span
        className="inline-flex items-center justify-center"
        style={{
          background: tone ? tone.bg : "transparent",
          color: tone ? tone.fg : "var(--fg)",
          padding: tone ? padding : 0,
          borderRadius: tone ? 2 : 0,
          fontWeight: tone ? 600 : 400,
          minWidth: tone ? "1.4em" : undefined,
          textAlign: "center",
        }}
      >
        {position}
      </span>
      <span style={{ color: "var(--fg-subtle)" }}>/{total}</span>
    </span>
  )
}

function rankMedal(position: number | null, total: number | null): string | null {
  if (position == null || total == null || total <= 0) return null
  if (position === 1) return "🥇"
  if (position === 2) return "🥈"
  if (position === 3) return "🥉"
  return null
}

// Gold / silver / bronze chip colors for rank 1 / 2 / 3. Returns null
// for positions outside the top three — those render as plain mono text.
function rankBadgeColor(position: number | null): { bg: string; fg: string } | null {
  if (position == null) return null
  if (position === 1) return { bg: "#D4A017", fg: "#FFFFFF" } // gold
  if (position === 2) return { bg: "#A8A8A8", fg: "#FFFFFF" } // silver
  if (position === 3) return { bg: "#B87333", fg: "#FFFFFF" } // bronze
  return null
}

function formatSummaryScore(raw: number, unit?: string, displayFallback?: string): string {
  if (!Number.isFinite(raw)) return displayFallback ?? "—"
  const u = (unit || "").toLowerCase()
  // Percent-style metrics always render as "<n>%" — never "<n> percent",
  // never "<n> proportion". Handles both 0–1 (proportion) and 0–100
  // (percent already) value ranges so the suffix stays consistent.
  const isPercentish = !u || /percent|proportion|accuracy|score|pass@|exact|f1|%/.test(u)
  if (isPercentish) {
    const value = Math.abs(raw) <= 1 ? raw * 100 : raw
    const abs = Math.abs(value)
    const decimals = abs < 1 ? 2 : abs < 10 ? 2 : 1
    return `${value.toFixed(decimals)}%`
  }
  return displayFallback ?? formatRawScoreValue(raw, unit)
}

function SummaryMetricsRow({
  row,
  router,
  currentDetailHref,
  modelIds,
  peerRanks,
}: {
  row: {
    group: BenchmarkGroup
    rankPosition: number | null
    rankTotal: number | null
    rankRatio: number | null
    rawScore: number
    displayScore: string
    unit?: string
    lowerIsBetter: boolean
    evalSummaryId: string | null
  }
  router: ReturnType<typeof useRouter>
  currentDetailHref?: string
  modelIds: string[]
  peerRanks: PeerRanksMap
}) {
  const { group, rankPosition, rankTotal, lowerIsBetter, evalSummaryId } = row
  const variants = group.variants ?? []
  const isBranched = variants.length > 1
  const interactive = Boolean(group.evalDetailHref)
  const navigate = () => {
    if (!group.evalDetailHref) return
    const href = currentDetailHref
      ? `${group.evalDetailHref}${
          group.evalDetailHref.includes("?") ? "&" : "?"
        }from=${encodeURIComponent(currentDetailHref)}`
      : group.evalDetailHref
    router.push(href)
  }

  const categoryLabel = formatTagLabel(group.category as unknown as string)
  const parentMedal = rankMedal(rankPosition, rankTotal)
  const hasParentRank = rankPosition != null && rankTotal != null && rankTotal > 0
  const parentScore = formatSummaryScore(row.rawScore, row.unit, row.displayScore)

  return (
    <>
      <li
        className="grid items-baseline gap-4 py-2.5"
        style={{
          gridTemplateColumns: "1fr auto",
          borderBottom: isBranched
            ? "1px solid var(--border-soft)"
            : "1px solid var(--border-soft)",
          cursor: interactive ? "pointer" : "default",
        }}
        role={interactive ? "link" : undefined}
        tabIndex={interactive ? 0 : -1}
        onClick={interactive ? navigate : undefined}
        onKeyDown={
          interactive
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  navigate()
                }
              }
            : undefined
        }
      >
        <div className="min-w-0">
          <div className="flex items-baseline flex-wrap gap-x-2 gap-y-1">
            <span
              className="text-[14px] truncate"
              style={{ color: "var(--fg)" }}
              title={group.title}
            >
              {group.title}
            </span>
            {categoryLabel && (
              <span
                className="inline-flex items-center font-mono text-[9px] uppercase tracking-[0.12em] border px-1.5 py-0.5 shrink-0"
                style={{
                  color: "var(--fg-muted)",
                  borderColor: "var(--border-soft)",
                  background: "var(--bg)",
                }}
                title={`Category: ${categoryLabel}`}
              >
                {categoryLabel}
              </span>
            )}
            {lowerIsBetter && (
              <span
                className="font-mono"
                style={{ fontSize: 10, color: "var(--fg-subtle)" }}
                title="Lower raw score is better on this benchmark."
              >
                ↓ lower is better
              </span>
            )}
            {isBranched && (
              <span
                className="font-mono"
                style={{ fontSize: 10, color: "var(--fg-subtle)" }}
                title={`Average across ${variants.length} reported variants.`}
              >
                · avg of {variants.length}
              </span>
            )}
          </div>
          {!isBranched && evalSummaryId && (
            <div
              className="mt-0.5 font-mono truncate"
              style={{
                fontSize: 11,
                color: "var(--fg-subtle)",
                letterSpacing: "0.02em",
              }}
              title={`Source: ${decodeURIComponent(evalSummaryId)}`}
            >
              on {decodeURIComponent(evalSummaryId)}
            </div>
          )}
        </div>
        <div className="flex items-baseline justify-end gap-3 whitespace-nowrap">
          {hasParentRank && (
            <span
              className="font-mono tabular-nums"
              style={{ fontSize: 11, color: "var(--fg-muted)" }}
              title={`Ranked ${rankPosition} of ${rankTotal} models reported on this benchmark.`}
            >
              <span style={{ color: "var(--fg)" }}>{rankPosition}</span>
              <span style={{ color: "var(--fg-subtle)" }}> / {rankTotal}</span>
            </span>
          )}
          {parentMedal && (
            <span
              className="text-[15px] leading-none"
              aria-hidden
              title={
                hasParentRank
                  ? `Ranked ${rankPosition} of ${rankTotal} models.`
                  : undefined
              }
            >
              {parentMedal}
            </span>
          )}
          <span
            className="font-mono tabular-nums text-[14px]"
            style={{ color: "var(--fg)" }}
            title={isBranched ? "Average across reported variants" : "Raw score"}
          >
            {parentScore}
          </span>
        </div>
      </li>

      {isBranched &&
        variants.map((v, idx) => {
          const vEvalId = v.evaluation?.eval_summary_id ?? null
          const vRawScore = v.result?.score_details?.score
          const vUnit = v.result?.metric_config?.unit
          const vDisplay = v.displayScore || formatRawScoreValue(vRawScore ?? NaN, vUnit)
          // Sidecar lookup per-variant — the in-record `v.rankPosition`
          // is null for most benchmarks (only embedded ranks). Prefer the
          // peer-ranks sidecar, fall back to the in-record rank.
          let vRankPosition = v.rankPosition ?? null
          let vRankTotal = v.rankTotal ?? null
          if (vEvalId && vRankPosition == null) {
            const evalRanks = peerRanks[vEvalId]
            if (evalRanks) {
              for (const mid of modelIds) {
                const r = evalRanks[mid]
                if (r != null) {
                  vRankPosition = r.position
                  vRankTotal = r.total
                  break
                }
              }
            }
          }
          const vMedal = rankMedal(vRankPosition, vRankTotal)
          const vHasRank =
            vRankPosition != null && vRankTotal != null && vRankTotal > 0
          const vScoreText = formatSummaryScore(vRawScore ?? NaN, vUnit, vDisplay)
          const setupOrSlice = v.setupLabel || v.sliceLabel
          return (
            <li
              key={`${group.key}-variant-${idx}`}
              className="grid items-baseline gap-4 py-2"
              style={{
                gridTemplateColumns: "1fr auto",
                borderBottom: "1px solid var(--border-soft)",
                paddingLeft: 20,
              }}
            >
              <div className="min-w-0 flex items-baseline gap-2">
                <span
                  className="font-mono shrink-0"
                  style={{ fontSize: 11, color: "var(--fg-subtle)" }}
                  aria-hidden
                >
                  └
                </span>
                <div className="min-w-0">
                  {vEvalId && (
                    <span
                      className="font-mono truncate"
                      style={{
                        fontSize: 11,
                        color: "var(--fg-muted)",
                        letterSpacing: "0.02em",
                      }}
                      title={`Source: ${decodeURIComponent(vEvalId)}`}
                    >
                      on {decodeURIComponent(vEvalId)}
                    </span>
                  )}
                  {setupOrSlice && (
                    <span
                      className="ml-2 font-mono"
                      style={{ fontSize: 10, color: "var(--fg-subtle)" }}
                    >
                      · {setupOrSlice}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-baseline justify-end gap-3 whitespace-nowrap">
                {vHasRank && (
                  <span
                    className="font-mono tabular-nums"
                    style={{ fontSize: 11, color: "var(--fg-muted)" }}
                    title={`Ranked ${vRankPosition} of ${vRankTotal}.`}
                  >
                    <span style={{ color: "var(--fg)" }}>{vRankPosition}</span>
                    <span style={{ color: "var(--fg-subtle)" }}>
                      {" "}
                      / {vRankTotal}
                    </span>
                  </span>
                )}
                {vMedal && (
                  <span className="text-[14px] leading-none" aria-hidden>
                    {vMedal}
                  </span>
                )}
                <span
                  className="font-mono tabular-nums"
                  style={{ fontSize: 13, color: "var(--fg)" }}
                >
                  {vScoreText}
                </span>
              </div>
            </li>
          )
        })}
    </>
  )
}

function SummaryMetricsFamilyBlock({
  familyName,
  rows,
  router,
  currentDetailHref,
  modelIds,
  peerRanks,
}: {
  familyName: string
  rows: {
    group: BenchmarkGroup
    rankPosition: number | null
    rankTotal: number | null
    rankRatio: number | null
    rawScore: number
    displayScore: string
    unit?: string
    lowerIsBetter: boolean
    evalSummaryId: string | null
  }[]
  router: ReturnType<typeof useRouter>
  currentDetailHref?: string
  modelIds: string[]
  peerRanks: PeerRanksMap
}) {
  return (
    <div>
      <div
        className="mb-3 flex items-baseline justify-between gap-3 pb-2"
        style={{ borderBottom: "1px solid var(--border-soft)" }}
      >
        <h3
          className="font-mono uppercase"
          style={{ fontSize: 11, letterSpacing: "0.14em", color: "var(--fg)" }}
        >
          {familyName}
        </h3>
        <span
          className="font-mono uppercase"
          style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--fg-subtle)" }}
        >
          {rows.length} benchmark{rows.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="m-0 p-0 list-none">
        {rows.map((row) => (
          <SummaryMetricsRow
            key={row.group.key}
            row={row}
            router={router}
            currentDetailHref={currentDetailHref}
            modelIds={modelIds}
            peerRanks={peerRanks}
          />
        ))}
      </ul>
    </div>
  )
}

/**
 * Donut + per-category bars showing first-party vs third-party row counts.
 * Adapted from mock_design/model_detail_a.jsx#EvaluatorMix.
 */
/**
 * Plain-language version of §3 for Summary view. One sentence with the
 * first/third-party split + a thin inline bar; skips the per-category
 * breakdown and donut. Researcher view keeps the full EvaluatorMix.
 */
function EvaluatorMixSummary({ mix }: { mix: EvaluatorMixData }) {
  const { firstTotal, thirdTotal, collabTotal, otherTotal, grand } = mix
  if (grand <= 0) return null
  const pct = (n: number) => Math.round((n / grand) * 100)
  const fFirst = pct(firstTotal)
  const fThird = pct(thirdTotal)
  const fCollab = pct(collabTotal)

  const headline = (() => {
    if (thirdTotal === grand) return "Every reported score comes from an independent third-party evaluator."
    if (firstTotal === grand) return "Every reported score comes from the model's own developer (first-party)."
    return `${fThird}% of reported scores come from independent third-party evaluators; ${fFirst}% are from the model's own developer.`
  })()

  return (
    <div className="space-y-3 max-w-[64rem]">
      <p className="text-[14px] leading-[1.65] text-[color:var(--fg)]">{headline}</p>

      <div
        className="flex h-2 overflow-hidden"
        style={{ background: "var(--bg-surface)" }}
        aria-label={`First-party ${fFirst}%, third-party ${fThird}%, collaborative ${fCollab}%`}
      >
        {firstTotal > 0 && (
          <div
            style={{ width: `${(firstTotal / grand) * 100}%`, background: "var(--fg)" }}
            title={`${firstTotal} first-party (${fFirst}%)`}
          />
        )}
        {thirdTotal > 0 && (
          <div
            style={{ width: `${(thirdTotal / grand) * 100}%`, background: "var(--accent)" }}
            title={`${thirdTotal} third-party · independent (${fThird}%)`}
          />
        )}
        {collabTotal > 0 && (
          <div
            style={{ width: `${(collabTotal / grand) * 100}%`, background: "var(--accent-hover)" }}
            title={`${collabTotal} collaborative (${fCollab}%)`}
          />
        )}
        {otherTotal > 0 && (
          <div
            style={{ width: `${(otherTotal / grand) * 100}%`, background: "var(--fg-subtle)" }}
            title={`${otherTotal} unspecified`}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px]">
        <LegendDot color="var(--fg)" label={`${firstTotal} first-party`} pct={fFirst} />
        <LegendDot color="var(--accent)" label={`${thirdTotal} third-party · independent`} pct={fThird} />
        {collabTotal > 0 && (
          <LegendDot color="var(--accent-hover)" label={`${collabTotal} collaborative`} pct={fCollab} />
        )}
        {otherTotal > 0 && (
          <LegendDot color="var(--fg-subtle)" label={`${otherTotal} unspecified`} pct={pct(otherTotal)} />
        )}
      </div>

      <p className="text-[12px] leading-[1.55] text-[color:var(--fg-muted)]">
        Independent reports cross-check a developer's own numbers. Switch to{" "}
        <em className="text-[color:var(--fg)] not-italic font-medium">Researcher view</em>{" "}
        to see the breakdown by category.
      </p>
    </div>
  )
}

function LegendDot({ color, label, pct }: { color: string; label: string; pct: number }) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span
        className="inline-block h-3 w-3 shrink-0 translate-y-0.5"
        style={{ background: color }}
        aria-hidden
      />
      <span style={{ color: "var(--fg-muted)" }}>{label}</span>
      <span
        className="font-mono tabular-nums"
        style={{ fontSize: 11, color: "var(--fg-subtle)" }}
      >
        {pct}%
      </span>
    </span>
  )
}

function EvaluatorMix({ mix }: { mix: EvaluatorMixData }) {
  const { rows, firstTotal, thirdTotal, collabTotal, otherTotal, grand } = mix
  const R = 64
  const sw = 18
  const C = 2 * Math.PI * R
  const fFirst = firstTotal / grand
  const fThird = thirdTotal / grand
  const fCollab = collabTotal / grand
  const fOther = otherTotal / grand
  const lFirst = C * fFirst
  const lThird = C * fThird
  const lCollab = C * fCollab
  const lOther = C * fOther

  return (
    <div className="grid grid-cols-1 gap-10 lg:grid-cols-[220px_1fr] lg:items-start">
      {/* Donut */}
      <div className="relative mx-auto h-[200px] w-[200px] lg:mx-0">
        <svg width="200" height="200" viewBox="-100 -100 200 200" style={{ transform: "rotate(-90deg)" }}>
          <circle r={R} cx="0" cy="0" fill="none" stroke="var(--bg-surface)" strokeWidth={sw} />
          <circle
            r={R} cx="0" cy="0" fill="none"
            stroke="var(--fg)" strokeWidth={sw}
            strokeDasharray={`${lFirst} ${C - lFirst}`}
            strokeDashoffset="0"
          />
          <circle
            r={R} cx="0" cy="0" fill="none"
            stroke="var(--accent)" strokeWidth={sw}
            strokeDasharray={`${lThird} ${C - lThird}`}
            strokeDashoffset={`${-lFirst}`}
          />
          <circle
            r={R} cx="0" cy="0" fill="none"
            stroke="var(--accent-hover)" strokeWidth={sw}
            strokeDasharray={`${lCollab} ${C - lCollab}`}
            strokeDashoffset={`${-(lFirst + lThird)}`}
          />
          <circle
            r={R} cx="0" cy="0" fill="none"
            stroke="var(--fg-subtle)" strokeWidth={sw}
            strokeDasharray={`${lOther} ${C - lOther}`}
            strokeDashoffset={`${-(lFirst + lThird + lCollab)}`}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div
            className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[color:var(--fg-subtle)] text-center max-w-[80%]"
            title="One row per (model, benchmark, metric-path) reported result"
          >
            Reported results
          </div>
          <div className="text-[36px] font-bold leading-[1.05] tracking-[-0.02em] text-[color:var(--fg)] tabular-nums">
            {grand}
          </div>
        </div>
      </div>

      {/* Legend + per-category bars */}
      <div>
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 mb-4">
          <div className="flex items-center gap-2">
            <span className="inline-block h-3.5 w-3.5" style={{ background: "var(--fg)" }} />
            <span className="text-[13px]">
              <strong className="font-semibold tabular-nums">{firstTotal}</strong>
              <span className="text-[color:var(--fg-muted)]"> first-party</span>
              <span className="ml-1.5 font-mono text-[11px] text-[color:var(--fg-subtle)] tabular-nums">
                {Math.round(fFirst * 100)}%
              </span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-3.5 w-3.5" style={{ background: "var(--accent)" }} />
            <span className="text-[13px]">
              <strong className="font-semibold tabular-nums">{thirdTotal}</strong>
              <span className="text-[color:var(--fg-muted)]"> third-party · independent</span>
              <span className="ml-1.5 font-mono text-[11px] text-[color:var(--fg-subtle)] tabular-nums">
                {Math.round(fThird * 100)}%
              </span>
            </span>
          </div>
          {collabTotal > 0 && (
            <div className="flex items-center gap-2">
              <span className="inline-block h-3.5 w-3.5" style={{ background: "var(--accent-hover)" }} />
              <span className="text-[13px]">
                <strong className="font-semibold tabular-nums">{collabTotal}</strong>
                <span className="text-[color:var(--fg-muted)]"> collaborative</span>
              </span>
            </div>
          )}
          {otherTotal > 0 && (
            <div className="flex items-center gap-2">
              <span className="inline-block h-3.5 w-3.5" style={{ background: "var(--fg-subtle)" }} />
              <span className="text-[13px]">
                <strong className="font-semibold tabular-nums">{otherTotal}</strong>
                <span className="text-[color:var(--fg-muted)]"> unspecified</span>
              </span>
            </div>
          )}
        </div>

        <div className="border-t border-[color:var(--border-soft)]">
          {rows.map((row, i) => {
            const f = row.first / row.total
            const t = row.third / row.total
            const c = row.collab / row.total
            const o = row.other / row.total
            return (
              <div
                key={row.label}
                className="grid items-center gap-4 py-3 sm:grid-cols-[180px_1fr_140px]"
                style={{ borderBottom: i < rows.length - 1 ? "1px solid var(--border-soft)" : "none" }}
              >
                <div>
                  <div className="text-[13px] font-medium capitalize">{row.label}</div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-[color:var(--fg-subtle)] mt-0.5">
                    {row.total} result{row.total === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="flex h-3 overflow-hidden bg-[color:var(--bg-surface)]">
                  {f > 0 && <div style={{ width: `${f * 100}%`, background: "var(--fg)" }} title={`${row.first} first-party`} />}
                  {t > 0 && <div style={{ width: `${t * 100}%`, background: "var(--accent)" }} title={`${row.third} third-party`} />}
                  {c > 0 && <div style={{ width: `${c * 100}%`, background: "var(--accent-hover)" }} title={`${row.collab} collaborative`} />}
                  {o > 0 && <div style={{ width: `${o * 100}%`, background: "var(--fg-subtle)" }} title={`${row.other} unspecified`} />}
                </div>
                <div className="text-right font-mono text-[11px] tabular-nums text-[color:var(--fg-muted)]">
                  <span className="text-[color:var(--fg)]">{row.first}</span>
                  <span className="text-[color:var(--fg-subtle)]"> · </span>
                  <span style={{ color: "var(--accent)" }}>{row.third}</span>
                  {(row.collab > 0 || row.other > 0) && (
                    <>
                      <span className="text-[color:var(--fg-subtle)]"> · </span>
                      <span className="text-[color:var(--fg-subtle)]">{row.collab + row.other}</span>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function AllEvaluationsView({ evaluations }: { evaluations: BenchmarkEvaluation[] }) {
  return (
    <div className="space-y-6">
      {evaluations.map((eval_, idx) => (
        <div key={idx} className="space-y-6">
          {eval_.evaluation_results.map((result, ridx) => (
            <BenchmarkResultCard 
              key={`${eval_.evaluation_id}-${ridx}`}
              evaluation={eval_}
              result={result}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function CategoryStatsView({ 
  stats, 
  summary
}: { 
  stats: { category: EvalTag; count: number; avg_score: number }[]
  summary: ModelSummaryCore
}) {
  const getCategoryColor = (score: number) => {
    if (score >= 0.8) return 'text-green-600'
    if (score >= 0.6) return 'text-yellow-600'
    return 'text-red-600'
  }
  
  const getCategoryLabel = (category: EvalTag): string => {
    return category.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  }
  
  return (
    <div className="grid gap-6 md:grid-cols-2">
      {stats.map((stat) => {
        const evals = summary.evaluations_by_tag[stat.category] || []
        
        return (
          <Card key={stat.category} className="overflow-hidden">
            <CardHeader className="bg-muted/30 pb-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">{getCategoryLabel(stat.category)}</CardTitle>
                <div className={`text-2xl font-bold ${getCategoryColor(stat.avg_score)}`}>
                  {formatRawScoreValue(stat.avg_score)}
                </div>
              </div>
              <CardDescription>{stat.count} evaluation{stat.count !== 1 ? 's' : ''}</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">
                {evals.map((eval_: BenchmarkEvaluation, idx: number) => {
                  // Filter results to only show those carrying this tag
                  const relevantResults = eval_.evaluation_results.filter((result: any) => {
                    const resultTags = eval_.derived_tags && eval_.derived_tags.length > 0
                      ? eval_.derived_tags
                      : inferTagsFromBenchmark(result.evaluation_name)
                    return resultTags.includes(stat.category)
                  })
                  
                  if (relevantResults.length === 0) return null
                  
                  return relevantResults.map((result: any, ridx: number) => (
                    <div key={`${idx}-${ridx}`} className="flex items-center justify-between p-4 hover:bg-muted/50 transition-colors">
                      <div className="space-y-1">
                        <div className="font-medium text-sm">{getResultDisplayName(eval_, result)}</div>
                        <div className="text-xs text-muted-foreground">
                          {((getEvaluationVariantLabel(eval_) ? `Setup: ${formatSetupDisplayLabel(getEvaluationVariantLabel(eval_))}` : null)) || (Array.isArray(eval_.source_data)
                            ? (normalizeDisplayLabel(eval_.source_metadata.source_name) || 'Unknown')
                            : normalizeDisplayLabel(eval_.source_data.dataset_name))}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 font-mono font-semibold">
                        {formatRawScoreValue(result.score_details.score, result.metric_config.unit)}
                        <VerifiedBadge
                          verified={result.is_verified_evaluator}
                          recognized={isRecognizedEvaluator(
                            eval_.source_metadata?.source_name
                              ?? eval_.source_metadata?.source_organization_name,
                          )}
                        />
                      </div>
                    </div>
                  ))
                })}
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
