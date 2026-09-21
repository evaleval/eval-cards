"use client"

import { Fragment, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowUpRight, ChevronDown, ChevronRight, ChevronUp } from "lucide-react"

import type { HierarchyBenchmark, HierarchyComposite, HierarchyFamily } from "@/lib/backend-artifacts"
import { candidateBenchmarkKeys } from "@/lib/benchmark-metadata-utils"
import { formatTagLabel } from "@/lib/benchmark-tags"
import type { BenchmarkCard } from "@/lib/benchmark-schema"
import type { BenchmarkEvalListItem } from "@/lib/eval-processing"
import { routeIdFromSegments, routeIdToPath } from "@/lib/utils"

const LEAVES_INLINE_MAX = 50

export type FamilySortCol = "name" | "benchmarks" | "results"

interface FamilyTableProps {
  families: HierarchyFamily[]
  evalItems?: Map<string, BenchmarkEvalListItem>
  benchmarkCards?: Record<string, BenchmarkCard>
  domainFilter?: Set<string> | null
  categoryFilter?: Set<string> | null
  /** Live search query from the page-level filter. The page already
   *  decided which families pass; FamilyTable uses the same query to
   *  narrow each row's visible leaves to the matches and auto-expand. */
  searchQuery?: string
  /** When provided, restrict leaves to those mapping to one of these
   *  evaluation_ids (drives the /evals "Verified only" filter in Family
   *  mode — the set is the verified-eval id universe). Null/undefined =
   *  no restriction. */
  verifiedEvalIds?: Set<string> | null
  /** When provided, restrict leaves to those mapping to one of these
   *  evaluation_ids (drives the /evaluators/<slug> detail page — the set is
   *  the eval-id universe owned by one reporting org). Composes with
   *  verifiedEvalIds: when both are present a leaf must intersect both.
   *  Null/undefined = no restriction. */
  restrictEvalIds?: Set<string> | null
  sortCol?: FamilySortCol
  sortDir?: "asc" | "desc"
  onSort?: (col: FamilySortCol) => void
}

function slugify(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "")
}

const FAMILY_KEY_ACRONYMS = new Set([
  "llm", "llms", "aa", "hf", "api", "cli", "sql", "gpt", "qa", "ai", "ml",
  "nlp", "rl", "vqa", "vlm", "mt", "cv",
  // Security / safety / red-team families.
  "ctf", "cve", "gdm",
])
function humanizeFamilyKey(key: string): string {
  return key
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) => {
      if (FAMILY_KEY_ACRONYMS.has(word.toLowerCase())) return word.toUpperCase()
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    })
    .join("-")
}

interface LeafEntry {
  id: string
  /** All evaluation_ids this leaf maps to (constituent ids or fallbacks). */
  evalIds: string[]
  /** Canonical benchmark id when a merged all-sources page exists for this
   *  node; null on older snapshots / synthetic nodes → per-source link. */
  benchmarkId: string | null
  leafKey: string
  leafName: string
  evalsCount: number
  domains: string[]
  tags: string[]
  description?: string | null
  sliceCount: number
}

/** A section inside the family accordion.
 *  "composite" — benchmarks that belong to a named composite group.
 *  "flat"      — standalone / direct benchmarks with no composite wrapper. */
interface AccordionSection {
  type: "composite" | "flat"
  key: string
  name: string
  description?: string | null
  leaves: LeafEntry[]
}

/**
 * A card for one hierarchy node.
 *
 * Card keys are normalized benchmark NAMES ("swe bench pro"), while a
 * hierarchy node is keyed by slug ("swe-bench-pro") and its eval ids
 * carry a source prefix ("aisi-inference-scaling%2Fswe-bench-pro"). A
 * raw index into the card map therefore misses every node whose slug
 * spells its name with hyphens, which is why some tiles showed an
 * overview and their neighbours showed none. Normalize each name the
 * node offers and take the first exact hit — no fuzzy substring step,
 * so a node with no card of its own never borrows a neighbour's
 * description.
 */
function findLeafCard(
  cards: Record<string, BenchmarkCard> | undefined,
  names: (string | null | undefined)[],
): BenchmarkCard | undefined {
  if (!cards) return undefined
  for (const name of names) {
    if (!name) continue
    for (const key of candidateBenchmarkKeys(name)) {
      const card = cards[key]
      if (card) return card
    }
  }
  return undefined
}

/** The benchmark's own name inside a per-source eval id, e.g.
 *  "aisi-inference-scaling%2Fswe-bench-pro" → "swe-bench-pro". */
function evalIdLeafName(evalId: string): string {
  const decoded = decodeLoose(evalId)
  const parts = decoded.split("/")
  return parts[parts.length - 1] ?? decoded
}

function buildLeafEntry(
  benchmark: HierarchyBenchmark,
  famKey: string,
  benchmarkCards?: Record<string, BenchmarkCard>,
): LeafEntry | null {
  const summaryIds = benchmark.constituent_evaluation_ids ?? []
  const ids = summaryIds.length > 0
    ? summaryIds
    : benchmark.key ? [`${famKey}_${benchmark.key}`, benchmark.key] : []
  if (ids.length === 0) return null

  const collected = new Set<string>()
  for (const d of benchmark.tags?.domains ?? []) collected.add(d.toLowerCase())
  const card = findLeafCard(benchmarkCards, [
    benchmark.key,
    benchmark.display_name,
    ...ids.map(evalIdLeafName),
  ])
  for (const d of card?.benchmark_details?.domains ?? []) collected.add(d.toLowerCase())

  const description = card?.benchmark_details?.overview ?? null

  return {
    id: ids[0],
    evalIds: ids,
    benchmarkId: benchmark.benchmark_id ?? null,
    leafKey: benchmark.key,
    leafName: benchmark.display_name || benchmark.key,
    evalsCount: ids.length,
    domains: Array.from(collected),
    tags: benchmark.derivedTags ?? [],
    description: description
      ? description.length > 120 ? description.slice(0, 117) + "…" : description
      : null,
    sliceCount: benchmark.slices?.length ?? 0,
  }
}

function decodeLoose(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Where a leaf click lands (merged-benchmark-view spec F2): when the
 * node carries the producer's `benchmark_id`, route to the merged
 * all-sources page with the clicked leaf's source pre-highlighted via
 * `?source=<composite_slug>` (derived from the leaf's per-source eval
 * id's first segment). Nodes without a benchmark_id (older snapshots,
 * client-side re-keyed/synthetic nodes) keep today's per-source link.
 */
function leafNavHref(leaf: LeafEntry): string {
  if (leaf.benchmarkId) {
    const mergedPath = routeIdFromSegments(leaf.benchmarkId)
    const sourceSlug = leaf.id.includes("%2F") ? decodeLoose(leaf.id.split("%2F")[0]) : ""
    const query = sourceSlug ? `?source=${encodeURIComponent(sourceSlug)}` : ""
    return `/evals/${mergedPath}${query}`
  }
  return `/evals/${routeIdToPath(leaf.id)}`
}

function collectFamilySections(
  fam: HierarchyFamily,
  benchmarkCards?: Record<string, BenchmarkCard>,
): AccordionSection[] {
  const sections: AccordionSection[] = []

  // 1. Composite groups first
  for (const composite of fam.composites ?? []) {
    const leaves: LeafEntry[] = []
    for (const bench of composite.benchmarks ?? []) {
      const entry = buildLeafEntry(bench, fam.key, benchmarkCards)
      if (entry) leaves.push(entry)
    }
    if (leaves.length === 0) continue
    const compDesc =
      findLeafCard(benchmarkCards, [composite.key, composite.display_name])?.benchmark_details
        ?.overview ?? null
    sections.push({
      type: "composite",
      key: composite.key,
      name: composite.display_name || composite.key,
      description: compDesc
        ? compDesc.length > 120 ? compDesc.slice(0, 117) + "…" : compDesc
        : null,
      leaves,
    })
  }

  // 2. Standalone + direct benchmarks — flat section (no header)
  const flatLeaves: LeafEntry[] = []
  for (const bench of [...(fam.standalone_benchmarks ?? []), ...(fam.benchmarks ?? [])]) {
    const entry = buildLeafEntry(bench, fam.key, benchmarkCards)
    if (entry) flatLeaves.push(entry)
  }
  if (flatLeaves.length > 0) {
    sections.push({ type: "flat", key: `${fam.key}--flat`, name: "", leaves: flatLeaves })
  }

  return sections
}

// Keep a flat list for filtering/counting
function collectLeafEntries(
  fam: HierarchyFamily,
  benchmarkCards?: Record<string, BenchmarkCard>,
): LeafEntry[] {
  const all: HierarchyBenchmark[] = [
    ...(fam.standalone_benchmarks ?? []),
    ...(fam.benchmarks ?? []),
    ...(fam.composites ?? []).flatMap((c: HierarchyComposite) => c.benchmarks ?? []),
  ]
  const out: LeafEntry[] = []
  for (const b of all) {
    const entry = buildLeafEntry(b, fam.key, benchmarkCards)
    if (entry) out.push(entry)
  }
  return out
}

function isFamilyDisplayNameMisleading(
  fam: Pick<HierarchyFamily, "key" | "display_name">,
  leafEntries: LeafEntry[],
): boolean {
  const nameSlug = slugify(fam.display_name)
  if (!nameSlug) return false
  if (nameSlug === slugify(fam.key)) return false
  if (leafEntries.length < 2) return false
  return leafEntries.some(
    (l) => slugify(l.leafKey) === nameSlug || slugify(l.leafName) === nameSlug,
  )
}

/** The label a family row shows (distinct from lib/hierarchy-lookup's
 * familyDisplayName, which returns the raw upstream value). Humanize the key when:
 *   - the upstream display_name is misleading (matches a leaf, not the family);
 *   - the display_name *is* the key (raw slug never humanized upstream); or
 *   - the display_name slugifies to the key AND is still all-lowercase, i.e. it
 *     is the raw slug with different separators ("commonsense_qa" vs key
 *     "commonsense-qa").
 * A curated name that merely slugifies to the key ("HELM", "aiXamine", "MMMU",
 * "LiveBench") is already the right label; humanizing it lowercases the
 * mid-word capitals and is data loss, so it is kept verbatim. */
export function familyRowLabel(
  fam: Pick<HierarchyFamily, "key" | "display_name">,
  leafEntries: LeafEntry[],
): string {
  const display = fam.display_name ?? ""
  const isRawSlug =
    display !== "" &&
    slugify(display) === slugify(fam.key) &&
    display === display.toLowerCase()
  return isFamilyDisplayNameMisleading(fam, leafEntries) ||
    display === fam.key ||
    isRawSlug
    ? humanizeFamilyKey(fam.key)
    : display
}

/** Nav target for a single-benchmark family: the full `/evals/...` href
 *  (merged page when the leaf carries a benchmark_id, else per-source). */
export function getFamilyNavHref(
  fam: HierarchyFamily,
  benchmarkCards?: Record<string, BenchmarkCard>,
): string | null {
  const leaves = collectLeafEntries(fam, benchmarkCards)
  if (leaves.length === 1) return leafNavHref(leaves[0])
  return null
}

interface RowData {
  key: string
  name: string
  keySlug: string
  tags: string[]
  benchmarks: number
  evalsCount: number
  leaves: LeafEntry[]
  sections: AccordionSection[]
  description: string | null
}

export function FamilyTable({
  families,
  evalItems,
  benchmarkCards,
  domainFilter,
  categoryFilter,
  searchQuery,
  verifiedEvalIds,
  restrictEvalIds,
  sortCol,
  sortDir,
  onSort,
}: FamilyTableProps) {
  const router = useRouter()
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const domainFilterActive = Boolean(domainFilter && domainFilter.size > 0)
  const categoryFilterActive = Boolean(categoryFilter && categoryFilter.size > 0)
  const verifiedFilterActive = Boolean(verifiedEvalIds)
  const restrictFilterActive = Boolean(restrictEvalIds)
  const normalizedQuery = (searchQuery ?? "").trim().toLowerCase()
  const searchActive = normalizedQuery.length > 0
  const filterActive = domainFilterActive || categoryFilterActive || searchActive || verifiedFilterActive || restrictFilterActive

  function leafMatchesDomain(leaf: LeafEntry): boolean {
    if (!domainFilterActive || !domainFilter) return true
    return leaf.domains.some((d) => domainFilter.has(d))
  }

  function leafMatchesCategory(leaf: LeafEntry): boolean {
    if (!categoryFilterActive || !categoryFilter) return true
    return leaf.tags.some((t) => categoryFilter.has(t))
  }

  function leafMatchesQuery(leaf: LeafEntry): boolean {
    if (!searchActive) return true
    if (leaf.id.toLowerCase().includes(normalizedQuery)) return true
    if (decodeURIComponent(leaf.id).toLowerCase().includes(normalizedQuery)) return true
    if (leaf.leafKey.toLowerCase().includes(normalizedQuery)) return true
    if (leaf.leafName.toLowerCase().includes(normalizedQuery)) return true
    return false
  }

  function leafMatchesVerified(leaf: LeafEntry): boolean {
    if (!verifiedFilterActive || !verifiedEvalIds) return true
    return leaf.evalIds.some((id) => verifiedEvalIds.has(id))
  }

  function leafMatchesRestrict(leaf: LeafEntry): boolean {
    if (!restrictFilterActive || !restrictEvalIds) return true
    return leaf.evalIds.some((id) => restrictEvalIds.has(id))
  }

  function leafMatchesFilter(leaf: LeafEntry, opts?: { skipQuery?: boolean }): boolean {
    if (!leafMatchesDomain(leaf)) return false
    if (!leafMatchesCategory(leaf)) return false
    if (!leafMatchesVerified(leaf)) return false
    if (!leafMatchesRestrict(leaf)) return false
    if (!opts?.skipQuery && !leafMatchesQuery(leaf)) return false
    return true
  }

  function familyMatchedAtFamilyLevel(fam: HierarchyFamily): boolean {
    if (!searchActive) return false
    if (fam.display_name.toLowerCase().includes(normalizedQuery)) return true
    if (fam.key.toLowerCase().includes(normalizedQuery)) return true
    if (fam.category?.toLowerCase().includes(normalizedQuery)) return true
    for (const tag of fam.derivedTags ?? []) {
      if (tag.toLowerCase().includes(normalizedQuery)) return true
    }
    return false
  }

  function familyMatchesFilter(
    fam: HierarchyFamily,
    leafEntries: LeafEntry[],
  ): boolean {
    if (!filterActive) return true
    if (leafEntries.some((leaf) => leafMatchesFilter(leaf))) return true
    // Family-level search match keeps the row even if no leaf survives
    // the leaf-query filter (the row will fall back to showing all
    // leaves). But the verified and restrict filters are hard leaf-level
    // gates: never resurrect a family that has zero surviving leaves.
    if (
      searchActive &&
      familyMatchedAtFamilyLevel(fam) &&
      leafEntries.some((leaf) => leafMatchesVerified(leaf) && leafMatchesRestrict(leaf))
    )
      return true
    if (categoryFilterActive && categoryFilter) {
      for (const tag of fam.derivedTags ?? []) {
        if (categoryFilter.has(tag) && !domainFilterActive) return true
      }
    }
    if (!domainFilterActive || !domainFilter) return false
    const sources: Array<string[]> = [
      benchmarkCards?.[fam.key]?.benchmark_details?.domains ?? [],
    ]
    for (const id of fam.constituent_evaluation_ids ?? []) {
      sources.push(benchmarkCards?.[id]?.benchmark_details?.domains ?? [])
    }
    for (const list of sources) {
      for (const d of list) {
        if (domainFilter.has(d.trim().toLowerCase())) return true
      }
    }
    return false
  }

  const rows = useMemo<RowData[]>(() => {
    const out: RowData[] = []
    for (const fam of families) {
      const allBenchmarks = [
        ...(fam.standalone_benchmarks ?? []),
        ...(fam.benchmarks ?? []),
        ...(fam.composites ?? []).flatMap((c) => c.benchmarks ?? []),
      ]
      const metricCount = allBenchmarks.reduce((sum, b) => sum + (b.metrics?.length ?? 0), 0)
      const benchmarkCount = allBenchmarks.length

      const leafEntries = collectLeafEntries(fam, benchmarkCards)
      if (!familyMatchesFilter(fam, leafEntries)) continue

      // When a search query matches the family itself (e.g. typed
      // "MMLU" → MMLU family hits at family level), don't filter leaves
      // by the query — the user wants to see the whole family. We still
      // apply domain/category filters since those are independent of
      // the search box.
      const querySatisfiedAtFamily =
        searchActive && familyMatchedAtFamilyLevel(fam)
      const leafFilter = (leaf: LeafEntry) =>
        leafMatchesFilter(leaf, { skipQuery: querySatisfiedAtFamily })

      const visibleLeafEntries = filterActive
        ? leafEntries.filter(leafFilter)
        : leafEntries

      const sections = collectFamilySections(fam, benchmarkCards).map((section) => ({
        ...section,
        leaves: filterActive ? section.leaves.filter(leafFilter) : section.leaves,
      })).filter((s) => s.leaves.length > 0)

      const displayName = familyRowLabel(fam, leafEntries)

      // Description: try family-level eval item (via a single benchmark family)
      // or fall back to the benchmark cards on the family's own leaves.
      let description: string | null = null
      if (evalItems && visibleLeafEntries.length === 1) {
        const overview = evalItems.get(visibleLeafEntries[0].id)?.benchmark_card?.benchmark_details?.overview
        if (overview) description = overview.length > 140 ? overview.slice(0, 137) + "…" : overview
      }

      // Same definition as the home page and benchmark cards: one per
      // (model, benchmark, metric).
      const reportedResults =
        fam.provenance_summary?.total_results ??
        fam.reproducibility_summary?.results_total ??
        fam.evals_count ??
        metricCount
      out.push({
        key: fam.key,
        name: displayName,
        keySlug: fam.key,
        tags: fam.derivedTags ?? [],
        benchmarks: benchmarkCount,
        evalsCount: reportedResults,
        leaves: visibleLeafEntries,
        sections,
        description,
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [families, evalItems, benchmarkCards, domainFilter, categoryFilter, searchQuery, verifiedEvalIds, restrictEvalIds])

  function SortIcon({ col }: { col: FamilySortCol }) {
    if (!onSort) return null
    if (sortCol !== col) return null
    return sortDir === "asc"
      ? <ChevronUp className="h-3 w-3" aria-hidden />
      : <ChevronDown className="h-3 w-3" aria-hidden />
  }

  function SortTh({
    col,
    children,
    className,
    style,
  }: {
    col: FamilySortCol
    children: React.ReactNode
    className?: string
    style?: React.CSSProperties
  }) {
    const active = sortCol === col
    return (
      <th
        className={className}
        style={{
          ...style,
          cursor: onSort ? "pointer" : undefined,
          userSelect: onSort ? "none" : undefined,
          color: active ? "var(--fg)" : undefined,
        }}
        onClick={onSort ? () => onSort(col) : undefined}
        title={onSort ? `Sort by ${typeof children === "string" ? children : col}` : undefined}
      >
        <span className="inline-flex items-center gap-1">
          {children}
          <SortIcon col={col} />
        </span>
      </th>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="ec-htable">
        <thead>
          <tr>
            <SortTh col="name" style={{ width: "55%" }}>Family</SortTh>
            <th>Categories</th>
            <SortTh col="benchmarks" className="num">Benchmarks</SortTh>
            <SortTh col="results" className="num">Reported results</SortTh>
            <th style={{ width: 90 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isExpanded = filterActive
              ? expanded[row.key] ?? true
              : expanded[row.key] ?? false
            const allLeaves = row.sections.flatMap((s) => s.leaves)
            const hiddenLeafCount = isExpanded
              ? Math.max(allLeaves.length - LEAVES_INLINE_MAX, 0)
              : 0

            // Build visible sections respecting the per-section leaf cap
            let remaining = LEAVES_INLINE_MAX
            const visibleSections: AccordionSection[] = isExpanded
              ? row.sections.map((section) => {
                  const capped = section.leaves.slice(0, remaining)
                  remaining -= capped.length
                  return { ...section, leaves: capped }
                }).filter((s) => s.leaves.length > 0)
              : []

            const singleLeaf = row.leaves.length === 1 ? row.leaves[0] : null
            const navigateToLeaf = singleLeaf
              ? () => router.push(leafNavHref(singleLeaf))
              : null
            return (
              <Fragment key={row.key}>
                <tr
                  onClick={() =>
                    navigateToLeaf
                      ? navigateToLeaf()
                      : setExpanded((current) => ({ ...current, [row.key]: !isExpanded }))
                  }
                  style={{ cursor: "pointer" }}
                >
                  <td>
                    <div className="flex items-start gap-2.5 min-w-0">
                      <button
                        type="button"
                        data-row-toggle
                        onClick={(e) => {
                          e.stopPropagation()
                          if (navigateToLeaf) navigateToLeaf()
                          else setExpanded((current) => ({ ...current, [row.key]: !isExpanded }))
                        }}
                        aria-expanded={navigateToLeaf ? undefined : isExpanded}
                        aria-label={
                          navigateToLeaf
                            ? "Open benchmark"
                            : isExpanded
                              ? "Collapse family"
                              : "Expand family"
                        }
                        className="-ml-1 mt-0.5 inline-flex h-4 w-4 items-center justify-center transition-colors hover:text-[color:var(--accent)]"
                        style={{ color: "var(--fg-muted)" }}
                      >
                        {navigateToLeaf
                          ? <ArrowUpRight className="h-3 w-3" />
                          : isExpanded
                            ? <ChevronDown className="h-3 w-3" />
                            : <ChevronRight className="h-3 w-3" />}
                      </button>
                      <div className="min-w-0">
                        <div className="font-semibold text-[14px] text-[color:var(--fg)] truncate">
                          {row.name}
                        </div>
                        {row.description && (
                          <div
                            className="mt-0.5"
                            style={{ fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
                          >
                            {row.description}
                          </div>
                        )}
                        <div className="font-mono text-[10px] tracking-[0.06em] text-[color:var(--fg-subtle)] mt-0.5 truncate">
                          {row.keySlug}
                          <span className="ml-2 normal-case tracking-[0.04em]">
                            · {row.leaves.length} {row.leaves.length === 1 ? "benchmark" : "benchmarks"}
                          </span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    {row.tags.length === 0 ? (
                      <span className="inline-flex items-center font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--fg-subtle)]">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {row.tags.map((tag) => {
                          const highlighted = categoryFilter && categoryFilter.has(tag)
                          return (
                            <span
                              key={tag}
                              className="inline-flex items-center font-mono text-[10px] uppercase tracking-[0.12em] border px-1.5 py-0.5"
                              style={{
                                color: highlighted ? "var(--bg)" : "var(--fg-muted)",
                                borderColor: highlighted ? "var(--fg)" : "var(--border-soft)",
                                background: highlighted ? "var(--fg)" : "var(--bg)",
                              }}
                            >
                              {formatTagLabel(tag)}
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </td>
                  <td className="num font-mono text-[13px]">{row.benchmarks.toLocaleString()}</td>
                  <td className="num font-mono text-[13px]">
                    {row.evalsCount.toLocaleString()}
                  </td>
                  <td>
                    <span className="font-mono text-[10px] tracking-[0.12em] uppercase text-[color:var(--accent)] inline-flex items-center gap-1">
                      {navigateToLeaf ? "Open" : isExpanded ? "Hide" : "Browse"}
                    </span>
                  </td>
                </tr>

                {!navigateToLeaf && isExpanded && visibleSections.length > 0 && (
                  <tr style={{ background: "var(--bg-warm)" }}>
                    <td colSpan={5} style={{ padding: 0 }}>
                      <div style={{ padding: "10px 24px 14px 64px" }}>
                        <div
                          className="font-mono uppercase mb-2"
                          style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
                        >
                          Benchmarks in this family · {row.leaves.length}
                        </div>

                        {visibleSections.map((section) => (
                          <div key={section.key} className="mb-3 last:mb-0">
                            {/* Composite header — not clickable to a page */}
                            {section.type === "composite" && (
                              <div
                                className="mb-1.5 flex items-baseline gap-2"
                                style={{ paddingBottom: 4, borderBottom: "1px solid var(--border-soft)" }}
                              >
                                <span
                                  className="font-semibold text-[12px]"
                                  style={{ color: "var(--fg-muted)" }}
                                >
                                  {section.name}
                                </span>
                                {section.description && (
                                  <span
                                    className="text-[11px] truncate"
                                    style={{ color: "var(--fg-subtle)" }}
                                  >
                                    {section.description}
                                  </span>
                                )}
                              </div>
                            )}

                            <ul
                              className="grid"
                              style={{
                                gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                                gap: "0",
                                borderTop: "1px solid var(--border-soft)",
                                borderLeft: "1px solid var(--border-soft)",
                              }}
                            >
                              {section.leaves.map((leaf) => (
                                <li
                                  key={leaf.id}
                                  style={{
                                    borderBottom: "1px solid var(--border-soft)",
                                    borderRight: "1px solid var(--border-soft)",
                                  }}
                                >
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      router.push(leafNavHref(leaf))
                                    }}
                                    className="w-full flex items-start justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-[color:var(--bg-surface)]"
                                  >
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        <span className="text-[13px] font-medium truncate text-[color:var(--fg)]">
                                          {leaf.leafName}
                                        </span>
                                        {leaf.sliceCount > 1 && (
                                          <span
                                            className="font-mono text-[9px] uppercase tracking-[0.1em] border px-1 py-px shrink-0"
                                            style={{ color: "var(--fg-subtle)", borderColor: "var(--border-soft)" }}
                                          >
                                            splits · {leaf.sliceCount}
                                          </span>
                                        )}
                                      </div>
                                      {leaf.description && (
                                        <div
                                          className="truncate mt-0.5"
                                          style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.4 }}
                                        >
                                          {leaf.description}
                                        </div>
                                      )}
                                    </div>
                                    <ArrowUpRight
                                      className="h-3 w-3 shrink-0 mt-0.5"
                                      style={{ color: "var(--accent)" }}
                                      aria-hidden
                                    />
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}

                        {hiddenLeafCount > 0 && (
                          <div
                            className="mt-2 font-mono uppercase"
                            style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
                          >
                            {hiddenLeafCount} more benchmarks not shown
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
