import "server-only"

import { createHash } from "node:crypto"
import { gzip } from "node:zlib"
import { promisify } from "node:util"

import { stringifyJsonWithBounds } from "@/lib/json-bounds"

const gzipAsync = promisify(gzip)

// These index payloads are large (model-cards-lite ~15 MB, eval-list-lite
// ~5 MB) and computed from the in-memory DuckDB tables on every request,
// then shipped uncompressed — so /models and /evals showed a long loading
// state on first visit. Server compute is only ~1s; the cost is the
// uncompressed transfer.
//
// This memoises the *serialized, gzipped* bytes per process with a TTL, so:
//   - the payload is built once (not per request), and
//   - clients download the gzipped form (~10x smaller) with an ETag for
//     conditional 304s on repeat visits.
// `scripts/warm-startup-cache.mjs` hits these routes at boot, so the cache
// is primed before the first real visitor.

type Entry = { gz: Buffer; raw: Buffer; etag: string }

const inflight = new Map<string, { at: number; promise: Promise<Entry> }>()

async function buildEntry(producer: () => Promise<unknown>): Promise<Entry> {
  const data = await producer()
  // Bound wire form: a bare JSON.stringify would turn a revived infinite
  // registry bound into null on its way to the browser.
  const raw = Buffer.from(stringifyJsonWithBounds(data))
  const gz = await gzipAsync(raw)
  const etag = `"${createHash("sha1").update(raw).digest("hex").slice(0, 27)}"`
  return { gz, raw, etag }
}

const CACHE_CONTROL = "public, max-age=600, stale-while-revalidate=3600"

/**
 * Build (or reuse a cached) gzipped JSON response for `key`, recomputing at
 * most once per `ttlMs`. Honors If-None-Match (304) and Accept-Encoding
 * (falls back to identity for the rare client that can't take gzip).
 */
export async function cachedGzipJson(
  request: Request,
  key: string,
  ttlMs: number,
  producer: () => Promise<unknown>,
): Promise<Response> {
  const now = Date.now()
  const hit = inflight.get(key)

  let entryPromise: Promise<Entry>
  if (hit && now - hit.at < ttlMs) {
    entryPromise = hit.promise
  } else {
    entryPromise = buildEntry(producer)
    inflight.set(key, { at: now, promise: entryPromise })
    // On failure, evict so the next request retries instead of caching a
    // rejected promise for the whole TTL.
    entryPromise.catch(() => {
      if (inflight.get(key)?.promise === entryPromise) inflight.delete(key)
    })
  }

  return respond(request, await entryPromise)
}

/** The same gzip / ETag response for a payload built per request, without
 *  the per-process memo. */
export async function gzipJson(request: Request, data: unknown): Promise<Response> {
  return respond(request, await buildEntry(async () => data))
}

function respond(request: Request, entry: Entry): Response {
  if (request.headers.get("if-none-match") === entry.etag) {
    return new Response(null, {
      status: 304,
      headers: { etag: entry.etag, "cache-control": CACHE_CONTROL },
    })
  }

  const acceptsGzip = (request.headers.get("accept-encoding") ?? "").includes("gzip")
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": CACHE_CONTROL,
    etag: entry.etag,
    vary: "Accept-Encoding",
  }
  if (acceptsGzip) headers["content-encoding"] = "gzip"

  const buf = acceptsGzip ? entry.gz : entry.raw
  // Hand the Response the raw bytes. A Node Buffer is a valid body at
  // runtime (undici), but its generic type isn't assignable to BodyInit, so
  // cast through unknown.
  return new Response(buf as unknown as BodyInit, { headers })
}
