"use client"

import { startTransition, useCallback, useEffect, useMemo, useState } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ArrowLeft } from "lucide-react"
import { Navigation } from "@/components/navigation"
import { ReaderModeBar } from "@/components/reader-mode-bar"
import { BenchmarkDetail, comparisonRouteIdOf } from "@/components/benchmark-detail"
import type { BenchmarkCard, ModelEvaluationSummary } from "@/lib/eval-processing"
import {
  fetchBenchmarkMetadata,
  fetchEvalHierarchy,
  fetchModelSummary,
  fetchModelCards,
} from "@/lib/dashboard-data-client"
import type { BenchmarkEvaluationCardData } from "@/components/benchmark-evaluation-card"
import type { EvalHierarchy } from "@/lib/backend-artifacts"
import { useComparisonIndex } from "@/lib/use-comparison-index"
import { routeIdFromSegments, routeIdToPath } from "@/lib/utils"

export default function ModelDetailPage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [summary, setSummary] = useState<ModelEvaluationSummary | null>(null)
  const [benchmarkCards, setBenchmarkCards] = useState<Record<string, BenchmarkCard>>({})
  const [modelCards, setModelCards] = useState<BenchmarkEvaluationCardData[]>([])
  const [evalHierarchy, setEvalHierarchy] = useState<EvalHierarchy | null>(null)
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const routeId = routeIdFromSegments(params.id as string | string[])

  const getVariantFromQuery = useCallback(
    (modelSummary: ModelEvaluationSummary) => {
      const requestedVersion = searchParams.get("version")

      if (!requestedVersion || modelSummary.variants.length === 0) {
        return modelSummary.variants[0] ?? null
      }

      return (
        modelSummary.variants.find(
          (variant) =>
            variant.variant_key === requestedVersion ||
            variant.variant_id === requestedVersion
        ) ?? modelSummary.variants[0] ?? null
      )
    },
    [searchParams]
  )

  const handleBack = useCallback(() => {
    if (typeof window !== "undefined") {
      const referrer = document.referrer

      if (referrer) {
        try {
          const referrerUrl = new URL(referrer)
          if (referrerUrl.origin === window.location.origin) {
            router.back()
            return
          }
        } catch {
          // Fall through to a deterministic in-app destination.
        }
      }
    }

    router.push("/models")
  }, [router])

  const handleVariantChange = useCallback(
    (nextVariantId: string) => {
      setSelectedVariantId(nextVariantId)

      if (!summary || summary.variants.length <= 1 || !routeId) {
        return
      }

      const nextVariant = summary.variants.find((variant) => variant.variant_id === nextVariantId)
      if (!nextVariant) {
        return
      }

      const nextParams = new URLSearchParams(searchParams.toString())
      const currentVersion = nextParams.get("version")
      const nextVersion = nextVariant.variant_key

      if (currentVersion === nextVersion) {
        return
      }

      nextParams.set("version", nextVersion)
      const nextQuery = nextParams.toString()
      router.replace(
        nextQuery ? `/models/${routeIdToPath(routeId)}?${nextQuery}` : `/models/${routeIdToPath(routeId)}`,
        { scroll: false }
      )
    },
    [routeId, router, searchParams, summary]
  )

  useEffect(() => {
    let isCancelled = false

    const loadCoreData = async () => {
      try {
        const [modelSummary, cards, hierarchy] = await Promise.all([
          fetchModelSummary(routeId),
          fetchBenchmarkMetadata(),
          fetchEvalHierarchy().catch((err) => {
            console.warn("Failed to load eval-hierarchy:", err)
            return null as EvalHierarchy | null
          }),
        ])
        if (isCancelled) {
          return
        }

        setSummary(modelSummary)
        setBenchmarkCards(cards)
        setEvalHierarchy(hierarchy)
        setSelectedVariantId((current) => current ?? modelSummary.variants[0]?.variant_id ?? null)
      } catch (err) {
        if (isCancelled) {
          return
        }

        console.error("Failed to load model:", err)
        setError("Failed to load model data")
      } finally {
        if (!isCancelled) {
          setLoading(false)
        }
      }
    }

    loadCoreData()

    return () => {
      isCancelled = true
    }
  }, [routeId])

  useEffect(() => {
    let isCancelled = false

    const loadAuxiliaryData = async () => {
      const allModelCards = await fetchModelCards().catch((err) => {
        console.warn("Failed to load model cards:", err)
        return [] as BenchmarkEvaluationCardData[]
      })

      if (isCancelled) {
        return
      }

      startTransition(() => {
        setModelCards(allModelCards)
      })
    }

    loadAuxiliaryData()

    return () => {
      isCancelled = true
    }
  }, [routeId])

  useEffect(() => {
    if (!summary?.variants.length) {
      return
    }

    const requestedVariant = getVariantFromQuery(summary)
    if (requestedVariant && requestedVariant.variant_id !== selectedVariantId) {
      setSelectedVariantId(requestedVariant.variant_id)
    }
  }, [getVariantFromQuery, searchParams, summary])

  useEffect(() => {
    if (!summary?.variants.length || !routeId) {
      return
    }

    const requestedVersion = searchParams.get("version")
    if (!requestedVersion) {
      return
    }

    const matchesKnownVariant = summary.variants.some(
      (variant) =>
        variant.variant_key === requestedVersion ||
        variant.variant_id === requestedVersion
    )

    if (matchesKnownVariant) {
      return
    }

    const nextParams = new URLSearchParams(searchParams.toString())
    nextParams.delete("version")
    const nextQuery = nextParams.toString()

    router.replace(
      nextQuery ? `/models/${routeIdToPath(routeId)}?${nextQuery}` : `/models/${routeIdToPath(routeId)}`,
      { scroll: false }
    )
  }, [routeId, router, searchParams, summary])

  const selectedVariant = useMemo(() => {
    if (!summary) {
      return null
    }

    if (!summary.variants.length) {
      return summary
    }

    return (
      summary.variants.find((variant) => variant.variant_id === selectedVariantId) ??
      summary.variants[0]
    )
  }, [selectedVariantId, summary])

  const comparisonSummary = selectedVariant ?? summary
  const comparisonIndex = useComparisonIndex(
    comparisonSummary ? { model: comparisonRouteIdOf(comparisonSummary) } : null,
  )

  useEffect(() => {
    if (!summary) {
      return
    }

    const titleParts = [summary.model_family_name]
    if (selectedVariant && "variant_key" in selectedVariant && selectedVariant.variant_key !== "base") {
      titleParts.push(selectedVariant.variant_label)
    }

    document.title = `${titleParts.join(" · ")} - AI Evaluation Dashboard`
  }, [selectedVariant, summary])

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <ReaderModeBar />
        <main className="ec-page">
          <div className="flex items-center justify-center h-96">
            <div className="kicker">Loading model record…</div>
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
            <div className="kicker">{error || "Model not found"}</div>
            <button type="button" onClick={handleBack} className="btn-ec outline">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </button>
          </div>
        </main>
      </div>
    )
  }

  const detailSummary = selectedVariant ?? summary
  const hasVariantTabs = summary.variants.length > 1

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
          Models
        </button>

        {hasVariantTabs ? (
          <div className="mb-8 border-y border-[var(--border-soft)] py-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="kicker">Versions</span>
              <div className="flex flex-wrap gap-1.5">
                {summary.variants.map((variant) => (
                  <button
                    key={variant.variant_id}
                    type="button"
                    onClick={() => handleVariantChange(variant.variant_id)}
                    className={`ec-pill ${
                      (selectedVariantId ?? summary.variants[0].variant_id) === variant.variant_id ? "on" : ""
                    }`}
                  >
                    {variant.variant_label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        <BenchmarkDetail
          summary={detailSummary}
          benchmarkCards={benchmarkCards}
          modelCards={modelCards}
          evalHierarchy={evalHierarchy}
          comparisonIndex={comparisonIndex}
        />
      </main>
    </div>
  )
}
