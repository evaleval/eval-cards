import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

// No page, route, build step or dev script may load the whole comparison
// index: the app reads per-page slices of the comparison tables. The only
// exceptions are the tools that check those tables against the producer's
// JSON, and the legacy data backend, which publishes nothing else.

const ROOT = path.join(__dirname, "..")
const SCANNED = ["app", "components", "lib", "scripts", "middleware.ts"]
const SOURCE = /\.(?:ts|tsx|mts|js|mjs|cjs)$/

const WHOLE_INDEX_TOOLS = new Set([
  "scripts/comparison-full-index.ts",
  "scripts/verify-comparison-slices.mts",
  "scripts/build-comparison-fixture.mjs",
])
// Legacy only: the dataset publishes the whole index (the route slices it in
// memory), the cache shape check names it, and the prefetch script exits
// under the v2 backend before reaching its file list.
const LEGACY_READERS: Record<string, number> = {
  "lib/hf-data.ts": 2,
  "scripts/cache-hf-data.mjs": 1,
}

function files(entry: string): string[] {
  const full = path.join(ROOT, entry)
  if (!statSync(full, { throwIfNoEntry: false })) return []
  if (statSync(full).isFile()) return SOURCE.test(entry) ? [entry] : []
  return readdirSync(full).flatMap((name) => files(path.join(entry, name)))
}

function code(file: string) {
  return readFileSync(path.join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
}

const sources = SCANNED.flatMap(files)

describe("no code path loads the whole comparison index", () => {
  it("scans the app, its libraries and its scripts", () => {
    expect(sources).toContain("lib/comparison-table.ts")
    expect(sources).toContain("app/api/comparison-index/route.ts")
    expect(sources).toContain("scripts/warm-startup-cache.mjs")
  })

  it("reads comparison-index.json only in the verification tools and the legacy backend", () => {
    const offenders = sources.flatMap((file) => {
      if (WHOLE_INDEX_TOOLS.has(file)) return []
      const count = code(file).match(/comparison-index\.json/g)?.length ?? 0
      return count > (LEGACY_READERS[file] ?? 0) ? [`${file} (${count})`] : []
    })
    expect(offenders).toEqual([])
  })

  it("calls /api/comparison-index only with a selector", () => {
    const offenders = sources.filter((file) => /\/api\/comparison-index(?!\?)(?![\w/.-])/.test(code(file)))
    expect(offenders).toEqual([])
  })

  it("fetches a ComparisonIndex only as a page slice, or whole in the legacy branch", () => {
    const allowed = (file: string, call: string) =>
      (file === "lib/dashboard-data-client.ts" && /^fetchJson<ComparisonIndex>\(`\/api\/comparison-index\?(?:model|evals)=/.test(call)) ||
      (file === "lib/hf-data.ts" && call === 'fetchHFJson<ComparisonIndex>("comparison-index.json"')
    const calls = sources
      .filter((file) => !WHOLE_INDEX_TOOLS.has(file))
      .flatMap((file) =>
        [...code(file).matchAll(/\b\w+\s*<\s*ComparisonIndex\s*>\s*\(\s*[^,)\n]*/g)].map((m) => ({ file, call: m[0] })),
      )
    expect(calls.filter(({ file, call }) => allowed(file, call))).toHaveLength(3)
    expect(calls.filter(({ file, call }) => !allowed(file, call))).toEqual([])
    const legacyReads = code("lib/hf-data.ts").match(/fetchHFJson<ComparisonIndex>/g) ?? []
    expect(legacyReads).toHaveLength(1)
  })

  it("reads the whole index in lib/hf-data.ts only after the v2 backend has returned", () => {
    const body = code("lib/hf-data.ts").match(/export async function fetchComparisonSlice\([\s\S]*?\n}\n/)?.[0] ?? ""
    const v2Return = body.search(/if \(useViewLayerBackend\(\)\) \{[^}]*\breturn\b[^}]*\}/)
    const read = body.indexOf("fetchHFJson<ComparisonIndex>")
    expect(v2Return).toBeGreaterThanOrEqual(0)
    expect(read).toBeGreaterThan(v2Return)
  })

  it("uses the whole-index rebuild and in-memory slicers only where allowed", () => {
    // module or export name -> files outside the verification tools that may use it
    const restricted: Array<[RegExp, Set<string>]> = [
      [/comparison-full-index|\bfullComparisonIndex\b/, new Set()],
      [/\bcomparisonTableInternals\b/, new Set(["lib/comparison-table.ts"])],
      [/comparison-slice["'`]|\bsliceIndexFor(?:Model|Evals)\b/, new Set(["lib/comparison-slice.ts", "lib/hf-data.ts"])],
    ]
    const offenders = sources.flatMap((file) => {
      if (WHOLE_INDEX_TOOLS.has(file)) return []
      const text = code(file)
      return restricted.filter(([pattern, owners]) => !owners.has(file) && pattern.test(text)).map(([p]) => `${file} ${p}`)
    })
    expect(offenders).toEqual([])
  })
})
