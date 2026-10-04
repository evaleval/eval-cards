import "server-only"

import { DuckDBConnection } from "@duckdb/node-api"
import { fileURLToPath } from "node:url"

let connectionPromise: Promise<DuckDBConnection> | null = null

function getSnapshotUrl() {
  const snapshotUrl = process.env.SNAPSHOT_URL?.trim()
  if (!snapshotUrl) {
    throw new Error("DATA_BACKEND=v2 requires SNAPSHOT_URL to point at a Stage J snapshot directory")
  }

  return snapshotUrl.replace(/\/+$/, "")
}

function snapshotArtifact(name: string) {
  return `${getSnapshotUrl()}/${name}`
}

function sqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

const VIEW_FILES = {
  models_view: "models_view.parquet",
  evals_view: "evals_view.parquet",
  eval_results_view: "eval_results_view.parquet",
} as const

// Additive snapshot artifacts that older snapshots don't ship. Loaded
// best-effort: a missing file must NOT fail connection init (the required
// loop above hard-fails by design). Consumers probe table presence and
// degrade — getMergedBenchmarkSummary returns null when the merged view
// is absent.
const OPTIONAL_VIEW_FILES = {
  merged_evals_view: "merged_evals_view.parquet",
  // Collections (notes/collection-dashboard-spec.md): per-attempt
  // trajectories for protocol-varied collections; only present on
  // snapshots whose backend shipped a vendored collection extract.
  collection_trajectories: "collection_trajectories.parquet",
} as const

// The comparison leaderboards (one row per eval, per eval metric, per score
// cell). They only mean something together, so they load as one unit: if any
// file is missing or they come from different snapshots, none of them is
// kept and consumers see the comparison data as unavailable.
export const COMPARISON_TABLES = {
  comparison_evals: "comparison_evals.parquet",
  comparison_metrics: "comparison_metrics.parquet",
  comparison_scores: "comparison_scores.parquet",
} as const

// The index's top-level values (comparison_index_version, config_version,
// generated_at, metric_group_order) ride on every comparison_evals row and,
// as JSON, in that file's parquet key-value metadata, so an index with no
// evals still has them. Loading into a table drops file metadata, so the JSON
// is kept here (one row, or none when the file has no such key).
export const COMPARISON_TOP_LEVEL_TABLE = "comparison_top_level"
const TOP_LEVEL_METADATA_KEY = "comparison_index_top_level"

function isTopLevel(value: unknown): boolean {
  const v = value as Record<string, unknown> | null
  return (
    typeof v === "object" &&
    v !== null &&
    Number.isInteger(v.comparison_index_version) &&
    Number.isInteger(v.config_version) &&
    typeof v.generated_at === "string" &&
    Array.isArray(v.metric_group_order) &&
    v.metric_group_order.every((group) => typeof group === "string")
  )
}

async function loadTopLevel(connection: DuckDBConnection, evalsSource: string) {
  await connection.run(
    `CREATE OR REPLACE TABLE ${COMPARISON_TOP_LEVEL_TABLE} AS
     SELECT decode(value) AS top_level FROM parquet_kv_metadata(${sqlString(evalsSource)})
     WHERE decode(key) = ${sqlString(TOP_LEVEL_METADATA_KEY)}`,
  )
  const [stored] = (
    await connection.runAndReadAll(`SELECT top_level FROM ${COMPARISON_TOP_LEVEL_TABLE}`)
  ).getRowObjectsJS()
  const [row] = (
    await connection.runAndReadAll(
      `SELECT
         CAST(comparison_index_version AS INTEGER) AS comparison_index_version,
         CAST(config_version AS INTEGER) AS config_version,
         generated_at,
         metric_group_order
       FROM comparison_evals
       LIMIT 1`,
    )
  ).getRowObjectsJS()
  if (stored === undefined) {
    if (row === undefined) throw new Error("comparison_evals has no rows and no top-level metadata")
    return
  }
  const topLevel = JSON.parse(String(stored.top_level))
  if (!isTopLevel(topLevel)) throw new Error("comparison_evals top-level metadata is malformed")
  if (
    row !== undefined &&
    JSON.stringify([
      row.comparison_index_version,
      row.config_version,
      row.generated_at,
      row.metric_group_order,
    ]) !==
      JSON.stringify([
        topLevel.comparison_index_version,
        topLevel.config_version,
        topLevel.generated_at,
        topLevel.metric_group_order,
      ])
  ) {
    throw new Error("comparison_evals rows disagree with its top-level metadata")
  }
}

async function loadComparisonTables(connection: DuckDBConnection): Promise<boolean> {
  try {
    const sources: Record<string, string> = {}
    for (const [tableName, fileName] of Object.entries(COMPARISON_TABLES)) {
      const url = snapshotArtifact(fileName)
      const source = url.startsWith("file://") ? fileURLToPath(url) : url
      sources[tableName] = source
      await connection.run(
        `CREATE OR REPLACE TABLE ${tableName} AS SELECT * FROM read_parquet(${sqlString(source)})`,
      )
    }
    await loadTopLevel(connection, sources.comparison_evals)
    // An empty table carries no snapshot_id, so this cannot tell which
    // snapshot an empty file came from.
    const reader = await connection.runAndReadAll(
      `SELECT count(DISTINCT snapshot_id) AS n FROM (${Object.keys(COMPARISON_TABLES)
        .map((tableName) => `SELECT DISTINCT snapshot_id FROM ${tableName}`)
        .join(" UNION ALL ")})`,
    )
    const distinctSnapshots = Number(reader.getRowObjectsJS()[0]?.n)
    if (distinctSnapshots > 1) {
      throw new Error(`expected one snapshot_id across the comparison tables, found ${distinctSnapshots}`)
    }
    return true
  } catch (err) {
    for (const tableName of [...Object.keys(COMPARISON_TABLES), COMPARISON_TOP_LEVEL_TABLE]) {
      await connection.run(`DROP TABLE IF EXISTS ${tableName}`).catch(() => {})
    }
    console.warn(
      `[duckdb] comparison tables unavailable (${
        err instanceof Error ? err.message : String(err)
      }); continuing without them`,
    )
    return false
  }
}

export async function getConnection(): Promise<DuckDBConnection> {
  if (!connectionPromise) {
    const pending = (async () => {
      const connection = await DuckDBConnection.create()

      // Materialise each parquet snapshot into an in-memory DuckDB table at
      // connection-open time, reading once straight from HF over httpfs.
      //
      // We previously mirrored the parquet to a local disk cache (/data on
      // the Space) and opened views over the file. But DuckDB memory-maps
      // local parquet files, and right after a fresh download onto HF's
      // /data persistent mount those mmap'd pages could be read back
      // incoherent — failing a query mid-scan with "Invalid Error: don't
      // know what type:" even though the bytes on disk were byte-for-byte
      // correct (sha256 matched the remote). Reading over httpfs never
      // mmaps a local file, so it is unaffected.
      //
      // Loading into a table (not an httpfs-backed view) keeps queries
      // fast: the one-time startup read replaces the old cache download,
      // and every subsequent query hits RAM instead of the network or a
      // memory-mapped file. The snapshots are small (a few MB each).
      const t0 = Date.now()
      for (const [viewName, fileName] of Object.entries(VIEW_FILES)) {
        const url = snapshotArtifact(fileName)
        // file:// SNAPSHOT_URL (local dev) is a filesystem path to
        // read_parquet, not an httpfs URL.
        const source = url.startsWith("file://") ? fileURLToPath(url) : url
        await connection.run(
          `CREATE OR REPLACE TABLE ${viewName} AS SELECT * FROM read_parquet(${sqlString(source)})`,
        )
      }
      let optionalLoaded = 0
      for (const [viewName, fileName] of Object.entries(OPTIONAL_VIEW_FILES)) {
        const url = snapshotArtifact(fileName)
        const source = url.startsWith("file://") ? fileURLToPath(url) : url
        try {
          await connection.run(
            `CREATE OR REPLACE TABLE ${viewName} AS SELECT * FROM read_parquet(${sqlString(source)})`,
          )
          optionalLoaded += 1
        } catch (err) {
          console.warn(
            `[duckdb] optional snapshot table ${viewName} unavailable (${
              err instanceof Error ? err.message : String(err)
            }) — continuing without it`,
          )
        }
      }
      if (await loadComparisonTables(connection)) {
        optionalLoaded += Object.keys(COMPARISON_TABLES).length
      }
      console.warn(
        `[duckdb] loaded ${Object.keys(VIEW_FILES).length + optionalLoaded} snapshot tables in ${Date.now() - t0}ms`,
      )

      return connection
    })()
    connectionPromise = pending
    // If init fails (e.g. a transient httpfs blip during the snapshot
    // read), clear the cached rejected promise so the NEXT request retries
    // instead of every request awaiting a permanently-rejected promise
    // until the Space restarts. Guard on identity so a later retry already
    // in flight is never stomped.
    pending.catch(() => {
      if (connectionPromise === pending) connectionPromise = null
    })
  }

  return connectionPromise
}

let queryQueue: Promise<unknown> = Promise.resolve()

/** Run `query` after every earlier queued query has settled. All readers of
 *  the shared connection go through this queue: overlapping readers on the
 *  one connection can trip linux-only binding failures. */
export function serialized<T>(query: () => Promise<T>): Promise<T> {
  const scheduled = queryQueue.then(query, query)
  queryQueue = scheduled.then(() => undefined, () => undefined)
  return scheduled
}
