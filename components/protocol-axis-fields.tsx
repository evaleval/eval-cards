"use client"

/**
 * Shared rendering for protocol-axis columns.
 *
 * A run's budget reads the same on the benchmark page, the merged page
 * and the leaderboard embed, because every surface renders through these
 * pieces and every value comes from lib/collections' one reader,
 * formatter and comparator. Layout chrome stays at the call site; what is
 * shared is the wording, the title, the sort affordance and the filter
 * identity.
 */

import Link from "next/link"

import {
  declaredKeysOf,
  formatProtocolValue,
  protocolColumnsForRow,
  protocolValueTitle,
  readProtocolAxis,
  type CollectionsSidecarEntry,
  type ProtocolAxisReading,
  type ProtocolColumn,
  type ProtocolFilterOption,
} from "@/lib/collections"
import { familyEvalsHref, routeIdToPath } from "@/lib/utils"

/** Column tooltip. Merged pages carry one headline protocol point per
 *  source and model, so they say so rather than implying the full grid. */
export function protocolHeaderTitle(column: ProtocolColumn, headlineOnly = false): string {
  const unit = column.unit ? ` (${column.unit})` : ""
  const scope = headlineOnly
    ? "the headline run's protocol for each source and model"
    : "the protocol setting each run used"
  return `Protocol axis "${column.key}"${unit}: ${scope}`
}

export function ProtocolSortButton({
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

/** One desktop cell. */
export function ProtocolValueText({
  reading,
  column,
  className,
  style,
}: {
  reading: ProtocolAxisReading
  column: ProtocolColumn
  className?: string
  style?: React.CSSProperties
}) {
  const missing = reading.state !== "value"
  return (
    <span
      className={className}
      title={protocolValueTitle(reading, column)}
      style={{ color: missing ? "var(--fg-subtle)" : "var(--fg)", ...style }}
    >
      {formatProtocolValue(reading, column)}
    </span>
  )
}

/**
 * The narrow-layout block. One labelled item per axis, because
 * "xhigh · 32k · on" leaves the reader guessing which number is which
 * budget. Axes that do not apply to the row are left out; an axis that
 * applies but was not reported says so.
 */
export function ProtocolNarrowItems({
  columns,
  readingFor,
}: {
  columns: ProtocolColumn[]
  readingFor: (column: ProtocolColumn) => ProtocolAxisReading
}) {
  const items = columns
    .map((column) => ({ column, reading: readingFor(column) }))
    .filter(({ reading }) => reading.state !== "not_applicable")
  if (items.length === 0) return null
  return (
    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5" style={{ fontSize: 10 }}>
      {items.map(({ column, reading }) => (
        <span key={column.key} style={{ color: "var(--fg-subtle)" }}>
          {column.label}:{" "}
          <span className="font-mono" title={protocolValueTitle(reading, column)}>
            {formatProtocolValue(reading, column)}
          </span>
        </span>
      ))}
    </div>
  )
}

/**
 * The setting one curated study's reported run was measured under.
 *
 * A model page carries a study's HEADLINE run per benchmark, which is one
 * point out of a grid the study reported at several budgets. The score
 * alone therefore says less than it looks like it does, so the run's own
 * settings sit with it, labelled and in the study's declared units, and
 * the full grid is one link away. Rows outside a curated study render
 * nothing extra.
 *
 * The study's name links to the listing of its own benchmarks, the same
 * way any family link in the app does, and stays plain text when the row
 * carries no family key to send the reader to.
 *
 * The generic `Max tokens` shown beside this is `generation_args.
 * max_tokens`, a different quantity, and is left exactly as it is.
 */
export function RunProtocolSummary({
  collectionId,
  protocolCondition,
  familyKey,
  evalSummaryId,
  collections,
}: {
  collectionId: string | null | undefined
  protocolCondition: string | null | undefined
  familyKey?: string | null
  evalSummaryId: string
  collections: Record<string, CollectionsSidecarEntry> | undefined
}) {
  const entry = collectionId ? collections?.[collectionId] : undefined
  if (!collectionId || !entry?.curated) return null
  const columns = protocolColumnsForRow(protocolCondition, entry.protocol_axes)
  if (columns.length === 0) return null
  // Every row here belongs to the study, so an axis the study declares
  // applies to it whether or not the row carries a value for it.
  const declaredKeys = declaredKeysOf(entry.protocol_axes)

  return (
    <div className="px-1 pb-2">
      <ProtocolNarrowItems
        columns={columns}
        readingFor={(column) => readProtocolAxis(protocolCondition, column, declaredKeys)}
      />
      <div
        className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono"
        style={{ fontSize: 10 }}
      >
        {evalSummaryId && (
          <Link
            href={`/evals/${routeIdToPath(evalSummaryId)}`}
            className="hover:text-[color:var(--accent)]"
            style={{ color: "var(--fg-muted)" }}
          >
            All protocol points →
          </Link>
        )}
        {familyKey ? (
          <Link
            href={familyEvalsHref(familyKey)}
            className="hover:text-[color:var(--accent)]"
            style={{ color: "var(--fg-subtle)" }}
          >
            {entry.display_name}
          </Link>
        ) : (
          <span style={{ color: "var(--fg-subtle)" }}>{entry.display_name}</span>
        )}
      </div>
    </div>
  )
}

/** Per-axis multi-select. Selecting nothing on an axis means "every
 *  value", which is what an untouched filter has to mean. */
export function ProtocolFilters({
  columns,
  optionsFor,
  selected,
  activeCount,
  onToggle,
  onClear,
}: {
  columns: ProtocolColumn[]
  optionsFor: (column: ProtocolColumn) => ProtocolFilterOption[]
  selected: ReadonlyMap<string, readonly string[]>
  activeCount: number
  onToggle: (axisKey: string, optionId: string) => void
  onClear: () => void
}) {
  const axes = columns
    .map((column) => ({ column, options: optionsFor(column) }))
    .filter(({ options }) => options.length > 1)
  if (axes.length === 0) return null

  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
      {axes.map(({ column, options }) => {
        const active = selected.get(column.key) ?? []
        return (
          <div key={column.key} className="flex flex-col gap-1">
            <span
              className="font-mono uppercase"
              style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
            >
              {column.label}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {options.map((option) => {
                const on = active.includes(option.id)
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={on}
                    title={option.title}
                    onClick={() => onToggle(column.key, option.id)}
                    className="font-mono"
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      border: `1px solid ${on ? "var(--accent)" : "var(--border-soft)"}`,
                      color: on ? "var(--accent)" : "var(--fg-muted)",
                      background: "transparent",
                      cursor: "pointer",
                    }}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
      {activeCount > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="font-mono uppercase self-end"
          style={{
            fontSize: 10,
            letterSpacing: "0.14em",
            color: "var(--fg-muted)",
            background: "transparent",
            border: 0,
            padding: "2px 0",
            cursor: "pointer",
          }}
        >
          Clear protocol filters
        </button>
      )}
    </div>
  )
}
