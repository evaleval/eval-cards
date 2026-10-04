import "server-only"

import { createHash } from "node:crypto"
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type {
  BackendManifest,
  CorpusAggregates,
  EvalHierarchy,
  OrgMetadata,
  OrgMetadataIndex,
  PeerRanksMap,
  PeerRanksSidecar,
} from "@/lib/backend-artifacts"
import { cleanHierarchy, type ComparisonIndexLike } from "@/lib/clean-hierarchy"
import { cleanerInput } from "@/lib/comparison-table"
import { parseJsonWithBounds, stringifyJsonWithBounds } from "@/lib/json-bounds"
import type { CollectionContextSidecar, CollectionsSidecarEntry } from "@/lib/collections"

interface CacheSlot<T> {
  value: Promise<T>
  ts: number
  refresh?: Promise<void>
}

let cache: {
  manifest?: CacheSlot<BackendManifest>
  headline?: CacheSlot<CorpusAggregates>
  hierarchy?: CacheSlot<EvalHierarchy>
  peerRanks?: CacheSlot<PeerRanksMap>
  organizations?: CacheSlot<Record<string, OrgMetadata>>
  collections?: CacheSlot<Record<string, CollectionsSidecarEntry>>
  collectionContext?: CacheSlot<CollectionContextSidecar>
} = {}

function getSnapshotUrl() {
  const snapshotUrl = process.env.SNAPSHOT_URL?.trim()
  if (!snapshotUrl) {
    throw new Error("DATA_BACKEND=v2 requires SNAPSHOT_URL to point at a Stage J snapshot directory")
  }

  return snapshotUrl.replace(/\/+$/, "")
}

function sidecarUrl(name: string) {
  return `${getSnapshotUrl()}/${name}`
}

// Disk cache directory + refresh window for the multi-MB sidecar payloads.
// Next.js' built-in fetch cache rejects items over 2 MB so the 6 MB
// peer-ranks / 2.5 MB hierarchy were re-fetched
// from HuggingFace on every cold start. With the disk cache, a warm
// container reads from disk (sub-second) instead of re-downloading.
//
// Once a cached payload is older than the refresh window, we keep serving that
// stale file immediately and trigger exactly one background refresh. That
// avoids putting a real user back onto the slow path just because the daily
// refresh window rolled over.
//
// Resolution order:
//   1. `SIDECAR_CACHE_DIR` env var (explicit override)
//   2. `/data/sidecars` when `/data` is writable — the HF Space mounts a
//      persistent storage bucket there, so the cache survives container
//      rebuilds (not just restarts within one container).
//   3. `<tmpdir>/eval-card-sidecars` as the local-dev / no-bucket fallback.
function resolveDiskCacheDir(): string {
  const explicit = process.env.SIDECAR_CACHE_DIR?.trim()
  if (explicit) return explicit
  try {
    accessSync("/data", fsConstants.W_OK)
    return "/data/sidecars"
  } catch {
    return join(tmpdir(), "eval-card-sidecars")
  }
}

const DISK_CACHE_DIR = resolveDiskCacheDir()
const CACHE_REFRESH_SECONDS = Number.parseInt(
  process.env.SIDECAR_CACHE_REFRESH_SECONDS ??
    process.env.SIDECAR_CACHE_TTL_SECONDS ??
    "86400",
  10,
)
const CACHE_REFRESH_MS = CACHE_REFRESH_SECONDS * 1000
const backgroundRefreshes = new Map<string, Promise<void>>()

// Identifies the deployed build. Next.js writes a fresh random
// `.next/BUILD_ID` per `next build`, so reading it gives us a value
// that changes on every HF Space rebuild but is stable across restarts
// of the same container. `SIDECAR_BUILD_ID` overrides for tests / when
// the build id needs to be forced from outside.
function readBuildId(): string {
  const explicit = process.env.SIDECAR_BUILD_ID?.trim()
  if (explicit) return explicit
  try {
    const id = readFileSync(join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim()
    if (id) return id
  } catch {}
  return "dev"
}

const BUILD_ID = readBuildId()
const BUILD_MARKER_PATH = join(DISK_CACHE_DIR, ".build-id")

// Auto-purge the persistent /data/sidecars bucket whenever BUILD_ID changes.
// The bucket survives container rebuilds, so without this a rebuild would keep
// serving stale sidecars + stale cleaner output until the refresh window
// expired. Wiping on build change means: rebuild the Space -> first request
// after boot refetches everything fresh.
//
// SIDECAR_CACHE_PURGE=1 stays as a manual escape hatch (e.g. wipe without
// rebuilding when SNAPSHOT_URL is bumped at runtime).
function purgeAndStampBuild() {
  const forced = process.env.SIDECAR_CACHE_PURGE === "1"
  let prev = ""
  try {
    prev = readFileSync(BUILD_MARKER_PATH, "utf8").trim()
  } catch {}
  if (!forced && prev === BUILD_ID) return
  try {
    rmSync(DISK_CACHE_DIR, { recursive: true, force: true })
    mkdirSync(DISK_CACHE_DIR, { recursive: true })
    writeFileSync(BUILD_MARKER_PATH, BUILD_ID, "utf8")
    const reason = forced ? "SIDECAR_CACHE_PURGE=1" : `build ${prev || "<none>"} -> ${BUILD_ID}`
    console.warn(`[sidecars] purged ${DISK_CACHE_DIR} (${reason})`)
  } catch (err) {
    console.warn(`[sidecars] purge failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

purgeAndStampBuild()

function diskCachePath(url: string): string {
  // The path encodes the URL hash so swapping SNAPSHOT_URL doesn't collide
  // with the previous snapshot's cached payloads.
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 16)
  const safeName = url.split("/").slice(-1)[0]?.replace(/[^a-zA-Z0-9._-]/g, "_") ?? "sidecar"
  return join(DISK_CACHE_DIR, `${hash}-${safeName}`)
}

async function readFromDisk(path: string): Promise<{ text: string | null; stale: boolean }> {
  try {
    const info = await stat(path)
    const text = await readFile(path, "utf8")
    return {
      text,
      stale: Date.now() - info.mtimeMs > CACHE_REFRESH_MS,
    }
  } catch {
    return { text: null, stale: false }
  }
}

async function writeToDisk(path: string, payload: string): Promise<void> {
  try {
    await mkdir(DISK_CACHE_DIR, { recursive: true })
    const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmpPath, payload, "utf8")
    const fs = await import("node:fs/promises")
    await fs.rename(tmpPath, path)
  } catch (err) {
    console.warn(`[sidecars] failed to write disk cache ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function fetchRemoteSidecar(url: string): Promise<string> {
  const response = await fetch(url, { next: { revalidate: CACHE_REFRESH_SECONDS } })
  if (!response.ok) {
    throw new Error(`Snapshot sidecar fetch failed: ${response.status} ${response.statusText} for ${url}`)
  }
  return response.text()
}

function queueRefresh(refreshKey: string, label: string, refresh: () => Promise<void>) {
  if (backgroundRefreshes.has(refreshKey)) {
    return
  }

  const refreshPromise = refresh()
    .catch((err) => {
      console.warn(
        `[sidecars] background refresh failed for ${label}: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
    .finally(() => {
      backgroundRefreshes.delete(refreshKey)
    })

  backgroundRefreshes.set(refreshKey, refreshPromise)
}

async function fetchJson<T>(name: string, preferStale = true): Promise<T> {
  const url = sidecarUrl(name)

  if (url.startsWith("file://")) {
    const text = await readFile(new URL(url), "utf8")
    return parseJsonWithBounds<T>(text)
  }

  const cachePath = diskCachePath(url)
  const cached = await readFromDisk(cachePath)
  if (cached.text !== null) {
    if (preferStale) {
      if (cached.stale) {
        queueRefresh(cachePath, name, async () => {
          const text = await fetchRemoteSidecar(url)
          await writeToDisk(cachePath, text)
        })
      }
      return parseJsonWithBounds<T>(cached.text)
    }

    if (!cached.stale) {
      return parseJsonWithBounds<T>(cached.text)
    }
  }

  const text = await fetchRemoteSidecar(url)
  void writeToDisk(cachePath, text)
  return parseJsonWithBounds<T>(text)
}

function getCachedValue<K extends keyof typeof cache>(
  key: K,
  label: string,
  loader: (preferStale?: boolean) => Promise<NonNullable<(typeof cache)[K]> extends CacheSlot<infer T> ? T : never>,
): NonNullable<(typeof cache)[K]> extends CacheSlot<infer T> ? Promise<T> : never {
  type Value = NonNullable<(typeof cache)[K]> extends CacheSlot<infer T> ? T : never

  const existing = cache[key] as CacheSlot<Value> | undefined
  if (!existing) {
    const slot = {} as CacheSlot<Value>
    slot.ts = Date.now()
    slot.value = loader(true).catch((err) => {
      if (cache[key] === slot) {
        delete cache[key]
      }
      throw err
    })
    cache[key] = slot as (typeof cache)[K]
    return slot.value as NonNullable<(typeof cache)[K]> extends CacheSlot<infer T> ? Promise<T> : never
  }

  if (Date.now() - existing.ts >= CACHE_REFRESH_MS && !existing.refresh) {
    existing.refresh = (async () => {
      try {
        const freshValue = await loader(false)
        existing.value = Promise.resolve(freshValue)
        existing.ts = Date.now()
      } catch (err) {
        console.warn(
          `[sidecars] in-memory refresh failed for ${label}: ${err instanceof Error ? err.message : String(err)}`,
        )
      } finally {
        existing.refresh = undefined
      }
    })()
  }

  return existing.value as NonNullable<(typeof cache)[K]> extends CacheSlot<infer T> ? Promise<T> : never
}

async function fetchComparisonForCleaner(): Promise<ComparisonIndexLike | null> {
  try {
    const input = await cleanerInput()
    if (input) return input
    console.warn("[sidecars] comparison tables not in snapshot; cleaner will skip aggregator dedup.")
  } catch (err) {
    console.warn(
      `[sidecars] comparison data unavailable; cleaner will skip aggregator dedup. ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return null
}

async function buildCleanedHierarchy(): Promise<EvalHierarchy> {
  const [raw, comparisonIndex] = await Promise.all([
    fetchJson<EvalHierarchy>("hierarchy.json", false),
    fetchComparisonForCleaner(),
  ])
  return cleanHierarchy(raw, comparisonIndex)
}

async function fetchCleanedHierarchy(preferStale = true): Promise<EvalHierarchy> {
  const snapshotUrl = getSnapshotUrl()
  const cleanCachePath = diskCachePath(`${snapshotUrl}/clean-hierarchy.json`)
  const cached = await readFromDisk(cleanCachePath)

  if (cached.text !== null) {
    try {
      const parsed = parseJsonWithBounds<EvalHierarchy>(cached.text)
      if (preferStale && cached.stale) {
        queueRefresh(cleanCachePath, "clean-hierarchy.json", async () => {
          const cleaned = await buildCleanedHierarchy()
          await writeToDisk(cleanCachePath, stringifyJsonWithBounds(cleaned))
        })
      }
      if (preferStale || !cached.stale) {
        return parsed
      }
    } catch (err) {
      console.warn(
        `[sidecars] clean-hierarchy cache corrupt at ${cleanCachePath}; rebuilding. ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const cleaned = await buildCleanedHierarchy()
  void writeToDisk(cleanCachePath, stringifyJsonWithBounds(cleaned))
  return cleaned
}

export function fetchManifest(): Promise<BackendManifest> {
  return getCachedValue("manifest", "manifest", (preferStale) => fetchJson<BackendManifest>("manifest.json", preferStale))
}

export function fetchHeadline(): Promise<CorpusAggregates> {
  return getCachedValue("headline", "headline", (preferStale) => fetchJson<CorpusAggregates>("headline.json", preferStale))
}

/**
 * Returns the cleaned hierarchy used by the rest of the app — sanitised
 * display names, populated `derivedTags`, filtered `benchmark_index[]`.
 *
 * Disk cache layout: distinct from the raw `hierarchy.json` cache so the
 * cleaner runs at most once per snapshot. On a cold container we hit the
 * clean cache first; once it is older than the refresh window we keep serving
 * it immediately and rebuild in the background.
 */
export function fetchHierarchy(): Promise<EvalHierarchy> {
  return getCachedValue("hierarchy", "hierarchy", (preferStale) => fetchCleanedHierarchy(preferStale))
}

/** Per-model cleaned benchmark count from the hierarchy payload.
 *  Returns an empty map when the hierarchy was loaded without
 *  comparison data (e.g. old cached v10 blobs). */
export async function fetchModelCoverage(): Promise<Record<string, number>> {
  const h = await fetchHierarchy()
  return h._modelCoverageMap ?? {}
}

/**
 * Per-(eval, model) primary-metric peer ranks from
 * `warehouse/<snapshot>/peer-ranks.json`. Resolves to the bare
 * `eval_summary_id -> model_route_id -> {position, total}` map the
 * model-detail benchmark grid expects, so callers don't have to reach
 * into `.ranks` themselves.
 *
 * Returns an empty map if the snapshot doesn't carry the file yet — the
 * producer started emitting it as a Stage J sidecar in May 2026, so older
 * pinned snapshots may 404. Logs a warning in that case rather than throwing
 * so the rest of the page still renders.
 */
export function fetchPeerRanks(): Promise<PeerRanksMap> {
  return getCachedValue("peerRanks", "peer ranks", (preferStale) =>
    fetchJson<PeerRanksSidecar>("peer-ranks.json", preferStale)
      .then((payload) => payload?.ranks ?? {})
      .catch((err) => {
        console.warn(
          `[sidecars] peer-ranks.json not available on snapshot; ` +
            `falling back to empty map. ${err instanceof Error ? err.message : String(err)}`,
        )
        return {} as PeerRanksMap
      }),
  )
}

/**
 * Per-evaluator-org metadata (homepage URL + logo pointer) from
 * `warehouse/<snapshot>/organizations.json`, sourced from the registry.
 * Resolves to the bare `normalizedName -> OrgMetadata` map the evaluator page
 * looks up by name.
 *
 * Returns an empty map when the snapshot doesn't carry the file (older pinned
 * snapshots predate the Stage J `organizations` sidecar), logging a warning
 * rather than throwing so the page still renders with monograms + no links.
 */
export function fetchOrganizations(): Promise<Record<string, OrgMetadata>> {
  return getCachedValue("organizations", "organizations", (preferStale) =>
    fetchJson<OrgMetadataIndex>("organizations.json", preferStale)
      .then((payload) => payload?.orgs ?? {})
      .catch((err) => {
        console.warn(
          `[sidecars] organizations.json not available on snapshot; ` +
            `falling back to empty map. ${err instanceof Error ? err.message : String(err)}`,
        )
        return {} as Record<string, OrgMetadata>
      }),
  )
}

/**
 * Per-collection metadata from `warehouse/<snapshot>/collections.json`,
 * keyed by `eval_results_view.collection_id`. Curated entries carry the
 * study attribution + protocol axes the collection surfaces read
 * (notes/collection-benchmark-page-spec.md R1.2).
 *
 * Returns an empty map when the snapshot doesn't carry the file (older
 * pinned snapshots predate the collections sidecar), logging a warning
 * rather than throwing so eval pages render exactly as before.
 */
export function fetchCollections(): Promise<Record<string, CollectionsSidecarEntry>> {
  return getCachedValue("collections", "collections", (preferStale) =>
    fetchJson<Record<string, CollectionsSidecarEntry>>("collections.json", preferStale)
      .then((payload) => payload ?? {})
      .catch((err) => {
        console.warn(
          `[sidecars] collections.json not available on snapshot; ` +
            `falling back to empty map. ${err instanceof Error ? err.message : String(err)}`,
        )
        return {} as Record<string, CollectionsSidecarEntry>
      }),
  )
}

/**
 * Scaffold-context strips from `warehouse/<snapshot>/collection_context.json`,
 * keyed collection_id → benchmark_key. The producer pre-joins the external
 * per-scaffold leaderboard points onto the collection's own models, so the
 * frontend only has to render what it is handed.
 *
 * Returns an empty map when the snapshot doesn't carry the file (every
 * snapshot before the scaffold-context bake), logging a warning rather than
 * throwing so the Context view is simply absent.
 */
export function fetchCollectionContext(): Promise<CollectionContextSidecar> {
  return getCachedValue("collectionContext", "collection context", (preferStale) =>
    fetchJson<CollectionContextSidecar>("collection_context.json", preferStale)
      .then((payload) => payload ?? {})
      .catch((err) => {
        console.warn(
          `[sidecars] collection_context.json not available on snapshot; ` +
            `falling back to empty map. ${err instanceof Error ? err.message : String(err)}`,
        )
        return {} as CollectionContextSidecar
      }),
  )
}

export function resetSidecarCacheForTests() {
  cache = {}
  backgroundRefreshes.clear()
}
