"use client"

/**
 * Protocol-axis filter state, owned by the URL.
 *
 * The metric, slice and source controls already read Next's search params
 * and write through its router. Protocol filters join them rather than
 * keeping a second copy: state is derived from the search params, so back
 * and forward move the buttons, and a metric change rebuilds its query
 * from a snapshot that already contains the protocol keys instead of
 * dropping them.
 *
 * Axis names arrive from the URL, so they are read as own properties of a
 * Map and accepted only when the page actually has that column. Without
 * that, `?protocol.__proto__=x` reads an inherited value and the page
 * throws before it renders.
 */

import { useCallback, useMemo } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

const PROTOCOL_FILTER_PARAM_PREFIX = "protocol."

export type ProtocolFilterSelection = ReadonlyMap<string, readonly string[]>

/** The query string the page is currently at, from whichever source can
 *  answer: Next's params inside the app, the address bar otherwise. */
function currentQuery(params: URLSearchParams | null): URLSearchParams {
  if (params) return new URLSearchParams(params.toString())
  if (typeof window !== "undefined") return new URLSearchParams(window.location.search)
  return new URLSearchParams()
}

export function parseProtocolFilters(
  query: URLSearchParams,
  axisKeys: readonly string[],
): Map<string, string[]> {
  const known = new Set(axisKeys)
  const selected = new Map<string, string[]>()
  for (const [key, value] of query.entries()) {
    if (!key.startsWith(PROTOCOL_FILTER_PARAM_PREFIX)) continue
    const axis = key.slice(PROTOCOL_FILTER_PARAM_PREFIX.length)
    if (!axis || !known.has(axis)) continue
    const current = selected.get(axis)
    if (current) current.push(value)
    else selected.set(axis, [value])
  }
  return selected
}

export function useProtocolFilters(axisKeys: readonly string[]): {
  selected: ProtocolFilterSelection
  activeCount: number
  toggle: (axisKey: string, optionId: string) => void
  clear: () => void
} {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const axisKey = axisKeys.join("\u0000")
  const search = searchParams?.toString() ?? ""

  const selected = useMemo(
    () => parseProtocolFilters(currentQuery(searchParams), axisKey ? axisKey.split("\u0000") : []),
    // `search` and `axisKey` are the values that change the result; the
    // params object identity is not stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search, axisKey],
  )

  const activeCount = useMemo(() => {
    let total = 0
    for (const ids of selected.values()) total += ids.length
    return total
  }, [selected])

  const commit = useCallback(
    (next: ProtocolFilterSelection) => {
      const query = currentQuery(searchParams)
      for (const key of Array.from(query.keys())) {
        if (key.startsWith(PROTOCOL_FILTER_PARAM_PREFIX)) query.delete(key)
      }
      for (const [axis, ids] of next) {
        for (const id of ids) query.append(`${PROTOCOL_FILTER_PARAM_PREFIX}${axis}`, id)
      }
      const qs = query.toString()
      const base = pathname ?? (typeof window !== "undefined" ? window.location.pathname : "")
      router.replace(qs ? `${base}?${qs}` : base, { scroll: false })
    },
    [pathname, router, searchParams],
  )

  const toggle = useCallback(
    (axis: string, optionId: string) => {
      const next = new Map(selected)
      const current = next.get(axis) ?? []
      const ids = current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId]
      if (ids.length > 0) next.set(axis, ids)
      else next.delete(axis)
      commit(next)
    },
    [commit, selected],
  )

  const clear = useCallback(() => commit(new Map()), [commit])

  return { selected, activeCount, toggle, clear }
}
