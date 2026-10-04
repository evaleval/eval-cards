import "server-only"

import { promises as fs } from "fs"
import path from "path"

import type {
  BackendManifest,
  BackendManifestStatus,
  ComparisonIndex,
  CorpusAggregates,
  EvalHierarchy,
  EvalcardsAnnotations,
  HierarchyBenchmark,
  HierarchyComposite,
  HierarchyFamily,
  HierarchyMetric,
  HierarchySlice,
  HierarchyTags,
  PeerRanksMap,
  RowAnnotations,
  SignalSummaries,
} from "@/lib/backend-artifacts"
import type {
  BenchmarkCard,
  BenchmarkEvaluation,
  EvalTag,
  EvaluationResult,
  MetricConfig,
  ModelInfo,
  SampleResult,
  SourceData,
  SourceMetadata,
} from "@/lib/benchmark-schema"

// ---------------------------------------------------------------------------
// HuggingFace dataset base URL
// ---------------------------------------------------------------------------

const HF_DATASET = "evaleval/card_backend"
const HF_BASE = `https://huggingface.co/datasets/${HF_DATASET}/resolve/main`

// ---------------------------------------------------------------------------
// Local disk cache (populated by scripts/cache-hf-data.mjs during build)
// ---------------------------------------------------------------------------

// HF_DATA_LOCAL_DIR overrides the cache location so the JSON read path can be
// pointed at a sibling repo's pipeline output for parity testing against the
// DuckDB backend. Falls back to the cache populated by scripts/cache-hf-data.mjs.
const LOCAL_CACHE_DIR = process.env.HF_DATA_LOCAL_DIR?.trim()
  ? path.resolve(process.env.HF_DATA_LOCAL_DIR.trim())
  : path.join(process.cwd(), ".cache", "hf-data")

// Bound wire form ("Infinity" / "-Infinity" on bound keys): see
// lib/json-bounds.ts. Re-exported so existing imports keep working.
import { parseJsonWithBounds } from "@/lib/json-bounds"
export { reviveNonFiniteBounds } from "@/lib/json-bounds"
import { sliceIndexForEvals, sliceIndexForModel } from "@/lib/comparison-slice"

async function readLocalCache<T>(relativePath: string): Promise<T | null> {
  try {
    const filePath = path.join(LOCAL_CACHE_DIR, relativePath)
    const text = await fs.readFile(filePath, "utf8")
    return parseJsonWithBounds<T>(text) as T
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// In-memory cache (always active to avoid HF rate limits)
// ---------------------------------------------------------------------------

interface CacheEntry {
  data: unknown
  ts: number
  manifestSignature?: string
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS =
  process.env.HF_DATA_CACHE_TTL_MS != null
    ? Number.parseInt(process.env.HF_DATA_CACHE_TTL_MS, 10)
    : process.env.NODE_ENV === "production"
      ? 60 * 1000
      : 0
const MANIFEST_TTL_MS =
  process.env.HF_MANIFEST_CACHE_TTL_MS != null
    ? Number.parseInt(process.env.HF_MANIFEST_CACHE_TTL_MS, 10)
    : process.env.NODE_ENV === "production"
      ? 30 * 1000
      : 0

let manifestSnapshotCache:
  | {
      remote: BackendManifest | null
      local: BackendManifest | null
      ts: number
    }
  | null = null
let localManifestPromise: Promise<BackendManifest | null> | null = null
let manifestRefreshPromise: Promise<void> | null = null
let refreshTargetManifestSignature: string | null = null
let refreshTargetFailed = false
let activeManifestSignature: string | null = null
let activeManifest: BackendManifest | null = null
const backgroundRefreshes = new Map<string, Promise<void>>()
const observedPaths = new Set<string>()

function isCanonicalCacheShape(relativePath: string, data: unknown) {
  if (!data || typeof data !== "object") {
    return false
  }

  const record = data as Record<string, unknown>

  if (relativePath.startsWith("models/")) {
    return record.hierarchy_by_category != null
  }

  if (relativePath.startsWith("evals/")) {
    return Array.isArray(record.metrics)
  }

  if (relativePath === "eval-list.json") {
    const evals = Array.isArray(record.evals) ? (record.evals as Array<Record<string, unknown>>) : []
    return evals.length === 0 || typeof evals[0]?.benchmark_family_key === "string"
  }

  if (relativePath === "comparison-index.json") {
    return record.evals != null && record.by_model != null
  }

  return true
}

function getManifestSignature(manifest: BackendManifest | null | undefined) {
  if (!manifest) {
    return null
  }

  return JSON.stringify({
    generated_at: manifest.generated_at,
    config_version: manifest.config_version,
    skipped_configs: [...manifest.skipped_configs].sort(),
  })
}

// HF_DATA_OFFLINE disables every network fetch, so the read path is fully
// served by LOCAL_CACHE_DIR. Used by the DuckDB parity setup so two servers
// reading the same on-disk artifacts cannot diverge mid-test via background
// refresh, and useful generally for offline development.
const OFFLINE = process.env.HF_DATA_OFFLINE === "1"
const DATA_BACKEND_VERSION = process.env.DATA_BACKEND?.trim().toLowerCase()

function useViewLayerBackend() {
  return DATA_BACKEND_VERSION === "v2" || DATA_BACKEND_VERSION === "stage-j"
}

async function fetchSnapshotSidecars() {
  return import("@/lib/sidecars")
}

async function fetchRemoteJson<T>(relativePath: string): Promise<T> {
  if (OFFLINE) {
    throw new Error(`HF_DATA_OFFLINE=1: refusing remote fetch for ${relativePath}`)
  }

  const url = `${HF_BASE}/${relativePath}`
  let lastError: Error | null = null

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
    }

    try {
      const res = await fetch(url, { cache: "no-store" })
      if (res.status === 429) {
        lastError = new Error(`HF rate limited (429) for ${url}`)
        continue
      }

      if (!res.ok) {
        throw new Error(`HF fetch failed: ${res.status} ${res.statusText} for ${url}`)
      }

      return parseJsonWithBounds<T>(await res.text()) as T
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (!String(err).includes("429")) {
        throw err
      }
    }
  }

  throw lastError ?? new Error(`HF fetch failed for ${url}`)
}

async function getLocalManifest() {
  if (!localManifestPromise) {
    localManifestPromise = readLocalCache<BackendManifest>("manifest.json")
  }

  const local = await localManifestPromise

  if (!manifestSnapshotCache) {
    manifestSnapshotCache = {
      remote: null,
      local,
      ts: 0,
    }
  } else if (manifestSnapshotCache.local == null && local != null) {
    manifestSnapshotCache.local = local
  }

  if (!activeManifestSignature) {
    activeManifestSignature = getManifestSignature(local)
    activeManifest = local
  }

  return local
}

function queueArtifactRefresh(
  relativePath: string,
  manifestSignature: string,
  remoteManifest: BackendManifest | null
) {
  if (backgroundRefreshes.has(relativePath)) {
    return
  }

  if (backgroundRefreshes.size === 0 || refreshTargetManifestSignature !== manifestSignature) {
    refreshTargetManifestSignature = manifestSignature
    refreshTargetFailed = false
  }

  const refreshPromise = (async () => {
    try {
      const data = await fetchRemoteJson<unknown>(relativePath)
      if (isCanonicalCacheShape(relativePath, data)) {
        cache.set(relativePath, {
          data,
          ts: Date.now(),
          manifestSignature,
        })
      }
    } catch (err) {
      refreshTargetFailed = true
      console.warn(`[hf-data] Background refresh failed for ${relativePath}:`, err)
    } finally {
      backgroundRefreshes.delete(relativePath)

      if (
        backgroundRefreshes.size === 0 &&
        !refreshTargetFailed &&
        refreshTargetManifestSignature === manifestSignature
      ) {
        activeManifestSignature = manifestSignature
        activeManifest = remoteManifest
      }
    }
  })()

  backgroundRefreshes.set(relativePath, refreshPromise)
}

function queueObservedPathRefreshes(snapshot: {
  remote: BackendManifest | null
  local: BackendManifest | null
}) {
  const remoteManifestSignature = getManifestSignature(snapshot.remote)
  if (!remoteManifestSignature || remoteManifestSignature === activeManifestSignature) {
    return
  }

  for (const relativePath of observedPaths) {
    if (relativePath !== "manifest.json") {
      queueArtifactRefresh(relativePath, remoteManifestSignature, snapshot.remote)
    }
  }
}

function queueManifestSnapshotRefresh() {
  if (manifestRefreshPromise) {
    return manifestRefreshPromise
  }

  manifestRefreshPromise = (async () => {
    const local = await getLocalManifest()
    const remote = await fetchRemoteJson<BackendManifest>("manifest.json").catch((err) => {
      console.warn("[hf-data] Failed to fetch remote manifest:", err)
      return null
    })

    manifestSnapshotCache = {
      remote,
      local,
      ts: Date.now(),
    }

    const remoteManifestSignature = getManifestSignature(remote)
    if (!activeManifestSignature && remoteManifestSignature) {
      activeManifestSignature = remoteManifestSignature
      activeManifest = remote
    }

    queueObservedPathRefreshes(manifestSnapshotCache)
  })().finally(() => {
    manifestRefreshPromise = null
  })

  return manifestRefreshPromise
}

async function getManifestSnapshot() {
  const local = await getLocalManifest()

  if (!manifestSnapshotCache) {
    manifestSnapshotCache = {
      remote: null,
      local,
      ts: 0,
    }
  }

  if (
    MANIFEST_TTL_MS === 0 ||
    Date.now() - manifestSnapshotCache.ts >= MANIFEST_TTL_MS
  ) {
    void queueManifestSnapshotRefresh()
  }

  return manifestSnapshotCache
}

function getCurrentManifestFromSnapshot(snapshot: {
  remote: BackendManifest | null
  local: BackendManifest | null
}) {
  const remoteSignature = getManifestSignature(snapshot.remote)

  if (remoteSignature && remoteSignature === activeManifestSignature) {
    return snapshot.remote
  }

  return activeManifest ?? snapshot.local ?? snapshot.remote
}

async function fetchHFJson<T>(relativePath: string): Promise<T> {
  if (relativePath === "manifest.json") {
    const snapshot = await getManifestSnapshot()

    if (snapshot.remote) {
      return snapshot.remote as T
    }

    if (snapshot.local) {
      return snapshot.local as T
    }

    throw new Error("HF manifest fetch failed and no local manifest cache is available")
  }

  const manifestSnapshot = await getManifestSnapshot()
  const remoteManifestSignature = getManifestSignature(manifestSnapshot.remote)
  const localManifestSignature = getManifestSignature(manifestSnapshot.local)
  observedPaths.add(relativePath)

  // 1. In-memory cache (hot)
  const hit = cache.get(relativePath)
  const validHotCache = hit ? isCanonicalCacheShape(relativePath, hit.data) : false
  if (hit && !validHotCache) {
    cache.delete(relativePath)
  }
  if (
    hit &&
    validHotCache &&
    CACHE_TTL_MS > 0 &&
    Date.now() - hit.ts < CACHE_TTL_MS &&
    (!remoteManifestSignature || hit.manifestSignature === remoteManifestSignature)
  ) {
    return hit.data as T
  }

  if (hit && validHotCache) {
    if (remoteManifestSignature && hit.manifestSignature !== remoteManifestSignature) {
      queueArtifactRefresh(relativePath, remoteManifestSignature, manifestSnapshot.remote)
    }
    return hit.data as T
  }

  const local = await readLocalCache<T>(relativePath)
  const validLocalCache = local !== null && isCanonicalCacheShape(relativePath, local)

  // 2. If the local cache was built from the same manifest, keep using it.
  if (
    validLocalCache &&
    remoteManifestSignature &&
    localManifestSignature &&
    remoteManifestSignature === localManifestSignature
  ) {
    cache.set(relativePath, {
      data: local,
      ts: Date.now(),
      manifestSignature: remoteManifestSignature,
    })
    return local
  }

  // 3. Serve the local cache immediately and refresh in the background when the
  // manifest indicates newer data exists.
  if (validLocalCache) {
    cache.set(relativePath, {
      data: local,
      ts: Date.now(),
      manifestSignature: localManifestSignature ?? undefined,
    })

    if (remoteManifestSignature && remoteManifestSignature !== localManifestSignature) {
      queueArtifactRefresh(relativePath, remoteManifestSignature, manifestSnapshot.remote)
    }

    return local
  }

  // 4. Fall back to a live fetch only when there is no usable stale cache.
  try {
    const data = await fetchRemoteJson<T>(relativePath)
    cache.set(relativePath, {
      data,
      ts: Date.now(),
      manifestSignature: remoteManifestSignature ?? undefined,
    })
    return data
  } catch (err) {
    if (hit && validHotCache) {
      console.warn(`[hf-data] Using stale cache for ${relativePath} after live fetch failed`)
      return hit.data as T
    }

    throw err
  }
}

async function fetchHFJsonSafe<T>(relativePath: string): Promise<T | null> {
  try {
    return await fetchHFJson<T>(relativePath)
  } catch (err) {
    if (!String(err).includes("404")) {
      console.warn(`[hf-data] Failed to fetch ${relativePath}:`, err)
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// HF dataset types (shapes of JSON files in the HF repo)
// ---------------------------------------------------------------------------

export interface HFEvalModelResult {
  model_id: string
  model_route_id: string
  model_name: string
  developer: string
  raw_model_id?: string
  score: number
  evaluation_id?: string
  retrieved_timestamp?: string
  source_record_url?: string
  // The pipeline copies the parent record's provenance onto every hierarchy
  // model_result row. Required.
  source_metadata: SourceMetadata
  source_data?: SourceData | string[]
  detailed_evaluation_results?: string | null
  detailed_evaluation_results_meta?: unknown
  instance_level_data?: unknown
  passthrough_top_level_fields?: unknown
  evalcards?: { annotations?: RowAnnotations }
}

export interface HFEvalMetric {
  metric_summary_id: string
  legacy_eval_summary_id?: string
  evaluation_name?: string
  metric_name: string
  metric_key: string
  display_name?: string
  canonical_display_name?: string
  metric_config?: MetricConfig | Record<string, unknown>
  lower_is_better: boolean
  model_results: HFEvalModelResult[]
}

export interface HFEvalDetail extends SignalSummaries {
  eval_summary_id: string
  benchmark: string
  canonical_display_name?: string
  benchmark_family_key: string
  benchmark_leaf_key: string
  benchmark_leaf_name: string
  benchmark_parent_key?: string
  benchmark_parent_name?: string
  parent_benchmark_display_name?: string
  category: string
  source_data: SourceData
  benchmark_card: BenchmarkCard | null
  metrics: HFEvalMetric[]
  subtasks: unknown[]
  evalcards?: { annotations?: EvalcardsAnnotations }
}

export interface HFModelDetail extends SignalSummaries {
  model_info: ModelInfo & {
    family_id?: string
    family_slug?: string
    variant_key?: string
    variant_label?: string
    model_route_id?: string
  }
  model_group_id: string
  model_route_id: string
  model_family_name?: string
  raw_model_ids?: string[]
  last_updated?: string
  hierarchy_by_category: Record<string, HFModelHierarchyNode[]>
  evaluations_by_category?: Record<string, HFModelEvaluation[]>
  total_evaluations: number
  categories_covered: string[]
  variants: Array<{
    variant_key: string
    variant_label: string
    evaluation_count: number
    raw_model_ids: string[]
  }>
}

/** Evaluation entry inside an HF model detail file */
export interface HFModelEvaluation {
  schema_version?: string
  evaluation_id: string
  retrieved_timestamp: string
  benchmark?: string
  source_data?: SourceData | string[]
  source_metadata?: SourceMetadata
  eval_library?: { name: string; version?: string; additional_details?: Record<string, unknown> }
  model_info?: ModelInfo
  generation_config?: BenchmarkEvaluation["generation_config"]
  evaluation_results: EvaluationResult[]
  source_record_url?: string
  detailed_evaluation_results?: string | null
  detailed_evaluation_results_meta?: unknown
  instance_level_data?: unknown
  benchmark_card?: BenchmarkCard | null
  passthrough_top_level_fields?: unknown
}

export interface HFModelHierarchyMetric {
  metric_summary_id: string
  legacy_eval_summary_id?: string
  evaluation_name: string
  display_name: string
  canonical_display_name?: string
  benchmark_leaf_key: string
  benchmark_leaf_name: string
  slice_key?: string | null
  slice_name?: string | null
  lower_is_better: boolean
  metric_name: string
  metric_id: string
  metric_key: string
  metric_source?: string
  metric_config: MetricConfig
  models_count: number
  top_score?: number
  model_results: HFEvalModelResult[]
}

export interface HFModelHierarchyNode {
  eval_summary_id: string
  benchmark: string
  canonical_display_name?: string
  benchmark_family_key: string
  benchmark_family_name: string
  benchmark_parent_key: string
  benchmark_parent_name: string
  parent_benchmark_display_name?: string
  benchmark_leaf_key: string
  benchmark_leaf_name: string
  benchmark_component_key?: string | null
  benchmark_component_name?: string | null
  evaluation_name: string
  display_name: string
  is_summary_score: boolean
  category: string
  source_data: SourceData
  benchmark_card: BenchmarkCard | null
  tags: {
    domains: string[]
    languages: string[]
    tasks: string[]
  }
  subtasks_count: number
  metrics_count: number
  metric_names: string[]
  primary_metric_name: string
  metrics: HFModelHierarchyMetric[]
  subtasks: HFModelHierarchyNode[]
  top_score?: number
  constituent_evaluation_ids?: string[]
  instance_data?: {
    available: boolean
    url_count: number
    sample_urls: string[]
    models_with_loaded_instances: number
  }
}

// ---------------------------------------------------------------------------
// Public data fetchers
// ---------------------------------------------------------------------------

export async function fetchBenchmarkMetadataMap(): Promise<Record<string, BenchmarkCard>> {
  if (useViewLayerBackend()) {
    return (await import("@/lib/view-data")).getBenchmarkMetadataMap()
  }

  return fetchHFJson<Record<string, BenchmarkCard>>("benchmark-metadata.json")
}

export async function fetchBackendManifest(): Promise<BackendManifest> {
  if (useViewLayerBackend()) {
    return (await fetchSnapshotSidecars()).fetchManifest()
  }

  return fetchHFJson<BackendManifest>("manifest.json")
}

export async function fetchEvalHierarchy(): Promise<EvalHierarchy> {
  if (useViewLayerBackend()) {
    return adaptEvalHierarchy(await (await fetchSnapshotSidecars()).fetchHierarchy())
  }

  const raw = await fetchHFJson<EvalHierarchy>("eval-hierarchy.json")
  return adaptEvalHierarchy(raw)
}

/**
 * Validate-and-passthrough for the v3 hierarchy shape. The producer's
 * `write_hierarchy()` emits family-rooted trees directly; the adapter
 * no longer synthesises legacy shapes.
 *
 * Behaviour:
 *   - v3 detection via `schema_version === "v3.hierarchy.1"` —
 *     pass through unchanged.
 *   - Older snapshot lacking schema_version: log a warning and
 *     pass through. Consumers may render empty for missing fields
 *     but won't crash.
 *
 * The adapter no longer synthesises `families[].composites[]` from a
 * top-level `composites[]`; the producer does that grouping at write
 * time using `canonical_composites.family_id`.
 */
export function adaptEvalHierarchy(raw: EvalHierarchy): EvalHierarchy {
  if (!raw) {
    return { families: [] }
  }
  if (raw.schema_version && !raw.schema_version.startsWith("v3.hierarchy.")) {
    console.warn(
      `adaptEvalHierarchy: unexpected schema_version=${JSON.stringify(raw.schema_version)}; ` +
        `expected v3.hierarchy.*. Frontend may render incompletely.`,
    )
  }
  return raw
}

/**
 * The comparison index sliced to one page: the model slice or the slice of
 * exactly these evals. v2 queries the snapshot's comparison tables (null when
 * the snapshot has none); legacy datasets publish only the whole index, so it
 * is loaded as before and sliced in memory.
 */
export async function fetchComparisonSlice(
  request: { model: string } | { evals: string[] },
): Promise<ComparisonIndex | null> {
  if (useViewLayerBackend()) {
    const table = await import("@/lib/comparison-table")
    return "model" in request ? table.sliceForModel(request.model) : table.sliceForEvals(request.evals)
  }

  const index = await fetchHFJson<ComparisonIndex>("comparison-index.json")
  return "model" in request ? sliceIndexForModel(index, request.model) : sliceIndexForEvals(index, request.evals)
}

/**
 * Per-(eval, model) primary-metric peer ranks. v2 reads the wrapped
 * sidecar from the pinned snapshot; legacy reads the bare-map file
 * historically published unversioned at the dataset root.
 */
export async function fetchPeerRanks(): Promise<PeerRanksMap> {
  if (useViewLayerBackend()) {
    return (await fetchSnapshotSidecars()).fetchPeerRanks()
  }

  return (await fetchHFJsonSafe<PeerRanksMap>("peer-ranks.json")) ?? {}
}

export async function fetchCorpusAggregates(): Promise<CorpusAggregates | null> {
  if (useViewLayerBackend()) {
    return (await fetchSnapshotSidecars()).fetchHeadline()
  }

  return fetchHFJsonSafe<CorpusAggregates>("corpus-aggregates.json")
}

export async function fetchModelDetail(slug: string): Promise<HFModelDetail | null> {
  return fetchHFJsonSafe<HFModelDetail>(`models/${slug}.json`)
}

export async function fetchEvalDetail(slug: string): Promise<HFEvalDetail | null> {
  return fetchHFJsonSafe<HFEvalDetail>(`evals/${slug}.json`)
}
