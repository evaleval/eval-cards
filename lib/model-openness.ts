/**
 * Open / closed / unknown, as one classification both the model list and the
 * leaderboards read from.
 *
 * The producer sets `open_weights` TRUE only where a model's weights are
 * confirmed published, and FALSE only where the entity registry curated that
 * verdict. Everything else is NULL — and NULL is the largest bucket, so it
 * cannot be folded into "closed": doing so would assert a verdict about
 * roughly half the corpus that nothing in the data supports. It gets its own
 * category instead, and the filter defaults to showing all three.
 */

export type ModelOpenness = "open" | "closed" | "unknown"

export const MODEL_OPENNESS_ORDER: readonly ModelOpenness[] = [
  "open",
  "closed",
  "unknown",
] as const

export const MODEL_OPENNESS_LABELS: Record<ModelOpenness, string> = {
  open: "Open weights",
  closed: "Closed",
  unknown: "Unknown",
}

/** Longer copy for tooltips — says what the category does and doesn't claim. */
export const MODEL_OPENNESS_DESCRIPTIONS: Record<ModelOpenness, string> = {
  open: "Weights are published — the model resolves to a Hugging Face model repo, or the registry records it as open. Gated repos count as open.",
  closed: "The registry records this model as not publishing weights.",
  unknown:
    "No weights verdict. The model has no published repo we could confirm and the registry has not curated it — which is not the same as closed.",
}

/**
 * Bucket a raw `open_weights` value.
 *
 * Accepts the shapes the column arrives in across the stack: a real boolean
 * from the parquet reader, and the string/number forms a JSON round-trip can
 * produce. Anything else — null, undefined, unrecognised — is `unknown`,
 * which is the honest answer rather than a guess.
 */
export function modelOpenness(value: unknown): ModelOpenness {
  if (value === true || value === 1 || value === "true") return "open"
  if (value === false || value === 0 || value === "false") return "closed"
  return "unknown"
}

/** True when `value`'s bucket is in `selected`. An empty selection shows
 *  nothing, which is what an all-off filter should mean. */
export function matchesOpenness(
  value: unknown,
  selected: readonly ModelOpenness[]
): boolean {
  return selected.includes(modelOpenness(value))
}
