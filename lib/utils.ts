import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Convert a backend route id (literal `%2F` slug form, e.g.
 * `openai%2Fgpt-4o`, `helm-capabilities%2Fmmlu-pro`) into the
 * human-readable path form (`openai/gpt-4o`) used in URLs.
 *
 * Pages mount via catch-all routes (`[...id]`) so multi-segment paths
 * resolve cleanly. The inverse — `params.id[]` → backend id form — is
 * `routeIdFromSegments`.
 */
export function routeIdToPath(id: string | null | undefined): string {
  if (!id) return ""
  return id.replace(/%2F/g, "/")
}

/**
 * Percent-encode one path segment to match the producer's Python
 * `urllib.parse.quote(value, safe="")` encoding. `encodeURIComponent`
 * leaves `! ' ( ) *` bare where Python encodes them, so those are
 * re-encoded explicitly (raw-key ids contain parens/apostrophes,
 * e.g. `Humanity's Last Exam (accuracy)`).
 */
function encodeSegmentStrict(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** decodeURIComponent that tolerates malformed input (lone `%` etc.). */
function decodeLoose(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Reconstruct the backend fully-percent-encoded id from a Next.js
 * catch-all params value. Accepts either the raw `string[]` from
 * `useParams()` or a pre-joined string for safety. Empty arrays
 * produce "".
 *
 * Segments are decoded first (Next has been inconsistent about whether
 * server `params` / `useParams()` deliver decoded or raw-encoded
 * values) then re-encoded with Python `quote(safe="")` semantics, so
 * both cases converge to the canonical stored id form — the transform
 * is idempotent. Mirrors the tradeoff `safeDecode` in middleware.ts
 * already makes for values that merely look encoded.
 */
export function routeIdFromSegments(value: string | string[] | undefined): string {
  if (value == null) return ""
  const segments = Array.isArray(value) ? value : value.split("/")
  return segments.map((s) => encodeSegmentStrict(decodeLoose(s))).join("%2F")
}

/**
 * True when an eval id routes to the MERGED benchmark page: merged ids
 * are single-segment (percent-encoded canonical benchmark ids, e.g.
 * `mmlu-pro`) and never contain `%2F`; per-source evaluation_ids always
 * do — that's the routing discriminator (merged-benchmark-view spec F2).
 * Normalises through `routeIdFromSegments` first so raw path arrays,
 * pre-joined paths, and already-encoded ids all classify identically.
 */
export function isMergedEvalId(value: string | string[] | undefined): boolean {
  const id = routeIdFromSegments(value)
  return id !== "" && !id.includes("%2F")
}

/**
 * Build the backend `%2F`-encoded route id form from a plain canonical
 * model id (`org/name`). Matches the producer's `route_id` /
 * `model_route_id` encoding (RFC 3986 percent-encoding of the whole id),
 * so the result can be fed straight into `routeIdToPath` for a URL path.
 *
 * This is the model-resolution-rework replacement for the old
 * client-side family-route computation (since removed): the
 * group/leaf id is now server-provided (`model_group_id`), and we only
 * need to encode it for routing — never re-derive it.
 */
export function routeIdFromModelId(id: string | null | undefined): string {
  if (!id) return ""
  return encodeURIComponent(id.trim())
}

/**
 * Title-case a benchmark / family / eval label that arrives in slug or
 * snake-case form. Example inputs and outputs:
 *   `gdm_intercode_ctf` → `GDM Intercode CTF`
 *   `vals ai gpqa`      → `Vals AI GPQA`
 *   `mmlu-pro`          → `MMLU-Pro`
 *
 * Common AI-eval acronyms are upper-cased; everything else is title-cased.
 * No-op when the input already looks like prose (any character has its
 * canonical case position — i.e. there's at least one upper-case letter
 * mid-word) so we don't mangle "MMLU-Pro" or "RewardBench Chat".
 */
const BENCHMARK_NAME_ACRONYMS = new Set([
  "ai", "ml", "llm", "llms", "nlp", "rl", "qa", "vqa", "vlm", "mt", "cv",
  "api", "cli", "sql", "io", "ui", "ux",
  "gpt", "ctf", "cve", "gdm", "mmlu", "gpqa", "bbh", "hle", "gsm8k", "aime",
  "ifeval", "ifbench", "humaneval", "mbpp", "gaia", "scicode", "agentharm",
  "csqa", "boolq", "openbookqa", "narrativeqa", "naturalquestions", "imdb",
  "piqa", "triviaqa", "truthfulqa", "musr", "math", "mgsm", "mmmu", "medqa",
  "legalbench", "bbq",
])

export function humanizeBenchmarkName(value: string | null | undefined): string {
  if (!value) return ""
  let s = value.trim()
  try { s = decodeURIComponent(s) } catch {}
  // Already prose? Any non-leading uppercase letter implies it's
  // already been display-formatted — leave it alone.
  if (/[a-z][A-Z]/.test(s)) return s
  return s
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase()
      if (BENCHMARK_NAME_ACRONYMS.has(lower)) return word.toUpperCase()
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    })
    .join(" ")
}

/**
 * Render an `evaluation_id` for human eyes.
 *
 * Backend evaluation_ids are RFC 3986 percent-encoded so they're safe
 * as URL path segments — `wasp%2Fjudgebench-coding` for the (composite,
 * benchmark) pair `wasp/judgebench-coding`. The encoded form is fine for
 * routes and React keys, but reads as nonsense in research-view labels.
 *
 * `humanizeEvaluationId` decodes the slug and falls back to the input
 * when decoding fails (malformed sequences, etc.) so it's always safe
 * to drop in at a render site.
 */
export function humanizeEvaluationId(value: string | null | undefined): string {
  if (!value) return ""
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Format an evaluation timestamp as `YYYY-MM-DD` for table cells.
 *
 * Accepts the two shapes the backend emits:
 *   - ISO date-time strings (`"2026-04-29T00:00:00Z"`)
 *   - Unix-epoch numerics as strings (`"1777496278.157"`)
 *
 * Returns `"Unknown"` when the value is missing or unparseable. Lossy
 * by design — the `Updated` column shows the date only, not time.
 *
 * Day-precision timestamps are interpreted in UTC (`toISOString()`)
 * rather than the local zone so a `2026-04-29T00:00:00Z` value renders
 * as `2026-04-29` everywhere instead of slipping to `2026-04-28` west of
 * UTC.
 */
export function formatDateISO(ts: string | null | undefined): string {
  if (!ts || !String(ts).trim()) return "Unknown"
  const raw = String(ts)
  const numeric = Number(raw)
  const parsed =
    !Number.isNaN(numeric) && !raw.includes("-")
      ? new Date(numeric * 1000)
      : new Date(raw)
  if (Number.isNaN(parsed.getTime())) return "Unknown"
  return parsed.toISOString().slice(0, 10)
}

/**
 * The Evaluations list scoped to one benchmark family, which is where the
 * app has always sent a family link (the home page's family cards). The
 * list resolves the key itself: a family with a single clean benchmark
 * redirects to that benchmark's page, and one with several seeds the
 * search box so the listing narrows to it.
 */
export function familyEvalsHref(familyKey: string): string {
  return `/evals?family=${encodeURIComponent(familyKey)}`
}
