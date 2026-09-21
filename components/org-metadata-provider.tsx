"use client"

import Link from "next/link"
import { createContext, useContext, useMemo } from "react"

import { evaluatorSlugFor, type OrgMetaMap } from "@/lib/evaluators"
import { cn } from "@/lib/utils"

/**
 * Makes the per-org registry metadata (from the organizations.json sidecar)
 * available app-wide, keyed by normalizeOrgKey(displayName). It carries each
 * org's stable canonical `id`, which is what evaluator URLs are slugged from —
 * so renaming an org's display name never changes its /evaluators/<slug> URL.
 *
 * Fetched once server-side in the root layout and handed down as a plain
 * (serializable) object, so the slug is correct on first render with no flash.
 */
const OrgMetadataContext = createContext<OrgMetaMap>({})

export function OrgMetadataProvider({
  value,
  children,
}: {
  value: OrgMetaMap
  children: React.ReactNode
}) {
  return <OrgMetadataContext.Provider value={value ?? {}}>{children}</OrgMetadataContext.Provider>
}

/**
 * The orgs that actually have an /evaluators/<slug> page, from the eval
 * list's own evaluator names. Empty is the default, and it means no name
 * may be linked: a href built from an arbitrary display string is a
 * guaranteed 404, so an index that is missing or failed to load costs a
 * link rather than producing a broken one. Provided only by the route
 * segments that render evaluator links, so a page that shows none never
 * pays for the lookup.
 */
const EvaluatorIndexContext = createContext<ReadonlySet<string>>(new Set())

export function EvaluatorIndexProvider({
  names,
  children,
}: {
  /** Every name in any eval's `evaluator_names`. */
  names: string[] | null | undefined
  children: React.ReactNode
}) {
  const index = useMemo(
    () => new Set((names ?? []).map((name) => name.trim().toLowerCase())),
    [names],
  )
  return <EvaluatorIndexContext.Provider value={index}>{children}</EvaluatorIndexContext.Provider>
}

/** Raw display→metadata map (homepage url, logo, canonical id). */
export function useOrgMetadata(): OrgMetaMap {
  return useContext(OrgMetadataContext)
}

/**
 * Returns the canonical, rename-stable slug function bound to the current org
 * metadata. Use this everywhere an /evaluators/<slug> link is built so the
 * whole app agrees on one URL per org.
 */
export function useEvaluatorSlug(): (name: string) => string {
  const orgMeta = useContext(OrgMetadataContext)
  return useMemo(() => (name: string) => evaluatorSlugFor(name, orgMeta), [orgMeta])
}

/**
 * True when the name has an evaluator page to link to. False whenever the
 * index cannot say so, including when it was never provided: an evaluator
 * name with no page renders as text, never as a link into a 404.
 */
export function useKnownEvaluator(): (name: string | null | undefined) => boolean {
  const index = useContext(EvaluatorIndexContext)
  return useMemo(
    () => (name: string | null | undefined) =>
      Boolean(name && index.has(name.trim().toLowerCase())),
    [index],
  )
}

/**
 * Render an evaluator org name. The name links to /evaluators/<slug>
 * only when it is a known evaluator, one that appears in some eval's
 * `evaluator_names`, so a study title or a raw source string renders as
 * plain text instead of pointing at a page that does not exist. The slug
 * uses the shared, deterministic `evaluatorSlug` base helper.
 */
export function EvaluatorName({
  display,
  linkName,
  className,
  style,
}: {
  display: React.ReactNode
  linkName: string | null
  className?: string
  style?: React.CSSProperties
}) {
  const slugFor = useEvaluatorSlug()
  const isKnownEvaluator = useKnownEvaluator()
  if (!linkName || !isKnownEvaluator(linkName)) {
    return <span className={className} style={style}>{display}</span>
  }
  return (
    <Link
      href={`/evaluators/${slugFor(linkName)}`}
      className={cn("hover:text-[color:var(--accent)] hover:underline", className)}
      style={style}
      onClick={(e) => e.stopPropagation()}
    >
      {display}
    </Link>
  )
}
