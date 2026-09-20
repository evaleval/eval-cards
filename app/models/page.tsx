"use client"

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react"
import { ArrowRightLeft, Search, X } from "lucide-react"

import { type BenchmarkEvaluationCardData } from "@/components/benchmark-evaluation-card"
import { DeveloperTable, type DeveloperTableSortCol } from "@/components/developer-table"
import { InfiniteScrollSentinel } from "@/components/infinite-scroll"
import { ModelCompareDialog } from "@/components/model-compare-dialog"
import { ModelTable, type ModelTableSortCol } from "@/components/model-table"
import { Navigation } from "@/components/navigation"
import { PageLoadingState, type PageLoadingStage } from "@/components/page-loading-state"
import { ParamRangePicker } from "@/components/param-range-picker"
import { fetchCorpusAggregates, fetchDevelopers, fetchModelCards, fetchBenchmarkMetadata, type DeveloperListItem } from "@/lib/dashboard-data-client"
import type { BenchmarkCard } from "@/lib/benchmark-schema"
import { isOfficialDeveloper } from "@/lib/known-developers"
import { PARAM_RANGE_MAX_INDEX, paramStepToNumeric } from "@/lib/param-range"
import { OpennessFilter } from "@/components/openness-filter"
import {
  MODEL_OPENNESS_ORDER,
  matchesOpenness,
  modelOpenness,
  type ModelOpenness,
} from "@/lib/model-openness"

const PAGE_SIZE = 40
const MAX_COMPARE_MODELS = 4

type ModelSort = ModelTableSortCol
type DevSort = DeveloperTableSortCol
type SortDir = "asc" | "desc"
type DevScope = "official" | "community" | "all"

// Default sort direction per column when the user first clicks it. Numeric /
// recency columns descend (newest, biggest first); name columns ascend.
const MODEL_DEFAULT_DIR: Record<ModelSort, SortDir> = {
  name: "asc",
  developer: "asc",
  released: "desc",
  params: "desc",
  results: "desc",
}
const DEV_DEFAULT_DIR: Record<DevSort, SortDir> = {
  name: "asc",
  models: "desc",
  benchmarks: "desc",
  results: "desc",
}

function safeTimestamp(value: string | null | undefined) {
  if (!value) return 0
  const numeric = Number(value)
  if (!Number.isNaN(numeric) && !value.includes("-")) {
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000
  }
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? 0 : parsed
}

export default function ModelsPage() {
  const [evaluations, setEvaluations] = useState<BenchmarkEvaluationCardData[]>([])
  const [developers, setDevelopers] = useState<DeveloperListItem[]>([])
  const [benchmarkCards, setBenchmarkCards] = useState<Record<string, BenchmarkCard>>({})
  const [totalBenchmarksFromHeadline, setTotalBenchmarksFromHeadline] = useState<number | null>(null)
  const [modelsStageDone, setModelsStageDone] = useState(false)
  const [metadataStageDone, setMetadataStageDone] = useState(false)
  const [headlineStageDone, setHeadlineStageDone] = useState(false)
  const [loadingModels, setLoadingModels] = useState(true)
  const [loadingDevelopers, setLoadingDevelopers] = useState(false)
  const [developersReady, setDevelopersReady] = useState(false)
  const [groupByDeveloper, setGroupByDeveloper] = useState(false)
  const [modelSortBy, setModelSortBy] = useState<ModelSort>("released")
  const [modelSortDir, setModelSortDir] = useState<SortDir>("desc")
  const [developerSortBy, setDeveloperSortBy] = useState<DevSort>("models")
  const [developerSortDir, setDeveloperSortDir] = useState<SortDir>("desc")
  const [developerScope, setDeveloperScope] = useState<DevScope>("official")

  const handleModelSort = useCallback((col: ModelSort) => {
    setModelSortBy((current) => {
      if (current === col) {
        setModelSortDir((dir) => (dir === "asc" ? "desc" : "asc"))
        return current
      }
      setModelSortDir(MODEL_DEFAULT_DIR[col])
      return col
    })
  }, [])

  const handleDeveloperSort = useCallback((col: DevSort) => {
    setDeveloperSortBy((current) => {
      if (current === col) {
        setDeveloperSortDir((dir) => (dir === "asc" ? "desc" : "asc"))
        return current
      }
      setDeveloperSortDir(DEV_DEFAULT_DIR[col])
      return col
    })
  }, [])
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([])
  const [compareOpen, setCompareOpen] = useState(false)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [minParamStep, setMinParamStep] = useState(0)
  const [maxParamStep, setMaxParamStep] = useState(PARAM_RANGE_MAX_INDEX)
  const [showUnknownSize, setShowUnknownSize] = useState(true)
  // All three on by default: the filter narrows, it never hides by surprise.
  const [openness, setOpenness] = useState<ModelOpenness[]>([...MODEL_OPENNESS_ORDER])
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const numericMinParams = useMemo(() => paramStepToNumeric(minParamStep, "min"), [minParamStep])
  const numericMaxParams = useMemo(() => paramStepToNumeric(maxParamStep, "max"), [maxParamStep])

  useEffect(() => {
    const modelCardsRequest = fetchModelCards()
      .then((cards) => {
        setEvaluations(cards)
        setModelsStageDone(true)
      })
      .catch((error) => {
        console.error("Failed to load evaluations:", error)
      })

    const benchmarkMetadataRequest = fetchBenchmarkMetadata()
      .then((metadata) => {
        setBenchmarkCards(metadata)
        setMetadataStageDone(true)
      })
      .catch((error) => {
        console.error("Failed to load benchmark metadata:", error)
      })

    const corpusAggregatesRequest = fetchCorpusAggregates()
      .then((aggregates) => {
        if (typeof aggregates?.total_benchmarks === "number") {
          setTotalBenchmarksFromHeadline(aggregates.total_benchmarks)
        }
        setHeadlineStageDone(true)
      })
      .catch((error) => {
        console.error("Failed to load corpus aggregates:", error)
        setHeadlineStageDone(true)
      })

    Promise.allSettled([modelCardsRequest, benchmarkMetadataRequest, corpusAggregatesRequest])
      .finally(() => setLoadingModels(false))
  }, [])

  const totalBenchmarks = useMemo(
    () => totalBenchmarksFromHeadline ?? Object.keys(benchmarkCards).length,
    [totalBenchmarksFromHeadline, benchmarkCards],
  )

  useEffect(() => {
    if (!groupByDeveloper || developersReady || loadingDevelopers) return
    setLoadingDevelopers(true)
    fetchDevelopers()
      .then(setDevelopers)
      .catch((error) => {
        console.error("Failed to load developers:", error)
      })
      .finally(() => {
        setLoadingDevelopers(false)
        setDevelopersReady(true)
      })
  }, [developersReady, groupByDeveloper, loadingDevelopers])

  const loadingStages = useMemo<PageLoadingStage[]>(() => {
    if (groupByDeveloper && !developersReady) {
      return [
        { label: "Model index", done: modelsStageDone },
        { label: "Benchmark metadata", done: metadataStageDone },
        { label: "Corpus totals", done: headlineStageDone },
        { label: "Developer rollups", done: developersReady },
      ]
    }

    return [
      { label: "Model index", done: modelsStageDone },
      { label: "Benchmark metadata", done: metadataStageDone },
      { label: "Corpus totals", done: headlineStageDone },
    ]
  }, [developersReady, groupByDeveloper, headlineStageDone, metadataStageDone, modelsStageDone])

  // Models — filter + sort
  const sortedEvaluations = useMemo(() => {
    const query = deferredSearchQuery.trim().toLowerCase()
    let filtered = evaluations

    filtered = filtered.filter((row) => matchesOpenness(row.open_weights, openness))

    filtered = filtered.filter((row) => {
      if (row.params_billions == null) return showUnknownSize
      if (numericMinParams != null && row.params_billions < numericMinParams) return false
      if (numericMaxParams != null && row.params_billions > numericMaxParams) return false
      return true
    })

    if (query) {
      filtered = filtered.filter((row) => {
        return (
          (row.model_name ?? "").toLowerCase().includes(query) ||
          (row.canonical_model_name ?? "").toLowerCase().includes(query) ||
          (row.developer ?? "").toLowerCase().includes(query) ||
          (row.benchmark_names ?? []).some((b) => (b ?? "").toLowerCase().includes(query))
        )
      })
    }

    const dirMul = modelSortDir === "asc" ? 1 : -1
    const nameOf = (row: BenchmarkEvaluationCardData) => row.model_name ?? ""
    const developerOf = (row: BenchmarkEvaluationCardData) => row.developer ?? ""
    return filtered.slice().sort((a, b) => {
      let cmp = 0
      switch (modelSortBy) {
        case "name":
          cmp = nameOf(a).localeCompare(nameOf(b))
          break
        case "developer":
          cmp = developerOf(a).localeCompare(developerOf(b))
          break
        case "released":
          cmp = safeTimestamp(a.release_date) - safeTimestamp(b.release_date)
          break
        case "params":
          cmp = (a.params_billions ?? -1) - (b.params_billions ?? -1)
          break
        case "results":
          cmp = a.evaluations_count - b.evaluations_count
          break
      }
      // Stable tie-break by model name so equal rows don't shuffle.
      if (cmp === 0) return nameOf(a).localeCompare(nameOf(b))
      return cmp * dirMul
    })
  }, [evaluations, deferredSearchQuery, modelSortBy, modelSortDir, numericMinParams, numericMaxParams, showUnknownSize, openness])

  // Counts for the weights filter. Computed with every OTHER filter applied
  // but not this one, so the numbers describe what ticking a box would add
  // rather than collapsing to zero as boxes come off.
  const opennessCounts = useMemo(() => {
    const query = deferredSearchQuery.trim().toLowerCase()
    const tally: Partial<Record<ModelOpenness, number>> = {}
    for (const row of evaluations) {
      if (row.params_billions == null) {
        if (!showUnknownSize) continue
      } else {
        if (numericMinParams != null && row.params_billions < numericMinParams) continue
        if (numericMaxParams != null && row.params_billions > numericMaxParams) continue
      }
      if (query) {
        const hit =
          (row.model_name ?? "").toLowerCase().includes(query) ||
          (row.canonical_model_name ?? "").toLowerCase().includes(query) ||
          (row.developer ?? "").toLowerCase().includes(query) ||
          (row.benchmark_names ?? []).some((b) => (b ?? "").toLowerCase().includes(query))
        if (!hit) continue
      }
      const bucket = modelOpenness(row.open_weights)
      tally[bucket] = (tally[bucket] ?? 0) + 1
    }
    return tally
  }, [evaluations, deferredSearchQuery, numericMinParams, numericMaxParams, showUnknownSize])

  // Developers — filter + sort
  const sortedDevelopers = useMemo(() => {
    const query = deferredSearchQuery.trim().toLowerCase()
    let filtered = developers

    if (developerScope !== "all") {
      filtered = filtered.filter((dev) => {
        const official = isOfficialDeveloper(dev.developer)
        return developerScope === "official" ? official : !official
      })
    }

    if (query) {
      filtered = filtered.filter(
        (dev) =>
          (dev.developer ?? "").toLowerCase().includes(query) ||
          (dev.popular_evals ?? []).some((ev) => (ev?.benchmark ?? "").toLowerCase().includes(query)),
      )
    }

    const dirMul = developerSortDir === "asc" ? 1 : -1
    return filtered.slice().sort((a, b) => {
      const devA = a.developer ?? ""
      const devB = b.developer ?? ""
      let cmp = 0
      switch (developerSortBy) {
        case "name":
          cmp = devA.localeCompare(devB)
          break
        case "models":
          cmp = a.model_count - b.model_count
          break
        case "benchmarks":
          cmp = a.benchmark_count - b.benchmark_count
          break
        case "results":
          cmp = a.evaluation_count - b.evaluation_count
          break
      }
      if (cmp === 0) return devA.localeCompare(devB)
      return cmp * dirMul
    })
  }, [developers, deferredSearchQuery, developerSortBy, developerSortDir, developerScope])

  // Reset visible window when filter/sort changes
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [groupByDeveloper, modelSortBy, modelSortDir, developerSortBy, developerSortDir, developerScope, deferredSearchQuery, minParamStep, maxParamStep, showUnknownSize, openness])

  const totalCount = groupByDeveloper ? sortedDevelopers.length : sortedEvaluations.length
  const visibleEvaluations = useMemo(
    () => sortedEvaluations.slice(0, visibleCount),
    [sortedEvaluations, visibleCount],
  )
  const visibleDevelopers = useMemo(
    () => sortedDevelopers.slice(0, visibleCount),
    [sortedDevelopers, visibleCount],
  )
  const hasMore = visibleCount < totalCount
  const handleLoadMore = useCallback(() => {
    setVisibleCount((current) => Math.min(current + PAGE_SIZE, totalCount))
  }, [totalCount])

  const toggleModelSelection = useCallback((id: string) => {
    setSelectedModelIds((current) => {
      if (current.includes(id)) return current.filter((existing) => existing !== id)
      if (current.length >= MAX_COMPARE_MODELS) return current
      return [...current, id]
    })
  }, [])

  const selectedModels = useMemo(
    () =>
      selectedModelIds
        .map((id) => evaluations.find((evaluation) => evaluation.id === id))
        .filter((evaluation): evaluation is BenchmarkEvaluationCardData => Boolean(evaluation)),
    [evaluations, selectedModelIds],
  )

  const loading = loadingModels || (groupByDeveloper && !developersReady)
  const totalResults = useMemo(
    () => sortedEvaluations.reduce((sum, row) => sum + row.evidence_count, 0),
    [sortedEvaluations],
  )

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <main className="mx-auto w-full max-w-[96rem] px-4 pt-12 pb-24 sm:px-8">
        {/* HEADER --------------------------------------------------- */}
        <div className="kicker">Index</div>
        <h1 className="ec-page-h1">{groupByDeveloper ? "Model developers" : "Models"}</h1>
        <p className="ec-page-lede">
          {groupByDeveloper
            ? "Every reporting organization in the corpus and the breadth of evaluation it ships."
            : (
              <>
                Every indexed model and the shape of its published evaluation record across{" "}
                <span className="font-mono text-[13px]">
                  {totalBenchmarks.toLocaleString()}
                </span>{" "}
                benchmarks reported on by the developer (or a third party).
              </>
            )}
        </p>

        {/* META + FILTER BAR — single row -------------------------- */}
        <div className="mb-6 flex flex-wrap items-center gap-x-8 gap-y-3 border-y border-[color:var(--border-soft)] py-4">
          {/* Inline meta — mono kicker stat strip */}
          <div className="flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-[11px] tracking-[0.1em] uppercase text-[color:var(--fg-subtle)]">
            <span>
              <span className="text-[color:var(--fg)] tabular-nums font-semibold mr-1">
                {totalCount.toLocaleString()}
              </span>
              {groupByDeveloper ? "developers" : "models"}
            </span>
            {!groupByDeveloper && (
              <span>
                · <span className="text-[color:var(--fg)] tabular-nums font-semibold mr-1">{totalResults.toLocaleString()}</span>
                results
              </span>
            )}
            {!groupByDeveloper && (
              <span>
                · <span className="text-[color:var(--fg)] tabular-nums font-semibold mr-1">{selectedModels.length}/{MAX_COMPARE_MODELS}</span>
                selected to compare
              </span>
            )}
          </div>

          <span className="hidden h-5 w-px bg-[color:var(--border-soft)] sm:block" />

          <div className="ec-mode-toggle">
            <button
              type="button"
              className={!groupByDeveloper ? "on" : ""}
              onClick={() => setGroupByDeveloper(false)}
            >
              Models
            </button>
            <button
              type="button"
              className={groupByDeveloper ? "on" : ""}
              onClick={() => setGroupByDeveloper(true)}
            >
              Developers
            </button>
          </div>

          {groupByDeveloper && (
            <div className="ec-mode-toggle" role="group" aria-label="Developer scope">
              <button
                type="button"
                className={developerScope === "official" ? "on" : ""}
                onClick={() => setDeveloperScope("official")}
              >
                Official
              </button>
              <button
                type="button"
                className={developerScope === "community" ? "on" : ""}
                onClick={() => setDeveloperScope("community")}
              >
                Community
              </button>
              <button
                type="button"
                className={developerScope === "all" ? "on" : ""}
                onClick={() => setDeveloperScope("all")}
              >
                All
              </button>
            </div>
          )}

          <div className="relative ml-auto min-w-[180px] flex-1 sm:max-w-[360px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--fg-subtle)]" />
            <input
              className="ec-input pl-9"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={
                groupByDeveloper ? "Search developers…" : "Search model or developer…"
              }
            />
          </div>

        </div>

        {/* PARAM RANGE — its own row so the rail has room to breathe.
            Sharing the toolbar with stats / search / sort squished it. */}
        {!groupByDeveloper && (
          <div className="mb-6 -mt-2">
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
            />
            <div className="mt-3">
              <OpennessFilter
                selected={openness}
                onChange={setOpenness}
                counts={opennessCounts}
              />
            </div>
          </div>
        )}

        {/* TABLE ---------------------------------------------------- */}
        {loading ? (
          <PageLoadingState
            title={groupByDeveloper ? "Loading developers" : "Loading models"}
            description={
              groupByDeveloper
                ? "Refreshing the model index, benchmark metadata, and developer rollups."
                : "Refreshing the model index, benchmark metadata, and corpus totals."
            }
            stages={loadingStages}
            className="py-14"
          />
        ) : totalCount === 0 ? (
          <div className="py-16 text-center border border-dashed border-[color:var(--border-soft)] bg-[color:var(--bg-warm)]">
            <p className="mb-4 text-base text-[color:var(--fg-muted)]">
              {groupByDeveloper
                ? "No developers found matching your filters."
                : "No models found matching your filters."}
            </p>
            <button
              type="button"
              className="btn-ec outline"
              onClick={() => {
                setSearchQuery("")
                setModelSortBy("released")
                setModelSortDir("desc")
                setDeveloperSortBy("models")
                setDeveloperSortDir("desc")
                setDeveloperScope("all")
              }}
            >
              Reset filters
            </button>
          </div>
        ) : groupByDeveloper ? (
          <DeveloperTable
            rows={visibleDevelopers}
            sortCol={developerSortBy}
            sortDir={developerSortDir}
            onSort={handleDeveloperSort}
          />
        ) : (
          <ModelTable
            rows={visibleEvaluations}
            selectedIds={selectedModelIds}
            onToggleSelect={toggleModelSelection}
            maxCompare={MAX_COMPARE_MODELS}
            sortCol={modelSortBy}
            sortDir={modelSortDir}
            onSort={handleModelSort}
          />
        )}

        <InfiniteScrollSentinel
          hasMore={hasMore}
          onLoadMore={handleLoadMore}
          loadingLabel="Loading more…"
          endLabel={`Showing ${Math.min(visibleCount, totalCount).toLocaleString()} of ${totalCount.toLocaleString()} ${groupByDeveloper ? "developers" : "models"}`}
        />

        {/* COMPARE TRAY (sticky bottom) ---------------------------- */}
        {!groupByDeveloper && selectedModels.length > 0 && (
          <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
            <div className="pointer-events-auto w-full max-w-5xl border border-[color:var(--fg)] bg-[color:var(--bg)] p-4 shadow-[var(--shadow-card)]">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="space-y-2">
                  <div className="kicker">Models selected to compare</div>
                  <div className="flex flex-wrap gap-2">
                    {selectedModels.map((model) => (
                      <span
                        key={model.id}
                        className="inline-flex items-center gap-2 border border-[color:var(--border-soft)] bg-[color:var(--bg-warm)] px-3 py-1.5 text-sm"
                      >
                        <span className="font-medium text-[color:var(--fg)]">
                          {model.model_name}
                        </span>
                        <button
                          type="button"
                          onClick={() => toggleModelSelection(model.id)}
                          className="text-[color:var(--fg-muted)] transition-colors hover:text-[color:var(--fg)]"
                          aria-label={`Remove ${model.model_name} from compare`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn-ec ghost"
                    onClick={() => setSelectedModelIds([])}
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={() => setCompareOpen(true)}
                    disabled={selectedModels.length < 2}
                    className="btn-ec disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <ArrowRightLeft className="h-3.5 w-3.5" />
                    Compare {selectedModels.length}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      <ModelCompareDialog
        models={selectedModels}
        open={compareOpen}
        onOpenChange={setCompareOpen}
      />
    </div>
  )
}
