"use client"

import {
  MODEL_OPENNESS_DESCRIPTIONS,
  MODEL_OPENNESS_LABELS,
  MODEL_OPENNESS_ORDER,
  type ModelOpenness,
} from "@/lib/model-openness"

interface OpennessFilterProps {
  /** Currently visible categories. */
  selected: readonly ModelOpenness[]
  onChange: (next: ModelOpenness[]) => void
  /** How many rows fall in each category, before this filter is applied —
   *  so the counts don't collapse to zero as you untick boxes. */
  counts?: Partial<Record<ModelOpenness, number>>
  /** Suppress a category that nothing in the current data falls into. */
  hideEmpty?: boolean
  headline?: string
  className?: string
}

/**
 * Three-way weights filter: open / closed / unknown.
 *
 * Deliberately three checkboxes rather than an open-vs-closed switch. The
 * producer only asserts a verdict where it has one, and "unknown" is the
 * largest bucket — a two-state control would have to fold it into one side or
 * the other, silently hiding or mislabelling roughly half the corpus. Each box
 * carries its count so the split is visible before anything is filtered.
 *
 * Matches the param-range picker's checkbox idiom: mono uppercase micro-label,
 * square box, `--fg-subtle` off / `--fg` on.
 */
export function OpennessFilter({
  selected,
  onChange,
  counts,
  hideEmpty = false,
  headline = "Weights",
  className,
}: OpennessFilterProps) {
  const categories = MODEL_OPENNESS_ORDER.filter(
    (c) => !hideEmpty || (counts?.[c] ?? 0) > 0
  )
  if (categories.length === 0) return null

  const toggle = (category: ModelOpenness) => {
    // Preserve the canonical order rather than selection order, so the
    // value is stable however the boxes were clicked.
    const next = selected.includes(category)
      ? selected.filter((c) => c !== category)
      : MODEL_OPENNESS_ORDER.filter((c) => c === category || selected.includes(c))
    onChange([...next])
  }

  const noneSelected = selected.length === 0

  return (
    <div className={`ow-filter${className ? ` ${className}` : ""}`}>
      <span className="ow-filter-headline">{headline}</span>
      <div className="ow-filter-options" role="group" aria-label="Filter by weights availability">
        {categories.map((category) => {
          const on = selected.includes(category)
          const count = counts?.[category]
          return (
            <button
              key={category}
              type="button"
              onClick={() => toggle(category)}
              className={`ow-toggle${on ? " on" : ""}`}
              aria-pressed={on}
              title={MODEL_OPENNESS_DESCRIPTIONS[category]}
            >
              <span className="ow-toggle-box" aria-hidden>
                {on ? "✓" : ""}
              </span>
              {MODEL_OPENNESS_LABELS[category]}
              {count != null && <span className="ow-toggle-count">{count.toLocaleString()}</span>}
            </button>
          )
        })}
      </div>
      {noneSelected && (
        <span className="ow-filter-empty" role="status">
          No categories selected — nothing to show.
        </span>
      )}
    </div>
  )
}
