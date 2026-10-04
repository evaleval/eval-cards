"use client"

import { useEffect, useState } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { BenchmarkDetail, comparisonRouteIdOf } from "@/components/benchmark-detail"
import {
  fetchBenchmarkMetadata,
  fetchEvalHierarchy,
  fetchModelSummary,
} from "@/lib/dashboard-data-client"
import { routeIdFromSegments } from "@/lib/utils"
import type { BenchmarkCard } from "@/lib/benchmark-schema"
import type { EvalHierarchy } from "@/lib/backend-artifacts"
import { useComparisonIndex } from "@/lib/use-comparison-index"

/**
 * Embed-only render of a single model/benchmark histogram plotbox.
 * Reuses <BenchmarkDetail> with embedSurface="histogram" so the on-page
 * plotbox (split picker, view selector, peer rank, cross-family whisker,
 * setup notes) renders unchanged — the host page just hides the rest of
 * the model detail.
 *
 * URL shape:
 *   /embed/eval/histogram/<evalId>?model=<modelRouteId>
 *
 * The model route id arrives in slash form (e.g. "openai/gpt-4o");
 * `routeIdFromSegments` converts it back to the `%2F` form the data
 * backend expects.
 */
export default function EmbedEvalHistogram() {
  const params = useParams()
  const searchParams = useSearchParams()
  const evalId = routeIdFromSegments(params.id)
  const modelParam = searchParams.get("model") ?? ""
  const modelRouteId = routeIdFromSegments(modelParam)

  const [summary, setSummary] = useState<Awaited<ReturnType<typeof fetchModelSummary>> | null>(null)
  const [benchmarkCards, setBenchmarkCards] = useState<Record<string, BenchmarkCard>>({})
  const [evalHierarchy, setEvalHierarchy] = useState<EvalHierarchy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const comparisonIndex = useComparisonIndex(summary ? { model: comparisonRouteIdOf(summary) } : null)

  useEffect(() => {
    if (!modelRouteId) {
      setError("Missing ?model=<routeId> query parameter")
      return
    }
    let cancelled = false
    Promise.all([
      fetchModelSummary(modelRouteId),
      fetchBenchmarkMetadata(),
      fetchEvalHierarchy().catch(() => null),
    ])
      .then(([modelSummary, cards, hierarchy]) => {
        if (cancelled) return
        setSummary(modelSummary)
        setBenchmarkCards(cards)
        setEvalHierarchy(hierarchy)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
    }
  }, [modelRouteId])

  if (error) {
    return (
      <div className="font-mono" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
        Failed to load: {error}
      </div>
    )
  }
  if (!summary) {
    return (
      <div
        className="font-mono uppercase"
        style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--fg-subtle)" }}
      >
        Loading…
      </div>
    )
  }

  return (
    <BenchmarkDetail
      summary={summary}
      benchmarkCards={benchmarkCards}
      evalHierarchy={evalHierarchy}
      comparisonIndex={comparisonIndex}
      embedSurface="histogram"
      embedTargetEvalId={evalId}
    />
  )
}
