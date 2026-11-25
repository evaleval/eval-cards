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

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { EvalDetail } from "@/components/eval-detail"
import type { MetricFilterBarProps, MetricFilterItem } from "@/components/metric-filter-control"
import { fetchMergedBenchmarkSummary } from "@/lib/dashboard-data-client"
import {
  isMergedBenchmarkSummary,
  mergedSummaryToEvalSummary,
  scaleHarmonizedNotes,
} from "@/lib/merged-adapter"
import {
  isAssistedResult,
  type MergedBenchmarkSummary,
  type ModelResultForBenchmark,
} from "@/lib/eval-processing"
import { protocolSourceRow, studySourceRow } from "@/lib/collections"
import type { EvalHierarchy } from "@/lib/backend-artifacts"
import { crossSuiteSiblingEvalIds } from "@/components/signals/benchmark-signals-strip"
import { replaceUrlQueryParam } from "@/lib/metric-selection"
import { useComparisonIndex } from "@/lib/use-comparison-index"
import { routeIdToPath } from "@/lib/utils"

const MAX_CACHED_MERGED_SUMMARIES = 32

function mergedCacheKey(
  benchmarkId: string,
  metricId: string | null | undefined,
  sliceId: string | null | undefined,
): string {
  return `${benchmarkId}::${metricId ?? ""}::${sliceId ?? ""}`
}

export function MergedBenchmarkView({
  benchmarkId,
  evalHierarchy,
}: {
  benchmarkId: string
  /** Cross-suite comparability input, lazily loaded by the route page —
   *  same wiring the per-source path gives EvalDetail. */
  evalHierarchy?: EvalHierarchy | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const sourceParam = searchParams.get("source")
  const urlMetricParam = searchParams.get("metric")
  const urlSliceParam = searchParams.get("slice")

  const [requestedMetricParam, setRequestedMetricParam] = useState<string | null>(urlMetricParam)
  const [requestedSliceParam, setRequestedSliceParam] = useState<string | null>(urlSliceParam)
  const [requestNonce, setRequestNonce] = useState(0)
  const pathnameRef = useRef(pathname)
  const searchParamsRef = useRef(searchParams)
  pathnameRef.current = pathname
  searchParamsRef.current = searchParams

  useEffect(() => {
    // Ignore stale startTransition commits from Next.js's replaceState patch
    // if a newer metric click already updated window.location.search.
    if (typeof window !== "undefined" && window.location.pathname === pathnameRef.current) {
      const liveMetric = new URLSearchParams(window.location.search).get("metric")
      if (liveMetric !== urlMetricParam) return
    }
    setRequestedMetricParam(urlMetricParam)
  }, [urlMetricParam])
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.pathname === pathnameRef.current) {
      const liveSlice = new URLSearchParams(window.location.search).get("slice")
      if (liveSlice !== urlSliceParam) return
    }
    setRequestedSliceParam(urlSliceParam)
  }, [urlSliceParam])

  const [summary, setSummary] = useState<MergedBenchmarkSummary | null>(null)
  const summaryRef = useRef<MergedBenchmarkSummary | null>(null)
  const cacheRef = useRef<Map<string, MergedBenchmarkSummary>>(new Map())
  const preserveRefreshErrorRef = useRef(false)
  const [loading, setLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  useEffect(() => {
    summaryRef.current = summary
  }, [summary])

  const cacheMergedPayload = useCallback(
    (
      bId: string,
      reqMetric: string | null,
      reqSlice: string | null,
      payload: MergedBenchmarkSummary,
    ) => {
      const cache = cacheRef.current
      const keys = new Set<string>([
        mergedCacheKey(bId, reqMetric, reqSlice),
        mergedCacheKey(bId, payload.selected_metric_id, payload.selected_slice_id),
      ])
      if (payload.selected_metric_id === payload.preferred_metric_id) {
        keys.add(mergedCacheKey(bId, null, payload.selected_slice_id))
        if (!reqSlice) keys.add(mergedCacheKey(bId, null, null))
      }
      for (const key of keys) {
        if (cache.has(key)) cache.delete(key)
        cache.set(key, payload)
      }
      while (cache.size > MAX_CACHED_MERGED_SUMMARIES) {
        const oldestKey = cache.keys().next().value
        if (oldestKey === undefined) break
        cache.delete(oldestKey)
      }
    },
    [],
  )

  const revertSelectionToLoaded = useCallback(
    (loaded: MergedBenchmarkSummary, message: string) => {
      const loadedMetricParam =
        loaded.selected_metric_id && loaded.selected_metric_id !== loaded.preferred_metric_id
          ? loaded.selected_metric_id
          : null
      const loadedSliceParam = loaded.selected_slice_id ?? null
      preserveRefreshErrorRef.current = true
      setRefreshError(message)
      setRequestedMetricParam(loadedMetricParam)
      setRequestedSliceParam(loadedSliceParam)
      replaceUrlQueryParam(
        pathnameRef.current,
        searchParamsRef.current,
        "metric",
        loadedMetricParam,
      )
      if (loaded.grain === "slice") {
        replaceUrlQueryParam(
          pathnameRef.current,
          searchParamsRef.current,
          "slice",
          loadedSliceParam,
        )
      }
    },
    [],
  )

  useEffect(() => {
    const cacheKey = mergedCacheKey(benchmarkId, requestedMetricParam, requestedSliceParam)
    const cached = cacheRef.current.get(cacheKey)
    if (cached) {
      setSummary(cached)
      summaryRef.current = cached
      setError(null)
      if (preserveRefreshErrorRef.current) {
        preserveRefreshErrorRef.current = false
      } else {
        setRefreshError(null)
      }
      setLoading(false)
      setIsRefreshing(false)
      document.title = `${cached.display_name} | Benchmark`
      return
    }

    const controller = new AbortController()
    let cancelled = false
    const loadedSameBenchmark =
      summaryRef.current?.benchmark_id === benchmarkId ? summaryRef.current : null
    if (loadedSameBenchmark) {
      setIsRefreshing(true)
      setRefreshError(null)
    } else {
      setLoading(true)
      setIsRefreshing(false)
      setError(null)
      setRefreshError(null)
    }

    fetchMergedBenchmarkSummary(benchmarkId, {
      metricId: requestedMetricParam ?? undefined,
      sliceId: requestedSliceParam ?? undefined,
      signal: controller.signal,
    })
      .then((payload) => {
        if (cancelled) return
        if (!isMergedBenchmarkSummary(payload)) {
          if (loadedSameBenchmark) {
            revertSelectionToLoaded(
              loadedSameBenchmark,
              "This snapshot has no merged data for that selection.",
            )
          } else {
            setError("This snapshot has no merged page for this benchmark.")
          }
          return
        }
        cacheMergedPayload(benchmarkId, requestedMetricParam, requestedSliceParam, payload)
        setSummary(payload)
        summaryRef.current = payload
        setError(null)
        setRefreshError(null)
        document.title = `${payload.display_name} | Benchmark`
      })
      .catch((err) => {
        if (cancelled || controller.signal.aborted) return
        console.error(err)
        if (loadedSameBenchmark) {
          revertSelectionToLoaded(loadedSameBenchmark, "Could not load that metric view.")
        } else {
          setError("Benchmark not found")
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
          setIsRefreshing(false)
        }
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [
    benchmarkId,
    cacheMergedPayload,
    requestedMetricParam,
    requestedSliceParam,
    requestNonce,
    revertSelectionToLoaded,
  ])

  // Update a query param in place without an RSC round-trip so metric/slice
  // selections feel instant and still survive reload and back.
  const setQueryParam = useCallback(
    (key: "metric" | "slice", value: string | null) => {
      const normalized = value?.trim() || null
      preserveRefreshErrorRef.current = false
      setRefreshError(null)
      if (key === "metric") {
        setRequestedMetricParam(normalized)
      } else {
        setRequestedSliceParam(normalized)
      }
      setRequestNonce((n) => n + 1)
      replaceUrlQueryParam(pathname, searchParams, key, normalized)
    },
    [pathname, searchParams],
  )

  // Reshape onto the per-source BenchmarkEvalSummary surface so the page
  // can mount the full EvalDetail experience at merged grain: pooled
  // all-sources observation rows on the metric's canonical scale.
  const adapted = useMemo(
    () => (summary ? mergedSummaryToEvalSummary(summary) : null),
    [summary],
  )
  // The leaderboards the signals strip reads for this page's cross-suite
  // siblings, requested once the page summary and hierarchy are known.
  const comparisonIndex = useComparisonIndex(
    useMemo(
      () => (adapted ? { evals: crossSuiteSiblingEvalIds(adapted, evalHierarchy) } : null),
      [adapted, evalHierarchy],
    ),
  )

  const selectedMetricId = summary?.selected_metric_id
  const activeMetricId = selectedMetricId ?? summary?.preferred_metric_id
  const optimisticMetricId =
    isRefreshing &&
    requestedMetricParam &&
    summary?.metrics.some((metric) => metric.metric_id === requestedMetricParam)
      ? requestedMetricParam
      : isRefreshing && requestedMetricParam === null && summary?.preferred_metric_id
        ? summary.preferred_metric_id
        : activeMetricId

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

  const selectedMetricSourceSlugs = useMemo(
    () => new Set((summary?.results ?? []).map((row) => row.composite_slug).filter(Boolean)),
    [summary],
  )
  const isPreferredMetricSelected =
    !activeMetricId || activeMetricId === summary?.preferred_metric_id
  const disclosureSources = (summary?.aggregate_sources ?? []).filter((s) => {
    if (s.slice_only) return true
    return isPreferredMetricSelected
      ? !s.reports_preferred
      : !selectedMetricSourceSlugs.has(s.composite_slug)
  })

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

  // Sources whose scores were moved onto the page's scale because the
  // metric declares no bounds of its own.
  const harmonizedNotes = scaleHarmonizedNotes(
    (summary?.results ?? []).map((row) => ({
      name: row.composite_display_name || row.composite_slug,
      kind: row.scale_harmonized,
    })),
  )

  if (loading && summary?.benchmark_id !== benchmarkId) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="kicker">Loading merged benchmark…</div>
      </div>
    )
  }

  if ((error && summary?.benchmark_id !== benchmarkId) || !summary || !adapted) {
    return (
      <div className="flex flex-col items-center justify-center h-96 space-y-4">
        <div className="kicker">{error ?? "Benchmark not found"}</div>
      </div>
    )
  }

  const preselectedSource =
    sourceParam && sourceSlugSet.has(sourceParam) ? sourceParam : ""

  // Leaderboard Option 2A MetricFilterBar — mirrors Model View and Per-Source
  // Benchmark View. Switching re-queries ?metric= in place without unmounting.
  const mergedMetricBar: MetricFilterBarProps | undefined =
    summary.metrics.length > 1
      ? (() => {
          const items: MetricFilterItem[] = [...summary.metrics]
            .sort((a, b) => {
              const aPref = a.metric_id === summary.preferred_metric_id ? 0 : 1
              const bPref = b.metric_id === summary.preferred_metric_id ? 0 : 1
              if (aPref !== bPref) return aPref - bPref
              return b.models_count - a.models_count
            })
            .map((metric) => {
              const isLoadedMetric = metric.metric_id === activeMetricId
              const isPref = metric.metric_id === summary.preferred_metric_id
              return {
                key: metric.metric_id,
                label: metric.display_name,
                count: isLoadedMetric ? modelsCount : metric.models_count,
                direction:
                  metric.lower_is_better == null
                    ? null
                    : metric.lower_is_better
                      ? "lower"
                      : "higher",
                isDefault: isPref,
              }
            })
          return {
            label: "Metric",
            items,
            value: optimisticMetricId ?? null,
            isPending: isRefreshing,
            onChange: (nextKey: string | null) =>
              setQueryParam(
                "metric",
                !nextKey || nextKey === summary.preferred_metric_id ? null : nextKey,
              ),
            countNoun: { singular: "model", plural: "models" },
            searchPlaceholder: "Filter measures…",
            statusText: refreshError
              ? refreshError
              : `${modelsCount.toLocaleString()} ${modelsCount === 1 ? "model" : "models"} · ${sourcesCount.toLocaleString()} ${sourcesCount === 1 ? "source" : "sources"} · ${resultsCount.toLocaleString()} ${resultsCount === 1 ? "result" : "results"}`,
          }
        })()
      : undefined

  const rowHighlight = preselectedSource
    ? (row: ModelResultForBenchmark) => row.merged_source_slug === preselectedSource
    : undefined

  // Study-protocol banner link target: the shared EvalDetail
  // has no per-source evaluation_id in scope on merged pages, so resolve
  // the study source here — the protocol-carrying observation rows name
  // their per-source page directly.
  const studyRow = studySourceRow(summary.results)
  const studySourceHref = studyRow ? `/evals/${routeIdToPath(studyRow.evaluation_id)}` : undefined
  // The "View all protocol points" link is about any protocol point, study
  // or not, and exists only when one source page lists them all.
  const protocolRow = protocolSourceRow(summary.results)
  const protocolPointsHref = protocolRow
    ? `/evals/${routeIdToPath(protocolRow.evaluation_id)}`
    : undefined

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
        metricBarOverride={mergedMetricBar}
        rowHighlight={rowHighlight}
        studySourceHref={studySourceHref}
        protocolPointsHref={protocolPointsHref}
        leaderboardNotes={harmonizedNotes}
      />

      {/* DISCLOSURE NOTES -------------------------------------------------- */}
      {(disclosureSources.length > 0 ||
        unconvertibleCount > 0 ||
        assistedExcludedCount > 0) && (
        <div className="space-y-1.5">
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
              : isPreferredMetricSelected
                ? "reports only other metrics for this benchmark (see metric switcher)."
                : "does not report this metric (see metric switcher)."
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
