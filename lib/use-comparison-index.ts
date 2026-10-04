import { startTransition, useEffect, useState } from "react"

import type { ComparisonIndex } from "@/lib/backend-artifacts"
import {
  fetchComparisonIndexForEvals,
  fetchComparisonIndexForModel,
} from "@/lib/dashboard-data-client"

export type ComparisonIndexRequest = { model: string } | { evals: string[] }

function requestKey(request: ComparisonIndexRequest | null): string | null {
  if (!request) return null
  if ("model" in request) return request.model ? `model:${request.model}` : null
  const ids = [...new Set(request.evals)].sort()
  return ids.length > 0 ? `evals:${JSON.stringify(ids)}` : null
}

function fetchForKey(key: string): Promise<ComparisonIndex> {
  if (key.startsWith("model:")) return fetchComparisonIndexForModel(key.slice("model:".length))
  return fetchComparisonIndexForEvals(JSON.parse(key.slice("evals:".length)) as string[])
}

/**
 * The comparison-index slice `request` names. Null while it loads, when it
 * fails to load and when there is no request; never a slice that was fetched
 * for an earlier request.
 */
export function useComparisonIndex(request: ComparisonIndexRequest | null): ComparisonIndex | null {
  const key = requestKey(request)
  const [loaded, setLoaded] = useState<{ key: string; index: ComparisonIndex } | null>(null)

  useEffect(() => {
    if (!key) return
    let cancelled = false
    fetchForKey(key)
      .then((index) => {
        if (!cancelled) startTransition(() => setLoaded({ key, index }))
      })
      .catch((err) => {
        console.warn("Failed to load comparison-index:", err)
      })
    return () => {
      cancelled = true
    }
  }, [key])

  return loaded != null && loaded.key === key ? loaded.index : null
}
