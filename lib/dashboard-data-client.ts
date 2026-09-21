import type {
  BackendManifestStatus,
  ComparisonIndex,
  CorpusAggregates,
  EvalHierarchy,
  OrgMetadata,
  PeerRanksMap,
} from "@/lib/backend-artifacts"
import { decorateHierarchyDerivedTags } from "@/lib/benchmark-tags"
import type { BenchmarkEvaluationCardData } from "@/components/benchmark-evaluation-card"
import type { HFEvalDetail } from "@/lib/hf-data"
import type {
  BenchmarkCard,
  BenchmarkEvalListItem,
  BenchmarkEvalSummary,
  MergedBenchmarkSummary,
  ModelEvaluationSummary,
} from "@/lib/eval-processing"
import { isMergedBenchmarkSummary, mergedSummaryToEvalSummary } from "@/lib/merged-adapter"
import { parseJsonWithBounds } from "@/lib/json-bounds"

export interface EvalListResponse {
  evals: BenchmarkEvalListItem[]
  totalModels: number
}

export interface DeveloperListItem {
  developer: string
  route_id: string
  model_count: number
  benchmark_count: number
  evaluation_count: number
  popular_evals: Array<{
    benchmark: string
    model_count: number
  }>
}

export interface DeveloperSummaryResponse {
  developer: string
  route_id: string
  model_count: number
  benchmark_count: number
  evaluation_count: number
  popular_evals: Array<{
    benchmark: string
    model_count: number
  }>
  models: BenchmarkEvaluationCardData[]
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`)
  }

  // Producer-shaped payloads carry infinite registry bounds as "Infinity";
  // the same reviver the server-side readers use restores them.
  return parseJsonWithBounds<T>(await response.text())
}

export function fetchModelCards() {
  return fetchJson<BenchmarkEvaluationCardData[]>("/api/model-cards-lite")
}

export function fetchEvalList() {
  return fetchJson<EvalListResponse>("/api/eval-list-lite")
}

export function fetchModelSummary(modelId: string) {
  return fetchJson<ModelEvaluationSummary>(
    `/api/model-summary?id=${encodeURIComponent(modelId)}`
  )
}

export function fetchEvalSummary(evalId: string) {
  // Single-segment (merged benchmark) ids come back as the discriminated
  // `{ merged: true, ... }` payload; adapt it to the BenchmarkEvalSummary
  // shape so legacy consumers (embeds especially) render without their
  // own wiring. Two-segment ids pass through byte-identical.
  return fetchJson<BenchmarkEvalSummary | MergedBenchmarkSummary>(
    `/api/eval-summary?id=${encodeURIComponent(evalId)}`
  ).then((payload) =>
    isMergedBenchmarkSummary(payload) ? mergedSummaryToEvalSummary(payload) : payload,
  )
}

/**
 * Raw merged-benchmark payload for the merged detail page
 * (merged-benchmark-view spec F1). `metricId`/`sliceId` re-query the
 * observation table server-side. A non-merged payload comes back when
 * the snapshot predates merged_evals_view — callers should treat that
 * as "no merged page".
 *
 * `signal` is worth passing: this payload is every source's rows for the
 * whole benchmark and runs to megabytes on a well-covered one, so a
 * caller that navigates away should stop the transfer rather than just
 * drop the result.
 */
export function fetchMergedBenchmarkSummary(
  benchmarkId: string,
  query: { metricId?: string; sliceId?: string; signal?: AbortSignal } = {},
) {
  const params = new URLSearchParams({ id: benchmarkId })
  if (query.metricId) params.set("metric", query.metricId)
  if (query.sliceId) params.set("slice", query.sliceId)
  return fetchJson<MergedBenchmarkSummary | BenchmarkEvalSummary | { error: string }>(
    `/api/eval-summary?${params.toString()}`,
    query.signal ? { signal: query.signal } : undefined,
  )
}

/**
 * Trajectory panels for protocol-varied collection pages.
 * Resolves to null on 404 / any failure — absence means the page renders
 * without the Trajectories section, exactly as before.
 */
export function fetchEvalTrajectories(evalId: string) {
  return fetchJson<import("@/lib/collection-trajectories").EvalTrajectoriesPayload>(
    `/api/eval-trajectories?id=${encodeURIComponent(evalId)}`
  ).catch(() => null)
}

export function fetchEvalDetail(evalId: string) {
  return fetchJson<HFEvalDetail>(
    `/api/eval-detail?id=${encodeURIComponent(evalId)}`
  )
}

export function fetchDevelopers() {
  return fetchJson<DeveloperListItem[]>("/api/developers")
}

export function fetchDeveloperSummary(developerId: string) {
  return fetchJson<DeveloperSummaryResponse>(
    `/api/developer-summary?id=${encodeURIComponent(developerId)}`
  )
}

export function fetchBenchmarkMetadata() {
  return fetchJson<Record<string, BenchmarkCard>>("/api/benchmark-metadata")
}

export function fetchBackendManifest() {
  return fetchJson<BackendManifestStatus>("/api/backend-manifest")
}

export function fetchEvalHierarchy() {
  return fetchJson<EvalHierarchy>("/api/eval-hierarchy").then(decorateHierarchyDerivedTags)
}

export function fetchComparisonIndex() {
  return fetchJson<ComparisonIndex>("/api/comparison-index")
}

export function fetchCorpusAggregates() {
  return fetchJson<CorpusAggregates>("/api/corpus-aggregates")
}

export function fetchPeerRanks() {
  return fetchJson<PeerRanksMap>("/api/peer-ranks")
}

export function fetchOrganizations() {
  return fetchJson<Record<string, OrgMetadata>>("/api/org-metadata")
}
