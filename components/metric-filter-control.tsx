"use client"

import * as Popover from "@radix-ui/react-popover"
import { Check, ChevronDown, Search, X } from "lucide-react"
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react"

export interface MetricFilterItem {
  key: string
  label: string
  count: number
  direction?: "higher" | "lower" | "mixed" | null
  badge?: string | null
  isDefault?: boolean
}

export interface MetricFilterControlProps {
  label?: string
  items: readonly MetricFilterItem[]
  /** Active metric key; null selects `defaultItem` when provided. */
  value: string | null
  onChange: (nextKey: string | null) => void
  /** Optional pinned top entry representing the unfiltered lead-metric view. */
  defaultItem?: {
    label: string
    chipLabel?: string
    sublabel?: string
    count: number
  }
  countNoun?: { singular: string; plural: string }
  searchPlaceholder?: string
  variant?: "dropdown" | "chips"
  hideClearButton?: boolean
  className?: string
}

export interface MetricFilterBarProps
  extends Omit<MetricFilterControlProps, "variant" | "hideClearButton"> {
  statusText?: string | null
  dataEvalBar?: boolean
  /** True while a newly clicked server-backed metric is still loading in place. */
  isPending?: boolean
}

const DEFAULT_OPTION_KEY = "__default__"
const DROPDOWN_SEARCH_THRESHOLD = 8
const CHIPS_SEARCH_THRESHOLD = 6

function directionGlyph(direction: MetricFilterItem["direction"]): string | null {
  if (direction === "higher") return "↑"
  if (direction === "lower") return "↓"
  return null
}

/**
 * Editorial hairline metric filter control supporting both compact dropdown mode
 * and Option 2A Quick-Chips + `More (+N)` searchable overflow mode.
 *
 * Uses dedicated `data-metric-*` attributes and avoids `.ec-pill` /
 * `select.ec-select` so generic pill/select iterators in view-slice tests do
 * not accidentally mutate page-level metric state.
 */
export function MetricFilterControl({
  label = "Metric",
  items,
  value,
  onChange,
  defaultItem,
  countNoun = { singular: "benchmark", plural: "benchmarks" },
  searchPlaceholder = "Filter metrics…",
  variant = "dropdown",
  hideClearButton = false,
  className = "",
}: MetricFilterControlProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listboxId = useId()

  const totalOptionsCount = items.length + (defaultItem ? 1 : 0)
  const showSearch =
    variant === "chips"
      ? totalOptionsCount >= CHIPS_SEARCH_THRESHOLD
      : totalOptionsCount >= DROPDOWN_SEARCH_THRESHOLD

  const activeItem = useMemo(
    () => (value != null ? items.find((item) => item.key === value) ?? null : null),
    [items, value],
  )

  const defaultOptionItem = useMemo(
    () => items.find((item) => item.isDefault) ?? null,
    [items],
  )

  const isFilteredNonDefault = defaultItem
    ? activeItem != null
    : Boolean(activeItem && !activeItem.isDefault && defaultOptionItem)

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.key.toLowerCase().includes(q) ||
        (item.badge && item.badge.toLowerCase().includes(q)),
    )
  }, [items, query])

  const includeDefaultInList = useMemo(() => {
    if (!defaultItem) return false
    const q = query.trim().toLowerCase()
    if (!q) return true
    return (
      defaultItem.label.toLowerCase().includes(q) ||
      (defaultItem.chipLabel?.toLowerCase().includes(q) ?? false) ||
      (defaultItem.sublabel?.toLowerCase().includes(q) ?? false)
    )
  }, [defaultItem, query])

  const navigableKeys = useMemo(() => {
    const keys: string[] = []
    if (includeDefaultInList) keys.push(DEFAULT_OPTION_KEY)
    for (const item of filteredItems) keys.push(item.key)
    return keys
  }, [filteredItems, includeDefaultInList])

  useEffect(() => {
    if (!open) {
      setQuery("")
      return
    }
    const currentKey = activeItem?.key ?? (defaultItem ? DEFAULT_OPTION_KEY : items[0]?.key ?? "")
    const idx = navigableKeys.indexOf(currentKey)
    setHighlightedIndex(idx >= 0 ? idx : 0)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setHighlightedIndex((prev) =>
      navigableKeys.length === 0 ? 0 : Math.min(prev, navigableKeys.length - 1),
    )
  }, [navigableKeys.length])

  if (items.length <= 1 && !isFilteredNonDefault) return null

  const selectKey = (key: string) => {
    if (key === DEFAULT_OPTION_KEY) {
      onChange(null)
    } else if (!defaultItem && defaultOptionItem && key === defaultOptionItem.key) {
      onChange(null)
    } else {
      onChange(key)
    }
    setOpen(false)
  }

  const handleClear = () => {
    onChange(null)
    setOpen(false)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      if (navigableKeys.length > 0) {
        setHighlightedIndex((prev) => (prev + 1) % navigableKeys.length)
      }
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      if (navigableKeys.length > 0) {
        setHighlightedIndex((prev) => (prev - 1 + navigableKeys.length) % navigableKeys.length)
      }
      return
    }
    if (event.key === "Enter") {
      const target = navigableKeys[highlightedIndex]
      if (target) {
        event.preventDefault()
        selectKey(target)
      }
      return
    }
    if (event.key === "Escape") {
      setOpen(false)
    }
  }

  const popoverPortal = (
    <Popover.Portal>
      <Popover.Content
        align="start"
        sideOffset={6}
        onOpenAutoFocus={(event) => {
          if (showSearch && inputRef.current) {
            event.preventDefault()
            inputRef.current.focus()
          }
        }}
        onKeyDown={handleKeyDown}
        data-metric-filter-popover=""
        className="z-50 w-[min(22rem,calc(100vw-2rem))] overflow-hidden"
        style={{
          border: "1px solid var(--fg)",
          background: "var(--bg)",
          boxShadow: "0 8px 24px rgba(0, 0, 0, 0.12)",
        }}
      >
        {showSearch && (
          <div
            className="relative flex items-center px-3 py-2"
            style={{ borderBottom: "1px solid var(--border-soft)" }}
          >
            <Search
              className="h-3.5 w-3.5 shrink-0 mr-2"
              style={{ color: "var(--fg-subtle)" }}
              aria-hidden
            />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded={open}
              aria-controls={listboxId}
              aria-activedescendant={
                navigableKeys[highlightedIndex]
                  ? `${listboxId}-opt-${navigableKeys[highlightedIndex]}`
                  : undefined
              }
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setHighlightedIndex(0)
              }}
              placeholder={searchPlaceholder}
              data-metric-filter-search=""
              className="w-full bg-transparent text-[12px] outline-none"
              style={{ color: "var(--fg)" }}
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("")
                  inputRef.current?.focus()
                }}
                aria-label="Clear metric search"
                className="ml-1 inline-flex h-4 w-4 items-center justify-center"
                style={{ color: "var(--fg-muted)" }}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        )}

        <div
          id={listboxId}
          role="listbox"
          aria-label={`${label} options`}
          className="max-h-72 overflow-y-auto py-1"
        >
          {includeDefaultInList && defaultItem && (() => {
            const isSelected = activeItem == null
            const isHighlighted = navigableKeys[highlightedIndex] === DEFAULT_OPTION_KEY
            const noun =
              defaultItem.count === 1 ? countNoun.singular : countNoun.plural
            return (
              <button
                key={DEFAULT_OPTION_KEY}
                id={`${listboxId}-opt-${DEFAULT_OPTION_KEY}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-metric-option={DEFAULT_OPTION_KEY}
                onMouseEnter={() => setHighlightedIndex(0)}
                onClick={() => selectKey(DEFAULT_OPTION_KEY)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors"
                style={{
                  background: isHighlighted ? "var(--bg-warm)" : "transparent",
                  borderBottom: "1px solid var(--border-soft)",
                  cursor: "pointer",
                }}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {isSelected && (
                      <Check className="h-3.5 w-3.5" style={{ color: "var(--accent)" }} />
                    )}
                  </span>
                  <div className="min-w-0">
                    <div
                      className="truncate text-[12.5px]"
                      style={{
                        fontWeight: isSelected ? 600 : 500,
                        color: "var(--fg)",
                      }}
                    >
                      {defaultItem.label}
                    </div>
                    {defaultItem.sublabel && (
                      <div
                        className="font-mono text-[10px] uppercase tracking-[0.1em]"
                        style={{ color: "var(--fg-subtle)" }}
                      >
                        {defaultItem.sublabel}
                      </div>
                    )}
                  </div>
                </div>
                <span
                  className="font-mono text-[11px] tabular-nums shrink-0"
                  style={{ color: "var(--fg-muted)" }}
                >
                  {defaultItem.count} {noun}
                </span>
              </button>
            )
          })()}

          {filteredItems.map((item) => {
            const isSelected = activeItem
              ? activeItem.key === item.key
              : Boolean(!defaultItem && item.isDefault)
            const navIdx = navigableKeys.indexOf(item.key)
            const isHighlighted = navIdx >= 0 && navIdx === highlightedIndex
            const glyph = directionGlyph(item.direction)
            const noun = item.count === 1 ? countNoun.singular : countNoun.plural

            return (
              <button
                key={item.key}
                id={`${listboxId}-opt-${item.key}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-metric-option={item.key}
                onMouseEnter={() => {
                  if (navIdx >= 0) setHighlightedIndex(navIdx)
                }}
                onClick={() => selectKey(item.key)}
                className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left transition-colors"
                style={{
                  background: isHighlighted ? "var(--bg-warm)" : "transparent",
                  cursor: "pointer",
                }}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {isSelected && (
                      <Check className="h-3.5 w-3.5" style={{ color: "var(--accent)" }} />
                    )}
                  </span>
                  <span
                    className="truncate text-[12.5px]"
                    style={{
                      fontWeight: isSelected ? 600 : 400,
                      color: "var(--fg)",
                    }}
                  >
                    {item.label}
                  </span>
                  {glyph && (
                    <span
                      className="font-mono text-[10.5px] shrink-0"
                      style={{ color: "var(--fg-muted)" }}
                      aria-hidden
                    >
                      {glyph}
                    </span>
                  )}
                  {item.badge && (
                    <span
                      className="font-mono uppercase px-1 py-px shrink-0"
                      style={{
                        fontSize: 9,
                        letterSpacing: "0.1em",
                        border: "1px solid var(--border-soft)",
                        color: "var(--accent)",
                        background: "var(--bg)",
                      }}
                    >
                      {item.badge}
                    </span>
                  )}
                </div>
                <span
                  className="font-mono text-[11px] tabular-nums shrink-0"
                  style={{ color: "var(--fg-muted)" }}
                >
                  {item.count} {noun}
                </span>
              </button>
            )
          })}

          {navigableKeys.length === 0 && (
            <div
              className="px-3 py-6 text-center font-mono text-[11px]"
              style={{ color: "var(--fg-muted)" }}
            >
              No metrics match &ldquo;{query}&rdquo;
            </div>
          )}
        </div>
      </Popover.Content>
    </Popover.Portal>
  )

  if (variant === "chips") {
    const baseInlineLimit = 4
    const inlineLimit = items.length <= baseInlineLimit + 1 ? items.length : baseInlineLimit
    const inlineItems = items.slice(0, inlineLimit)
    const overflowCount = Math.max(0, items.length - inlineItems.length)
    const activeOverflowItem =
      activeItem && !inlineItems.some((item) => item.key === activeItem.key)
        ? activeItem
        : null

    const chipStyle = (selected: boolean) => ({
      border: `1px solid ${selected ? "var(--fg)" : "var(--border-strong)"}`,
      background: selected ? "var(--fg)" : "var(--bg)",
      color: selected ? "var(--bg)" : "var(--fg)",
      fontSize: 11.5,
      letterSpacing: "0.02em",
      lineHeight: 1.25,
      fontWeight: selected ? 600 : 400,
      cursor: "pointer" as const,
    })

    return (
      <div
        className={`flex flex-wrap items-center gap-1.5 ${className}`.trim()}
        data-metric-filter=""
      >
        <span
          className="font-mono uppercase shrink-0 mr-1.5"
          style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.14em", color: "var(--fg)" }}
        >
          {label}
        </span>

        {defaultItem && (() => {
          const isSelected = activeItem == null
          return (
            <button
              type="button"
              data-metric-chip={DEFAULT_OPTION_KEY}
              aria-pressed={isSelected}
              onClick={() => selectKey(DEFAULT_OPTION_KEY)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 font-mono transition-colors hover:border-[color:var(--fg)]"
              style={chipStyle(isSelected)}
            >
              <span>{defaultItem.chipLabel ?? defaultItem.label}</span>
              <span className="tabular-nums" style={{ opacity: isSelected ? 0.85 : 0.65, fontSize: 10.5 }}>
                · {defaultItem.count}
              </span>
            </button>
          )
        })()}

        {inlineItems.map((item) => {
          const isSelected = activeItem
            ? activeItem.key === item.key
            : Boolean(!defaultItem && item.isDefault)
          return (
            <button
              key={item.key}
              type="button"
              data-metric-chip={item.key}
              aria-pressed={isSelected}
              onClick={() => selectKey(item.key)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 font-mono transition-colors hover:border-[color:var(--fg)]"
              style={chipStyle(isSelected)}
            >
              <span className="truncate" style={{ maxWidth: "15rem" }}>
                {item.label}
                {!defaultItem && item.isDefault ? " ★" : ""}
              </span>
              <span className="tabular-nums shrink-0" style={{ opacity: isSelected ? 0.85 : 0.65, fontSize: 10.5 }}>
                · {item.count}
              </span>
            </button>
          )
        })}

        {activeOverflowItem && (
          <button
            type="button"
            data-metric-chip={activeOverflowItem.key}
            data-metric-chip-overflow=""
            aria-pressed={true}
            onClick={handleClear}
            title={defaultItem ? "Click to reset to main metric" : "Click to reset to primary metric"}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 font-mono transition-colors"
            style={chipStyle(true)}
          >
            <span className="truncate" style={{ maxWidth: "15rem" }}>
              {activeOverflowItem.label}
            </span>
            <span className="tabular-nums shrink-0" style={{ opacity: 0.85, fontSize: 10.5 }}>
              · {activeOverflowItem.count}
            </span>
            <X className="h-3 w-3 shrink-0" style={{ opacity: 0.85 }} aria-hidden />
          </button>
        )}

        {overflowCount > 0 && (
          <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>
              <button
                type="button"
                data-metric-filter-trigger=""
                aria-label={`More ${label.toLowerCase()} options (+${overflowCount})`}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 font-mono transition-colors hover:border-[color:var(--accent)]"
                style={{
                  border: `1px solid ${activeOverflowItem ? "var(--accent)" : "var(--border-strong)"}`,
                  background: "var(--bg)",
                  color: "var(--fg)",
                  fontSize: 11.5,
                  fontWeight: 500,
                  lineHeight: 1.25,
                  cursor: "pointer",
                }}
              >
                <span>More (+{overflowCount})</span>
                <ChevronDown
                  className="h-3.5 w-3.5 shrink-0 transition-transform"
                  style={{
                    color: "var(--fg-muted)",
                    transform: open ? "rotate(180deg)" : "rotate(0deg)",
                  }}
                  aria-hidden
                />
              </button>
            </Popover.Trigger>
            {popoverPortal}
          </Popover.Root>
        )}

        {!hideClearButton && isFilteredNonDefault && (
          <button
            type="button"
            onClick={handleClear}
            data-metric-filter-clear=""
            aria-label={defaultItem ? "Reset to main metric" : "Reset to primary metric"}
            title={defaultItem ? "Reset to main metric" : "Reset to primary metric"}
            className="inline-flex items-center gap-1 px-2 py-1 font-mono uppercase transition-colors hover:bg-[color:var(--accent)] hover:text-[color:var(--bg)]"
            style={{
              fontSize: 10,
              letterSpacing: "0.1em",
              border: "1px solid var(--accent)",
              background: "var(--bg-warm)",
              color: "var(--accent)",
              lineHeight: 1.2,
              cursor: "pointer",
            }}
          >
            Reset <X className="h-2.5 w-2.5" aria-hidden />
          </button>
        )}
      </div>
    )
  }

  const triggerLabel = activeItem
    ? activeItem.label
    : defaultItem
      ? defaultItem.label
      : (defaultOptionItem?.label ?? items[0]?.label ?? "Metric")
  const triggerCount = activeItem
    ? activeItem.count
    : defaultItem
      ? defaultItem.count
      : (defaultOptionItem?.count ?? items[0]?.count ?? 0)
  const triggerGlyph = activeItem ? directionGlyph(activeItem.direction) : null
  const borderColor = isFilteredNonDefault ? "var(--accent)" : "var(--border-strong)"

  return (
    <div
      className={`inline-flex items-stretch ${className}`.trim()}
      data-metric-filter=""
    >
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            data-metric-filter-trigger=""
            aria-label={`Filter by ${label.toLowerCase()}: ${triggerLabel}`}
            className="inline-flex items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-[color:var(--bg-warm)]"
            style={{
              border: `1px solid ${borderColor}`,
              background: isFilteredNonDefault ? "var(--bg-warm)" : "var(--bg)",
              color: "var(--fg)",
              fontSize: 12,
              lineHeight: 1.2,
              cursor: "pointer",
            }}
          >
            <span
              className="font-mono uppercase shrink-0"
              style={{
                fontSize: 10,
                letterSpacing: "0.14em",
                color: isFilteredNonDefault ? "var(--accent)" : "var(--fg-subtle)",
              }}
            >
              {label}
            </span>
            <span
              className="font-medium truncate"
              style={{ maxWidth: "15rem", color: "var(--fg)" }}
            >
              {triggerLabel}
            </span>
            {triggerGlyph && (
              <span
                className="font-mono shrink-0"
                style={{ fontSize: 11, color: "var(--accent)", fontWeight: 600 }}
                aria-hidden
              >
                {triggerGlyph}
              </span>
            )}
            <span
              className="font-mono tabular-nums shrink-0"
              style={{ fontSize: 11, color: "var(--fg-muted)" }}
            >
              ({triggerCount})
            </span>
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 transition-transform"
              style={{
                color: "var(--fg-muted)",
                transform: open ? "rotate(180deg)" : "rotate(0deg)",
              }}
              aria-hidden
            />
          </button>
        </Popover.Trigger>

        {popoverPortal}
      </Popover.Root>

      {!hideClearButton && isFilteredNonDefault && (
        <button
          type="button"
          onClick={handleClear}
          data-metric-filter-clear=""
          aria-label={defaultItem ? "Reset to main metric" : "Reset to primary metric"}
          title={defaultItem ? "Reset to main metric" : "Reset to primary metric"}
          className="inline-flex items-center justify-center px-2 transition-colors hover:bg-[color:var(--accent)] hover:text-[color:var(--bg)]"
          style={{
            borderTop: "1px solid var(--accent)",
            borderRight: "1px solid var(--accent)",
            borderBottom: "1px solid var(--accent)",
            borderLeft: "none",
            background: "var(--bg-warm)",
            color: "var(--accent)",
            cursor: "pointer",
          }}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}

/**
 * Shared Quick-Chips + `More (+N)` metric bar (Option 2A) rendered directly in
 * `§4 Reported metrics` on Model View (`/models/...`) and in the Leaderboard
 * section on Benchmark Views (`/evals/...`).
 */
export function MetricFilterBar({
  statusText,
  dataEvalBar = false,
  isPending = false,
  className = "",
  ...controlProps
}: MetricFilterBarProps) {
  const { items, value, defaultItem, onChange } = controlProps
  const activeItem = value != null ? items.find((item) => item.key === value) ?? null : null
  const defaultOptionItem = items.find((item) => item.isDefault) ?? null
  const isFilteredNonDefault = defaultItem
    ? activeItem != null
    : Boolean(activeItem && !activeItem.isDefault && defaultOptionItem)

  if (items.length <= 1 && !isFilteredNonDefault) return null

  return (
    <div
      data-metric-filter-bar=""
      aria-busy={isPending || undefined}
      {...(dataEvalBar ? { "data-eval-metric-bar": "" } : {})}
      className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 px-3.5 py-3 ${className}`.trim()}
      style={{
        borderTop: "1px solid var(--border-strong)",
        borderRight: "1px solid var(--border-strong)",
        borderBottom: "1px solid var(--border-strong)",
        borderLeft: "3px solid var(--accent)",
        background: "var(--bg-subtle)",
      }}
    >
      <MetricFilterControl {...controlProps} variant="chips" hideClearButton />

      <div
        className="flex flex-wrap items-center gap-2.5 font-mono text-[11px]"
        style={{ color: "var(--fg-muted)" }}
      >
        {isPending && (
          <span
            data-metric-filter-pending=""
            className="uppercase tracking-[0.1em]"
            style={{ fontSize: 10, color: "var(--accent)" }}
          >
            Updating…
          </span>
        )}
        {statusText && <span>{statusText}</span>}
        {isFilteredNonDefault && (
          <button
            type="button"
            onClick={() => onChange(null)}
            data-metric-filter-clear=""
            aria-label={defaultItem ? "Reset to main metric" : "Reset to primary metric"}
            title={defaultItem ? "Reset to main metric" : "Reset to primary metric"}
            className="inline-flex items-center gap-1 px-2 py-0.5 font-mono uppercase transition-colors hover:bg-[color:var(--fg)] hover:text-[color:var(--bg)]"
            style={{
              fontSize: 10,
              letterSpacing: "0.1em",
              border: "1px solid var(--accent)",
              background: "var(--bg)",
              color: "var(--fg)",
              cursor: "pointer",
            }}
          >
            Reset <X className="h-2.5 w-2.5" aria-hidden />
          </button>
        )}
      </div>
    </div>
  )
}
