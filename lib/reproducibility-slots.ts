/**
 * Reproducibility scoring: SLOTS, not a fixed list of field names.
 *
 * The previous rule asked every row for `temperature` and `max_tokens`. Across
 * the live warehouse (83,842 rows) temperature is disclosed on 1.9% of rows and
 * max_tokens on 1.4%, so the signal read ~0% almost everywhere — a constant,
 * which tells a reader nothing. It was also wrong in the direction that matters:
 * a study disclosing scaffold, token budget, reasoning effort, compaction and
 * feedback condition scored 0/2, because none of that lives in
 * `generation_config`.
 *
 * So: score the DECISIONS a re-runner must pin down, let any of several fields
 * satisfy each one, and never count a knob that this run demonstrably does not
 * have as a failure to disclose. "Demonstrably" is the whole of it: a knob
 * nobody said anything about is undisclosed, not absent.
 *
 * The slot table is data, not code — see `config/reproducibility-slots.json`.
 * Adding a field to a slot is an edit to that file.
 */
import slotConfig from "@/config/reproducibility-slots.json"

/**
 * EVIDENCE_SHAPE — the namespaces a slot's `satisfied_by` path may address:
 *
 *   generation_args.*    the row's decoding args (temperature, max_tokens, …)
 *   generation_config.*  the rest of generation_config (prompt_template, …)
 *   protocol.*           parsed `protocol_condition` (token_limit, scaffold, …)
 *   limits.*             harness limits pulled out of the agentic config
 *   agent.*              agentic setup blocks (eval_plan, agentic_eval_config)
 *   score.*              score_details (sample_size, split coverage, …)
 *   row.*                anything else carried on the result row
 *   model.*              model metadata (open_weights, …)
 *
 * A path that addresses nothing is simply unsatisfied; a typo in the JSON costs
 * credit rather than throwing.
 */
export interface ReproducibilityEvidence {
  generation_args?: Record<string, unknown> | null
  generation_config?: Record<string, unknown> | null
  protocol?: Record<string, unknown> | null
  limits?: Record<string, unknown> | null
  agent?: Record<string, unknown> | null
  score?: Record<string, unknown> | null
  row?: Record<string, unknown> | null
  model?: Record<string, unknown> | null
}

export type SlotState = "disclosed" | "missing" | "not_applicable" | "unknown"

export interface SlotResult {
  id: string
  label: string
  hint?: string
  state: SlotState
  /** The path that satisfied the slot, for "disclosed via …" in the UI. */
  satisfiedBy?: string
  /** The value found at `satisfiedBy`, so a surface can show WHAT was
   *  reported rather than only that something was. */
  value?: unknown
  /** Every path this slot would accept — what a reader should look for
   *  when the slot is missing. */
  candidates?: string[]
  /** Why the slot is not being counted, for `n/a` and `unknown`. */
  reason?: string
}

export interface ReproducibilitySummary {
  slots: SlotResult[]
  /** Slots that apply to this run and are disclosed. */
  disclosed: number
  /** Slots that apply to this run at all — the denominator. */
  applicable: number
  /** disclosed / applicable, or null when nothing applies. */
  ratio: number | null
}

interface SlotSpec {
  id: string
  label: string
  hint?: string
  applies: string
  satisfied_by: string[]
}

interface SlotConfigShape {
  slots: SlotSpec[]
  applicability: {
    reasoning_markers?: string[]
    agentic_markers?: string[]
    scoring_mode?: {
      canonical_paths?: string[]
      output_type_paths?: string[]
      log_prob_output_types?: string[]
      generative_output_types?: string[]
      model_type_paths?: string[]
      log_prob_model_types?: string[]
      generative_model_types?: string[]
    }
  }
}

const CONFIG = slotConfig as unknown as SlotConfigShape

/** Slot id -> the evidence paths that satisfy it, straight from the JSON.
 *  Surfaces use it to tell which displayed fields belong to a slot that
 *  does not apply, so the audit grid and the slot chips cannot disagree. */
export const SLOT_FIELD_PATHS: Record<string, string[]> = Object.fromEntries(
  CONFIG.slots.map((slot) => [slot.id, slot.satisfied_by ?? []]),
)

/** A value counts as disclosed when it is present and not an empty shell.
 *  `false` and `0` are disclosures — "temperature 0" is the most reproducible
 *  answer there is, and treating it as missing was part of the old bug. */
function isDisclosed(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === "string") return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "object") return Object.keys(value as object).length > 0
  return true
}

function resolvePath(evidence: ReproducibilityEvidence, path: string): unknown {
  const dot = path.indexOf(".")
  if (dot < 0) return undefined
  const namespace = path.slice(0, dot) as keyof ReproducibilityEvidence
  const rest = path.slice(dot + 1)
  let current: unknown = evidence[namespace]
  for (const part of rest.split(".")) {
    if (current == null || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/** Strings that disclose the ABSENCE of the thing they name. A hosted API
 *  spells "no thinking budget" as `reasoning_effort: "none"`, and that is a
 *  disclosure, but it cannot be the marker that says the run reasoned. */
const NEGATIVE_VALUES = new Set(["false", "no", "none", "off", "disabled"])

/** A disclosed value that says the thing HAPPENED. Numbers are left alone:
 *  `0` means "unlimited" on some harnesses and "none" on others. */
function isAffirmative(value: unknown): boolean {
  if (!isDisclosed(value)) return false
  if (value === false) return false
  if (typeof value === "string") return !NEGATIVE_VALUES.has(value.trim().toLowerCase())
  return true
}

function anyAffirmative(evidence: ReproducibilityEvidence, paths: string[] | undefined): boolean {
  return (paths ?? []).some((path) => isAffirmative(resolvePath(evidence, path)))
}

/** `true` / `false` / `null` when the evidence cannot say. */
function isReasoningRun(evidence: ReproducibilityEvidence): boolean | null {
  const markers = CONFIG.applicability.reasoning_markers ?? []
  if (anyAffirmative(evidence, markers)) return true
  // No marker is not evidence of absence: most rows disclose nothing at all,
  // and the registry carries no reasoning flag to fall back on.
  return null
}

/**
 * Generative or log-prob — the first question, because it decides which knobs
 * exist at all. A log-prob run scores the model's likelihood over fixed answer
 * choices: nothing is sampled and nothing is generated, so temperature and
 * max_tokens are not undisclosed, they are absent. About a quarter of the
 * corpus is scored this way and every one of those rows was being marked down
 * for it.
 *
 * Never inferred from the benchmark's name: helm_* runs multiple choice by
 * generating the answer letter, which is generative.
 */
function scoringMode(evidence: ReproducibilityEvidence): "log_prob" | "generative" | null {
  const cfg = CONFIG.applicability.scoring_mode
  if (!cfg) return null
  const norm = (value: unknown) =>
    typeof value === "string" ? value.trim().toLowerCase() : null

  // The producer's own classification, read before anything inferred from the
  // row's raw fields. Any other value falls through, so a snapshot without the
  // column is classified exactly as it was before the column existed.
  for (const path of cfg.canonical_paths ?? []) {
    const value = norm(resolvePath(evidence, path))
    if (value === "log_prob" || value === "generative") return value
  }
  for (const path of cfg.output_type_paths ?? []) {
    const value = norm(resolvePath(evidence, path))
    if (!value) continue
    if ((cfg.log_prob_output_types ?? []).some((v) => v.toLowerCase() === value)) return "log_prob"
    if ((cfg.generative_output_types ?? []).some((v) => v.toLowerCase() === value)) return "generative"
  }
  for (const path of cfg.model_type_paths ?? []) {
    const value = norm(resolvePath(evidence, path))
    if (!value) continue
    if ((cfg.log_prob_model_types ?? []).some((v) => v.toLowerCase() === value)) return "log_prob"
    if ((cfg.generative_model_types ?? []).some((v) => v.toLowerCase() === value)) return "generative"
  }
  return null
}

function isAgenticRun(evidence: ReproducibilityEvidence): boolean | null {
  if (anyAffirmative(evidence, CONFIG.applicability.agentic_markers)) return true
  return null
}

function appliesTo(
  rule: string,
  evidence: ReproducibilityEvidence,
): { applies: boolean | null; reason?: string } {
  switch (rule) {
    case "always":
      return { applies: true }
    case "never":
      return { applies: false, reason: "Retired from scoring." }
    case "reasoning_run": {
      const reasoning = isReasoningRun(evidence)
      if (reasoning === true) return { applies: true }
      return {
        applies: null,
        reason: "Nothing on this run says whether it used a reasoning budget.",
      }
    }
    case "agentic_run": {
      const agentic = isAgenticRun(evidence)
      if (agentic === true) return { applies: true }
      return { applies: null, reason: "Nothing on this run says whether it was agentic." }
    }
    case "log_prob_run": {
      if (scoringMode(evidence) === "log_prob") return { applies: true }
      return { applies: null, reason: "Not known to be scored from log-probabilities." }
    }
    // Only an affirmative log-prob classification excuses these two. A run
    // whose mode nobody recorded is still asked for its decoding and length
    // settings: an undisclosed setting is the thing being measured, and
    // exempting it would read as though the knob had been ruled out.
    case "generative_run": {
      if (scoringMode(evidence) === "log_prob") {
        return {
          applies: false,
          reason: "Scored from log-probabilities, so nothing is generated and there is no length to limit.",
        }
      }
      return { applies: true }
    }
    case "sampling_controlled": {
      if (scoringMode(evidence) === "log_prob") {
        return {
          applies: false,
          reason: "Scored from log-probabilities, so no sampling takes place.",
        }
      }
      return { applies: true }
    }
    default:
      // An unrecognised rule must not silently mark everything missing.
      return { applies: null, reason: `Unknown applicability rule "${rule}".` }
  }
}

/**
 * Score one row's disclosure. Slots that do not apply, and slots whose
 * applicability cannot be determined, are reported but left out of both
 * numerator and denominator.
 */
export function evaluateReproducibilitySlots(
  evidence: ReproducibilityEvidence,
): ReproducibilitySummary {
  const slots: SlotResult[] = []
  let disclosed = 0
  let applicable = 0

  for (const spec of CONFIG.slots) {
    const { applies, reason } = appliesTo(spec.applies, evidence)
    const satisfiedBy = (spec.satisfied_by ?? []).find((path) =>
      isDisclosed(resolvePath(evidence, path)),
    )

    const candidates = spec.satisfied_by ?? []

    if (spec.applies === "never") continue
    if (applies === false) {
      slots.push({
        id: spec.id, label: spec.label, hint: spec.hint, state: "not_applicable", reason, candidates,
      })
      continue
    }
    // A disclosed value settles applicability on its own, including one that
    // names an absence: `compaction: false` and `reasoning: false` are the
    // source answering the slot's question, and a source that answered it
    // must not be scored as though it had said nothing. What such a value
    // cannot do is stand in as a MARKER that the run reasoned or was agentic,
    // which is why the marker tests above read affirmative values only.
    if (applies === null && !satisfiedBy) {
      slots.push({
        id: spec.id, label: spec.label, hint: spec.hint, state: "unknown", reason, candidates,
      })
      continue
    }

    applicable += 1
    if (satisfiedBy) {
      disclosed += 1
      slots.push({
        id: spec.id,
        label: spec.label,
        hint: spec.hint,
        state: "disclosed",
        satisfiedBy,
        value: resolvePath(evidence, satisfiedBy),
        candidates,
      })
    } else {
      slots.push({ id: spec.id, label: spec.label, hint: spec.hint, state: "missing", candidates })
    }
  }

  return {
    slots,
    disclosed,
    applicable,
    ratio: applicable > 0 ? disclosed / applicable : null,
  }
}

/** Parse a JSON string column into an object, tolerating nulls and junk. */
function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== "string") return null
  try {
    const parsed = JSON.parse(raw)
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Build the evidence object from a leaderboard result row. Kept separate from
 * scoring so both the per-row panel and the page-level signal read the same
 * fields from the same places.
 */
export interface ReproducibilityRowInput {
  generation_config?: unknown
  protocol_condition?: string | null
  eval_library?: unknown
  eval_library_version?: unknown
  score_details?: unknown
  split?: unknown
  attempts?: unknown
  /** The producer's `scoring_mode` column: `generative`, `log_prob`, or
   *  null when it could not classify the row. */
  scoring_mode?: unknown
  model_info?: { open_weights?: unknown; additional_details?: unknown } | null
  result?: { generation_config?: unknown } | null
}

export function evidenceFromResult(result: ReproducibilityRowInput): ReproducibilityEvidence {
  const generationConfig =
    parseJsonObject(result.generation_config) ??
    parseJsonObject(result.result?.generation_config) ??
    {}
  const generationArgs = parseJsonObject(generationConfig.generation_args) ?? {}
  const additional = parseJsonObject(generationConfig.additional_details) ?? {}

  // The agentic blocks live under additional_details on some sources and at the
  // top of generation_config on others.
  const agent: Record<string, unknown> = {
    eval_plan: additional.eval_plan ?? generationConfig.eval_plan,
    agentic_eval_config: additional.agentic_eval_config ?? generationConfig.agentic_eval_config,
  }
  const limits = parseJsonObject(additional.eval_limits ?? generationConfig.eval_limits) ?? {}

  // The view ships the harness as a struct (`{name, version, ...}`). A
  // payload assembled outside the view layer may carry the two as plain
  // fields instead, so both shapes resolve to the same two paths: the
  // slots ask for a library and a pin, not for a column layout.
  const library = parseJsonObject(result.eval_library)
  const libraryName = library ? library.name : result.eval_library
  const libraryVersion = result.eval_library_version ?? library?.version

  return {
    generation_args: generationArgs,
    generation_config: generationConfig,
    protocol: parseJsonObject(result.protocol_condition) ?? {},
    limits,
    agent,
    score: (result.score_details as Record<string, unknown> | null) ?? {},
    row: {
      eval_library: libraryName,
      eval_library_version: libraryVersion,
      attempts: result.attempts,
      split: result.split,
      scoring_mode: result.scoring_mode,
    },
    model: {
      open_weights: result.model_info?.open_weights,
      additional_details: result.model_info?.additional_details,
    },
  }
}
