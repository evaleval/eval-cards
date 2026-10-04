"use client"

// Shared data hook + source picker for the /embed/eval/* pages.
//
// Per-source (two-segment) embed ids behave exactly as before: one
// fetch, no picker. Merged (single-segment) ids default to the MERGED
// all-sources data and expose a compact "Source" selector so a viewer —
// or an embedder, via ?source=<composite_slug> — can pin one source's
// instantiation of the benchmark instead. Selecting a source swaps the
// embed's data to that source's per-source summary without navigating.

import { useEffect, useMemo, useState } from "react"

import { fetchEvalSummary, fetchMergedBenchmarkSummary } from "@/lib/dashboard-data-client"
import {
  isMergedBenchmarkSummary,
  mergedSummaryToEvalSummary,
  scaleHarmonizedNotes,
} from "@/lib/merged-adapter"
import { isMergedEvalId } from "@/lib/utils"
import type { BenchmarkEvalSummary, MergedBenchmarkSummary } from "@/lib/eval-processing"

export interface EmbedSourceOption {
  /** Composite slug — the ?source= value. */
  slug: string
  label: string
  /** Two-segment per-source evaluation_id to fetch when selected. */
  evaluationId: string
}

export function useEmbedEvalSummary(
  evalId: string,
  opts: { metricParam?: string | null; sourceParam?: string | null } = {},
): {
  summary: BenchmarkEvalSummary | null
  error: string | null
  /** Non-null only for merged ids with at least one linkable source. */
  sources: EmbedSourceOption[] | null
  /** "" = merged (default). */
  activeSource: string
  setActiveSource: (slug: string) => void
  /** Merged data only: which sources' scores were rescaled, and how. */
  scaleNotes: string[]
} {
  const isMerged = isMergedEvalId(evalId)
  const metricId = opts.metricParam?.trim() || undefined

  // `base` = the embed's default data: the adapted merged summary for
  // merged ids, or the plain per-source summary otherwise.
  const [base, setBase] = useState<BenchmarkEvalSummary | null>(null)
  const [mergedRaw, setMergedRaw] = useState<MergedBenchmarkSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeSource, setActiveSource] = useState<string>(
    () => opts.sourceParam?.trim() ?? "",
  )
  const [sourceSummary, setSourceSummary] = useState<BenchmarkEvalSummary | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!isMerged) {
      fetchEvalSummary(evalId)
        .then((s) => {
          if (cancelled) return
          setBase(s)
          setError(null)
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        })
      return () => {
        cancelled = true
      }
    }
    fetchMergedBenchmarkSummary(evalId, { metricId })
      .then((payload) => {
        if (cancelled) return
        if (isMergedBenchmarkSummary(payload)) {
          setMergedRaw(payload)
          setBase(mergedSummaryToEvalSummary(payload))
          setError(null)
        } else if (payload && !("error" in payload)) {
          // Pre-merged-view snapshot: the API answered with a plain summary.
          setBase(payload)
          setError(null)
        } else {
          setError("Evaluation not found")
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [evalId, isMerged, metricId])

  const sources: EmbedSourceOption[] | null = useMemo(() => {
    if (!mergedRaw) return null
    // Every source with a per-source page is pinnable — a pinned source
    // shows ITS OWN per-source data, so sources that only report other
    // metrics (reports_preferred=false, e.g. HELM Capabilities on gpqa)
    // belong in the list too. Slice-only sources have no top-level page
    // to pin, so they stay out.
    const options = mergedRaw.aggregate_sources
      .filter((s) => s.evaluation_id && !s.slice_only)
      .map((s) => ({
        slug: s.composite_slug,
        label: s.composite_display_name || s.composite_slug,
        evaluationId: s.evaluation_id!,
      }))
    return options.length > 0 ? options : null
  }, [mergedRaw])

  // Ignore a ?source= that names no linkable source (typo / stale link):
  // fall back to merged rather than an empty embed.
  const effectiveSource =
    activeSource && sources?.some((s) => s.slug === activeSource) ? activeSource : ""

  useEffect(() => {
    if (!effectiveSource || !sources) {
      setSourceSummary(null)
      return
    }
    const target = sources.find((s) => s.slug === effectiveSource)
    if (!target) return
    let cancelled = false
    setSourceSummary(null)
    fetchEvalSummary(target.evaluationId)
      .then((s) => {
        if (cancelled) return
        setSourceSummary(s)
        setError(null)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [effectiveSource, sources])

  // Clear any stale error when the viewer changes selection, so a failed
  // pinned-source fetch doesn't leave the embed stuck on the error state
  // after switching back to Merged (or to another source).
  const selectSource = (slug: string) => {
    setError(null)
    setActiveSource(slug)
  }

  const scaleNotes = useMemo(
    () =>
      mergedRaw && !effectiveSource
        ? scaleHarmonizedNotes(
            mergedRaw.results.map((row) => ({
              name: row.composite_display_name || row.composite_slug,
              kind: row.scale_harmonized,
            })),
          )
        : [],
    [mergedRaw, effectiveSource],
  )

  return {
    scaleNotes,
    summary: effectiveSource ? sourceSummary : base,
    error,
    sources,
    activeSource: effectiveSource,
    setActiveSource: selectSource,
  }
}

/** Compact merged-vs-source selector, styled like the embeds' Split dropdown. */
export function EmbedSourcePicker({
  sources,
  value,
  onChange,
}: {
  sources: EmbedSourceOption[] | null
  value: string
  onChange: (slug: string) => void
}) {
  if (!sources || sources.length === 0) return null
  return (
    <div className="mb-3 flex items-center gap-3">
      <span
        className="font-mono uppercase shrink-0"
        style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
      >
        Source
      </span>
      <select
        className="ec-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Merged (all sources)</option>
        {sources.map((s) => (
          <option key={s.slug} value={s.slug}>
            {s.label}
          </option>
        ))}
      </select>
    </div>
  )
}
