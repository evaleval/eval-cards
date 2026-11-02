import type { ReproducibilityGap } from "@/lib/backend-artifacts"

/**
 * Display copy for the eight setup items the reproducibility signal checks.
 * The backend decides each item's state per result; this file only names
 * the items and explains the states.
 */
export interface SetupItem {
  id: string
  label: string
  hint: string
  /** Why the item does not apply, for the items that can be not applicable. */
  notApplicableReason?: string
  /** Why applicability is unknown, for the items that apply only to some runs. */
  unknownReason?: string
}

const LOG_PROB_DECODING = "Scored from log-probabilities, so nothing is sampled."
const LOG_PROB_LENGTH = "Scored from log-probabilities, so nothing is generated."
const UNKNOWN_REASONING = "Nothing on this result says whether it used a reasoning budget."
const UNKNOWN_AGENTIC = "Nothing on this result says whether it was agentic."

export const SETUP_ITEMS: SetupItem[] = [
  {
    id: "decoding",
    label: "Decoding",
    hint: "The sampling settings a re-run has to match, such as temperature or top-p.",
    notApplicableReason: LOG_PROB_DECODING,
  },
  {
    id: "reasoning_budget",
    label: "Reasoning budget",
    hint: "How much thinking the model was allowed before answering.",
    unknownReason: UNKNOWN_REASONING,
  },
  {
    id: "output_length",
    label: "Output length",
    hint: "Where generation was cut off: a limit on tokens, messages or steps.",
    notApplicableReason: LOG_PROB_LENGTH,
  },
  {
    id: "harness",
    label: "Harness",
    hint: "Which scaffold, agent or evaluation library produced the run, named so that someone can obtain it.",
  },
  {
    id: "harness_version",
    label: "Harness version",
    hint: "Which version or task configuration of that harness was used. A library name on its own is not enough to re-run the evaluation.",
  },
  {
    id: "context_handling",
    label: "Context handling",
    hint: "What happened when the transcript outgrew the context window: compaction, truncation or nothing.",
    unknownReason: UNKNOWN_AGENTIC,
  },
  {
    id: "test_set",
    label: "Test set",
    hint: "Which items the score covers: an item count, a split or a subset.",
  },
  {
    id: "attempts",
    label: "Attempts",
    hint: "How many times the evaluation was run: the repeated trajectories, epochs or samples the reported score pools over.",
    unknownReason: UNKNOWN_AGENTIC,
  },
]

const SETUP_ITEMS_BY_ID = new Map(SETUP_ITEMS.map((item) => [item.id, item]))

export function setupItem(id: string): SetupItem | undefined {
  return SETUP_ITEMS_BY_ID.get(id)
}

export function setupItemLabel(id: string): string {
  return SETUP_ITEMS_BY_ID.get(id)?.label ?? id.replace(/_/g, " ")
}

export type SetupItemState = "disclosed" | "missing" | "not_applicable" | "unknown"

const STATE_CODES: Record<string, SetupItemState> = {
  d: "disclosed",
  m: "missing",
  n: "not_applicable",
  u: "unknown",
}

/** The annotation `item_states` encodes: a merged row ships only the
 *  states, and this restores the members source rows carry. */
export function gapFromItemStates(itemStates: string): ReproducibilityGap {
  const missing = SETUP_ITEMS.filter((_, i) => itemStates[i] === "m").map((item) => item.id)
  const disclosed = [...itemStates].filter((code) => code === "d").length
  return {
    has_reproducibility_gap: missing.length > 0,
    missing_fields: missing,
    populated_count: disclosed,
    required_count: disclosed + missing.length,
    item_states: itemStates,
  }
}

/** The backend's state for one item, read from `item_states`. */
export function setupItemState(gap: ReproducibilityGap | null | undefined, id: string): SetupItemState {
  const code = gap?.item_states?.[SETUP_ITEMS.findIndex((item) => item.id === id)]
  return (code && STATE_CODES[code]) || "unknown"
}
