import "server-only"

import { cache } from "react"

import type { BackendManifestStatus } from "@/lib/backend-artifacts"
import { cleanHierarchy } from "@/lib/clean-hierarchy"
import { getEvalsForEvaluator, isRecognizedEvaluator } from "@/lib/evaluators"

async function viewBackend() {
  return import("@/lib/view-data")
}

async function sidecars() {
  return import("@/lib/sidecars")
}

async function hfData() {
  return import("@/lib/hf-data")
}

async function applyModelCoverage<T extends { route_id: string; benchmarks_count: number }>(
  cards: T[],
): Promise<T[]> {
  try {
    const coverage = await (await sidecars()).fetchModelCoverage()
    if (Object.keys(coverage).length === 0) return cards
    return cards.map((c) =>
      coverage[c.route_id] != null
        ? { ...c, benchmarks_count: coverage[c.route_id] }
        : c,
    )
  } catch {
    return cards
  }
}

export async function getModelCards() {
  const cards = await (await viewBackend()).getModelCards()
  return applyModelCoverage(cards)
}

export async function getModelCardsLite() {
  const cards = await (await viewBackend()).getModelCardsLite()
  return applyModelCoverage(cards)
}

export async function getEvalListData() {
  return (await viewBackend()).getEvalListData()
}

export async function getEvalListLiteData() {
  return (await viewBackend()).getEvalListLiteData()
}

export async function getEvalList() {
  return (await viewBackend()).getEvalList()
}

export async function getEvaluatorNameIndex() {
  return (await viewBackend()).getEvaluatorNameIndex()
}

export async function getDashboardData() {
  return (await viewBackend()).getDashboardData()
}

export async function getDeveloperList() {
  return (await viewBackend()).getDeveloperList()
}

export async function getDeveloperSummaryById(routeId: string) {
  return (await viewBackend()).getDeveloperSummaryById(routeId)
}

export async function getModelSummaryById(modelId: string) {
  return (await viewBackend()).getModelSummaryById(modelId)
}

export async function getEvalSummaryById(evalId: string) {
  return (await viewBackend()).getEvalSummaryById(evalId)
}

export async function getMergedBenchmarkSummary(
  benchmarkId: string,
  metricId?: string,
  sliceId?: string,
) {
  return (await viewBackend()).getMergedBenchmarkSummary(benchmarkId, metricId, sliceId)
}

export async function getEvalTrajectories(evalId: string) {
  return (await viewBackend()).getEvalTrajectories(evalId)
}

/**
 * Resolve an evaluator-org slug (/evaluators/<slug>) to the facts the page
 * metadata + OG card need: canonical org name, evals-reported count, and
 * verified count. Mirrors the client-side derivation in
 * app/evaluators/[...id]/page.tsx — getEvalsForEvaluator over the lite eval
 * list, keyed by the organizations.json sidecar — so the server-rendered
 * unfurl agrees with what the page shows. Returns null when the slug
 * resolves to no org (bad/expired link → falls back to the generic card).
 *
 * verifiedCount spans both trust tiers (blue verified-for-this-eval and grey
 * recognized-source), matching the evaluator page header.
 */
export const getEvaluatorSummaryBySlug = cache(async (slug: string) => {
  const [list, orgMeta] = await Promise.all([
    getEvalListLiteData(),
    getOrganizationsData().catch(() => ({})),
  ])
  const { name, isVerified, evals } = getEvalsForEvaluator(list.evals, slug, { orgMeta })
  if (!name) return null

  const recognized = isRecognizedEvaluator(name)
  let verifiedCount = 0
  for (const ev of evals) {
    if (recognized || (ev.verified_evaluator_names ?? []).includes(name)) verifiedCount += 1
  }

  return { name, isVerified, evalCount: evals.length, verifiedCount }
})

export async function getBackendManifestData() {
  return (await sidecars()).fetchManifest()
}

export async function getBackendManifestStatusData(): Promise<BackendManifestStatus> {
  const manifest = await (await sidecars()).fetchManifest()
  return {
    currentManifest: manifest,
    latestManifest: manifest,
    currentManifestSignature: manifest.generated_at,
    latestManifestSignature: manifest.generated_at,
    updateAvailable: false,
    refreshing: false,
    pendingRefreshCount: 0,
  }
}

export async function getOrganizationsData() {
  return (await sidecars()).fetchOrganizations()
}

export async function getEvalHierarchyData() {
  // The v2 sidecar ships hierarchy.json in the composite/family/slice
  // taxonomy shape (top-level `composites[]`, flat `families[]` lookup
  // index). UI components expect the legacy nested
  // `families[].composites[]` / `families[].standalone_benchmarks[]`
  // shape, so route the sidecar through the adapter, then `cleanHierarchy`
  // for sanitised display names + family-rollup filtering.
  const raw = await (await sidecars()).fetchHierarchy()
  return cleanHierarchy((await hfData()).adaptEvalHierarchy(raw))
}
