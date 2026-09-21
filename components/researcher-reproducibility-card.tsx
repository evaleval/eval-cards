"use client"

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { AlertTriangle, ExternalLink, FlaskConical } from "lucide-react"
import { Term } from "@/components/term"
import { SignalTooltip } from "@/components/signals/signal-tooltip"
import type { ModelResultForBenchmark } from "@/lib/eval-processing"
import type { GenerationConfig, ScoreDetails } from "@/lib/benchmark-schema"
import {
  evaluateReproducibilitySlots,
  evidenceFromResult,
  SLOT_FIELD_PATHS,
} from "@/lib/reproducibility-slots"

interface ResearcherReproducibilityCardProps {
  modelResult: ModelResultForBenchmark
  /**
   * Benchmark identifier used to pick the right per-eval row when fetching
   * enrichment from the model's full record. The eval-detail endpoint
   * synthesizes leaderboard rows without `generation_config`, so we top up
   * lazily on row expand from /api/eval-row-config.
   */
  benchmarkKey?: string
  evalName?: string
}

const KNOWN_DECODING_KEYS = ["temperature", "top_p", "top_k", "max_tokens", "seed", "reasoning"] as const

// Keys that belong to agentic eval setups, surfaced in their own group rather
// than dumped under "decoding" extras as raw JSON.
const KNOWN_AGENT_KEYS = [
  "agentic_eval_config",
  "max_attempts",
  "eval_limits",
  "eval_plan",
  "sandbox",
  "max_turns",
  "message_limit",
] as const

const KEY_LABEL: Record<string, string> = {
  temperature: "temperature",
  top_p: "top-p",
  top_k: "top-k",
  max_tokens: "max tokens",
  seed: "seed",
  reasoning: "reasoning mode",
  n: "samples per prompt",
  best_of: "best-of-N",
  num_samples: "samples per prompt",
  num_runs: "runs",
  n_shot: "n-shot",
  num_fewshot: "few-shot examples",
  fewshot: "few-shot examples",
  agentic_eval_config: "tools available",
  max_attempts: "max attempts",
  eval_limits: "eval limits",
  eval_plan: "eval plan",
  sandbox: "sandbox",
  max_turns: "max turns",
  message_limit: "message limit",
}

/**
 * Try to render a structured agentic config object as a short, readable
 * string. Falls back to null so the caller can use the generic formatter.
 */
function formatAgentValue(key: string, value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== "object") return null

  if (key === "agentic_eval_config") {
    const tools = (value as { available_tools?: unknown }).available_tools
    if (Array.isArray(tools)) {
      const names = tools
        .map((t) => (t && typeof t === "object" ? (t as { name?: unknown }).name : null))
        .filter((n): n is string => typeof n === "string" && n.length > 0)
      if (names.length === 0) return "no tools"
      if (names.length <= 4) return `${names.length} tools: ${names.join(", ")}`
      return `${names.length} tools: ${names.slice(0, 4).join(", ")} +${names.length - 4}`
    }
  }

  if (key === "eval_limits") {
    const obj = value as Record<string, unknown>
    const parts: string[] = []
    for (const k of ["message_limit", "max_messages", "token_limit", "max_tokens"]) {
      if (typeof obj[k] === "number") parts.push(`${k.replace(/_/g, " ")}: ${obj[k]}`)
    }
    if (parts.length > 0) return parts.join(", ")
  }

  if (key === "eval_plan") {
    const name = (value as { name?: unknown }).name
    const steps = (value as { steps?: unknown }).steps
    if (typeof name === "string" && Array.isArray(steps)) return `${name} (${steps.length} step${steps.length === 1 ? "" : "s"})`
    if (typeof name === "string") return name
  }

  if (key === "sandbox") {
    const keys = Object.keys(value as Record<string, unknown>)
    if (keys.length === 0) return "default"
    return keys.join(", ")
  }

  return null
}

function pickFromAdditional(value: unknown, keys: string[]): unknown | undefined {
  if (!value || typeof value !== "object") return undefined
  const obj = value as Record<string, unknown>
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k]
  }
  return undefined
}

/**
 * Renders any value as a short string for the parameter cards. Returns null
 * when the value is empty so the caller can render "Not disclosed" instead.
 */
function formatValue(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === "boolean") return value ? "yes" : "no"
  if (typeof value === "number") return Number.isInteger(value) ? value.toString() : value.toFixed(3)
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length === 0 ? null : trimmed
  }
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

/** "protocol.reasoning_effort" -> "reasoning effort". The namespace is
 *  plumbing; the reader wants the field. */
function fieldNameOf(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1).replace(/_/g, " ")
}

function ParamRow({
  label,
  value,
  termKey,
  hint,
  notApplicable,
}: {
  label: string
  value: ReactNode | null
  termKey?: string
  hint?: string
  notApplicable?: boolean
}) {
  const isMissing = value === null || value === undefined
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-dashed border-border/50 py-1.5 text-sm last:border-0">
      <span className="text-muted-foreground">
        {termKey ? <Term term={termKey}>{label}</Term> : label}
      </span>
      {isMissing && notApplicable ? (
        <SignalTooltip content="This run has no such control, so it is not counted against the source.">
          <span className="text-xs font-medium cursor-help" style={{ color: "var(--fg-subtle)" }}>
            n/a
          </span>
        </SignalTooltip>
      ) : isMissing ? (
        <SignalTooltip
          content={
            hint ??
            "This parameter wasn't reported by the source. Without it, the result may not be exactly reproducible."
          }
        >
          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300 cursor-help">
            <AlertTriangle className="h-3 w-3" /> Not disclosed
          </span>
        </SignalTooltip>
      ) : (
        <span className="font-medium tabular-nums">{value}</span>
      )}
    </div>
  )
}

interface FieldSpec {
  label: string
  value: string | null
  termKey?: string
  hint?: string
  /** The slot this field belongs to does not apply to this run, so its
   *  absence is not a disclosure failure. */
  notApplicable?: boolean
}

interface FieldGroup {
  title: string
  fields: FieldSpec[]
}

/**
 * Detailed reproducibility surface for researcher mode. Shown inside a
 * leaderboard row's expanded panel. Adaptive: when most fields aren't disclosed
 * (the common case today), it collapses to a compact "Limited disclosure"
 * summary showing only fields that *are* present, with a button to reveal the
 * full audit grid.
 */
export function ResearcherReproducibilityCard({
  modelResult,
  benchmarkKey,
  evalName,
}: ResearcherReproducibilityCardProps) {
  const [enrichedGen, setEnrichedGen] = useState<GenerationConfig | null>(null)
  const [enrichedScore, setEnrichedScore] = useState<ScoreDetails | null>(null)
  const [loading, setLoading] = useState(false)

  // Lazily top up generation_config / score_details from the model's full
  // record. The eval-detail leaderboard endpoint omits these fields; we only
  // pay the fetch cost when a researcher actually expands a row.
  useEffect(() => {
    const inlineGen = modelResult.result.generation_config
    const inlineScoreOk =
      modelResult.score_details.standard_error != null ||
      modelResult.score_details.confidence_interval != null ||
      modelResult.score_details.sample_size != null
    const hasInlineArgs =
      !!inlineGen &&
      typeof inlineGen === "object" &&
      "generation_args" in inlineGen &&
      Object.keys((inlineGen as { generation_args?: Record<string, unknown> }).generation_args ?? {}).length > 0
    if (hasInlineArgs && inlineScoreOk) return // nothing to fetch

    const modelId = modelResult.model_info.id
    if (!modelId) return

    const params = new URLSearchParams({ model_id: modelId })
    if (benchmarkKey) params.set("benchmark_key", benchmarkKey)
    if (evalName) params.set("eval_name", evalName)

    let cancelled = false
    setLoading(true)
    fetch(`/api/eval-row-config?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return
        if (data.generation_config) setEnrichedGen(data.generation_config as GenerationConfig)
        if (data.score_details) setEnrichedScore(data.score_details as ScoreDetails)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [modelResult, benchmarkKey, evalName])

  const gen = modelResult.result.generation_config ?? enrichedGen ?? undefined
  const args = gen?.generation_args ?? {}
  const scoreDetails = {
    ...modelResult.score_details,
    sample_size: modelResult.score_details.sample_size ?? enrichedScore?.sample_size,
    standard_error: modelResult.score_details.standard_error ?? enrichedScore?.standard_error,
    confidence_interval:
      modelResult.score_details.confidence_interval ?? enrichedScore?.confidence_interval,
  }
  const additional =
    typeof gen?.additional_details === "object" && gen?.additional_details !== null
      ? (gen.additional_details as Record<string, unknown>)
      : null

  const argsKeys = Object.keys(args)
  const extraDecodingKeys = argsKeys.filter(
    (k) =>
      !KNOWN_DECODING_KEYS.includes(k as (typeof KNOWN_DECODING_KEYS)[number]) &&
      !KNOWN_AGENT_KEYS.includes(k as (typeof KNOWN_AGENT_KEYS)[number])
  )
  const agentKeysPresent = KNOWN_AGENT_KEYS.filter((k) => args[k] != null)
  const hasAgentSetup = agentKeysPresent.length > 0

  const shots = pickFromAdditional(additional, ["num_fewshot", "n_shot", "shots", "fewshot"])
  const samplesPerPrompt = pickFromAdditional(additional, ["n", "num_samples", "samples_per_prompt"]) ?? args["n"]
  const bestOf = pickFromAdditional(additional, ["best_of", "best_of_n"]) ?? args["best_of"]
  const numRuns = pickFromAdditional(additional, ["num_runs", "n_runs", "runs"])
  const scoringMethod = pickFromAdditional(additional, ["scoring", "scoring_method", "judge", "evaluator"])
  const evalLibrary = pickFromAdditional(additional, ["eval_library", "harness", "framework"])
  const evalLibraryVersion = pickFromAdditional(additional, ["eval_library_version", "harness_version"])
  const promptTemplate = gen?.prompt_template?.trim() || null

  const groups: FieldGroup[] = [
    {
      title: "Decoding",
      fields: [
        {
          label: "temperature",
          termKey: "temperature",
          value: formatValue(args.temperature),
          hint: "Temperature controls randomness. Without it, others can't recreate the same outputs.",
        },
        { label: "top-p", termKey: "top-p", value: formatValue(args.top_p) },
        { label: "top-k", termKey: "top-k", value: formatValue(args.top_k) },
        { label: "max tokens", value: formatValue(args.max_tokens) },
        { label: "seed", value: formatValue(args.seed) },
        ...extraDecodingKeys.map((k) => ({
          label: KEY_LABEL[k] ?? k.replace(/_/g, " "),
          value: formatValue(args[k]),
        })),
      ],
    },
    {
      title: "Sampling",
      fields: [
        {
          label: "few-shot examples",
          termKey: "few-shot",
          value: formatValue(shots),
          hint: "How many worked examples were included in the prompt before the question.",
        },
        {
          label: "samples per prompt",
          value: formatValue(samplesPerPrompt),
          hint: "Number of completions generated per question.",
        },
        {
          label: "best-of-N",
          termKey: "best-of-n",
          value: formatValue(bestOf),
          hint: "Whether the score reflects the best of multiple attempts (inflates results vs. single-attempt).",
        },
        {
          label: "runs averaged",
          value: formatValue(numRuns),
          hint: "How many evaluation runs were averaged to produce the reported number.",
        },
        {
          label: "test instances",
          value: formatValue(scoreDetails.sample_size),
          hint: "Number of items in the test set the model was scored on.",
        },
      ],
    },
    ...(hasAgentSetup
      ? [
          {
            title: "Agent setup",
            fields: agentKeysPresent.map((k) => ({
              label: KEY_LABEL[k] ?? k.replace(/_/g, " "),
              value: formatAgentValue(k, args[k]) ?? formatValue(args[k]),
              hint:
                k === "agentic_eval_config"
                  ? "Tools the agent could call during the run."
                  : k === "max_attempts"
                    ? "Maximum independent attempts the agent gets per task."
                    : k === "eval_limits"
                      ? "Hard caps the harness enforced on the run (messages, tokens, etc.)."
                      : k === "eval_plan"
                        ? "Solver/plan the harness used to drive the agent."
                        : k === "sandbox"
                          ? "Environment in which the agent ran (e.g. docker, local)."
                          : undefined,
            })),
          } as FieldGroup,
        ]
      : []),
    {
      title: "Scoring & uncertainty",
      fields: [
        {
          label: "scoring method",
          value: formatValue(scoringMethod),
          hint: "Exact match, LLM-as-judge, human grading, etc. Determines what 'correct' means.",
        },
        { label: "standard error", value: formatValue(scoreDetails.standard_error) },
        {
          label: "confidence interval",
          // The producer sometimes ships the wrapping object with all
          // three inner fields null (e.g. when only standard_error was
          // reported). Stringifying those produces "null–null (null%)";
          // collapse to "Not disclosed" instead.
          value: (() => {
            const ci = scoreDetails.confidence_interval
            if (!ci) return null
            const lower = formatValue(ci.lower)
            const upper = formatValue(ci.upper)
            if (lower === null || upper === null) return null
            const level = formatValue(ci.confidence_level)
            return level !== null
              ? `${lower}–${upper} (${level}%)`
              : `${lower}–${upper}`
          })(),
        },
        { label: "eval library", value: formatValue(evalLibrary) },
        { label: "library version", value: formatValue(evalLibraryVersion) },
      ],
    },
  ]

  // Mirror the signal-strip's required-fields allowlist (see
  // BenchmarkSignalsStrip · BASE_REQUIRED_FIELDS / AGENTIC_REQUIRED_FIELDS).
  // The signal scores reproducibility on temperature + max_tokens only
  // (plus eval_plan + eval_limits when agentic), so the per-row dropdown
  // showing all 15 fields was confusing — readers saw "0/15 disclosed"
  // here but a different ratio in the strip above. Restrict this surface
  // to the same labels so the two views agree.
  //
  // TODO(repro-allowlist): expand both views together once the corpus
  // populates more fields reliably.
  // Scored as SLOTS — one per decision a re-runner must pin down, each
  // satisfiable by any of several fields, and each skipped when the knob
  // does not exist for this run. The old rule asked every row for
  // `temperature` and `max_tokens` and nothing else, which read ~0%
  // across 98% of the corpus and gave a study disclosing scaffold, token
  // budget and reasoning effort a flat 0/2. The slot table lives in
  // config/reproducibility-slots.json and is meant to be edited there.
  const slotSummary = useMemo(
    () =>
      evaluateReproducibilitySlots(
        evidenceFromResult({
          ...modelResult,
          generation_config: gen ?? modelResult.result.generation_config,
          protocol_condition: modelResult.protocol_condition,
        })
      ),
    [modelResult, gen]
  )

  // The audit grid still lists every field the source could have set; the
  // slots decide what is SCORED.
  const totalFields = slotSummary.applicable
  const disclosedFields = slotSummary.disclosed

  // Fields the source reported that no slot scores — standard error, test
  // instances, judge, and so on. Worth showing; never worth flagging as
  // missing, so only populated ones appear.
  const otherReportedFields = useMemo(() => {
    const scoredLabels = new Set(
      slotSummary.slots
        .flatMap((slot) => slot.candidates ?? [])
        .map((path) => path.slice(path.lastIndexOf(".") + 1).replace(/[^a-z0-9]/gi, "").toLowerCase()),
    )
    return groups
      .flatMap((g) => g.fields)
      .filter(
        (f) =>
          f.value !== null &&
          !scoredLabels.has(f.label.replace(/[^a-z0-9]/gi, "").toLowerCase()),
      )
  }, [groups, slotSummary])

  return (
    <section
      style={{
        padding: 16,
        border: "1px solid var(--border-soft)",
        background: "var(--bg)",
      }}
    >
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--fg-muted)" }} />
          <div className="min-w-0">
            <div
              className="font-mono uppercase mb-1"
              style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
            >
              Reproducibility
            </div>
            <div className="text-[12px]" style={{ color: "var(--fg-muted)" }}>
              {disclosedFields === 0
                ? "How this score was produced wasn't disclosed by the source."
                : "What the source reported, against what re-running this evaluation needs. Controls this run does not have are marked n/a and left out of the score."}
            </div>
          </div>
        </div>
        <span
          className="shrink-0 font-mono tabular-nums"
          style={{
            fontSize: 10,
            padding: "3px 8px",
            letterSpacing: "0.06em",
            border: "1px solid var(--border-soft)",
            background: "var(--bg-warm)",
            color: "var(--fg-muted)",
            textTransform: "uppercase",
          }}
        >
          {loading
            ? "loading…"
            : totalFields > 0
              ? `${disclosedFields}/${totalFields} applicable`
              : "nothing scorable"}
        </span>
      </header>

      {/* The slots, and why each one counts or doesn't. A bare percentage
          with a moving denominator is unreadable; showing the slots is
          what makes "3 of 4" mean something. */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {slotSummary.slots.map((slot) => {
          const style =
            slot.state === "disclosed"
              ? { color: "var(--fg)", border: "1px solid var(--fg-muted)" }
              : slot.state === "missing"
                ? { color: "var(--fg-muted)", border: "1px dashed var(--fg-muted)" }
                : { color: "var(--fg-subtle)", border: "1px solid var(--border-soft)" }
          const mark =
            slot.state === "disclosed"
              ? "✓"
              : slot.state === "missing"
                ? "—"
                : slot.state === "not_applicable"
                  ? "n/a"
                  : "?"
          return (
            <span
              key={slot.id}
              className="inline-flex items-center gap-1.5 font-mono uppercase"
              style={{ fontSize: 9.5, letterSpacing: "0.08em", padding: "2px 6px", ...style }}
              title={
                slot.state === "disclosed"
                  ? `${slot.label}: disclosed via ${slot.satisfiedBy}`
                  : slot.state === "missing"
                    ? `${slot.label}: applies to this run but the source did not disclose it.${slot.hint ? ` ${slot.hint}` : ""}`
                    : `${slot.label}: not counted. ${slot.reason ?? ""}`
              }
            >
              <span aria-hidden="true">{mark}</span>
              {slot.label}
            </span>
          )
        })}
      </div>

      {/* What the source actually reported, per slot. The old fixed grid
          listed every field the schema knows about and flagged the rest
          "Not disclosed" — under a dynamic rule that grid says nothing
          about what was scored, and contradicts the chips above whenever a
          slot is n/a. This lists the evidence instead. */}
      <div>
        {slotSummary.slots.map((slot) => (
          <div
            key={slot.id}
            className="flex items-baseline justify-between gap-3 border-b border-dashed border-border/50 py-1.5 text-sm last:border-0"
          >
            <span className="min-w-0">
              <span style={{ color: "var(--fg)" }}>{slot.label}</span>
              {slot.state === "disclosed" && slot.satisfiedBy && (
                <span className="ml-2 font-mono" style={{ fontSize: 11, color: "var(--fg-subtle)" }}>
                  {fieldNameOf(slot.satisfiedBy)}
                </span>
              )}
              {slot.state === "missing" && slot.candidates && slot.candidates.length > 0 && (
                <span className="ml-2" style={{ fontSize: 11, color: "var(--fg-subtle)" }}>
                  looked for {slot.candidates.map(fieldNameOf).join(", ")}
                </span>
              )}
            </span>
            {slot.state === "disclosed" ? (
              <span className="font-medium tabular-nums shrink-0">
                {formatValue(slot.value) ?? "reported"}
              </span>
            ) : slot.state === "missing" ? (
              <SignalTooltip
                content={
                  slot.hint ??
                  "This applies to the run but the source did not report it, so the result may not be exactly reproducible."
                }
              >
                <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300 cursor-help shrink-0">
                  <AlertTriangle className="h-3 w-3" /> Not disclosed
                </span>
              </SignalTooltip>
            ) : (
              <SignalTooltip content={slot.reason ?? "Not counted for this run."}>
                <span
                  className="text-xs font-medium cursor-help shrink-0"
                  style={{ color: "var(--fg-subtle)" }}
                >
                  {slot.state === "not_applicable" ? "n/a" : "unknown"}
                </span>
              </SignalTooltip>
            )}
          </div>
        ))}
      </div>

      {otherReportedFields.length > 0 && (
        <div className="mt-4">
          <div
            className="mb-2 font-mono uppercase"
            style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
          >
            Also reported
          </div>
          <div className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
            {otherReportedFields.map((f) => (
              <ParamRow key={f.label} label={f.label} termKey={f.termKey} value={f.value} hint={f.hint} />
            ))}
          </div>
        </div>
      )}

      {/* Prompt-template block hidden until the corpus reliably reports
          it; see TODO(repro-allowlist) above. The signal score doesn't
          consider prompt_template either, so showing it here would
          re-introduce the disagreement we just fixed. */}

      {modelResult.source_metadata.source_url && (
        <div className="mt-3">
          <a
            href={modelResult.source_metadata.source_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono uppercase underline-offset-4 hover:underline"
            style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--accent)" }}
          >
            View original source <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}
    </section>
  )
}
