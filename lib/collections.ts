/**
 * Protocol-varied collections (notes/collection-benchmark-page-spec.md).
 *
 * Pure helpers shared by the server payload builder (lib/view-data) and
 * the client surfaces (eval-detail / score-distribution): protocol-
 * condition parsing, the R1 compute-axis selection rule, and the
 * compute-view mark builder. Client-safe: no server imports.
 *
 * Vocabulary follows the study's own: runs belong to a FEEDBACK
 * CONDITION ("no feedback" / "oracle score feedback"), never an "arm".
 */

export type FeedbackCondition = "none" | "answer_feedback" | "unknown"

export interface CollectionProtocolAxis {
  key: string
  type: string
  unit?: string | null
  values?: Array<string | null> | null
}

/** One entry of the snapshot's `collections.json` sidecar, keyed by
 *  `eval_results_view.collection_id` (NOT the composite slug). */
export interface CollectionsSidecarEntry {
  curated: boolean
  display_name: string
  kind?: string
  url?: string
  has_trajectories?: boolean
  /** Keyed by the study's own per-benchmark raw names (`benchmark_raw`),
   *  which need not match canonical benchmark ids. */
  outcome_type?: Record<string, string>
  protocol_axes?: CollectionProtocolAxis[]
  merge_raw_keys?: string[]
}

export interface CollectionComputeAxis {
  key: string
  /** Names the NOMINAL quantity ("token budget (limit)") — never tokens
   *  consumed; consumed-token curves are the trajectory panels' surface. */
  label: string
  unit?: string
}

/**
 * The eval-summary payload's optional `collection` attachment. Built
 * server-side for per-source pages whose rows belong to a CURATED
 * collection; the merged adapter never sets it, which is what keeps the
 * Compute view off merged summaries everywhere. Per-source embeds carry
 * the attachment and render the study surfaces deliberately.
 */
export interface CollectionAttachment {
  collection_id: string
  display_name: string
  url?: string
  curated: boolean
  kind?: string
  has_trajectories?: boolean
  /** This page's benchmark outcome type when resolvable from the sidecar
   *  map; absent when the map key doesn't match the canonical id. */
  outcome_type?: string
  protocol_axes?: CollectionProtocolAxis[]
  /** Server-computed R1 x-axis choice; null = no Compute view for this
   *  page by design (nothing numeric varies within a condition). */
  compute_axis: CollectionComputeAxis | null
  /** Scaffold-context strips for this (collection, benchmark), built from
   *  the `collection_context.json` sidecar. Null when the sidecar carries
   *  no entry for this pair — the Context view is then absent by design. */
  context?: ScaffoldContextPayload | null
}

export function parseProtocolCondition(
  raw: string | null | undefined,
): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** The comparability-bearing condition family. Unknown stays unknown —
 *  unparseable or missing feedback never gets promoted to a clean
 *  condition. */
export function feedbackConditionOf(raw: string | null | undefined): FeedbackCondition {
  const fields = parseProtocolCondition(raw)
  const feedback = fields?.feedback
  if (feedback === "none") return "none"
  if (feedback === "answer_feedback") return "answer_feedback"
  return "unknown"
}

// Preference order is the study's own: token_limit is the headline
// budget axis; reasoning_tokens is the fallback for pages where the
// budget never varies within a condition.
const COMPUTE_AXIS_CANDIDATES: CollectionComputeAxis[] = [
  { key: "token_limit", label: "token budget (limit)", unit: "tokens" },
  { key: "reasoning_tokens", label: "reasoning-token allowance", unit: "tokens" },
]

function axisValue(fields: Record<string, unknown>, key: string): number | null {
  const value = fields[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * One protocol axis surfaced as its own leaderboard column.
 *
 * A QUANTITATIVE axis is one whose descriptor declares a unit: the
 * reader cannot judge a run without the budget it ran under, so those
 * are shown whenever the page knows about them, constant or entirely
 * unreported. Categorical and boolean axes earn a column only by
 * varying, where the column is what tells two same-named rows apart.
 */
export interface ProtocolColumn {
  key: string
  /** Column header — the study's key, humanised. */
  label: string
  /** The axis type as the study declares it (`int`, `boolean`,
   *  `categorical`); "unknown" when only the rows know the key. */
  type: string
  unit?: string | null
  /** Declared value order for a categorical axis, when the study names one. */
  values?: Array<string | null> | null
  /** True when the descriptor declares a unit. */
  quantitative: boolean
}

/** Declared axes per collection id: the descriptor lookup a page whose
 *  rows span several collections (a merged benchmark page) needs to give
 *  a row's numbers their unit and to tell "not reported here" from "this
 *  axis is not part of that row's protocol". */
export type ProtocolAxesByCollection = Record<string, CollectionProtocolAxis[]>

/** A curated study the visible rows belong to. Attribution only: unlike
 *  {@link CollectionAttachment} it lights up no study chrome. */
export interface StudyRef {
  collection_id: string
  name: string
  url?: string
  /** The benchmark family the study's rows sit under, when they all sit
   *  under one. It is what makes the study's name a way back into the
   *  list of its benchmarks; absent when the rows span several families
   *  or the page carries no family key, and the name is then plain
   *  text rather than a link into the wrong listing. */
  family_key?: string
}

/** Feedback is already carried by the ASSISTED badge on the model cell,
 *  by the same badge in a folded row's run list, and by the folded row's
 *  count of the assisted runs beneath it. A column would say the same
 *  thing a fourth time, and say it loudest in the narrow layout, where
 *  every axis costs a line. */
const PROTOCOL_COLUMN_EXCLUDED = new Set(["feedback"])

const PROTOCOL_COLUMN_LABELS: Record<string, string> = {
  feedback: "Feedback",
  token_limit: "Token budget",
  reasoning_tokens: "Thinking tokens",
  reasoning_effort: "Effort",
  compaction: "Compaction",
  scaffold: "Scaffold",
}

function humaniseProtocolKey(key: string): string {
  const known = PROTOCOL_COLUMN_LABELS[key]
  if (known) return known
  const spaced = key.replace(/[_-]+/g, " ").trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** Distinct-value identity for one row's value of one axis. A missing
 *  key and an explicit null are the SAME reading ("the study did not set
 *  it here"), so they must not count as two values and conjure a column
 *  out of nothing. */
function protocolValueKey(value: unknown): string {
  return value == null ? "\u0000absent" : JSON.stringify(value)
}

/**
 * The columns a leaderboard needs to describe its protocol rows.
 *
 * Two rules, both driven by the descriptor and the data, never by a
 * benchmark id or an axis-name list:
 *
 *   - An axis with a declared unit is a budget the reader has to know to
 *     read the score at all, so it is shown whenever the collection
 *     declares it or a row carries it: constant, single-row, all-null,
 *     and no row carrying a condition at all included. A budget that
 *     vanishes reads as an axis that never applied, which is a different
 *     claim about the score.
 *   - A page that declares nothing and whose rows carry nothing gets no
 *     columns, which is every ordinary benchmark page.
 *   - Every other axis earns its column by varying across the page's
 *     rows. Nine rows reading "Claude Opus 4.6" are nine runs, and the
 *     varying axis is what tells them apart; an axis the study held
 *     constant explains nothing.
 *
 * `declaredAxes` is the collection sidecar's own axis list — it carries
 * the study's ordering, types and units. On a page whose rows span
 * several collections it is the union of their axes, in declared order.
 * Keys seen only in the rows are appended after it so a new axis still
 * surfaces, untyped, rather than silently disappearing.
 */
export function chooseProtocolColumns(
  protocolConditions: Array<string | null | undefined>,
  declaredAxes?: CollectionProtocolAxis[] | null,
): ProtocolColumn[] {
  const parsed = protocolConditions
    .map((raw) => parseProtocolCondition(raw))
    .filter((fields): fields is Record<string, unknown> => fields != null)

  const columns: ProtocolColumn[] = []
  for (const axis of orderedProtocolAxes(parsed, declaredAxes)) {
    if (PROTOCOL_COLUMN_EXCLUDED.has(axis.key)) continue
    const column = protocolColumnOf(axis)
    if (!column.quantitative) {
      const values = new Set(parsed.map((fields) => protocolValueKey(fields[axis.key])))
      if (values.size < 2) continue
    }
    columns.push(column)
  }
  return columns
}

/** The declared axes first, in the study's own order, then any key only
 *  the rows know about. */
function orderedProtocolAxes(
  parsed: Array<Record<string, unknown>>,
  declaredAxes?: CollectionProtocolAxis[] | null,
): CollectionProtocolAxis[] {
  const ordered: CollectionProtocolAxis[] = []
  const seen = new Set<string>()
  for (const axis of declaredAxes ?? []) {
    if (!axis?.key || seen.has(axis.key)) continue
    seen.add(axis.key)
    ordered.push({ ...axis, type: axis.type ?? "unknown" })
  }
  for (const fields of parsed) {
    for (const key of Object.keys(fields)) {
      if (seen.has(key)) continue
      seen.add(key)
      ordered.push({ key, type: "unknown" })
    }
  }
  return ordered
}

function protocolColumnOf(axis: CollectionProtocolAxis): ProtocolColumn {
  return {
    key: axis.key,
    label: humaniseProtocolKey(axis.key),
    type: axis.type ?? "unknown",
    unit: axis.unit ?? null,
    values: axis.values ?? null,
    quantitative: Boolean(axis.unit),
  }
}

/**
 * The axes ONE row can speak to, in declared order. The varying-axis rule
 * that shapes a leaderboard cannot apply here, because a single run
 * varies nothing; away from the leaderboard the reader still needs the
 * whole setting the score was measured under, so a constant budget is
 * exactly as load-bearing as a varied one.
 *
 * Every declared budget is listed, reported or not, because "the study
 * did not say" is itself part of how the score has to be read. The rest
 * of the axes are listed only when this run reports a value, which keeps
 * the group short enough to sit inline.
 */
export function protocolColumnsForRow(
  protocolCondition: string | null | undefined,
  declaredAxes?: CollectionProtocolAxis[] | null,
): ProtocolColumn[] {
  const fields = parseProtocolCondition(protocolCondition)
  const declaredKeys = declaredKeysOf(declaredAxes)
  const columns: ProtocolColumn[] = []
  for (const axis of orderedProtocolAxes(fields ? [fields] : [], declaredAxes)) {
    if (PROTOCOL_COLUMN_EXCLUDED.has(axis.key)) continue
    const column = protocolColumnOf(axis)
    if (column.quantitative) {
      columns.push(column)
      continue
    }
    if (readProtocolAxis(protocolCondition, column, declaredKeys).state !== "value") continue
    columns.push(column)
  }
  return columns
}

/** The key set a row's readings are judged against, so an axis the study
 *  declares reads "not reported" rather than "not applicable" when the
 *  row carries no protocol at all. */
export function declaredKeysOf(
  declaredAxes: CollectionProtocolAxis[] | null | undefined,
): ReadonlySet<string> {
  return new Set((declaredAxes ?? []).map((axis) => axis.key))
}

// ---------------------------------------------------------------------------
// One reading, one formatter. Every surface that shows a protocol value
// (benchmark page, merged page, embed) reads the raw typed value through
// `readProtocolAxis` and renders it through `formatProtocolValue`, so the
// same run never reads "50M" in one place and "50000000" in another.
// ---------------------------------------------------------------------------

/** Missing means one of two different things, and a reader has to be
 *  able to tell them apart: the axis applies to this run and the study
 *  did not report it, or the axis is not part of this run's protocol at
 *  all (a row from another source on a merged page). Neither ever means
 *  "no limit". */
export type ProtocolValueState = "value" | "not_reported" | "not_applicable"

export interface ProtocolAxisReading {
  state: ProtocolValueState
  /** The typed value sorting and filtering use, normalised to the
   *  descriptor's declared type but never to a display string. */
  raw: string | number | boolean | null
}

const NOT_REPORTED: ProtocolAxisReading = { state: "not_reported", raw: null }
const NOT_APPLICABLE: ProtocolAxisReading = { state: "not_applicable", raw: null }

/** Declared types that make an axis a quantity. A descriptor that names a
 *  unit is quantitative whatever it calls its type. */
const NUMERIC_AXIS_TYPES = new Set(["int", "integer", "number", "float", "double"])

function isNumericAxis(column: ProtocolColumn): boolean {
  return Boolean(column.unit) || NUMERIC_AXIS_TYPES.has((column.type ?? "").toLowerCase())
}

/**
 * Coerce one raw JSON value to the descriptor's declared type. A source
 * that writes its token budget as "6000000" must still sort below
 * 10000000 and still read as 6M, so a numeric axis parses numeric text.
 * A value that will not convert keeps its own type rather than becoming a
 * silent NaN.
 */
function normalizeAxisValue(
  value: unknown,
  column: ProtocolColumn,
): string | number | boolean | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (isNumericAxis(column)) {
      const parsed = Number(trimmed)
      if (Number.isFinite(parsed)) return parsed
    }
    return value
  }
  return value == null ? null : JSON.stringify(value)
}

/**
 * One row's reading of one axis.
 *
 * `declaredKeys` is the set of axis keys the ROW's own collection
 * declares. Pass null (the per-source default) when every column on the
 * page applies to every row; pass a per-row set on a mixed page, where a
 * row whose collection declares nothing about the axis reads "not
 * applicable" rather than pretending the study withheld a value.
 */
export function readProtocolAxis(
  protocolCondition: string | null | undefined,
  column: ProtocolColumn,
  declaredKeys?: ReadonlySet<string> | null,
): ProtocolAxisReading {
  const fields = parseProtocolCondition(protocolCondition)
  if (fields && Object.prototype.hasOwnProperty.call(fields, column.key)) {
    const raw = normalizeAxisValue(fields[column.key], column)
    return raw == null ? NOT_REPORTED : { state: "value", raw }
  }
  if (declaredKeys) return declaredKeys.has(column.key) ? NOT_REPORTED : NOT_APPLICABLE
  return fields ? NOT_REPORTED : NOT_APPLICABLE
}

/** SI decimal steps, smallest first, which is how the studies write their
 *  own round numbers. */
const COMPACT_UNITS: Array<[number, string]> = [
  [1, ""],
  [1_000, "k"],
  [1_000_000, "M"],
  [1_000_000_000, "B"],
]

/** Three significant digits: enough that 1,040,000 and 1,049,000 stay
 *  visibly different, few enough that a budget does not fill the cell. */
function toThreeSignificant(value: number): number {
  return Number(value.toPrecision(3))
}

/** 32000 -> "32k", 10000000 -> "10M", 1500 -> "1.5k", 999999 -> "1M". */
function formatCompactCount(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  const abs = Math.abs(value)
  let index = 0
  for (let i = COMPACT_UNITS.length - 1; i > 0; i -= 1) {
    if (abs >= COMPACT_UNITS[i][0]) {
      index = i
      break
    }
  }
  let scaled = toThreeSignificant(value / COMPACT_UNITS[index][0])
  // Rounding can push a value past its own unit: 999,999 divided by a
  // thousand rounds to 1000, which reads as "1000k" rather than "1M".
  while (Math.abs(scaled) >= 1000 && index < COMPACT_UNITS.length - 1) {
    index += 1
    scaled = toThreeSignificant(value / COMPACT_UNITS[index][0])
  }
  return `${scaled}${COMPACT_UNITS[index][1]}`
}

/** Spellings the studies use that read badly verbatim. Everything else is
 *  the study's own wording and is shown as written, so an unrelated value
 *  such as "xml" is never rewritten into something it does not say. */
const PROTOCOL_VALUE_LABELS: Record<string, string> = {
  xhigh: "X-high",
  xlow: "X-low",
  high: "High",
  medium: "Medium",
  low: "Low",
  minimal: "Minimal",
  none: "None",
  unknown: "Unknown",
  answer_feedback: "Answer feedback",
}

function labelCategorical(value: string): string {
  const trimmed = value.trim()
  return PROTOCOL_VALUE_LABELS[trimmed.toLowerCase()] ?? trimmed
}

/** The value alone, with no unit after it: what a list of several values
 *  repeats, so the unit can be said once at the end instead of after
 *  every number. */
function protocolValueBody(
  value: string | number | boolean | null,
  column: ProtocolColumn,
): string {
  if (typeof value === "boolean") return value ? "On" : "Off"
  if (typeof value === "number" && Number.isFinite(value)) {
    // A declared unit makes the number a magnitude worth compacting; a
    // bare number (a temperature, a seed) stays verbatim.
    return column.unit ? formatCompactCount(value) : String(value)
  }
  return labelCategorical(String(value))
}

/** What the cell shows. */
export function formatProtocolValue(
  reading: ProtocolAxisReading,
  column: ProtocolColumn,
): string {
  if (reading.state === "not_applicable") return "Not applicable"
  if (reading.state === "not_reported") return "Not reported"
  const value = reading.raw
  const body = protocolValueBody(value, column)
  return column.unit && typeof value === "number" && Number.isFinite(value)
    ? `${body} ${column.unit}`
    : body
}

/** What the cell's title carries: the exact value, unshortened. */
export function protocolValueTitle(
  reading: ProtocolAxisReading,
  column: ProtocolColumn,
): string {
  if (reading.state !== "value") return formatProtocolValue(reading, column)
  const value = reading.raw
  if (typeof value === "number" && Number.isFinite(value)) {
    const exact = value.toLocaleString("en-US", { maximumFractionDigits: 20 })
    return column.unit ? `${exact} ${column.unit}` : exact
  }
  return formatProtocolValue(reading, column)
}

/**
 * Typed comparison for one axis, direction applied. Numbers compare as
 * numbers (6M before 10M), booleans Off before On, categoricals by the
 * study's declared order and then locale. Missing readings sort LAST in
 * both directions, because flipping the direction must not make an
 * unreported budget masquerade as the smallest one. Returns 0 on a tie,
 * leaving the caller to apply its own stable tie-break.
 */
export function compareProtocolReadings(
  a: ProtocolAxisReading,
  b: ProtocolAxisReading,
  column: ProtocolColumn,
  dir: "asc" | "desc",
): number {
  const aMissing = a.state !== "value"
  const bMissing = b.state !== "value"
  if (aMissing && bMissing) return 0
  if (aMissing) return 1
  if (bMissing) return -1

  const sign = dir === "asc" ? 1 : -1
  const left = a.raw
  const right = b.raw
  if (typeof left === "number" && typeof right === "number") return (left - right) * sign
  if (typeof left === "boolean" && typeof right === "boolean") {
    return ((left ? 1 : 0) - (right ? 1 : 0)) * sign
  }
  const leftText = String(left)
  const rightText = String(right)
  const declared = (column.values ?? []).filter((value): value is string => value != null)
  if (declared.length > 0) {
    const leftIndex = declared.indexOf(leftText)
    const rightIndex = declared.indexOf(rightText)
    // Values the study never declared follow the declared ones rather
    // than landing at the front on an index of -1.
    const leftRank = leftIndex === -1 ? declared.length : leftIndex
    const rightRank = rightIndex === -1 ? declared.length : rightIndex
    if (leftRank !== rightRank) return (leftRank - rightRank) * sign
  }
  return leftText.localeCompare(rightText) * sign
}

/**
 * Filter identity for one reading, carrying the state and the primitive
 * type as well as the text. Without the tag an unreported budget and a
 * categorical whose value is literally "null" would be the same filter,
 * and a numeric 1 could not be told from the string "1". Filters and the
 * URL key on this, never on the formatted label.
 */
export function protocolValueId(reading: ProtocolAxisReading): string {
  if (reading.state === "not_applicable") return "missing:not_applicable"
  if (reading.state === "not_reported") return "missing:not_reported"
  const raw = reading.raw
  if (typeof raw === "number") return `number:${raw}`
  if (typeof raw === "boolean") return `boolean:${raw}`
  return `string:${String(raw)}`
}

/**
 * One axis across the several runs a folded leaderboard row stands for.
 *
 * A row standing for nine runs has no single token budget, so a
 * unit-bearing axis reads as the study's own smallest and largest value,
 * with the unit said once at the end. An axis with no magnitude has no
 * range to speak of, so it lists the settings the runs used instead.
 * Runs that did not report the axis are counted rather than dropped:
 * "some of these ran without a stated budget" is a different claim from
 * "they all ran at 6M". Returns null only when the axis applies to none
 * of the runs, which is the one case with nothing to say.
 */
export interface ProtocolAxisSummary {
  text: string
  /** The exact values behind the shortened text, as the per-run cells
   *  carry them. */
  title: string
}

export function summariseProtocolReadings(
  readings: ProtocolAxisReading[],
  column: ProtocolColumn,
): ProtocolAxisSummary | null {
  if (readings.length === 0) return null
  const values = readings.filter((reading) => reading.state === "value")
  const missing = readings.length - values.length
  if (values.length === 0) {
    return readings.every((reading) => reading.state === "not_applicable")
      ? null
      : { text: "Not reported", title: "Not reported" }
  }
  const distinct = new Map<string, ProtocolAxisReading>()
  for (const reading of values) {
    const id = protocolValueId(reading)
    if (!distinct.has(id)) distinct.set(id, reading)
  }
  const sorted = [...distinct.values()].sort((a, b) =>
    compareProtocolReadings(a, b, column, "asc"),
  )
  const low = sorted[0]
  const high = sorted[sorted.length - 1]
  let text: string
  let title: string
  if (sorted.length === 1) {
    text = formatProtocolValue(low, column)
    title = protocolValueTitle(low, column)
  } else if (isNumericAxis(column)) {
    text = `${protocolValueBody(low.raw, column)} to ${formatProtocolValue(high, column)}`
    title = `${protocolValueTitle(low, column)} to ${protocolValueTitle(high, column)}`
  } else {
    text = sorted.map((reading) => formatProtocolValue(reading, column)).join(", ")
    title = sorted.map((reading) => protocolValueTitle(reading, column)).join(", ")
  }
  if (missing > 0) {
    const tail = `${missing} of ${readings.length} runs did not report it`
    return { text: `${text}, some not reported`, title: `${title} (${tail})` }
  }
  return { text, title }
}

export interface ProtocolFilterOption {
  /** Typed raw identity, as it appears in `protocol.<axis>=<id>`. */
  id: string
  label: string
  /** The exact value, for the button's title: two budgets can round to
   *  the same short label and the reader still has to tell them apart. */
  title: string
}

/**
 * The distinct readings of one axis across a page's rows, in the same
 * order the column sorts ascending. Options are typed raw identities; the
 * label is presentation only.
 */
export function protocolFilterOptions(
  readings: ProtocolAxisReading[],
  column: ProtocolColumn,
): ProtocolFilterOption[] {
  const byId = new Map<string, ProtocolAxisReading>()
  for (const reading of readings) {
    const id = protocolValueId(reading)
    if (!byId.has(id)) byId.set(id, reading)
  }
  return Array.from(byId.entries())
    .sort(([, a], [, b]) => compareProtocolReadings(a, b, column, "asc"))
    .map(([id, reading]) => ({
      id,
      label: formatProtocolValue(reading, column),
      title: protocolValueTitle(reading, column),
    }))
}

/** The row fields the shared protocol comparator breaks ties on. */
export interface ProtocolSortableRow {
  protocol_condition?: string | null
  model_info?: { name?: string }
  model_route_id?: string
  /** Present on per-source rows; merged rows carry their source slug. */
  evaluation_id?: string
  merged_source_slug?: string
}

/**
 * One deterministic order for every protocol sort. Equal readings fall
 * through a fixed tuple (model name, route id, source identity, the
 * canonical protocol JSON, original position), so two runs of the same
 * model at the same budget cannot swap places because the producer
 * happened to serve them in a different order.
 */
export function compareProtocolRows<T extends ProtocolSortableRow>(
  a: { row: T; index: number },
  b: { row: T; index: number },
  column: ProtocolColumn,
  dir: "asc" | "desc",
  readingFor: (row: T, column: ProtocolColumn) => ProtocolAxisReading,
): number {
  const primary = compareProtocolReadings(
    readingFor(a.row, column),
    readingFor(b.row, column),
    column,
    dir,
  )
  if (primary !== 0) return primary
  const keys: Array<(row: T) => string> = [
    (row) => row.model_info?.name ?? "",
    (row) => row.model_route_id ?? "",
    (row) => row.evaluation_id ?? row.merged_source_slug ?? "",
    (row) => row.protocol_condition ?? "",
  ]
  for (const key of keys) {
    const cmp = key(a.row).localeCompare(key(b.row))
    if (cmp !== 0) return cmp
  }
  return a.index - b.index
}

/**
 * The declared protocol tuple of one row, ascending with nulls last: the
 * order a model's extra runs sit in beneath its headline reading, so two
 * equivalent pages present the same rows in the same order.
 */
export function compareProtocolTuples(
  a: string | null | undefined,
  b: string | null | undefined,
  columns: ProtocolColumn[],
): number {
  for (const column of columns) {
    const cmp = compareProtocolReadings(
      readProtocolAxis(a, column),
      readProtocolAxis(b, column),
      column,
      "asc",
    )
    if (cmp !== 0) return cmp
  }
  return (a ?? "").localeCompare(b ?? "")
}

/** The axis keys one collection declares, for the per-row applicability
 *  test on a page whose rows span several collections. */
export function declaredAxisKeys(
  axesByCollection: ProtocolAxesByCollection | null | undefined,
  collectionId: string | null | undefined,
): ReadonlySet<string> {
  const axes = collectionId ? axesByCollection?.[collectionId] : undefined
  return new Set((axes ?? []).map((axis) => axis.key))
}

/** The declared axes of several collections, deduped, in declared order:
 *  the descriptor list a mixed page builds its columns from. */
export function unionProtocolAxes(
  axesByCollection: ProtocolAxesByCollection | null | undefined,
): CollectionProtocolAxis[] {
  const out: CollectionProtocolAxis[] = []
  const seen = new Set<string>()
  for (const axes of Object.values(axesByCollection ?? {})) {
    for (const axis of axes ?? []) {
      if (!axis?.key || seen.has(axis.key)) continue
      seen.add(axis.key)
      out.push(axis)
    }
  }
  return out
}

/**
 * R1 per-page x-axis selection: the first candidate axis with >= 2
 * distinct numeric values WITHIN at least one feedback condition.
 * Cross-condition variation alone never qualifies — that would plot a
 * comparison the study says must be made at matched budgets. Returns
 * null when nothing numeric varies within a condition (the chip is then
 * absent by design).
 */
export function chooseComputeAxis(
  protocolConditions: Array<string | null | undefined>,
): CollectionComputeAxis | null {
  for (const candidate of COMPUTE_AXIS_CANDIDATES) {
    const valuesByCondition = new Map<FeedbackCondition, Set<number>>()
    for (const raw of protocolConditions) {
      const fields = parseProtocolCondition(raw)
      if (!fields) continue
      const value = axisValue(fields, candidate.key)
      if (value == null) continue
      const condition = feedbackConditionOf(raw)
      const values = valuesByCondition.get(condition) ?? new Set<number>()
      values.add(value)
      valuesByCondition.set(condition, values)
    }
    for (const values of valuesByCondition.values()) {
      if (values.size >= 2) return candidate
    }
  }
  return null
}

/**
 * Build the payload attachment from the sidecar entry. Curated entries
 * only — every ordinary leaderboard row also carries a collection_id,
 * and attaching those would light up study chrome on ordinary pages.
 * Returns null for uncurated or missing entries.
 */
export function buildCollectionAttachment(
  collectionId: string,
  entry: CollectionsSidecarEntry | undefined,
  benchmarkId: string | undefined,
  protocolConditions: Array<string | null | undefined>,
): CollectionAttachment | null {
  if (!entry?.curated) return null
  // outcome_type is keyed by the study's raw benchmark names; attach only
  // on a defensible match (exact, or exact after stripping separators) —
  // never guessed. The trajectory route re-resolves this precisely via
  // benchmark_raw.
  let outcomeType: string | undefined
  if (benchmarkId && entry.outcome_type) {
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "")
    outcomeType =
      entry.outcome_type[benchmarkId] ??
      Object.entries(entry.outcome_type).find(
        ([key]) => normalize(key) === normalize(benchmarkId),
      )?.[1]
  }
  return {
    collection_id: collectionId,
    display_name: entry.display_name,
    url: entry.url,
    curated: true,
    kind: entry.kind,
    has_trajectories: entry.has_trajectories,
    outcome_type: outcomeType,
    protocol_axes: entry.protocol_axes,
    compute_axis: chooseComputeAxis(protocolConditions),
  }
}

// ---------------------------------------------------------------------------
// Measurement context (finding I1): the collection's own published score for
// a model, placed among the community's published measurements of the same
// model on the same benchmark. Scaffold names, where a source records them,
// are point metadata — not the unit of the plot.
//
// The producer pre-joins EVERYTHING into `collection_context.json` — the
// external points are already matched to the collection's models on
// `model_aggregation_key`, already scale-converted, already restricted to
// the source's latest harvest, and the "no official entries" list is
// producer-computed. Nothing here joins across artifacts; a client-side
// join would mislabel a failed match as an absence.
// ---------------------------------------------------------------------------

/** One external measurement: a published run of this model under the
 *  reporting source's own setup, which the source mostly does not record.
 *  `scaffold` is present only where the source names one; `source` is the
 *  reporting composite's display name (absent on old-schema sidecars). */
export interface ScaffoldContextExternalEntry {
  scaffold: string | null
  source?: string | null
  score: number
  score_se?: number | null
  run_date?: string | null
}

/** A curated context source: a composite the external measurements come
 *  from. The producer resolves the display name, so the frontend never
 *  has to prettify an id. */
export interface ScaffoldContextSource {
  id: string
  display_name: string
}

/** One model's entry in the sidecar, keyed by `model_aggregation_key`. */
export interface ScaffoldContextSidecarModel {
  display_name: string
  score: number
  /** The study's published standard error for the plotted row. */
  score_se?: number | null
  n_tasks: number
  /** Recorded attempts per task, from the trajectory pool. */
  attempts_min: number
  attempts_max: number
  /** Copied VERBATIM from the fact rows by the producer — caption 3
   *  depends on byte equality with the page's own condition strings. */
  protocol_condition: string
  /** Legacy re-run band fields; still emitted, no longer rendered. */
  band_lo?: number
  band_hi?: number
  band_runs?: number
  band_method?: string
  band_seed?: number
  /** The fullest-coverage answer-feedback (assisted) cell, when it clears
   *  the same coverage gate as the main pick. Absent on old sidecars. */
  assisted?: {
    score: number
    score_se?: number | null
    n_tasks: number
    protocol_condition: string
  } | null
  external: ScaffoldContextExternalEntry[]
}

/** One (collection, benchmark) entry of `collection_context.json`. */
export interface ScaffoldContextEntry {
  harvested_at: string
  official_task_count: number
  context_sources: ScaffoldContextSource[]
  /** Producer-joined display names, in `context_sources` order — what
   *  caption 1 names as the origin of the external points. */
  context_source_display: string
  models_without_context: string[]
  /** Models shown in the view whose assisted cell was gated out (low task
   *  coverage), with that cell's coverage for the caption. Absent on old
   *  sidecars. */
  models_without_assisted?: Array<{ display_name: string; n_tasks: number | null }>
  models: Record<string, ScaffoldContextSidecarModel>
}

/** `collection_context.json`: collection_id → benchmark_key → entry. */
export type CollectionContextSidecar = Record<string, Record<string, ScaffoldContextEntry>>

export interface ScaffoldContextPoint {
  scaffold: string | null
  source?: string | null
  score: number
  scoreSe?: number | null
  runDate?: string | null
}

/** One horizontal strip: the model's published score (diamond) with its
 *  published-SE whisker, and the external measurement points (circles). */
export interface ScaffoldContextModel {
  /** `model_aggregation_key` — the dated↔undated bridge the producer
   *  joined on. Display-only here. */
  key: string
  displayName: string
  /** Published score of the fullest no-feedback condition. */
  score: number
  /** The study's published standard error for that row, if reported. */
  scoreSe: number | null
  nTasks: number
  /** Legacy re-run band; tolerated from old sidecars, never rendered. */
  bandLo?: number
  bandHi?: number
  bandRuns?: number
  /** Recorded attempts per task, from the trajectory pool. */
  attemptsMin: number
  attemptsMax: number
  /** The study's assisted (oracle answer feedback) companion cell — a
   *  second study mark on the strip. Null when gated out or on old
   *  sidecars. */
  assisted: {
    score: number
    scoreSe: number | null
    nTasks: number
    protocolCondition: string
  } | null
  points: ScaffoldContextPoint[]
  /** External points dropped by the >30 rule (0 in every shipped case). */
  hiddenCount: number
  /** Caption 3: this model is shown at its fullest-coverage condition,
   *  which is NOT the best-scoring no-feedback condition the ranked list
   *  above shows. Per-model — a global caption would be wrong for the
   *  single-condition models. */
  conditionDiffersFromBestScoring: boolean
}

export interface ScaffoldContextPayload {
  /** What the subject mark is called. The curated study payload leaves it
   *  unset and reads as "This study"; a cross-source payload built from
   *  ordinary rows says "This source", because it answers a different
   *  question — whether this source's number is an outlier, not what a
   *  budget did to it. */
  subjectLabel?: string | null
  /** Snapshot id of the harvest the external points come from. */
  harvestedAt: string
  officialTaskCount: number
  /** Curated context sources, verbatim from the sidecar. */
  contextSources: ScaffoldContextSource[]
  /** Producer-resolved display string for those sources (caption 1). */
  contextSourceDisplay: string
  /** Producer-computed: collection models with no external entry. */
  modelsWithoutContext: string[]
  /** Models on the plot whose assisted cell was gated out, with that
   *  cell's task coverage for the caption. */
  modelsWithoutAssisted: Array<{ displayName: string; nTasks: number | null }>

  /** Benchmark display name for the captions. */
  benchmarkLabel: string
  /** Collection display name for the captions. */
  collectionLabel: string
  models: ScaffoldContextModel[]
  /** Sum of `hiddenCount` — drives the "+N not shown" caption. */
  hiddenTotal: number
}

/** The summary fields the builder reads. Structural so this module stays
 *  client-safe and free of a payload-type import cycle. */
export interface ScaffoldContextSummaryInput {
  evaluation_name?: string
  canonical_display_name?: string
  collection?: { display_name?: string } | null
  model_results: Array<{
    score: number
    protocol_condition?: string | null
    /** The producer's pick of the model's summary reading, or the rule the
     *  view layer derives on a snapshot predating the column. */
    is_headline?: boolean | null
    model_route_id?: string
    model_group_id?: string
    model_info: { name?: string; id?: string }
  }>
}

/** Never truncate below this many external points per model (today's max
 *  is 10; the live board has 11). */
const CONTEXT_POINT_CAP = 30

/**
 * Rank-quantile thinning that ALWAYS keeps both extremes. Top-N-by-score
 * truncation would narrow the visible spread — the exact quantity the
 * finding is about. Returns the kept points in the producer's original
 * order plus the number dropped.
 */
export function thinContextPoints(
  points: ScaffoldContextPoint[],
): { points: ScaffoldContextPoint[]; hiddenCount: number } {
  if (points.length <= CONTEXT_POINT_CAP) return { points, hiddenCount: 0 }

  // Rank order (ties broken by original position) so the quantile spacing
  // is over ranks, not over the producer's emit order.
  const byRank = points
    .map((point, index) => ({ point, index }))
    .sort((a, b) => a.point.score - b.point.score || a.index - b.index)

  const last = byRank.length - 1
  const keptRanks = new Set<number>([0, last])
  // Interior slots: quantile positions across the rank axis, rounded and
  // deduped, then topped up from the unused ranks so the cap is always met.
  const interior = CONTEXT_POINT_CAP - 2
  for (let i = 1; i <= interior; i += 1) {
    keptRanks.add(Math.round((i / (interior + 1)) * last))
  }
  for (let rank = 0; rank <= last && keptRanks.size < CONTEXT_POINT_CAP; rank += 1) {
    keptRanks.add(rank)
  }

  const keptIndices = new Set(
    Array.from(keptRanks, (rank) => byRank[rank].index),
  )
  return {
    points: points.filter((_, index) => keptIndices.has(index)),
    hiddenCount: points.length - keptIndices.size,
  }
}

/** Identity candidates a page row can be addressed by. The sidecar keys on
 *  `model_aggregation_key`, which equals the page's `model_key` for the
 *  collection's own rows; the display name is the last resort. */
function rowIdentities(row: ScaffoldContextSummaryInput["model_results"][number]): string[] {
  const ids: string[] = []
  if (row.model_info?.id) ids.push(row.model_info.id)
  if (row.model_group_id) ids.push(row.model_group_id)
  if (row.model_route_id) {
    try {
      ids.push(decodeURIComponent(row.model_route_id))
    } catch {
      ids.push(row.model_route_id)
    }
  }
  return ids
}

/**
 * The `feedback == "none"` condition of the row the ranked list above the
 * plot shows — which is the model's HEADLINE row, the one the producer
 * picked as its summary reading and the only one it serves a rank.
 * Highest-scoring is the fallback for snapshots that mark no headline.
 * Caption 3 fires when the sidecar's condition (fullest coverage) is a
 * DIFFERENT string from this one.
 */
function rankedNoFeedbackCondition(
  summary: ScaffoldContextSummaryInput,
  key: string,
  displayName: string,
): string | null {
  const normalizedName = displayName.trim().toLowerCase()
  const headlines: string[] = []
  let best: { score: number; condition: string } | null = null
  for (const row of summary.model_results ?? []) {
    if (!Number.isFinite(row.score)) continue
    const condition = row.protocol_condition
    if (!condition) continue
    if (feedbackConditionOf(condition) !== "none") continue
    const matches =
      rowIdentities(row).includes(key) ||
      (row.model_info?.name ?? "").trim().toLowerCase() === normalizedName
    if (!matches) continue
    if (row.is_headline === true) headlines.push(condition)
    if (!best || row.score > best.score) best = { score: row.score, condition }
  }
  // Exactly one headline is the producer's pick. Several means the group
  // was never ranked, so no row is privileged, and the highest score is
  // then what the list shows.
  if (headlines.length === 1) return headlines[0]
  return best?.condition ?? null
}

/**
 * Build the Context view payload from one sidecar entry. Pure. Returns null
 * when the sidecar carries no entry for this (collection, benchmark) or the
 * entry has no models — the view is then absent by design, never an empty
 * plot.
 */
export function buildScaffoldContext(
  entry: ScaffoldContextEntry | null | undefined,
  summary: ScaffoldContextSummaryInput,
): ScaffoldContextPayload | null {
  if (!entry) return null
  const sidecarModels = Object.entries(entry.models ?? {})
  if (sidecarModels.length === 0) return null

  const models: ScaffoldContextModel[] = []
  for (const [key, model] of sidecarModels) {
    if (!model) continue
    if (!Number.isFinite(model.score)) continue
    const displayName = model.display_name?.trim() || key
    const external = (model.external ?? [])
      .filter((point) => Number.isFinite(point?.score))
      .map((point) => ({
        scaffold: point.scaffold ?? null,
        source: point.source ?? null,
        score: point.score,
        scoreSe: point.score_se ?? null,
        runDate: point.run_date ?? null,
      }))
    const { points, hiddenCount } = thinContextPoints(external)
    const rankedCondition = rankedNoFeedbackCondition(summary, key, displayName)
    models.push({
      key,
      displayName,
      score: model.score,
      scoreSe: model.score_se ?? null,
      nTasks: model.n_tasks,
      bandLo: model.band_lo,
      bandHi: model.band_hi,
      bandRuns: model.band_runs,
      attemptsMin: model.attempts_min,
      attemptsMax: model.attempts_max,
      assisted:
        model.assisted && Number.isFinite(model.assisted.score)
          ? {
              score: model.assisted.score,
              scoreSe: model.assisted.score_se ?? null,
              nTasks: model.assisted.n_tasks,
              protocolCondition: model.assisted.protocol_condition,
            }
          : null,
      points,
      hiddenCount,
      // String equality on the verbatim producer-copied condition. A
      // missing page row can never fire the caption — we would be
      // asserting a difference we cannot see.
      conditionDiffersFromBestScoring:
        rankedCondition != null && rankedCondition !== model.protocol_condition,
    })
  }
  if (models.length === 0) return null

  return {
    harvestedAt: entry.harvested_at,
    officialTaskCount: entry.official_task_count,
    contextSources: entry.context_sources ?? [],
    contextSourceDisplay: entry.context_source_display,
    modelsWithoutContext: entry.models_without_context ?? [],
    modelsWithoutAssisted: (entry.models_without_assisted ?? []).map((m) => ({
      displayName: m.display_name,
      nTasks: m.n_tasks ?? null,
    })),
    benchmarkLabel:
      summary.canonical_display_name?.trim() || summary.evaluation_name?.trim() || "this benchmark",
    collectionLabel: summary.collection?.display_name?.trim() || "This study",
    models,
    hiddenTotal: models.reduce((acc, model) => acc + model.hiddenCount, 0),
  }
}
