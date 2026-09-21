"use client"

import { type ReactNode, useMemo, useState } from "react"

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type {
  BenchmarkIndexEntry,
  ComparisonIndex,
  ComparisonMetricEntry,
  EvalHierarchy,
} from "@/lib/backend-artifacts"
import type { BenchmarkEvalSummary } from "@/lib/eval-processing"
import {
  evaluateReproducibilitySlots,
  evidenceFromResult,
} from "@/lib/reproducibility-slots"
import type { ModelResultForBenchmark } from "@/lib/eval-processing"
import { isHeadlineResult } from "@/lib/eval-processing"

/**
 * The rows every page-level statistic on this strip is computed over.
 *
 * A model's judge panels and protocol arms are extra READINGS of the same
 * model, not extra results: counting them inflates every denominator here
 * and lets a page's reproducibility or provenance percentage move when a
 * source discloses a second judge. One model contributes one row.
 */
function headlineResults(summary: BenchmarkEvalSummary): ModelResultForBenchmark[] {
  return (summary.model_results ?? []).filter(isHeadlineResult)
}
import {
  mergeRegistryBounds,
  resolveCanonicalScaleGroup,
  type CanonicalScaleCell,
} from "@/lib/score-scale"

type SignalId = "reproducibility" | "completeness" | "provenance" | "comparability"

const SIGNAL_GLYPHS: Record<SignalId, string> = {
  reproducibility: "R",
  completeness: "C",
  provenance: "P",
  comparability: "X",
}

const SIGNAL_NAMES: Record<SignalId, string> = {
  reproducibility: "Reproducibility",
  completeness: "Completeness",
  provenance: "Provenance",
  comparability: "Comparability",
}

const SIGNAL_ASKS: Record<SignalId, string> = {
  reproducibility: "Could someone re-run this benchmark with what's documented?",
  completeness: "How much of the benchmark card is filled in?",
  provenance: "Who reported these scores and how many parties have replicated?",
  comparability: "Where multiple sources report the same benchmark, do their numbers agree?",
}

/**
 * Reproducibility signal.
 *
 * The spec lists `temperature, top_p, max_tokens, prompt_template` as the
 * base required fields. In the live EEE corpus only `temperature` and
 * `max_tokens` are reliably populated, so we restrict the check to those
 * two for now. Agentic benchmarks additionally
 * require `eval_plan` and `eval_limits` — the spec's classification rule
 * is followed verbatim.
 */
const BASE_REQUIRED_FIELDS = ["temperature", "max_tokens"] as const
const AGENTIC_REQUIRED_FIELDS = ["eval_plan", "eval_limits"] as const

const FIELD_LABELS: Record<string, string> = {
  temperature: "temperature",
  top_p: "top-p",
  max_tokens: "max tokens",
  prompt_template: "prompt template",
  eval_plan: "eval plan",
  eval_limits: "eval limits",
}

interface BreakdownLine {
  label: string
  value: string
}

interface BreakdownRow {
  label: string
  status: "ok" | "warn" | "missing" | "info"
  detail?: string
  href?: string
}

interface SignalBreakdown {
  /** Plain-language description of how the score is computed. */
  formula: string
  /** Numeric inputs / aggregate counts used in the calculation. */
  inputs: BreakdownLine[]
  /** Per-item evidence rows (e.g. per-field, per-source, per-organisation). */
  rows?: BreakdownRow[]
  /** Optional richer body for signals that benefit from custom layout. */
  custom?: ReactNode
  /** Sentence shown when there's nothing meaningful to display. */
  empty?: string
}

interface DerivedSignal {
  statValue: string
  statUnit: string
  headline: string
  detail: string
  breakdown: SignalBreakdown
}

interface BenchmarkSignalsStripProps {
  summary: BenchmarkEvalSummary
  /** Used to find sibling appearances of the same canonical benchmark
   *  across other suites (cross-suite comparability). */
  evalHierarchy?: EvalHierarchy | null
  /** Per-(eval, metric) leaderboards used to fetch sibling scores. */
  comparisonIndex?: ComparisonIndex | null
}

/**
 * Benchmark-level rollup of the four interpretive signals. Each tile
 * reports one headline statistic that reads
 * "higher is better, more documentation = better", and is clickable to
 * open a Dialog explaining how the score was computed.
 */
export function BenchmarkSignalsStrip({
  summary,
  evalHierarchy,
  comparisonIndex,
}: BenchmarkSignalsStripProps) {
  const [openSignal, setOpenSignal] = useState<SignalId | null>(null)

  // Cross-suite aggregate is shared between Provenance and Comparability —
  // both signals are weakened by the hierarchy design (each source lives
  // on its own eval page) and so both want to look across the dataset
  // rather than within a single page.
  const crossSuite = useMemo(
    () => buildCrossSuiteAggregate(summary, evalHierarchy, comparisonIndex),
    [summary, evalHierarchy, comparisonIndex],
  )

  const repro = useMemo(() => deriveReproducibility(summary), [summary])
  const comp = useMemo(() => deriveCompleteness(summary), [summary])
  const prov = useMemo(() => deriveProvenance(summary, crossSuite), [summary, crossSuite])
  const cmp = useMemo(() => deriveComparability(summary, crossSuite), [summary, crossSuite])

  const signals: Record<SignalId, DerivedSignal> = {
    reproducibility: repro,
    completeness: comp,
    provenance: prov,
    comparability: cmp,
  }

  return (
    <>
      <div
        className="grid gap-x-6 gap-y-3"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          border: "1px solid var(--border-soft)",
          background: "var(--bg)",
          padding: "12px 16px",
        }}
      >
        <SignalRow id="reproducibility" {...repro} onOpen={() => setOpenSignal("reproducibility")} />
        <SignalRow id="completeness" {...comp} onOpen={() => setOpenSignal("completeness")} />
        <SignalRow id="provenance" {...prov} onOpen={() => setOpenSignal("provenance")} />
        <SignalRow id="comparability" {...cmp} onOpen={() => setOpenSignal("comparability")} />
      </div>

      <Dialog open={openSignal !== null} onOpenChange={(open) => !open && setOpenSignal(null)}>
        {/* `sm:max-w-2xl` widens at >=sm without overriding the
            unprefixed `max-w-[calc(100%-2rem)]` the Dialog ships with,
            so the dialog never exceeds viewport width. Long content
            (cross-suite tables) scrolls vertically inside. */}
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          {openSignal && (
            <SignalExplanation id={openSignal} signal={signals[openSignal]} />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Reproducibility
// ──────────────────────────────────────────────────────────────────────────

function isAgenticBenchmark(summary: BenchmarkEvalSummary): boolean {
  const tasks = summary.benchmark_card?.purpose_and_intended_users?.tasks
  if (Array.isArray(tasks)) {
    const set = new Set(tasks.map((t) => String(t).toLowerCase()))
    if (set.has("agentic") || set.has("tool_use") || set.has("multi_step_agent")) return true
  }
  for (const r of summary.model_results ?? []) {
    const args = getGenerationArgs(r)
    if (args && args.agentic_eval_config != null) return true
  }
  return false
}

function getGenerationArgs(result: ModelResultForBenchmark): Record<string, unknown> | null {
  const gc = (result.result as { generation_config?: { generation_args?: Record<string, unknown> } } | undefined)
    ?.generation_config
  if (!gc) return null
  const args = gc.generation_args
  return args && typeof args === "object" ? args : null
}

function deriveReproducibility(summary: BenchmarkEvalSummary): DerivedSignal {
  const triples = headlineResults(summary)

  if (triples.length === 0) {
    return {
      statValue: "—",
      statUnit: "",
      headline: "Reproducibility doesn't apply (no reported scores).",
      detail: "",
      breakdown: {
        formula: "Reproducibility = (setup questions answered) / (setup questions that apply).",
        inputs: [{ label: "Reported results", value: "0" }],
        empty: "No model results have been reported for this benchmark yet.",
      },
    }
  }

  // Scored per SLOT, the same engine and the same data file the per-row panel
  // uses (config/reproducibility-slots.json). The old rule demanded
  // `temperature` and `max_tokens` of every result: temperature appears on
  // 1.9% of the corpus and max_tokens on 1.4%, so this read ~0% almost
  // everywhere — and it read 0% loudest on the studies that document the
  // most, because they record their setup as a protocol condition rather than
  // as decoding args, and because a quarter of the corpus is scored from
  // log-probabilities where neither field exists at all.
  const perSlot = new Map<string, { disclosed: number; applicable: number; label: string }>()
  let disclosedTotal = 0
  let applicableTotal = 0
  let fullyDocumented = 0

  for (const triple of triples) {
    const summaryForRow = evaluateReproducibilitySlots(evidenceFromResult(triple))
    if (summaryForRow.applicable > 0 && summaryForRow.disclosed === summaryForRow.applicable) {
      fullyDocumented += 1
    }
    disclosedTotal += summaryForRow.disclosed
    applicableTotal += summaryForRow.applicable
    for (const slot of summaryForRow.slots) {
      if (slot.state !== "disclosed" && slot.state !== "missing") continue
      const entry = perSlot.get(slot.id) ?? { disclosed: 0, applicable: 0, label: slot.label }
      entry.applicable += 1
      if (slot.state === "disclosed") entry.disclosed += 1
      perSlot.set(slot.id, entry)
    }
  }

  const total = triples.length
  const score = applicableTotal > 0 ? disclosedTotal / applicableTotal : 0

  const worst = [...perSlot.entries()]
    .filter(([, v]) => v.applicable - v.disclosed > 0)
    .sort((a, b) => b[1].applicable - b[1].disclosed - (a[1].applicable - a[1].disclosed))
    .slice(0, 2)
    .map(([, v]) => `${v.label} (${formatPct((v.applicable - v.disclosed) / v.applicable)})`)
    .join(", ")

  const headline =
    applicableTotal === 0
      ? "Nothing about this run's setup is scorable."
      : score === 1
        ? "Every setup question that applies to these runs is answered."
        : score === 0
          ? "How these scores were produced wasn't disclosed by the source."
          : `${disclosedTotal} of ${applicableTotal} applicable setup questions are answered.`

  const detail = worst
    ? `Most often missing: ${worst}.`
    : `${fullyDocumented} of ${total} results document everything that applies to them.`

  const rows: BreakdownRow[] = [...perSlot.entries()].map(([, v]) => {
    const missing = v.applicable - v.disclosed
    if (missing === 0) {
      return {
        label: v.label,
        status: "ok" as const,
        detail: `Reported wherever it applies (${v.disclosed}/${v.applicable}).`,
      }
    }
    if (v.disclosed === 0) {
      return {
        label: v.label,
        status: "missing" as const,
        detail: `Applies to ${v.applicable} result${v.applicable === 1 ? "" : "s"}, reported on none.`,
      }
    }
    return {
      label: v.label,
      status: "warn" as const,
      detail: `Reported on ${v.disclosed} of ${v.applicable} results it applies to.`,
    }
  })

  return {
    statValue: pctNum(score),
    statUnit: "%",
    headline,
    detail,
    breakdown: {
      formula:
        "Reproducibility = (setup questions answered) / (setup questions that apply). " +
        "A control this run demonstrably does not have, such as sampling on a score read " +
        "from log-probabilities, is not counted against it.",
      inputs: [
        { label: "Reported results", value: total.toString() },
        { label: "Questions answered", value: disclosedTotal.toString() },
        { label: "Questions applicable", value: applicableTotal.toString() },
        { label: "Fully documented results", value: fullyDocumented.toString() },
      ],
      rows,
    },
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Completeness
// ──────────────────────────────────────────────────────────────────────────

interface CompletenessField {
  path: string
  label: string
  coverage: "full" | "partial" | "reserved"
  /** For partial: list of sub-item names whose presence is checked. */
  subitems?: readonly string[]
}

const COMPLETENESS_FIELD_SET: readonly CompletenessField[] = [
  { path: "benchmark_details.overview", label: "overview", coverage: "full" },
  { path: "benchmark_details.data_type", label: "data type", coverage: "full" },
  {
    path: "benchmark_details",
    label: "domains / languages / resources",
    coverage: "partial",
    subitems: ["domains", "languages", "resources"],
  },
  {
    path: "purpose_and_intended_users",
    label: "purpose",
    coverage: "partial",
    subitems: ["goal", "audience", "tasks", "limitations"],
  },
  {
    path: "data",
    label: "data",
    coverage: "partial",
    subitems: ["source", "size", "format", "annotation"],
  },
  {
    path: "methodology",
    label: "methodology",
    coverage: "partial",
    subitems: ["methods", "metrics", "calculation", "interpretation", "baseline_results", "validation"],
  },
  {
    path: "ethical_and_legal_considerations",
    label: "ethical & legal",
    coverage: "partial",
    subitems: ["privacy_and_anonymity", "data_licensing", "consent_procedures", "compliance_with_regulations"],
  },
  // Reserved — counted in the denominator even when unset.
  { path: "evalcards.lifecycle_status", label: "lifecycle status", coverage: "reserved" },
] as const

function deriveCompleteness(summary: BenchmarkEvalSummary): DerivedSignal {
  const card = summary.benchmark_card

  const fieldScores: { path: string; label: string; coverage: CompletenessField["coverage"]; score: number }[] = []

  for (const field of COMPLETENESS_FIELD_SET) {
    let score = 0
    if (field.coverage === "reserved") {
      // The eval-summary payload doesn't currently carry an
      // evalcards.lifecycle_status section, so this scores 0 for now.
      // It still occupies a denominator slot.
      score = 0
    } else if (field.coverage === "full") {
      const value = card ? readCardPath(card, field.path) : undefined
      score = isPopulated(value) ? 1 : 0
    } else {
      // partial
      const parent = card ? (readCardPath(card, field.path) as Record<string, unknown> | undefined) : undefined
      const subs = field.subitems ?? []
      if (!parent || subs.length === 0) {
        score = 0
      } else {
        let populated = 0
        for (const key of subs) if (isPopulated(parent[key])) populated++
        score = populated / subs.length
      }
    }
    fieldScores.push({ path: field.path, label: field.label, coverage: field.coverage, score })
  }

  const total = fieldScores.length
  const sumScore = fieldScores.reduce((acc, f) => acc + f.score, 0)
  const completeness = total > 0 ? sumScore / total : null

  const populatedCount = fieldScores.reduce((acc, f) => acc + (f.score === 1 ? 1 : 0), 0)
  const partialCount = fieldScores.filter((f) => f.score > 0 && f.score < 1).length
  const missingCount = fieldScores.filter((f) => f.score === 0).length

  const topMissing = fieldScores
    .filter((f) => f.score === 0 && f.coverage !== "reserved")
    .slice(0, 2)
    .map((f) => f.label)
    .join(", ")

  const headline = !card
    ? "No benchmark card has been authored yet."
    : completeness === 1
    ? "Every documented field is populated."
    : completeness != null && completeness >= 0.6
    ? "Most documented fields are populated."
    : "Several documented fields are still empty."

  const detail = !card
    ? "Reading context will lean on whatever the leaderboard JSON provides."
    : `${populatedCount} full · ${partialCount} partial · ${missingCount} missing of ${total}${
        topMissing ? ` · gaps: ${topMissing}` : ""
      }`

  const rows: BreakdownRow[] = fieldScores.map((f) => {
    if (f.coverage === "reserved") {
      return {
        label: f.label,
        status: "info",
        detail: "Reserved field (not yet shipped by the producer).",
      }
    }
    if (f.score === 1) {
      return { label: f.label, status: "ok", detail: "Fully populated." }
    }
    if (f.score === 0) {
      return { label: f.label, status: "missing", detail: "Empty." }
    }
    return {
      label: f.label,
      status: "warn",
      detail: `Partially populated (${formatPct(f.score)} of sub-fields).`,
    }
  })

  return {
    statValue: pctNum(completeness),
    statUnit: "%",
    headline,
    detail,
    breakdown: {
      formula:
        "Completeness = (populated fields + partial fields × fraction populated) / (total fields evaluated).",
      inputs: [
        { label: "Fields evaluated", value: total.toString() },
        { label: "Fully populated", value: populatedCount.toString() },
        { label: "Partially populated", value: partialCount.toString() },
        { label: "Empty", value: missingCount.toString() },
      ],
      rows,
      empty: !card ? "No benchmark card has been authored for this benchmark." : undefined,
    },
  }
}

function readCardPath(card: unknown, path: string): unknown {
  if (!card || typeof card !== "object") return undefined
  let cur: unknown = card
  for (const segment of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[segment]
  }
  return cur
}

// ──────────────────────────────────────────────────────────────────────────
// Provenance
// ──────────────────────────────────────────────────────────────────────────

type ProvenanceSourceType = "first_party" | "third_party" | "collaborative" | "unspecified"

function readSourceType(result: ModelResultForBenchmark): ProvenanceSourceType {
  const sm = result.source_metadata as { evaluator_relationship?: string } | undefined
  const rel = sm?.evaluator_relationship
  if (rel === "first_party" || rel === "third_party" || rel === "collaborative") return rel
  return "unspecified"
}

function readSourceOrg(result: ModelResultForBenchmark): string | null {
  const sm = result.source_metadata as { source_organization_name?: string } | undefined
  const org = sm?.source_organization_name
  if (typeof org === "string" && org.trim().length > 0) return org.trim()
  return null
}

function metricKeyForResult(result: ModelResultForBenchmark): string {
  const r = result.result as { metric_summary_id?: string; metric_key?: string; evaluation_name?: string } | undefined
  return r?.metric_summary_id ?? r?.metric_key ?? r?.evaluation_name ?? ""
}

function modelKeyForResult(result: ModelResultForBenchmark): string {
  return result.model_info?.id ?? result.model_info?.name ?? ""
}

function deriveProvenance(
  summary: BenchmarkEvalSummary,
  cross: CrossSuiteAggregate | null,
): DerivedSignal {
  // Cross-suite provenance: when the canonical benchmark appears in
  // multiple suites, the meaningful provenance question becomes "how
  // many independent sources have reported any given model on this
  // benchmark?". Within-page provenance is always single-source on
  // this site (hierarchy keeps each source isolated), so it doesn't
  // tell the reader anything they can't see by glancing at the
  // EVALUATOR column.
  if (cross && cross.appearances.length >= 2) {
    return deriveCrossSuiteProvenance(cross)
  }

  const triples = headlineResults(summary)
  if (triples.length === 0) {
    return {
      statValue: "—",
      statUnit: "",
      headline: "No reported scores yet.",
      detail: "",
      breakdown: {
        formula: "Provenance = (results with a recorded reporting party) / (total results).",
        inputs: [{ label: "Reported results", value: "0" }],
        empty: "No model results have been reported.",
      },
    }
  }

  const counts: Record<ProvenanceSourceType, number> = {
    first_party: 0,
    third_party: 0,
    collaborative: 0,
    unspecified: 0,
  }
  const distinctOrgs = new Set<string>()
  const orgsByGroup = new Map<string, Set<string>>()

  for (const t of triples) {
    counts[readSourceType(t)]++
    const org = readSourceOrg(t)
    if (org) distinctOrgs.add(org)
    const groupKey = `${modelKeyForResult(t)}::${metricKeyForResult(t)}`
    if (org) {
      const existing = orgsByGroup.get(groupKey)
      if (existing) existing.add(org)
      else orgsByGroup.set(groupKey, new Set([org]))
    }
  }

  const total = triples.length
  const attributed = total - counts.unspecified
  const score = attributed / total

  const multiSourceGroups = Array.from(orgsByGroup.values()).filter((s) => s.size > 1).length
  const eligibleGroups = orgsByGroup.size
  const multiRate = eligibleGroups > 0 ? multiSourceGroups / eligibleGroups : null

  const headline =
    counts.unspecified === total
      ? "No triple carries an attribution."
      : multiSourceGroups > 0
      ? `${multiSourceGroups} of ${eligibleGroups} (model, metric) groups have reports from more than one party.`
      : `Single-source benchmark: ${distinctOrgs.size} reporting org${distinctOrgs.size === 1 ? "" : "s"}.`

  const dist: string[] = []
  if (counts.first_party > 0) dist.push(`${formatPct(counts.first_party / total)} first-party`)
  if (counts.third_party > 0) dist.push(`${formatPct(counts.third_party / total)} third-party`)
  if (counts.collaborative > 0) dist.push(`${formatPct(counts.collaborative / total)} collaborative`)
  if (counts.unspecified > 0) dist.push(`${formatPct(counts.unspecified / total)} unspecified`)

  const detailBits = [dist.join(" · ")]
  if (multiRate != null) detailBits.push(`${formatPct(multiRate)} multi-source`)

  const rows: BreakdownRow[] = []
  for (const org of Array.from(distinctOrgs).sort()) {
    rows.push({
      label: org,
      status: "info",
      detail: `Reported one or more results.`,
    })
  }
  if (counts.unspecified > 0) {
    rows.push({
      label: "Unattributed",
      status: "warn",
      detail: `${counts.unspecified} of ${total} results carry no source organization.`,
    })
  }

  return {
    statValue: pctNum(score),
    statUnit: "%",
    headline,
    detail: detailBits.join(" · "),
    breakdown: {
      formula: "Provenance = (results with a recorded reporting organization) / (total results).",
      inputs: [
        { label: "Total results", value: total.toString() },
        { label: "First-party", value: counts.first_party.toString() },
        { label: "Third-party", value: counts.third_party.toString() },
        { label: "Collaborative", value: counts.collaborative.toString() },
        { label: "Unattributed", value: counts.unspecified.toString() },
        { label: "Distinct organizations", value: distinctOrgs.size.toString() },
        {
          label: "Multi-source groups",
          value: `${multiSourceGroups} of ${eligibleGroups}`,
        },
      ],
      rows,
    },
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Comparability — cross-suite first, within-page fallback
// ──────────────────────────────────────────────────────────────────────────

function computeThreshold(metricConfig: BenchmarkEvalSummary["metric_config"]): number {
  if (!metricConfig) return 0.05
  const unit = (metricConfig as { unit?: string; metric_unit?: string }).unit
    ?? (metricConfig as { metric_unit?: string }).metric_unit
  const scoreType = (metricConfig as { score_type?: string }).score_type
  if (unit === "proportion" || scoreType === "continuous_normalized") return 0.05
  if (unit === "percent") return 5.0
  const min = metricConfig.min_score
  const max = metricConfig.max_score
  if (typeof min === "number" && typeof max === "number" && max > min) return 0.05 * (max - min)
  return 0.05
}

interface CrossSuiteAppearance {
  evalSummaryId: string
  familyKey: string
  familyName: string
  benchmarkKey: string
  isCurrentEval: boolean
}

interface CrossSuiteModelRow {
  modelRouteId: string
  modelDisplay: string
  scoresByEval: Map<string, number>
  spread: number | null
}

interface CrossSuiteAggregate {
  canonicalKey: string
  canonicalDisplayName: string
  appearances: CrossSuiteAppearance[]
  modelRows: CrossSuiteModelRow[]
  /** Rows where the model was reported in ≥2 sibling evals — eligible
   *  for an apples-to-apples comparison. */
  comparedCount: number
  agreementCount: number
  divergentCount: number
  threshold: number
  thresholdLabel: string
}

function findCanonicalEntry(
  hierarchy: EvalHierarchy | null | undefined,
  summary: BenchmarkEvalSummary,
): BenchmarkIndexEntry | null {
  const index = hierarchy?.benchmark_index ?? []
  if (index.length === 0) return null

  // Prefer "benchmark canonical" entries (whose appearances all point at
  // the same benchmark_key) over umbrella entries — same heuristic used
  // by the model-detail overlap section.
  const classify = (entry: BenchmarkIndexEntry): "canonical" | "umbrella" => {
    const apps = entry.appearances ?? []
    return apps.every((a) => !a.benchmark_key || a.benchmark_key === entry.key)
      ? "canonical"
      : "umbrella"
  }

  // Strategy 1 — exact match: the page's evaluation_id appears in some
  // appearance.constituent_evaluation_ids list (e.g. mmlu-pro-leaderboard%2Fmmlu-pro).
  const evalSummaryId = summary.evaluation_id
  if (evalSummaryId) {
    let exactCanonical: BenchmarkIndexEntry | null = null
    let exactUmbrella: BenchmarkIndexEntry | null = null
    for (const entry of index) {
      const apps = entry.appearances ?? []
      if (apps.length === 0) continue
      const hit = apps.some((a) => (a.constituent_evaluation_ids ?? []).includes(evalSummaryId))
      if (!hit) continue
      const kind = classify(entry)
      if (kind === "canonical") exactCanonical ??= entry
      else exactUmbrella ??= entry
    }
    if (exactCanonical) return exactCanonical
    if (exactUmbrella) return exactUmbrella
  }

  // Strategy 2 — tiered key fallback for canonical pages whose own
  // evaluation_id isn't listed in benchmark_index (e.g.
  // mmlu-pro%2Fmmlu-pro). Iterate keys from most specific to least:
  // benchmark_id → composite_slug → family_id. Crucial that
  // benchmark_id wins over family_id, otherwise an MMLU-Pro page can
  // resolve to the broader MMLU umbrella entry whose appearances are
  // for the unrelated original-MMLU benchmark, producing a
  // comparability score for a different benchmark altogether.
  const tieredKeys = [summary.benchmark_id, summary.composite_slug, summary.family_id]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
  const seen = new Set<string>()
  for (const key of tieredKeys) {
    if (seen.has(key)) continue
    seen.add(key)
    const match = index.find((e) => e.key === key && (e.appearances ?? []).length > 0)
    if (match) return match
  }

  return null
}

function pickRepresentativeMetric(metrics: ComparisonMetricEntry[]): ComparisonMetricEntry | null {
  if (metrics.length === 0) return null
  const isStderr = (id: string) => /(^|_)stderr(_|$)|standard.error/i.test(id)
  const main =
    metrics.find(
      (m) =>
        !isStderr(m.metric_summary_id) &&
        /accuracy|score|exact|pass|win|mean/i.test(m.metric_name ?? ""),
    ) ?? metrics.find((m) => !isStderr(m.metric_summary_id)) ?? metrics[0]
  return main ?? null
}

function buildCrossSuiteAggregate(
  summary: BenchmarkEvalSummary,
  hierarchy: EvalHierarchy | null | undefined,
  comparisonIndex: ComparisonIndex | null | undefined,
): CrossSuiteAggregate | null {
  if (!hierarchy || !comparisonIndex) return null

  const entry = findCanonicalEntry(hierarchy, summary)
  if (!entry) return null

  // Collect distinct sibling appearances (skip the current eval if it
  // appears alone — we need ≥2 siblings to be cross-suite-comparable).
  const familyDisplayByKey = new Map<string, string>()
  for (const fam of hierarchy.families ?? []) {
    familyDisplayByKey.set(fam.key, fam.display_name)
  }
  const appearances: CrossSuiteAppearance[] = []
  const seenEvalIds = new Set<string>()
  for (const app of entry.appearances ?? []) {
    for (const id of app.constituent_evaluation_ids ?? []) {
      if (seenEvalIds.has(id)) continue
      seenEvalIds.add(id)
      appearances.push({
        evalSummaryId: id,
        familyKey: app.family_key,
        familyName: familyDisplayByKey.get(app.family_key) ?? app.family_key,
        benchmarkKey: app.benchmark_key,
        isCurrentEval: id === summary.evaluation_id,
      })
    }
  }
  if (appearances.length < 2) return null

  // For each appearance, pick a representative metric and pull its
  // per-model leaderboard. Different suites may use slightly different
  // metric names; we pick the most "headline" metric per suite.
  const metricByEval = new Map<string, ComparisonMetricEntry>()
  for (const app of appearances) {
    const evalEntry = comparisonIndex.evals[app.evalSummaryId]
    if (!evalEntry) continue
    const metric = pickRepresentativeMetric(evalEntry.metrics)
    if (metric) metricByEval.set(app.evalSummaryId, metric)
  }
  if (metricByEval.size < 2) return null

  // Decide a normalization scale for cross-suite comparison: if the
  // representative metrics span a 0-1 scale and a 0-100 scale, rescale
  // the smaller into 0-100 so divergence is computed on a common axis.
  // Preferred path (spec F5): when every cell across the sibling metrics
  // carries producer canonical-scale fields, those settle the common axis
  // exactly. Otherwise (old snapshots, mixed groups, bounds-less metrics)
  // keep the legacy magnitude heuristic, mirroring the model-detail
  // overlap fallback.
  const sampleScores: number[] = []
  const scaleCells: CanonicalScaleCell[] = []
  for (const [evalId, metric] of metricByEval) {
    void evalId
    for (const row of metric.scores ?? []) {
      if (typeof row.score === "number" && Number.isFinite(row.score)) {
        sampleScores.push(row.score)
        scaleCells.push({
          score: row.score,
          scoreCanonical: row.score_canonical,
          scaleConversion: row.scale_conversion,
          unit: metric.unit ?? null,
        })
      }
    }
  }
  const scaleGroup = resolveCanonicalScaleGroup(
    scaleCells,
    // Registry bounds shared by the sibling metric entries — resolve
    // anchor-neutral / unit-conflicted groups exactly (conflicting bounds
    // merge to undefined and keep the fallback).
    mergeRegistryBounds(
      Array.from(metricByEval.values(), (m) => ({
        min: m.canonical_min_score,
        max: m.canonical_max_score,
      })),
    ),
  )
  // Same display convention as the legacy guess (any percent-scale source
  // pulls the whole table onto the 0-100 axis), read off the producer
  // fields when available.
  const looksPercent = scaleGroup
    ? scaleGroup.percentSourceCount > 0
    : sampleScores.some((s) => Math.abs(s) > 1.5)
  const rescale = (raw: number): number => {
    const isHigh = Math.abs(raw) > 1.5
    if (looksPercent) return isHigh ? raw : raw * 100
    return isHigh ? raw / 100 : raw
  }

  // Collect per-model scores keyed by model_route_id. A model's row is
  // "compared" when it has scores in ≥2 sibling evals.
  const rowsByModel = new Map<
    string,
    { modelDisplay: string; scoresByEval: Map<string, number> }
  >()
  for (const [evalSummaryId, metric] of metricByEval) {
    for (const row of metric.scores ?? []) {
      if (typeof row.score !== "number" || !Number.isFinite(row.score)) continue
      const display = row.model_family_name ?? row.model_route_id
      const slot = rowsByModel.get(row.model_route_id) ?? {
        modelDisplay: display,
        scoresByEval: new Map<string, number>(),
      }
      // Take the first score per (model, eval) — the comparison-index
      // already de-dupes within a metric. On the canonical path, flagged
      // rows (score_canonical null) fall back to the legacy per-row guess
      // inside toDisplay — they stay included, matching legacy behavior.
      if (!slot.scoresByEval.has(evalSummaryId)) {
        const value = scaleGroup
          ? scaleGroup.toDisplay(
              {
                score: row.score,
                scoreCanonical: row.score_canonical,
                scaleConversion: row.scale_conversion,
                unit: metric.unit ?? null,
              },
              looksPercent,
            )
          : rescale(row.score)
        slot.scoresByEval.set(evalSummaryId, value)
      }
      rowsByModel.set(row.model_route_id, slot)
    }
  }

  const baseThreshold = computeThreshold(summary.metric_config)
  // When we rescaled into a 0-100 axis, scale the threshold accordingly
  // so the comparison stays meaningful.
  const threshold = looksPercent && baseThreshold < 1 ? baseThreshold * 100 : baseThreshold
  const thresholdLabel = looksPercent ? `${formatNumber(threshold)} pts` : `±${formatNumber(threshold)}`

  let comparedCount = 0
  let divergentCount = 0
  const modelRows: CrossSuiteModelRow[] = []
  for (const [routeId, slot] of rowsByModel) {
    const scores = Array.from(slot.scoresByEval.values())
    if (scores.length < 2) {
      modelRows.push({
        modelRouteId: routeId,
        modelDisplay: slot.modelDisplay,
        scoresByEval: slot.scoresByEval,
        spread: null,
      })
      continue
    }
    const spread = Math.max(...scores) - Math.min(...scores)
    comparedCount += 1
    if (spread > threshold) divergentCount += 1
    modelRows.push({
      modelRouteId: routeId,
      modelDisplay: slot.modelDisplay,
      scoresByEval: slot.scoresByEval,
      spread,
    })
  }
  // Sort models with the largest spread to the top (but compared rows
  // before un-compared so the first model in the list is informative).
  modelRows.sort((a, b) => {
    const aHas = a.spread != null ? 1 : 0
    const bHas = b.spread != null ? 1 : 0
    if (aHas !== bHas) return bHas - aHas
    return (b.spread ?? 0) - (a.spread ?? 0)
  })

  const agreementCount = comparedCount - divergentCount

  return {
    canonicalKey: entry.key,
    canonicalDisplayName: entry.display_name,
    appearances,
    modelRows,
    comparedCount,
    agreementCount,
    divergentCount,
    threshold,
    thresholdLabel,
  }
}

function deriveCrossSuiteProvenance(cross: CrossSuiteAggregate): DerivedSignal {
  const sourceCount = cross.appearances.length
  // A model is "multi-source-attested" when it appears with a real score
  // in at least two sibling appearances of the same canonical benchmark.
  let multiSourceModels = 0
  let totalModels = 0
  for (const row of cross.modelRows) {
    if (row.scoresByEval.size === 0) continue
    totalModels += 1
    if (row.scoresByEval.size >= 2) multiSourceModels += 1
  }

  if (totalModels === 0) {
    return {
      statValue: "—",
      statUnit: "",
      headline: `${sourceCount} sources report this benchmark, but no model overlaps between them.`,
      detail: "",
      breakdown: {
        formula:
          "Provenance = (models reported by ≥2 independent sources) / (models reported by any source).",
        inputs: [
          { label: "Sources reporting this benchmark", value: sourceCount.toString() },
          { label: "Models with any report", value: "0" },
        ],
        custom: <CrossSuiteBreakdown aggregate={cross} />,
      },
    }
  }

  const score = multiSourceModels / totalModels
  const headline =
    multiSourceModels === 0
      ? `${sourceCount} independent sources report this benchmark, but no model has been reported by more than one.`
      : multiSourceModels === totalModels
      ? `Every reported model has been reported by ≥2 independent sources (${sourceCount} sources total).`
      : `${multiSourceModels} of ${totalModels} reported models have been reported by ≥2 independent sources.`
  const detail = `${sourceCount} source${sourceCount === 1 ? "" : "s"} · ${multiSourceModels}/${totalModels} multi-source models`

  return {
    statValue: pctNum(score),
    statUnit: "%",
    headline,
    detail,
    breakdown: {
      formula:
        "Provenance = (models reported by ≥2 independent sources) / (models reported by any source).",
      inputs: [
        { label: "Sources reporting this benchmark", value: sourceCount.toString() },
        { label: "Models reported in any source", value: totalModels.toString() },
        { label: "Reported by ≥2 sources", value: multiSourceModels.toString() },
        { label: "Reported by 1 source only", value: (totalModels - multiSourceModels).toString() },
      ],
      custom: <CrossSuiteBreakdown aggregate={cross} />,
    },
  }
}

function deriveComparability(
  summary: BenchmarkEvalSummary,
  cross: CrossSuiteAggregate | null,
): DerivedSignal {
  // Cross-suite is the meaningful comparison: the hierarchy keeps each
  // source on its own eval page, so within-page never has multiple
  // sources to compare against each other.
  if (cross && cross.appearances.length >= 2 && cross.comparedCount > 0) {
    const agreementRate = cross.agreementCount / cross.comparedCount
    const headline =
      cross.divergentCount === 0
        ? `Sources agree across all ${cross.comparedCount} models reported in multiple suites.`
        : cross.agreementCount === 0
        ? `Every model reported in multiple suites diverges by more than the ${cross.thresholdLabel} threshold.`
        : `${cross.agreementCount} of ${cross.comparedCount} models agree across suites within ${cross.thresholdLabel}.`
    const detail = `${cross.appearances.length} sources · ${cross.comparedCount} model${cross.comparedCount === 1 ? "" : "s"} compared · threshold ${cross.thresholdLabel}`

    const appearanceRows: BreakdownRow[] = cross.appearances.map((a) => ({
      label: a.familyName,
      status: a.isCurrentEval ? "info" : "info",
      detail: a.isCurrentEval ? "Current eval" : "Sibling source",
      href: a.isCurrentEval ? undefined : `/evals/${a.evalSummaryId.replace(/%2F/g, "/")}`,
    }))

    return {
      statValue: pctNum(agreementRate),
      statUnit: "%",
      headline,
      detail,
      breakdown: {
        formula:
          "Comparability = (models whose scores agree within threshold across sources) / (models reported in ≥2 sources).",
        inputs: [
          { label: "Sources reporting this benchmark", value: cross.appearances.length.toString() },
          { label: "Models compared", value: cross.comparedCount.toString() },
          { label: "Agree within threshold", value: cross.agreementCount.toString() },
          { label: "Diverge", value: cross.divergentCount.toString() },
          { label: "Threshold", value: cross.thresholdLabel },
        ],
        custom: <CrossSuiteBreakdown aggregate={cross} />,
        rows: appearanceRows,
      },
    }
  }

  if (cross && cross.appearances.length >= 2) {
    // Sources exist but no shared models — surface this honestly.
    return {
      statValue: "—",
      statUnit: "",
      headline: "Sources don't share any models.",
      detail: `${cross.appearances.length} sources report ${cross.canonicalDisplayName}, but no model overlaps between them.`,
      breakdown: {
        formula:
          "Comparability requires the same model to be reported in ≥2 sources. None overlap on this benchmark.",
        inputs: [
          { label: "Sources reporting this benchmark", value: cross.appearances.length.toString() },
          { label: "Shared models", value: "0" },
        ],
        custom: <CrossSuiteBreakdown aggregate={cross} />,
      },
    }
  }

  // Within-page fallback (rarely exercised given the hierarchy design).
  return deriveWithinPageComparability(summary)
}

function deriveWithinPageComparability(summary: BenchmarkEvalSummary): DerivedSignal {
  const triples = headlineResults(summary)
  if (triples.length === 0) {
    return {
      statValue: "—",
      statUnit: "",
      headline: "No reported scores yet.",
      detail: "",
      breakdown: {
        formula:
          "Comparability looks for the same benchmark reported by multiple sources or with multiple setups, then checks whether the numbers agree.",
        inputs: [],
        empty: "No results have been reported.",
      },
    }
  }

  return {
    statValue: "—",
    statUnit: "",
    headline: "Only one source reports this benchmark.",
    detail: "Cross-suite comparability needs at least two sources reporting the same canonical benchmark.",
    breakdown: {
      formula:
        "Comparability looks for the same benchmark reported by multiple sources or with multiple setups, then checks whether the numbers agree across sources.",
      inputs: [
        { label: "Sources reporting this benchmark", value: "1" },
      ],
      empty:
        "This benchmark is only reported on this page. Once another suite reports the same benchmark, comparability will compare scores across them.",
    },
  }
}

function CrossSuiteBreakdown({ aggregate }: { aggregate: CrossSuiteAggregate }) {
  const ordered = aggregate.modelRows.filter((r) => r.spread != null).slice(0, 8)
  const remaining = aggregate.modelRows.filter((r) => r.spread != null).length - ordered.length

  return (
    <div className="mt-4 space-y-4">
      <div>
        <div
          className="mb-2 font-mono uppercase"
          style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
        >
          This evaluation appears across {aggregate.appearances.length} sources
        </div>
        <ul className="flex flex-wrap gap-1.5">
          {aggregate.appearances.map((a) => (
            <li key={a.evalSummaryId}>
              {a.isCurrentEval ? (
                <span
                  className="ec-tag accent"
                  style={{ textTransform: "none", fontFamily: "var(--font-mono)", fontSize: 11 }}
                >
                  {a.familyName} (current)
                </span>
              ) : (
                <a
                  href={`/evals/${a.evalSummaryId.replace(/%2F/g, "/")}`}
                  className="ec-tag outline"
                  style={{
                    textTransform: "none",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    textDecoration: "none",
                  }}
                >
                  {a.familyName}
                </a>
              )}
            </li>
          ))}
        </ul>
      </div>

      {ordered.length > 0 && (
        <div>
          <div
            className="mb-2 font-mono uppercase"
            style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
          >
            Per-model spread across sources
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr style={{ color: "var(--fg-subtle)" }}>
                  <th className="text-left font-mono uppercase pb-1.5" style={{ fontSize: 10, letterSpacing: "0.12em" }}>
                    Model
                  </th>
                  {aggregate.appearances.map((a) => (
                    <th
                      key={a.evalSummaryId}
                      className="text-right font-mono uppercase pb-1.5 pl-3"
                      style={{ fontSize: 10, letterSpacing: "0.12em" }}
                      title={a.familyName}
                    >
                      {a.familyName}
                    </th>
                  ))}
                  <th className="text-right font-mono uppercase pb-1.5 pl-3" style={{ fontSize: 10, letterSpacing: "0.12em" }}>
                    Spread
                  </th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((row) => {
                  const isDivergent = (row.spread ?? 0) > aggregate.threshold
                  return (
                    <tr key={row.modelRouteId} style={{ borderTop: "1px solid var(--border-soft)" }}>
                      <td className="py-1.5 pr-3 font-medium" style={{ color: "var(--fg)" }}>
                        {row.modelDisplay}
                      </td>
                      {aggregate.appearances.map((a) => {
                        const score = row.scoresByEval.get(a.evalSummaryId)
                        return (
                          <td
                            key={a.evalSummaryId}
                            className="py-1.5 pl-3 text-right font-mono tabular-nums"
                            style={{ color: score != null ? "var(--fg)" : "var(--fg-subtle)" }}
                          >
                            {score != null ? formatNumber(score) : "—"}
                          </td>
                        )
                      })}
                      <td
                        className="py-1.5 pl-3 text-right font-mono tabular-nums"
                        style={{ color: isDivergent ? "var(--accent)" : "var(--fg-muted)" }}
                      >
                        {row.spread != null ? formatNumber(row.spread) : "—"}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {remaining > 0 && (
            <div
              className="mt-2 font-mono"
              style={{ fontSize: 11, color: "var(--fg-subtle)" }}
            >
              +{remaining} more model{remaining === 1 ? "" : "s"} not shown
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function isPopulated(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === "string") return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0
  return Boolean(value)
}

function pctNum(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  if (value <= 0) return "0"
  if (value < 0.01) return "<1"
  return `${Math.round(value * 100)}`
}

function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  if (value === 0) return "0%"
  if (value < 0.01) return "<1%"
  return `${Math.round(value * 100)}%`
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—"
  if (value >= 100) return value.toFixed(0)
  if (value >= 1) return value.toFixed(2)
  return value.toFixed(3).replace(/0+$/g, "").replace(/\.$/, "")
}

// ──────────────────────────────────────────────────────────────────────────
// Tile + Dialog rendering
// ──────────────────────────────────────────────────────────────────────────

function SignalRow({
  id,
  statValue,
  statUnit,
  headline,
  detail,
  onOpen,
}: {
  id: SignalId
  onOpen: () => void
} & DerivedSignal) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left transition-colors hover:bg-[color:var(--bg-warm)]"
      title={SIGNAL_ASKS[id]}
      style={{
        background: "transparent",
        border: 0,
        padding: "4px 6px",
        margin: "-4px -6px",
        cursor: "pointer",
        minWidth: 0,
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className={`sig-glyph sig-${id}`}
          style={{ width: 22, height: 22, fontSize: "0.7rem", flexShrink: 0 }}
        >
          <span>{SIGNAL_GLYPHS[id]}</span>
        </span>
        <span
          className="font-mono uppercase"
          style={{
            fontSize: 10,
            letterSpacing: "0.14em",
            color: "var(--fg-muted)",
            flexShrink: 0,
          }}
        >
          {SIGNAL_NAMES[id]}
        </span>
        <span
          className="ml-auto font-mono tabular-nums"
          style={{ fontSize: 16, fontWeight: 600, color: "var(--fg)" }}
        >
          {statValue}
          {statUnit && (
            <span style={{ fontSize: 10, color: "var(--fg-subtle)", marginLeft: 2 }}>
              {statUnit}
            </span>
          )}
        </span>
      </div>
      <div
        className="mt-1"
        style={{
          fontSize: 11,
          lineHeight: 1.4,
          color: "var(--fg-muted)",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {headline}
        {detail && (
          <span style={{ color: "var(--fg-subtle)" }}>
            {" · "}
            {detail}
          </span>
        )}
      </div>
      <div
        className="mt-1 font-mono uppercase"
        style={{ fontSize: 9, letterSpacing: "0.14em", color: "var(--accent)" }}
      >
        How is this calculated? →
      </div>
    </button>
  )
}

function SignalExplanation({ id, signal }: { id: SignalId; signal: DerivedSignal }) {
  const breakdown = signal.breakdown
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span
            className={`sig-glyph sig-${id}`}
            style={{ width: 22, height: 22, fontSize: "0.7rem" }}
          >
            <span>{SIGNAL_GLYPHS[id]}</span>
          </span>
          {SIGNAL_NAMES[id]} · {signal.statValue}
          {signal.statUnit && <span className="text-muted-foreground text-sm">{signal.statUnit}</span>}
        </DialogTitle>
        <DialogDescription>{SIGNAL_ASKS[id]}</DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div>
          <div
            className="mb-1 font-mono uppercase"
            style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
          >
            How it's calculated
          </div>
          <p
            className="text-[13px] leading-[1.6] break-words"
            style={{ color: "var(--fg)" }}
          >
            {breakdown.formula}
          </p>
        </div>

        {breakdown.inputs.length > 0 && (
          <div>
            <div
              className="mb-2 font-mono uppercase"
              style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
            >
              Inputs
            </div>
            <dl className="ec-datalist" style={{ maxWidth: "none" }}>
              {breakdown.inputs.map((line) => (
                <div key={line.label} className="contents">
                  <dt>{line.label}</dt>
                  <dd className="font-mono tabular-nums">{line.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {breakdown.custom}

        {breakdown.rows && breakdown.rows.length > 0 && !breakdown.custom && (
          <div>
            <div
              className="mb-2 font-mono uppercase"
              style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
            >
              Per-item breakdown
            </div>
            <ul className="flex flex-col" style={{ borderTop: "1px solid var(--border-soft)" }}>
              {breakdown.rows.map((row) => (
                <li
                  key={row.label}
                  className="grid gap-x-3 py-1.5"
                  style={{
                    gridTemplateColumns: "10px minmax(0, 1fr) auto",
                    borderBottom: "1px solid var(--border-soft)",
                    alignItems: "baseline",
                  }}
                >
                  <span
                    aria-hidden
                    style={{ color: statusColor(row.status), fontSize: 10, lineHeight: 1 }}
                  >
                    {statusGlyph(row.status)}
                  </span>
                  <span style={{ color: "var(--fg)", fontSize: 12.5 }}>{row.label}</span>
                  <span
                    className="text-right"
                    style={{ fontSize: 11, color: "var(--fg-muted)" }}
                  >
                    {row.detail}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {breakdown.empty && (!breakdown.rows || breakdown.rows.length === 0) && !breakdown.custom && (
          <p
            className="text-[13px] italic"
            style={{ color: "var(--fg-muted)" }}
          >
            {breakdown.empty}
          </p>
        )}
      </div>
    </>
  )
}

function statusGlyph(status: BreakdownRow["status"]): string {
  switch (status) {
    case "ok":
      return "●"
    case "warn":
      return "◐"
    case "missing":
      return "○"
    default:
      return "·"
  }
}

function statusColor(status: BreakdownRow["status"]): string {
  switch (status) {
    case "ok":
      return "var(--accent)"
    case "warn":
      return "var(--fg-muted)"
    case "missing":
      return "var(--fg-subtle)"
    default:
      return "var(--fg-subtle)"
  }
}
