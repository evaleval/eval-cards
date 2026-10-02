"use client"

// Merged all-sources benchmark page (merged-benchmark-view spec F3/F4).
//
// One page per resolved canonical benchmark, at observation grain: one
// row per (model, source) score, flat-interleaved and sorted by
// score_canonical in the metric's direction (spec Q6). Echo
// republications stay visible (Q3).
//
// The page renders the SAME full EvalDetail experience as a per-source
// eval page — hero, benchmark signals, metric spec, score distribution,
// leaderboard, embed links — fed with the merged payload adapted onto
// the BenchmarkEvalSummary surface (lib/merged-adapter). Merged-specific
// controls layer on top:
//   - Source narrower: NAVIGATES to the per-source eval page (Q5 —
//     unlike the state-swap SplitPicker on per-source pages).
//   - Metric switcher: mounts in EvalDetail's split-picker slot;
//     re-queries via ?metric= without navigation.
//   - Slice selector (grain='slice' pages only): ?slice=.
// ?source= pre-highlights the clicked browse-tree leaf's source rows.

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { EvalDetail } from "@/components/eval-detail"
import { fetchMergedBenchmarkSummary } from "@/lib/dashboard-data-client"
import { isMergedBenchmarkSummary, mergedSummaryToEvalSummary } from "@/lib/merged-adapter"
import {
  isAssistedResult,
  type MergedBenchmarkSummary,
  type ModelResultForBenchmark,
} from "@/lib/eval-processing"
import type { ComparisonIndex, EvalHierarchy } from "@/lib/backend-artifacts"
import { routeIdToPath } from "@/lib/utils"

export function MergedBenchmarkView({
  benchmarkId,
  evalHierarchy,
  comparisonIndex,
}: {
  benchmarkId: string
  /** Cross-suite comparability inputs, lazily loaded by the route page —
   *  same wiring the per-source path gives EvalDetail. */
  evalHierarchy?: EvalHierarchy | null
  comparisonIndex?: ComparisonIndex | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const sourceParam = searchParams.get("source")
  const metricParam = searchParams.get("metric")
  const sliceParam = searchParams.get("slice")

  const [summary, setSummary] = useState<MergedBenchmarkSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchMergedBenchmarkSummary(benchmarkId, {
      metricId: metricParam ?? undefined,
      sliceId: sliceParam ?? undefined,
    })
      .then((payload) => {
        if (cancelled) return
        if (!isMergedBenchmarkSummary(payload)) {
          setError("This snapshot has no merged page for this benchmark.")
          return
        }
        setSummary(payload)
        setError(null)
        document.title = `${payload.display_name} | Benchmark`
      })
      .catch((err) => {
        console.error(err)
        if (!cancelled) setError("Benchmark not found")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [benchmarkId, metricParam, sliceParam])

  // Update a query param in place (no navigation) so metric/slice
  // selections survive reload and back.
  const setQueryParam = (key: string, value: string | null) => {
    const params = new URLSearchParams(searchParams.toString())
    if (value) params.set(key, value)
    else params.delete(key)
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  // Reshape onto the per-source BenchmarkEvalSummary surface so the page
  // can mount the full EvalDetail experience at merged grain: pooled
  // all-sources observation rows on the metric's canonical scale.
  const adapted = useMemo(
    () => (summary ? mergedSummaryToEvalSummary(summary) : null),
    [summary],
  )

  const selectedMetricId = summary?.selected_metric_id
  const activeMetricId = selectedMetricId ?? summary?.preferred_metric_id

  // Counts at the SELECTED metric's visible merged grain. The raw payload
  // can include assisted and unconvertible observations that the merged
  // adapter intentionally withholds.
  const visibleRows = adapted?.model_results ?? []
  const resultsCount = visibleRows.length
  const sourcesCount = new Set(
    visibleRows.map((row) => row.merged_source_slug).filter(Boolean),
  ).size
  const modelsCount = new Set(
    visibleRows.map((row) => row.model_route_id ?? row.model_info.id),
  ).size

  const sourceSlugSet = useMemo(
    () => new Set((summary?.aggregate_sources ?? []).map((s) => s.composite_slug)),
    [summary],
  )

  const disclosureSources = (summary?.aggregate_sources ?? []).filter(
    (s) => !s.reports_preferred || s.slice_only,
  )

  const assistedExcludedCount = summary
    ? summary.results.filter((row) => isAssistedResult(row.protocol_condition)).length
    : 0
  // Keep this disclosure distinct from intentional protocol filtering:
  // these rows are absent because their scores cannot share the axis.
  const unconvertibleCount = summary
    ? summary.results.filter(
        (row) =>
          !isAssistedResult(row.protocol_condition) &&
          (row.score_canonical == null || !Number.isFinite(row.score_canonical)),
      ).length
    : 0

  // Sources whose fraction (or percent) scores were moved onto the page's
  // scale because the metric declares no bounds of its own.
  const harmonizedSources = summary
    ? Array.from(
        new Map(
          summary.results
            .filter((row) => row.scale_harmonized)
            .map((row) => [row.composite_slug, row] as const),
        ).values(),
      )
    : []

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="kicker">Loading merged benchmark…</div>
      </div>
    )
  }

  if (error || !summary || !adapted) {
    return (
      <div className="flex flex-col items-center justify-center h-96 space-y-4">
        <div className="kicker">{error ?? "Benchmark not found"}</div>
      </div>
    )
  }

  const preselectedSource =
    sourceParam && sourceSlugSet.has(sourceParam) ? sourceParam : ""

  // Metric switcher rides EvalDetail's split-picker slot (rendered just
  // above the score distribution, exactly where per-source pages mount
  // their split pickers). Switching re-queries ?metric= and re-adapts.
  const metricSplitConfig =
    summary.metrics.length > 1
      ? {
          label: "Metric",
          activeId: selectedMetricId ?? summary.preferred_metric_id,
          onChange: (metricId: string) =>
            setQueryParam("metric", metricId === summary.preferred_metric_id ? null : metricId),
          options: summary.metrics.map((metric) => {
            const isSelected = metric.metric_id === activeMetricId
            const displayedSources = isSelected ? sourcesCount : metric.sources_count
            const displayedResults = isSelected ? resultsCount : metric.results_count
            return {
              id: metric.metric_id,
              label: `${metric.display_name} (${displayedSources} ${
                displayedSources === 1 ? "source" : "sources"
              }, ${displayedResults} ${displayedResults === 1 ? "result" : "results"})`,
            }
          }),
        }
      : undefined

  const rowHighlight = preselectedSource
    ? (row: ModelResultForBenchmark) => row.merged_source_slug === preselectedSource
    : undefined

  // Study-protocol banner link target: the shared EvalDetail
  // has no per-source evaluation_id in scope on merged pages, so resolve
  // the study source here — the protocol-carrying observation rows name
  // their per-source page directly.
  const studyRow = summary.results.find(
    (row) => row.protocol_condition != null && row.evaluation_id,
  )
  const studySourceHref = studyRow ? `/evals/${routeIdToPath(studyRow.evaluation_id)}` : undefined

  return (
    <div className="space-y-8">
      {/* MERGED SCOPE BAR — merged-specific controls above the shared
          EvalDetail chrome. ------------------------------------------- */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <div
            className="font-mono text-[10px] uppercase tracking-[0.16em]"
            style={{ color: "var(--fg-subtle)" }}
          >
            Merged benchmark · all sources
          </div>
          <div
            className="mt-1 font-mono text-[11px] uppercase tracking-[0.12em]"
            style={{ color: "var(--fg-muted)" }}
          >
            {resultsCount.toLocaleString()} {resultsCount === 1 ? "result" : "results"} from{" "}
            {sourcesCount.toLocaleString()} {sourcesCount === 1 ? "source" : "sources"} ·{" "}
            {modelsCount.toLocaleString()} {modelsCount === 1 ? "model" : "models"}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <label className="flex flex-col gap-1">
            <span
              className="font-mono text-[10px] uppercase tracking-[0.14em]"
              style={{ color: "var(--fg-subtle)" }}
            >
              Source
            </span>
            <select
              className="ec-select"
              // ALWAYS displays "All sources (merged)" here: this page IS
              // the merged view, and the select is a navigator, not state.
              // The ?source= came-from param must never render as the
              // select's value — that read as "you are viewing one source"
              // on a merged page. It only drives the row highlight.
              value=""
              onChange={(e) => {
                const slug = e.target.value
                if (!slug) return
                const source = summary.aggregate_sources.find((s) => s.composite_slug === slug)
                if (source?.evaluation_id) {
                  // Navigate-on-select to the per-source page (spec Q5).
                  router.push(`/evals/${routeIdToPath(source.evaluation_id)}`)
                }
              }}
            >
              <option value="">All sources (merged)</option>
              {summary.aggregate_sources.map((source) => (
                <option
                  key={source.composite_slug}
                  value={source.composite_slug}
                  disabled={!source.evaluation_id}
                >
                  {source.composite_display_name || source.composite_slug} ({source.models_count}{" "}
                  {source.models_count === 1 ? "model" : "models"})
                  {source.slice_only ? " — slice-level only" : ""}
                </option>
              ))}
            </select>
          </label>

          {summary.grain === "slice" && (summary.slices?.length ?? 0) > 0 && (
            <label className="flex flex-col gap-1">
              <span
                className="font-mono text-[10px] uppercase tracking-[0.14em]"
                style={{ color: "var(--fg-subtle)" }}
              >
                Slice
              </span>
              <select
                className="ec-select"
                value={summary.selected_slice_id ?? ""}
                onChange={(e) => setQueryParam("slice", e.target.value || null)}
              >
                {(summary.slices ?? []).map((slice) => (
                  <option key={slice.slice_id} value={slice.slice_id}>
                    {slice.display_name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      {summary.grain === "slice" && (
        <p className="text-[13px] leading-[1.6]" style={{ color: "var(--fg-muted)", maxWidth: 720 }}>
          This benchmark reports slice-level results only; each slice merges across sources.
        </p>
      )}

      {/* FULL EVAL PAGE at merged grain -------------------------------- */}
      <EvalDetail
        summary={adapted}
        evalHierarchy={evalHierarchy}
        comparisonIndex={comparisonIndex}
        splitConfig={metricSplitConfig}
        rowHighlight={rowHighlight}
        studySourceHref={studySourceHref}
      />

      {/* DISCLOSURE NOTES -------------------------------------------------- */}
      {(disclosureSources.length > 0 ||
        unconvertibleCount > 0 ||
        assistedExcludedCount > 0 ||
        harmonizedSources.length > 0) && (
        <div className="space-y-1.5">
          {(["mul100", "div100", "of_total"] as const).map((kind) => {
            const names = harmonizedSources
              .filter((row) => row.scale_harmonized === kind)
              .map((row) => row.composite_display_name || row.composite_slug)
            if (names.length === 0) return null
            const one = names.length === 1
            const reported =
              kind === "mul100" ? "a fraction of 1" : kind === "div100" ? "a percentage" : "a raw point total"
            const shown =
              kind === "mul100"
                ? "×100"
                : kind === "div100"
                  ? "÷100"
                  : "as a share of the benchmark's published maximum"
            return (
              <p
                key={kind}
                className="text-[12px] leading-[1.6]"
                style={{ color: "var(--fg-muted)" }}
              >
                {names.join(", ")} {one ? "reports" : "report"} this metric as {reported};{" "}
                {one ? "its" : "their"} scores are shown {shown} so every source sits on the same
                scale.
              </p>
            )
          })}
          {assistedExcludedCount > 0 && (
            <p className="text-[12px] leading-[1.6]" style={{ color: "var(--fg-muted)" }}>
              {assistedExcludedCount.toLocaleString()} assisted study{" "}
              {assistedExcludedCount === 1 ? "result is" : "results are"} omitted from this
              merged view and {assistedExcludedCount === 1 ? "remains" : "remain"} available on the{" "}
              {studySourceHref ? (
                <Link
                  href={studySourceHref}
                  className="underline underline-offset-2 hover:text-[color:var(--accent)]"
                  style={{ color: "var(--fg)" }}
                >
                  source study page
                </Link>
              ) : (
                "source study page"
              )}.
            </p>
          )}
          {unconvertibleCount > 0 && (
            <p className="text-[12px] leading-[1.6]" style={{ color: "var(--fg-muted)" }}>
              {unconvertibleCount.toLocaleString()} {unconvertibleCount === 1 ? "result is" : "results are"} not
              shown: {unconvertibleCount === 1 ? "its score" : "their scores"} could not be converted to
              this metric&apos;s common scale.
            </p>
          )}
          {disclosureSources.map((source) => {
            const name = source.composite_display_name || source.composite_slug
            const note = source.slice_only
              ? "reports slice-level results only."
              : "reports only other metrics for this benchmark (see metric switcher)."
            return (
              <p
                key={`${source.composite_slug}-${source.slice_only ? "slice" : "metric"}`}
                className="text-[12px] leading-[1.6]"
                style={{ color: "var(--fg-muted)" }}
              >
                {source.evaluation_id ? (
                  <Link
                    href={`/evals/${routeIdToPath(source.evaluation_id)}`}
                    className="underline underline-offset-2 hover:text-[color:var(--accent)]"
                    style={{ color: "var(--fg)" }}
                  >
                    {name}
                  </Link>
                ) : (
                  <span style={{ color: "var(--fg)" }}>{name}</span>
                )}{" "}
                {note}
              </p>
            )
          })}
        </div>
      )}
    </div>
  )
}
