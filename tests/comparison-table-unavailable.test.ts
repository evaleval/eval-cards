import { copyFile, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gunzipSync } from "node:zlib"

import { DuckDBConnection } from "@duckdb/node-api"
import { afterEach, describe, expect, it, vi } from "vitest"

import { FIXTURE_DIR, fixtureIndex, useSnapshot } from "./comparison-fixture"

// A snapshot without usable comparison tables (one produced before they
// existed, one missing a table, or tables from two snapshots) behaves as a
// comparison index that failed to load: readers return null, the route says
// unavailable, and the hierarchy cleans without its two index-backed steps.

const BASE_FILES = [
  "models_view.parquet",
  "evals_view.parquet",
  "eval_results_view.parquet",
  "merged_evals_view.parquet",
  "hierarchy.json",
]

const COMPARISON_FILES = ["comparison_evals.parquet", "comparison_metrics.parquet", "comparison_scores.parquet"]

let cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const step of cleanup.reverse()) await step()
  cleanup = []
})

async function snapshotWith(tables: string[], mutate?: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "eval-card-no-comparison-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  for (const name of [...BASE_FILES, ...tables]) {
    await copyFile(path.join(FIXTURE_DIR, name), path.join(dir, name))
  }
  await mutate?.(dir)
  vi.resetModules()
  cleanup.push(useSnapshot(dir))
  return dir
}

/** The fixture's comparison_evals rewritten with the producer's top-level
 *  metadata key, its values overridden by `override`. */
async function evalsWithTopLevel(dir: string, override: Record<string, unknown>) {
  const { evals: _evals, by_model: _byModel, ...topLevel } = fixtureIndex()
  const json = JSON.stringify({ ...topLevel, ...override }).replace(/'/g, "''")
  const connection = await DuckDBConnection.create()
  const from = path.join(FIXTURE_DIR, "comparison_evals.parquet").replace(/'/g, "''")
  const to = path.join(dir, "comparison_evals.parquet").replace(/'/g, "''")
  await connection.run(
    `COPY (SELECT * FROM read_parquet('${from}')) TO '${to}'
     (FORMAT parquet, KV_METADATA {comparison_index_top_level: '${json}'})`,
  )
}

async function expectUnavailable() {
  const table = await import("@/lib/comparison-table")
  expect(await table.cleanerInput()).toBeNull()
  expect(await table.sliceForModel("openai%2Fgpt-5.5")).toBeNull()
  expect(await table.sliceForEvals(["llm-stats%2Fwmdp"])).toBeNull()

  const { GET } = await import("@/app/api/comparison-index/route")
  expect((await GET(new Request("http://localhost/api/comparison-index?model=openai%252Fgpt-5.5"))).status).toBe(503)
  expect((await GET(new Request("http://localhost/api/comparison-index?evals=wmdp"))).status).toBe(503)

  const sidecars = await import("@/lib/sidecars")
  const hierarchy = await sidecars.fetchHierarchy()
  expect(hierarchy.families.length).toBeGreaterThan(0)
  expect(hierarchy._modelCoverageMap).toBeUndefined()
  expect(await sidecars.fetchModelCoverage()).toEqual({})
}

describe("comparison data unavailable", () => {
  it("when the snapshot predates the comparison tables", async () => {
    await snapshotWith([])
    await expectUnavailable()
  })

  it("when one of the three tables is missing", async () => {
    await snapshotWith(["comparison_evals.parquet", "comparison_scores.parquet"])
    await expectUnavailable()
  })

  it("when the tables come from different snapshots", async () => {
    await snapshotWith(
      ["comparison_metrics.parquet", "comparison_scores.parquet"],
      async (dir) => {
        const connection = await DuckDBConnection.create()
        const from = path.join(FIXTURE_DIR, "comparison_evals.parquet").replace(/'/g, "''")
        const to = path.join(dir, "comparison_evals.parquet").replace(/'/g, "''")
        await connection.run(
          `COPY (SELECT * REPLACE (snapshot_id + INTERVAL 1 DAY AS snapshot_id) FROM read_parquet('${from}'))
           TO '${to}' (FORMAT parquet)`,
        )
      },
    )
    await expectUnavailable()
  })

  it("is available again once all three tables agree", async () => {
    await snapshotWith(["comparison_evals.parquet", "comparison_metrics.parquet", "comparison_scores.parquet"])
    const table = await import("@/lib/comparison-table")
    expect(await table.cleanerInput()).not.toBeNull()
    const sidecars = await import("@/lib/sidecars")
    expect(Object.keys(await sidecars.fetchModelCoverage()).length).toBeGreaterThan(0)
  })

  it("when the tables have no rows and no top-level metadata", async () => {
    await snapshotWith([], async (dir) => {
      const connection = await DuckDBConnection.create()
      for (const name of COMPARISON_FILES) {
        const from = path.join(FIXTURE_DIR, name).replace(/'/g, "''")
        const to = path.join(dir, name).replace(/'/g, "''")
        await connection.run(`COPY (SELECT * FROM read_parquet('${from}') LIMIT 0) TO '${to}' (FORMAT parquet)`)
      }
    })
    await expectUnavailable()
  })

  it("when comparison_evals rows disagree with its top-level metadata", async () => {
    await snapshotWith(COMPARISON_FILES.slice(1), (dir) => evalsWithTopLevel(dir, { generated_at: "1999-01-01T00:00:00Z" }))
    await expectUnavailable()
  })

  it("is available when comparison_evals rows agree with its top-level metadata", async () => {
    await snapshotWith(COMPARISON_FILES.slice(1), (dir) => evalsWithTopLevel(dir, {}))
    const table = await import("@/lib/comparison-table")
    const { by_model: _, ...expected } = fixtureIndex()
    expect(await table.sliceForEvals(Object.keys(expected.evals))).toStrictEqual(expected)
  })
})

// An index with no evals, written by the producer's own table writer
// (fixtures/comparison-empty), round-trips with its four top-level values,
// which then come from the parquet key-value metadata.
const EMPTY_FIXTURE_DIR = path.join(__dirname, "fixtures", "comparison-empty")
const EMPTY_TOP_LEVEL = {
  comparison_index_version: 2,
  config_version: 3,
  generated_at: "2026-09-30T12:34:56Z",
  metric_group_order: ["cost", "capability", "other"],
}

async function body(response: Response) {
  const bytes = Buffer.from(await response.arrayBuffer())
  return response.headers.get("content-encoding") === "gzip" ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8")
}

describe("comparison tables with no rows", () => {
  it("rebuild the empty index and serve it with all four top-level values", async () => {
    await snapshotWith([], async (dir) => {
      for (const name of COMPARISON_FILES) await copyFile(path.join(EMPTY_FIXTURE_DIR, name), path.join(dir, name))
    })
    const withByModel = {
      by_model: {},
      comparison_index_version: 2,
      config_version: 3,
      evals: {},
      generated_at: "2026-09-30T12:34:56Z",
      metric_group_order: ["cost", "capability", "other"],
    }
    const { by_model: _, ...withoutByModel } = withByModel

    const { fullComparisonIndex } = await import("../scripts/comparison-full-index")
    expect(await fullComparisonIndex()).toStrictEqual(withByModel)
    const table = await import("@/lib/comparison-table")
    expect(await table.cleanerInput()).toStrictEqual({ evals: {} })
    expect(await table.sliceForModel("openai%2Fgpt-5.5")).toStrictEqual(withByModel)
    expect(await table.sliceForEvals(["wmdp"])).toStrictEqual(withoutByModel)

    const { GET } = await import("@/app/api/comparison-index/route")
    const modelResponse = await GET(new Request("http://localhost/api/comparison-index?model=openai%252Fgpt-5.5"))
    expect(modelResponse.status).toBe(200)
    expect(await body(modelResponse)).toBe(JSON.stringify(withByModel))
    const evalsResponse = await GET(new Request("http://localhost/api/comparison-index?evals=wmdp"))
    expect(evalsResponse.status).toBe(200)
    expect(await body(evalsResponse)).toBe(JSON.stringify(withoutByModel))

    const sidecars = await import("@/lib/sidecars")
    expect((await sidecars.fetchHierarchy()).families.length).toBeGreaterThan(0)
    expect(await sidecars.fetchModelCoverage()).toEqual({})
  })
})
