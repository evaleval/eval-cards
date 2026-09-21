"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { ArrowLeft, ArrowUpRight, BarChart3, Grid3X3, Search } from "lucide-react"
import { Navigation } from "@/components/navigation"
import { ReaderModeBar } from "@/components/reader-mode-bar"
import { EvalDetail } from "@/components/eval-detail"
import { MergedBenchmarkView } from "@/components/merged-benchmark-view"
import { ParamRangePicker } from "@/components/param-range-picker"
import { useAudienceMode } from "@/components/audience-mode-provider"
import type { BenchmarkEvalSummary } from "@/lib/eval-processing"
import {
  buildCrossSourceContext,
  crossSourceRowsFromMerged,
  mergedPayloadIsComparable,
} from "@/lib/cross-source-context"
import { compositeScoresByModel } from "@/lib/eval-processing"
import { isMergedBenchmarkSummary } from "@/lib/merged-adapter"
import {
  fetchComparisonIndex,
  fetchEvalHierarchy,
  fetchEvalSummary,
  fetchMergedBenchmarkSummary,
} from "@/lib/dashboard-data-client"
import { humanizeEvaluationId, isMergedEvalId, routeIdFromSegments, routeIdToPath } from "@/lib/utils"
import { PARAM_RANGE_MAX_INDEX, parseParamsBillionsFromModelName, paramStepToNumeric } from "@/lib/param-range"
import type { ComparisonIndex, EvalHierarchy } from "@/lib/backend-artifacts"
import {
  buildHierarchyEvalIndex,
  type HierarchyEvalLocation,
} from "@/lib/hierarchy-lookup"
import { tagLabel } from "@/lib/benchmark-schema"

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
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [summary, setSummary] = useState<BenchmarkEvalSummary | null>(null)
  const [subSummaries, setSubSummaries] = useState<BenchmarkEvalSummary[]>([])
  const [hierarchy, setHierarchy] = useState<EvalHierarchy | null>(null)
  const [comparisonIndex, setComparisonIndex] = useState<ComparisonIndex | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [matrixSearch, setMatrixSearch] = useState("")
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
  const crossSourceContextLoader = useMemo(() => {
    const benchmarkId = summary?.benchmark_id
    const metricId = summary?.primary_metric_id
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
  }, [summary])

  const returnTo = searchParams.get("from")
  // Single URL segment = merged all-sources benchmark page (spec F2);
  // two segments = per-source eval page (unchanged).
  const routeEvalId = routeIdFromSegments(params.id as string | string[])
  const isMergedRoute = isMergedEvalId(routeEvalId)
  const currentDetailHref = useMemo(() => {
    const params = new URLSearchParams(searchParams.toString())
    params.delete("from")
    const query = params.toString()
    return query ? `${pathname}?${query}` : pathname
  }, [pathname, searchParams])

  const handleBack = useCallback(() => {
    if (returnTo?.startsWith("/")) {
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
        // (`["llm-stats", "drop"]`) — join + re-encode for backend
        // lookup. Every per-source evaluation_id in the snapshot uses
        // `%2F`, so this is unambiguous.
        const evalId = routeIdFromSegments(params.id as string | string[])
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

        if (found.is_aggregated && found.aggregate_sources?.length) {
          const subs = await Promise.all(
            found.aggregate_sources.map(async (source) => {
              try {
                return await fetchEvalSummary(source.evaluation_id)
              } catch {
                return null
              }
            })
          )
          setSubSummaries(subs.filter((s): s is BenchmarkEvalSummary => s !== null))
        } else {
          // Detect benchmark splits: non-composite evals whose hierarchy
          // benchmark has multiple constituent_evaluation_ids (e.g. fibble-arena variants).
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
        }
      } catch (err) {
        console.error(err)
        setError("Evaluation not found")
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [params.id, isMergedRoute])

  // Cross-suite comparability needs the full comparison-index, but it's
  // not on the critical path for first paint — load lazily so the page
  // renders fast even on slow networks.
  useEffect(() => {
    let cancelled = false
    fetchComparisonIndex()
      .then((idx) => {
        if (!cancelled) setComparisonIndex(idx)
      })
      .catch((err) => {
        console.warn("Failed to load comparison-index:", err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const hierarchyIndex = useMemo(() => {
    if (!hierarchy) return null
    const familyIdHints = new Map<string, string>()
    if (summary?.evaluation_id && summary.family_id) {
      familyIdHints.set(summary.evaluation_id, summary.family_id)
    }
    for (const sub of subSummaries) {
      if (sub.evaluation_id && sub.family_id) {
        familyIdHints.set(sub.evaluation_id, sub.family_id)
      }
    }
    return buildHierarchyEvalIndex(
      hierarchy,
      (evalSummaryId) => familyIdHints.get(evalSummaryId) ?? null,
    )
  }, [hierarchy, summary, subSummaries])

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
            comparisonIndex={comparisonIndex}
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

  const isComposite = summary.is_aggregated && (summary.aggregate_sources?.length ?? 0) > 1

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
        {isComposite ? (
          <CompositeEvalView
            summary={summary}
            subSummaries={subSummaries}
            matrixSearch={matrixSearch}
            onMatrixSearchChange={setMatrixSearch}
            currentDetailHref={currentDetailHref}
            hierarchyIndex={hierarchyIndex}
            hierarchyLocation={hierarchyLocation}
          />
        ) : (
          <>
            <PerSourceScopeBar summary={summary} />
            <EvalDetail
            summary={summary}
            hierarchyLocation={hierarchyLocation}
            evalHierarchy={hierarchy}
            comparisonIndex={comparisonIndex}
            activeSummary={activeSplitSummary ?? summary}
            crossSourceContextLoader={crossSourceContextLoader}
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
          </>
        )}
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

// ---------------------------------------------------------------------------
// Composite view — the composite reporting unit
// Surfaces sub-benchmarks as a hairline grid and a per-model × per-metric
// matrix table. Both modes (research / policy) share the same chrome; the
// policy-note panel changes per benchmark, surfaced from the sub-summary card.
// ---------------------------------------------------------------------------

type Tab = "metrics" | "matrix"

function CompositeEvalView({
  summary,
  subSummaries,
  matrixSearch,
  onMatrixSearchChange,
  currentDetailHref,
  hierarchyIndex,
  hierarchyLocation,
}: {
  summary: BenchmarkEvalSummary
  subSummaries: BenchmarkEvalSummary[]
  matrixSearch: string
  onMatrixSearchChange: (v: string) => void
  currentDetailHref: string
  hierarchyIndex: Map<string, HierarchyEvalLocation> | null
  hierarchyLocation: HierarchyEvalLocation | null
}) {
  const { mode } = useAudienceMode()
  const isPolicy = mode === "policy"
  const [tab, setTab] = useState<Tab>("metrics")

  const sources = summary.aggregate_sources ?? []
  const subBenchmarkCount = sources.length
  const card = summary.benchmark_card
  const goal = card?.purpose_and_intended_users?.goal?.trim()
  const overview = card?.benchmark_details?.overview?.trim()
  const limitations = card?.purpose_and_intended_users?.limitations?.trim()
  const audience = card?.purpose_and_intended_users?.audience
  const audienceText = Array.isArray(audience) ? audience.join("; ") : audience
  const familyHeader =
    hierarchyLocation?.familyDisplayName && hierarchyLocation.familyDisplayName !== summary.evaluation_name
      ? hierarchyLocation.familyDisplayName
      : summary.composite_benchmark_name && summary.composite_benchmark_name !== summary.evaluation_name
        ? summary.composite_benchmark_name
        : null
  const lede = isPolicy
    ? overview || goal || `Composite aggregating ${subBenchmarkCount} component benchmarks across ${summary.models_count.toLocaleString()} models.`
    : goal || overview || `Composite aggregating ${subBenchmarkCount} component benchmarks across ${summary.models_count.toLocaleString()} models.`

  return (
    <div className="space-y-10">
      {/* HERO ------------------------------------------------------------- */}
      <header className="motion-academic-enter">
        <h1 className="ec-page-h1">{summary.evaluation_name}</h1>
        <div
          className="mb-5 flex flex-wrap items-center gap-3 font-mono text-[11px] uppercase tracking-[0.12em]"
          style={{ color: "var(--fg-muted)" }}
        >
          {familyHeader && (
            <>
              <span>{familyHeader}</span>
              <span style={{ color: "var(--fg-subtle)" }}>·</span>
            </>
          )}
          {summary.derived_tags && summary.derived_tags.length > 0 && (
            <>
              <span>{summary.derived_tags.map(tagLabel).join(", ")}</span>
              <span style={{ color: "var(--fg-subtle)" }}>·</span>
            </>
          )}
          <span>{summary.metric_config.lower_is_better ? "Lower is better ↓" : "Higher is better ↑"}</span>
        </div>
        <p className="ec-page-lede">{lede}</p>

        <div className="ec-page-meta mt-2">
          <div className="ec-page-meta-item">
            <span className="ec-page-meta-item-l">Components</span>
            <span className="ec-page-meta-item-v">{subBenchmarkCount}</span>
          </div>
          <div className="ec-page-meta-item">
            <span className="ec-page-meta-item-l">Models</span>
            <span className="ec-page-meta-item-v">{summary.models_count.toLocaleString()}</span>
          </div>
          <div className="ec-page-meta-item">
            <span className="ec-page-meta-item-l">Metrics</span>
            <span className="ec-page-meta-item-v">{summary.metrics_count ?? subBenchmarkCount}</span>
          </div>
          {summary.tags?.languages && summary.tags.languages.length > 0 && (
            <div className="ec-page-meta-item">
              <span className="ec-page-meta-item-l">Languages</span>
              <span className="ec-page-meta-item-v">{summary.tags.languages.slice(0, 3).join(", ")}</span>
            </div>
          )}
        </div>
      </header>

      {/* POLICY NOTE (policy mode only) ----------------------------------- */}
      {isPolicy && (overview || limitations || audienceText) && (
        <section className="ec-card warm" style={{ padding: "20px 24px" }}>
          <div className="kicker mb-3">At a glance</div>
          <dl className="grid gap-y-2.5 text-[14px]" style={{ gridTemplateColumns: "max-content 1fr", columnGap: 24 }}>
            {overview && (
              <>
                <dt className="font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--fg-subtle)", paddingTop: 3 }}>
                  Measures
                </dt>
                <dd style={{ color: "var(--fg)", lineHeight: 1.6 }}>{overview}</dd>
              </>
            )}
            {limitations && (
              <>
                <dt className="font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--accent)", paddingTop: 3 }}>
                  Caveat
                </dt>
                <dd style={{ color: "var(--fg)", lineHeight: 1.6 }}>{limitations}</dd>
              </>
            )}
            {audienceText && (
              <>
                <dt className="font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--fg-subtle)", paddingTop: 3 }}>
                  Intended for
                </dt>
                <dd style={{ color: "var(--fg)", lineHeight: 1.6 }}>{audienceText}</dd>
              </>
            )}
          </dl>
        </section>
      )}

      {/* TAB SWITCH ------------------------------------------------------- */}
      <div>
        <div className="section-head">
          <h2>{tab === "metrics" ? "Sub-benchmarks" : "Score breakdown"}</h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setTab("metrics")}
              className={`ec-pill ${tab === "metrics" ? "on" : ""}`}
            >
              <span className="inline-flex items-center gap-1.5">
                <BarChart3 className="h-3 w-3" />
                Sub-benchmarks · {subBenchmarkCount}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setTab("matrix")}
              className={`ec-pill ${tab === "matrix" ? "on" : ""}`}
            >
              <span className="inline-flex items-center gap-1.5">
                <Grid3X3 className="h-3 w-3" />
                Matrix view
              </span>
            </button>
          </div>
        </div>

        <p
          className="text-[13px] leading-[1.6] mb-6"
          style={{ color: "var(--fg-muted)", maxWidth: 720 }}
        >
          {tab === "metrics"
            ? "Each card is one component benchmark inside this composite. Click a card to inspect its leaderboard, slices and benchmark card."
            : "Per-model scores across every component metric. Each column is a separately reported measure."}
        </p>

        {tab === "metrics" ? (
          <SubBenchmarkGrid
            sources={sources}
            subSummaries={subSummaries}
            currentDetailHref={currentDetailHref}
            hierarchyIndex={hierarchyIndex}
          />
        ) : (
          <MatrixLeaderboard
            summary={summary}
            subSummaries={subSummaries}
            search={matrixSearch}
            onSearchChange={onMatrixSearchChange}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-benchmark cards (paper-aligned fam-grid)
// ---------------------------------------------------------------------------

function SubBenchmarkGrid({
  sources,
  subSummaries,
  currentDetailHref,
  hierarchyIndex,
}: {
  sources: NonNullable<BenchmarkEvalSummary["aggregate_sources"]>
  subSummaries: BenchmarkEvalSummary[]
  currentDetailHref: string
  hierarchyIndex: Map<string, HierarchyEvalLocation> | null
}) {
  const subMap = useMemo(
    () => new Map(subSummaries.map((s) => [s.evaluation_id, s])),
    [subSummaries]
  )

  // Group sources by hierarchy family. When the hierarchy doesn't resolve a
  // family for a source (or no hierarchy was loaded), bucket those entries
  // under a single "Other" section instead of spamming per-eval headers.
  type FamilyBucket = {
    key: string
    displayName: string | null
    sources: NonNullable<BenchmarkEvalSummary["aggregate_sources"]>
  }
  const buckets = useMemo<FamilyBucket[]>(() => {
    if (!hierarchyIndex) {
      return [{ key: "__all__", displayName: null, sources }]
    }
    const ordered: FamilyBucket[] = []
    const byKey = new Map<string, FamilyBucket>()
    for (const source of sources) {
      const location = hierarchyIndex.get(source.evaluation_id) ?? null
      const key = location?.familyKey ?? "__unmapped__"
      const displayName = location?.familyDisplayName ?? null
      let bucket = byKey.get(key)
      if (!bucket) {
        bucket = { key, displayName, sources: [] }
        byKey.set(key, bucket)
        ordered.push(bucket)
      }
      bucket.sources.push(source)
    }
    return ordered
  }, [sources, hierarchyIndex])

  if (sources.length === 0) {
    return (
      <div className="ec-card" style={{ padding: 32, textAlign: "center" }}>
        <div className="kicker">No component benchmarks reported</div>
      </div>
    )
  }

  const renderCard = (source: NonNullable<BenchmarkEvalSummary["aggregate_sources"]>[number]) => {
    const sub = subMap.get(source.evaluation_id)
    const card = sub?.benchmark_card
    const overview = card?.benchmark_details?.overview ?? sub?.metric_config?.evaluation_description
    const goal = card?.purpose_and_intended_users?.goal
    const summaryLine = goal || overview

    return (
      <Link
        key={source.evaluation_id}
        href={`/evals/${routeIdToPath(source.evaluation_id)}?from=${encodeURIComponent(currentDetailHref)}`}
        className="fam-card group block"
        style={{ textDecoration: "none", color: "inherit" }}
      >
        <div className="flex items-start justify-between gap-2 mb-1">
          <div className="fam-card-kind">Component benchmark</div>
          <div className="fam-card-counts">
            {source.models_count} model{source.models_count === 1 ? "" : "s"}
          </div>
        </div>
        <h3 className="fam-card-name group-hover:text-[color:var(--accent)] transition-colors">
          {card?.benchmark_details?.name ?? source.composite_benchmark_name}
        </h3>
        <div className="fam-card-org">{humanizeEvaluationId(source.evaluation_id)}</div>
        {summaryLine && (
          <p className="fam-card-summary line-clamp-3">{summaryLine}</p>
        )}
        {sub?.best_model && (
          <div
            className="mt-3 pt-3 text-[12px]"
            style={{
              borderTop: "1px dashed var(--border-soft)",
              color: "var(--fg-muted)",
            }}
          >
            <span
              className="font-mono uppercase tracking-[0.12em] mr-2"
              style={{ fontSize: 9.5, color: "var(--fg-subtle)" }}
            >
              Top
            </span>
            <span style={{ color: "var(--fg)", fontWeight: 600 }}>
              {sub.best_model.name}
            </span>
            <span className="ml-1 font-mono tabular-nums" style={{ color: "var(--fg-muted)" }}>
              {(sub.best_model.score * 100).toFixed(1)}%
            </span>
          </div>
        )}
        <div
          className="mt-3 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em]"
          style={{ color: "var(--accent)" }}
        >
          Open
          <ArrowUpRight className="h-3 w-3" />
        </div>
      </Link>
    )
  }

  // Render flat when only a single bucket — the per-family headers add no
  // signal in that case (which is the typical "all components belong to one
  // family" composite).
  if (buckets.length <= 1) {
    return <div className="fam-grid">{sources.map(renderCard)}</div>
  }

  return (
    <div className="space-y-8">
      {buckets.map((bucket) => (
        <section key={bucket.key}>
          <div
            className="kicker mb-3"
            style={{ display: "flex", alignItems: "baseline", gap: 8 }}
          >
            <span>{bucket.displayName ?? "Other"}</span>
            <span style={{ color: "var(--fg-subtle)", fontWeight: 400 }}>
              · {bucket.sources.length} component{bucket.sources.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="fam-grid">{bucket.sources.map(renderCard)}</div>
        </section>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Matrix leaderboard (models × metrics) — paper-aligned ec-htable
// ---------------------------------------------------------------------------

function MatrixLeaderboard({
  summary: _summary,
  subSummaries,
  search,
  onSearchChange,
}: {
  summary: BenchmarkEvalSummary
  subSummaries: BenchmarkEvalSummary[]
  search: string
  onSearchChange: (v: string) => void
}) {
  const [sortCol, setSortCol] = useState<string>("avg")
  const [sortAsc, setSortAsc] = useState(false)
  const [page, setPage] = useState(1)
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set())
  const [minParamStep, setMinParamStep] = useState(0)
  const [maxParamStep, setMaxParamStep] = useState(PARAM_RANGE_MAX_INDEX)
  const PAGE_SIZE = 50

  const metricDirection = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const sub of subSummaries) {
      map.set(sub.evaluation_name, sub.metric_config.lower_is_better)
    }
    return map
  }, [subSummaries])

  const { models, metrics } = useMemo(() => {
    const metricNames = subSummaries.map((s) => s.evaluation_name)
    const modelScores = compositeScoresByModel(subSummaries)

    const modelList = Array.from(modelScores.entries())
      .map(([id, data]) => {
        const validScores = Array.from(data.scores.values()).filter(
          (s): s is number => s != null && Number.isFinite(s) && s > -99
        )
        const avg = validScores.length > 0
          ? validScores.reduce((a, b) => a + b, 0) / validScores.length
          : 0
        const sizeB =
          parseParamsBillionsFromModelName(data.name) ??
          parseParamsBillionsFromModelName(id)

        return { id, name: data.name, developer: data.developer, avg, scores: data.scores, sizeB }
      })

    return { models: modelList, metrics: metricNames }
  }, [subSummaries])

  const visibleMetrics = useMemo(
    () => metrics.filter((m) => !hiddenCols.has(m)),
    [metrics, hiddenCols]
  )

  const sortedModels = useMemo(() => {
    return [...models].sort((a, b) => {
      if (sortCol === "name") {
        return sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)
      }
      const aVal = sortCol === "avg" ? a.avg : (a.scores.get(sortCol) ?? -Infinity)
      const bVal = sortCol === "avg" ? b.avg : (b.scores.get(sortCol) ?? -Infinity)
      return sortAsc ? aVal - bVal : bVal - aVal
    })
  }, [models, sortCol, sortAsc])

  const numericMinParams = paramStepToNumeric(minParamStep, "min")
  const numericMaxParams = paramStepToNumeric(maxParamStep, "max")
  const [showUnknownSize, setShowUnknownSize] = useState(true)

  const hasParameterData = useMemo(() => models.some((m) => m.sizeB != null), [models])

  const query = search.trim().toLowerCase()
  const filteredModels = sortedModels.filter((m) => {
    if (query && !(
      m.name.toLowerCase().includes(query) ||
      m.developer.toLowerCase().includes(query) ||
      m.id.toLowerCase().includes(query)
    )) return false
    if (m.sizeB == null) return showUnknownSize
    if (numericMinParams != null && m.sizeB < numericMinParams) return false
    if (numericMaxParams != null && m.sizeB > numericMaxParams) return false
    return true
  })

  const pagedModels = filteredModels.slice(0, page * PAGE_SIZE)
  const hasMore = pagedModels.length < filteredModels.length

  const metricRanges = useMemo(() => {
    const ranges = new Map<string, { min: number; max: number }>()
    for (const metric of visibleMetrics) {
      const scores = models.map((m) => m.scores.get(metric)).filter(
        (s): s is number => s != null && Number.isFinite(s) && s > -99
      )
      if (scores.length > 0) {
        ranges.set(metric, { min: Math.min(...scores), max: Math.max(...scores) })
      }
    }
    return ranges
  }, [models, visibleMetrics])

  function isValidScore(score: number | null | undefined): score is number {
    return score != null && Number.isFinite(score) && score > -99
  }

  function scoreColor(metric: string, score: number): string {
    const range = metricRanges.get(metric)
    if (!range || range.max === range.min) return ""
    const lower = metricDirection.get(metric) ?? false
    const pct = lower
      ? (range.max - score) / (range.max - range.min)
      : (score - range.min) / (range.max - range.min)
    if (pct >= 0.8) return "bg-emerald-100 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200"
    if (pct >= 0.6) return "bg-sky-50 dark:bg-sky-950/30 text-sky-800 dark:text-sky-200"
    if (pct <= 0.2) return "bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-200"
    return ""
  }

  function formatScore(score: number): string {
    if (Math.abs(score) >= 100) return score.toFixed(1)
    if (Math.abs(score) >= 10) return score.toFixed(2)
    return score.toFixed(3).replace(/0+$/g, "").replace(/\.$/, "")
  }

  function handleSort(col: string) {
    if (sortCol === col) setSortAsc(!sortAsc)
    else { setSortCol(col); setSortAsc(false) }
  }

  const sortIndicator = (col: string) =>
    sortCol === col ? (sortAsc ? " ▲" : " ▼") : ""

  function toggleCol(metric: string) {
    setHiddenCols((prev) => {
      const next = new Set(prev)
      if (next.has(metric)) next.delete(metric)
      else next.add(metric)
      return next
    })
  }

  if (subSummaries.length === 0) {
    return (
      <div className="ec-card" style={{ padding: 32, textAlign: "center" }}>
        <div className="kicker">Loading component benchmark data…</div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Filter row */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:flex-wrap">
        <div className="relative w-full max-w-sm">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
            style={{ color: "var(--fg-subtle)" }}
          />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search models…"
            className="ec-input"
            style={{ paddingLeft: 36 }}
          />
        </div>

        {hasParameterData && (
          <ParamRangePicker
            variant="inline"
            headline="Params"
            minStep={minParamStep}
            maxStep={maxParamStep}
            onMinChange={setMinParamStep}
            onMaxChange={setMaxParamStep}
            onReset={() => {
              setMinParamStep(0)
              setMaxParamStep(PARAM_RANGE_MAX_INDEX)
            }}
            showUnknownSize={showUnknownSize}
            onShowUnknownSizeChange={setShowUnknownSize}
            className="min-w-[260px] flex-1 sm:max-w-[420px]"
          />
        )}

        <div
          className="font-mono uppercase tracking-[0.14em] whitespace-nowrap ml-auto"
          style={{ fontSize: 10, color: "var(--fg-subtle)" }}
        >
          {filteredModels.length} models × {visibleMetrics.length} metrics
        </div>
      </div>

      {/* Column toggles */}
      <div className="flex flex-wrap gap-1.5">
        {metrics.map((metric) => {
          const off = hiddenCols.has(metric)
          return (
            <button
              key={metric}
              type="button"
              onClick={() => toggleCol(metric)}
              className="ec-pill"
              style={{
                opacity: off ? 0.5 : 1,
                textDecoration: off ? "line-through" : "none",
                background: off ? "transparent" : "var(--bg)",
              }}
            >
              {metric}
            </button>
          )
        })}
      </div>

      {/* Matrix table */}
      <div className="overflow-x-auto" style={{ border: "1px solid var(--border-soft)" }}>
        <table className="ec-htable" style={{ tableLayout: "fixed", minWidth: "max-content" }}>
          <colgroup>
            <col style={{ width: 48 }} />
            <col style={{ width: 240 }} />
            <col style={{ width: 90 }} />
            {visibleMetrics.map((m) => (
              <col key={m} style={{ width: 130 }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th>#</th>
              <th
                onClick={() => handleSort("name")}
                style={{ cursor: "pointer" }}
              >
                Model{sortIndicator("name")}
              </th>
              <th
                className="num"
                onClick={() => handleSort("avg")}
                style={{ cursor: "pointer" }}
              >
                Avg{sortIndicator("avg")}
              </th>
              {visibleMetrics.map((metric) => (
                <th
                  key={metric}
                  className="num"
                  onClick={() => handleSort(metric)}
                  style={{ cursor: "pointer" }}
                  title={metric}
                >
                  <span className="truncate inline-block max-w-full">
                    {metric}{sortIndicator(metric)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pagedModels.map((model, idx) => (
              <tr key={model.id}>
                <td
                  className="font-mono tabular-nums"
                  style={{ color: idx < 3 ? "var(--accent)" : "var(--fg-muted)", fontSize: 12 }}
                >
                  {idx + 1}
                </td>
                <td>
                  <div className="font-semibold text-[14px] truncate">{model.name}</div>
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.08em] mt-0.5 truncate"
                    style={{ color: "var(--fg-subtle)" }}
                  >
                    {model.developer}
                  </div>
                </td>
                <td className="num font-mono tabular-nums" style={{ fontWeight: 600, fontSize: 14 }}>
                  {formatScore(model.avg)}
                </td>
                {visibleMetrics.map((metric) => {
                  const score = model.scores.get(metric)
                  const valid = isValidScore(score)
                  return (
                    <td
                      key={metric}
                      className={`num font-mono tabular-nums ${valid ? scoreColor(metric, score) : ""}`}
                      style={{ color: valid ? undefined : "var(--fg-subtle)", fontSize: 13 }}
                    >
                      {valid ? formatScore(score) : "—"}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="text-center">
          <button
            type="button"
            className="btn-ec outline"
            onClick={() => setPage((p) => p + 1)}
          >
            Load more ({filteredModels.length - pagedModels.length} remaining)
          </button>
        </div>
      )}
    </div>
  )
}
