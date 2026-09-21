"use client"

import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { ArrowLeft, Search } from "lucide-react"

import EvaluatorLetterhead from "@/components/evaluator/evaluator-letterhead"
import { useOrgMetadata } from "@/components/org-metadata-provider"
import { FamilyTable, type FamilySortCol } from "@/components/family-table"
import { Navigation } from "@/components/navigation"
import type { EvalHierarchy } from "@/lib/backend-artifacts"
import type { BenchmarkCard } from "@/lib/benchmark-schema"
import { fetchBenchmarkMetadata, fetchEvalHierarchy, fetchEvalList } from "@/lib/dashboard-data-client"
import type { BenchmarkEvalListItem } from "@/lib/eval-processing"
import { normalizeOrgKey } from "@/lib/evaluator-logo"
import { getEvalsForEvaluator, isRecognizedEvaluator } from "@/lib/evaluators"

/**
 * The evaluator (reporting-org) detail page body. Mounted by the route's
 * server component, which has already resolved the slug. An unknown one
 * never reaches here, it is a 404.
 */
function EvaluatorDetailInner() {
  const params = useParams()
  const router = useRouter()

  // The slug is a single URL-safe segment, but the route is a catch-all
  // ([...id]) to match the developers/models pattern. Join just in case.
  const slug = useMemo(() => {
    const raw = params.id as string | string[] | undefined
    const joined = Array.isArray(raw) ? raw.join("/") : (raw ?? "")
    return decodeURIComponent(joined)
  }, [params.id])

  const [allEvals, setAllEvals] = useState<BenchmarkEvalListItem[]>([])
  const [hierarchy, setHierarchy] = useState<EvalHierarchy | null>(null)
  const [benchmarkCards, setBenchmarkCards] = useState<Record<string, BenchmarkCard>>({})
  // Org metadata (homepage url, logo, stable id) comes from the app-wide
  // provider (server-fetched in the root layout) — no per-page fetch, no flash.
  const orgMeta = useOrgMetadata()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [sortCol, setSortCol] = useState<FamilySortCol>("name")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")

  useEffect(() => {
    const evalListRequest = fetchEvalList()
      .then((list) => setAllEvals(list.evals))
      .catch((err) => {
        console.error(err)
        setError("Failed to load evaluations")
      })
    const hierarchyRequest = fetchEvalHierarchy()
      .then((h) => setHierarchy(h))
      .catch(console.error)
    const metadataRequest = fetchBenchmarkMetadata()
      .then((metadata) => setBenchmarkCards(metadata))
      .catch(console.error)
    Promise.allSettled([evalListRequest, hierarchyRequest, metadataRequest]).finally(() =>
      setLoading(false),
    )
  }, [])

  const handleSort = useCallback((col: FamilySortCol) => {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortCol(col)
      setSortDir("asc")
    }
  }, [sortCol])

  // The evaluator page always shows the org's full profile — the verified
  // filter is a list-browsing concept that we deliberately do not persist into
  // this route (the header reports total + verified counts separately, so no
  // information is hidden). See evaluator-table.tsx hrefFor.
  const { name, isVerified, evals } = useMemo(
    () => getEvalsForEvaluator(allEvals, slug, { orgMeta }),
    [allEvals, slug, orgMeta],
  )

  // Eval-id universe owned by this evaluator — restricts the family tree to
  // this org's evaluations (slices already excluded by getEvalsForEvaluator).
  const restrictEvalIds = useMemo(() => {
    const set = new Set<string>()
    for (const ev of evals) set.add(ev.evaluation_id)
    return set
  }, [evals])

  const evalItems = useMemo(() => {
    const map = new Map<string, BenchmarkEvalListItem>()
    for (const ev of allEvals) map.set(ev.evaluation_id, ev)
    return map
  }, [allEvals])

  const families = hierarchy?.families ?? []

  // Quantified facts for the header. familyCount counts the top-level families
  // the table actually renders for this org (those whose constituent evals
  // intersect this evaluator's set), so the header agrees with the accordion
  // below it rather than the finer family_display_name grouping.
  const { familyCount, verifiedCount } = useMemo(() => {
    // "Verified" spans both trust tiers: blue (org verified for this eval) and
    // grey (a recognized source — the tier applies to all of the org's evals).
    // So a recognized-only org like Hugging Face reports its full eval count
    // rather than 0. Mirrors getEvalsForEvaluator's verified-only filter.
    const recognized = isRecognizedEvaluator(name)
    let verified = 0
    for (const ev of evals) {
      if (name && (recognized || (ev.verified_evaluator_names ?? []).includes(name))) verified += 1
    }
    let familyCount = 0
    for (const fam of families) {
      if ((fam.constituent_evaluation_ids ?? []).some((id) => restrictEvalIds.has(id))) {
        familyCount += 1
      }
    }
    return { familyCount, verifiedCount: verified }
  }, [evals, name, families, restrictEvalIds])

  const handleBack = useCallback(() => {
    router.push("/evals?groupBy=evaluator")
  }, [router])

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <main className="ec-page">
          <div className="flex h-96 items-center justify-center">
            <div className="kicker">Loading evaluator…</div>
          </div>
        </main>
      </div>
    )
  }

  // Slug resolved to no org (bad/expired link) — or the org has no evals
  // under the active verified filter.
  if (error || !name) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <main className="ec-page">
          <div className="flex flex-col items-center justify-center h-96 space-y-4">
            <div className="kicker">{error ?? "Evaluator not found"}</div>
            <button type="button" onClick={handleBack} className="btn-ec outline">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </button>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <main className="mx-auto w-full max-w-[96rem] px-4 pt-12 pb-24 sm:px-8">
        {/* BREADCRUMB ----------------------------------------------- */}
        <button
          type="button"
          onClick={handleBack}
          className="ec-crumb mb-4 inline-flex items-center gap-1.5"
        >
          <ArrowLeft className="h-3 w-3" />
          Evaluators
        </button>

        {/* HEADER — editorial letterhead masthead -------------------- */}
        <EvaluatorLetterhead
          name={name}
          logoSrc={orgMeta[normalizeOrgKey(name)]?.logo ?? null}
          homepageUrl={orgMeta[normalizeOrgKey(name)]?.url}
          isVerified={isVerified}
          recognized={isRecognizedEvaluator(name)}
          evalCount={evals.length}
          familyCount={familyCount}
          verifiedCount={verifiedCount}
        />
        <p className="ec-page-lede">
          Reported <strong>{evals.length.toLocaleString()}</strong>{" "}
          {evals.length === 1 ? "evaluation" : "evaluations"} across{" "}
          <strong>{familyCount.toLocaleString()}</strong>{" "}
          {familyCount === 1 ? "benchmark family" : "benchmark families"}
          {verifiedCount > 0 && (
            <>
              , <strong>{verifiedCount.toLocaleString()}</strong> verified
            </>
          )}
          .
        </p>

        <div className="ec-page-meta mt-2">
          <div className="ec-page-meta-item">
            <span className="ec-page-meta-item-l">Evaluations</span>
            <span className="ec-page-meta-item-v">{evals.length.toLocaleString()}</span>
          </div>
          <div className="ec-page-meta-item">
            <span className="ec-page-meta-item-l">Verified</span>
            <span className="ec-page-meta-item-v">{verifiedCount.toLocaleString()}</span>
          </div>
          <div className="ec-page-meta-item">
            <span className="ec-page-meta-item-l">Families</span>
            <span className="ec-page-meta-item-v">{familyCount.toLocaleString()}</span>
          </div>
        </div>

        {/* FILTER BAR ---------------------------------------------- */}
        <div className="mb-6 flex flex-wrap items-center gap-x-8 gap-y-3 border-y border-[color:var(--border-soft)] py-4">
          <div className="flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-[11px] tracking-[0.1em] uppercase text-[color:var(--fg-subtle)]">
            <span>
              <span className="text-[color:var(--fg)] tabular-nums font-semibold mr-1">
                {evals.length.toLocaleString()}
              </span>
              {evals.length === 1 ? "evaluation" : "evaluations"}
            </span>
          </div>

          <span className="hidden h-5 w-px bg-[color:var(--border-soft)] sm:block" />

          <div className="relative min-w-[200px] flex-1 sm:max-w-[300px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--fg-subtle)]" />
            <input
              className="ec-input pl-9"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search benchmarks…"
            />
          </div>
        </div>

        {/* FAMILY TABLE — scoped to this evaluator's evaluations ---- */}
        {restrictEvalIds.size === 0 ? (
          <div className="border border-dashed border-[color:var(--border-soft)] bg-[color:var(--bg-warm)] py-12 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-[color:var(--fg-subtle)]">
            No evaluations match the current filters
          </div>
        ) : (
          /* restrictEvalIds scopes the tree to this evaluator's evals; the
             page never filters by verified status, so no verifiedEvalIds. */
          <FamilyTable
            families={families}
            evalItems={evalItems}
            benchmarkCards={benchmarkCards}
            searchQuery={searchQuery}
            verifiedEvalIds={null}
            restrictEvalIds={restrictEvalIds}
            sortCol={sortCol}
            sortDir={sortDir}
            onSort={handleSort}
          />
        )}
      </main>
    </div>
  )
}

export function EvaluatorDetailView() {
  return (
    <Suspense fallback={null}>
      <EvaluatorDetailInner />
    </Suspense>
  )
}
