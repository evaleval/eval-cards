"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { Navigation } from "@/components/navigation"
import { ReaderModeBar } from "@/components/reader-mode-bar"
import { EvalDetail } from "@/components/eval-detail"
import { MergedBenchmarkView } from "@/components/merged-benchmark-view"
import type { BenchmarkEvalSummary } from "@/lib/eval-processing"
import {
  buildCrossSourceContext,
  crossSourceRowsFromMerged,
  mergedPayloadIsComparable,
} from "@/lib/cross-source-context"
import { isMergedBenchmarkSummary } from "@/lib/merged-adapter"
import {
  fetchEvalHierarchy,
  fetchEvalSummary,
  fetchMergedBenchmarkSummary,
} from "@/lib/dashboard-data-client"
import { humanizeEvaluationId, isMergedEvalId, routeIdFromSegments, routeIdToPath } from "@/lib/utils"
import type { EvalHierarchy } from "@/lib/backend-artifacts"
import {
  buildHierarchyEvalIndex,
  type HierarchyEvalLocation,
} from "@/lib/hierarchy-lookup"
import { crossSuiteSiblingEvalIds } from "@/components/signals/benchmark-signals-strip"
import { replaceUrlQueryParam } from "@/lib/metric-selection"
import { useComparisonIndex } from "@/lib/use-comparison-index"

function findBenchmarkSplitIds(hierarchy: EvalHierarchy | null, evalId: string): string[] {
  if (!hierarchy) return []
  for (const fam of hierarchy.families) {
    const benches = [
      ...(fam.standalone_benchmarks ?? []),
      ...(fam.benchmarks ?? []),
      ...(fam.composites ?? []).flatMap((c) => c.benchmarks ?? []),
    ]
    for (const bench of benches) {
      if (bench.constituent_evaluation_ids?.includes(evalId)) {
        return bench.constituent_evaluation_ids
      }
    }
  }
  return []
}

export default function EvalDetailPage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [summary, setSummary] = useState<BenchmarkEvalSummary | null>(null)
  const [hierarchy, setHierarchy] = useState<EvalHierarchy | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [splitIds, setSplitIds] = useState<string[]>([])
  const [splitSummaries, setSplitSummaries] = useState<Map<string, BenchmarkEvalSummary>>(new Map())
  const [activeSplitId, setActiveSplitId] = useState<string | null>(null)
  // Other sources' measurements of the same (model, benchmark), so a
  // reader can see whether THIS source's number is an outlier. The merged
  // endpoint is already the producer's cross-source join on a canonical
  // scale, so nothing is re-derived here.
  //
  // Deferred on purpose. The merged payload is every source's rows for the
  // whole benchmark and reaches ~9.8 MB on a well-covered one, which is
  // far too much to spend on deciding whether to offer a view nobody has
  // asked for. The page can tell from what it already has whether a second
  // source exists, so it offers the view on that and downloads only if the
  // reader opens it. Only ~250 of 1,218 benchmarks qualify at all.
  //
  // The curated study sidecar, where one exists, is richer and already on
  // the summary, so those pages never come here.
  const returnTo = searchParams.get("from")
  const metricParam = searchParams.get("metric")
  const crossSourceContextLoader = useMemo(() => {
    const benchmarkId = summary?.benchmark_id
    const requestedMetric = metricParam?.trim()
    const matchedRootMetric = requestedMetric
      ? (summary?.leaderboard_metrics ?? []).find(
          (m) =>
            m.scope !== "subtask" &&
            (m.column_key === requestedMetric || m.metric_id === requestedMetric),
        )
      : undefined
    const metricId = matchedRootMetric
      ? (matchedRootMetric.metric_id || matchedRootMetric.column_key)
      : summary?.primary_metric_id
    if (!summary || !benchmarkId || !metricId || summary.collection?.context) return undefined
    // Nothing to ask for when this benchmark has no sibling source, which
    // is most of them, or when the page reports one slice rather than the
    // benchmark the merged payload pools.
    if ((summary.source_options?.sources.length ?? 0) < 2 || summary.is_slice) return undefined
    const subjectSourceSlug = summary.composite_benchmark_key
    const benchmarkLabel = summary.evaluation_name
    const sourceLabel = summary.composite_benchmark_name
    return async (signal: AbortSignal) => {
      const payload = await fetchMergedBenchmarkSummary(benchmarkId, { metricId, signal })
      if (!isMergedBenchmarkSummary(payload)) return null
      if (!mergedPayloadIsComparable(payload, { benchmarkId, metricId })) return null
      return buildCrossSourceContext(crossSourceRowsFromMerged(payload), {
        subjectSourceSlug,
        subjectLabel: "This source",
        benchmarkLabel,
        sourceLabel,
      })
    }
  }, [summary, metricParam])

  const pathname = `/evals/${routeIdToPath(routeIdFromSegments(params.id as string | string[]))}`
  const handleSelectMetric = useCallback(
    (nextMetricId: string | null) => {
      replaceUrlQueryParam(pathname, searchParams, "metric", nextMetricId)
    },
    [pathname, searchParams],
  )
  // Single URL segment = merged all-sources benchmark page (spec F2);
  // two segments = per-source eval page (unchanged).
  const routeEvalId = routeIdFromSegments(params.id as string | string[])
  const isMergedRoute = isMergedEvalId(routeEvalId)
  const handleBack = useCallback(() => {
    if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
      router.push(returnTo)
      return
    }

    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back()
      return
    }

    router.push("/evals")
  }, [returnTo, router])

  useEffect(() => {
    // Merged pages own their summary data flow (components/
    // merged-benchmark-view), but the signals strip inside still needs
    // the hierarchy for cross-suite comparability.
    if (isMergedRoute) {
      setLoading(false)
      fetchEvalHierarchy()
        .then(setHierarchy)
        .catch((err) => console.warn("Failed to load eval-hierarchy:", err))
      return
    }
    const load = async () => {
      try {
        // The data is keyed by percent-encoded evaluation_ids (literal
        // `%2F` slug form, e.g. `llm-stats%2Fdrop`). The route is
        // catch-all so `params.id` arrives as a path segment array
        // (`["llm-stats", "drop"]`) — `routeEvalId` joins + re-encodes
        // it into a stable string primitive so query-param updates do
        // not re-trigger data loading when Next.js recreates `params.id`.
        const evalId = routeEvalId
        const [found, evalHierarchy] = await Promise.all([
          fetchEvalSummary(evalId),
          fetchEvalHierarchy().catch((err) => {
            console.warn("Failed to load eval-hierarchy:", err)
            return null as EvalHierarchy | null
          }),
        ])
        setSummary(found)
        setHierarchy(evalHierarchy)
        document.title = `${found.evaluation_name} | Benchmark`

        // Detect benchmark splits: evals whose hierarchy benchmark has
        // multiple constituent_evaluation_ids (e.g. fibble-arena variants).
        const siblings = findBenchmarkSplitIds(evalHierarchy, evalId)
        if (siblings.length > 1) {
          setSplitIds(siblings)
          setActiveSplitId(evalId)
          const map = new Map<string, BenchmarkEvalSummary>()
          map.set(evalId, found)
          const otherIds = siblings.filter((id) => id !== evalId)
          const others = await Promise.all(
            otherIds.map((id) => fetchEvalSummary(id).catch(() => null))
          )
          for (let i = 0; i < otherIds.length; i++) {
            const s = others[i]
            if (s) map.set(otherIds[i], s)
          }
          setSplitSummaries(map)
        }
      } catch (err) {
        console.error(err)
        setError("Evaluation not found")
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [routeEvalId, isMergedRoute])

  // Cross-suite comparability reads the leaderboards of this page's
  // benchmark-index siblings. Not on the critical path for first paint, so
  // it loads after the summary and hierarchy. Merged pages (which load
  // their own) request nothing here.
  const comparisonRequest = useMemo(() => {
    if (isMergedRoute || !summary) return null
    return { evals: crossSuiteSiblingEvalIds(summary, hierarchy) }
  }, [isMergedRoute, summary, hierarchy])
  const comparisonIndex = useComparisonIndex(comparisonRequest)

  const hierarchyIndex = useMemo(() => {
    if (!hierarchy) return null
    const familyIdHints = new Map<string, string>()
    if (summary?.evaluation_id && summary.family_id) {
      familyIdHints.set(summary.evaluation_id, summary.family_id)
    }
    return buildHierarchyEvalIndex(
      hierarchy,
      (evalSummaryId) => familyIdHints.get(evalSummaryId) ?? null,
    )
  }, [hierarchy, summary])

  const hierarchyLocation = useMemo<HierarchyEvalLocation | null>(() => {
    if (!hierarchyIndex || !summary?.evaluation_id) return null
    return hierarchyIndex.get(summary.evaluation_id) ?? null
  }, [hierarchyIndex, summary])

  // When splits are active, the leaderboard inside EvalDetail swaps to the
  // selected split's summary while the hero/cards continue to read from the
  // page-level summary.
  const activeSplitSummary = activeSplitId
    ? (splitSummaries.get(activeSplitId) ?? summary)
    : summary

  const splitOptions = useMemo(
    () =>
      splitIds
        .map((id) => {
          const sub = splitSummaries.get(id)
          return {
            id,
            label: sub?.evaluation_name ?? humanizeEvaluationId(id),
          }
        }),
    [splitIds, splitSummaries]
  )

  if (isMergedRoute) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <ReaderModeBar />
        <main className="ec-page">
          <button
            type="button"
            onClick={handleBack}
            className="ec-crumb mb-6 inline-flex items-center gap-1.5"
          >
            <ArrowLeft className="h-3 w-3" />
            Evaluations
          </button>
          <MergedBenchmarkView
            benchmarkId={routeEvalId}
            evalHierarchy={hierarchy}
          />
        </main>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <ReaderModeBar />
        <main className="ec-page">
          <div className="flex items-center justify-center h-96">
            <div className="kicker">Loading evaluation record…</div>
          </div>
        </main>
      </div>
    )
  }

  if (error || !summary) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <ReaderModeBar />
        <main className="ec-page">
          <div className="flex flex-col items-center justify-center h-96 space-y-4">
            <div className="kicker">{error ?? "Evaluation not found"}</div>
            <button type="button" onClick={handleBack} className="btn-ec outline">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Evaluations
            </button>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <ReaderModeBar />
      <main className="ec-page">
        <button
          type="button"
          onClick={handleBack}
          className="ec-crumb mb-6 inline-flex items-center gap-1.5"
        >
          <ArrowLeft className="h-3 w-3" />
          Evaluations
        </button>
        <PerSourceScopeBar summary={summary} />
        <EvalDetail
          summary={summary}
          hierarchyLocation={hierarchyLocation}
          evalHierarchy={hierarchy}
          comparisonIndex={comparisonIndex}
          activeSummary={activeSplitSummary ?? summary}
          crossSourceContextLoader={crossSourceContextLoader}
          selectedMetricId={metricParam}
          onSelectMetric={handleSelectMetric}
          splitConfig={
            splitOptions.length > 1
              ? {
                  options: splitOptions,
                  activeId: activeSplitId ?? splitOptions[0].id,
                  onChange: setActiveSplitId,
                  label: "Split",
                }
              : undefined
          }
        />
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-source scope bar: the merged
// page's Source control gets a counterpart here — a scope-bar-style flex
// row above EvalDetail, matching the merged page's visual position. The
// select semantics differ by design: merged pins the merged option; the
// per-source page selects the CURRENT source. Navigate-on-select; the
// merged option only appears when a merged page actually exists
// (server-provided merged_evaluation_id — never navigate to a 404).
// ---------------------------------------------------------------------------

function PerSourceScopeBar({ summary }: { summary: BenchmarkEvalSummary }) {
  const router = useRouter()
  const options = summary.source_options
  if (!options || (!options.merged_evaluation_id && options.sources.length <= 1)) {
    return null
  }

  const currentId = summary.evaluation_id
  const sources = options.sources.some((s) => s.evaluation_id === currentId)
    ? options.sources
    : [
        ...options.sources,
        { evaluation_id: currentId, composite_display_name: summary.composite_display_name },
      ]

  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div
        className="font-mono text-[10px] uppercase tracking-[0.16em]"
        style={{ color: "var(--fg-subtle)" }}
      >
        Per-source page · one source of this benchmark
      </div>
      <label className="flex flex-col gap-1">
        <span
          className="font-mono text-[10px] uppercase tracking-[0.14em]"
          style={{ color: "var(--fg-subtle)" }}
        >
          Source
        </span>
        <select
          className="ec-select"
          value={currentId}
          onChange={(e) => {
            const id = e.target.value
            if (!id || id === currentId) return
            router.push(`/evals/${routeIdToPath(id)}`)
          }}
        >
          {options.merged_evaluation_id && (
            <option value={options.merged_evaluation_id}>All sources (merged)</option>
          )}
          {sources.map((source) => (
            <option key={source.evaluation_id} value={source.evaluation_id}>
              {source.composite_display_name ||
                source.composite_slug ||
                humanizeEvaluationId(source.evaluation_id)}
              {source.models_count != null
                ? ` (${source.models_count} ${source.models_count === 1 ? "model" : "models"})`
                : ""}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
