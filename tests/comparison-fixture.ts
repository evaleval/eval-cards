import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ComparisonIndex, EvalHierarchy } from "@/lib/backend-artifacts"
import type { ModelEvaluationSummary, ModelSummaryCore } from "@/lib/benchmark-schema"
import { parseJsonWithBounds } from "@/lib/json-bounds"
import type { OverlapLeadReading } from "@/lib/overlaps"

// A real subset of a warehouse snapshot: the three comparison tables, the
// producer's comparison-index.json for the same evals and rows, the matching
// hierarchy, and view rows for those evals and models. Rebuilt by
// scripts/build-comparison-fixture.mjs.
export const FIXTURE_DIR = path.join(__dirname, "fixtures", "comparison-slices")

/** The producer's index for the fixture, parsed the way the sidecar loader
 *  parsed it (infinite registry bounds revived to numbers). */
export function fixtureIndex(): ComparisonIndex {
  return parseJsonWithBounds<ComparisonIndex>(
    readFileSync(path.join(FIXTURE_DIR, "comparison-index.json"), "utf8"),
  )
}

export function fixtureRawHierarchy(): EvalHierarchy {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, "hierarchy.json"), "utf8")) as EvalHierarchy
}

/** Point the v2 backend at `snapshotDir` (the fixture by default) with a
 *  private sidecar disk cache. Returns the restore function. */
export function useSnapshot(snapshotDir: string = FIXTURE_DIR): () => void {
  const previous = {
    DATA_BACKEND: process.env.DATA_BACKEND,
    SNAPSHOT_URL: process.env.SNAPSHOT_URL,
    SIDECAR_CACHE_DIR: process.env.SIDECAR_CACHE_DIR,
  }
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "eval-card-sidecar-cache-"))
  process.env.DATA_BACKEND = "v2"
  process.env.SNAPSHOT_URL = `file://${snapshotDir}`
  process.env.SIDECAR_CACHE_DIR = cacheDir
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(cacheDir, { recursive: true, force: true })
  }
}

/** The identifiers BenchmarkDetail matches the current model's score rows on
 *  (its `currentModelIdentityKeys` memo). */
export function identityKeysOf(summary: ModelSummaryCore): Set<string> {
  const s = summary as any
  const id = summary.model_info.id || ""
  return new Set<string>(
    [
      id,
      id && encodeURIComponent(id),
      s.model_route_id,
      s.variant_key,
      s.model_group_id,
      s.model_group_id && encodeURIComponent(s.model_group_id),
      (summary.model_info as any).family_id,
      (summary.model_info as any).model_route_id,
      ...(s.raw_model_ids ?? []),
    ].filter(Boolean) as string[],
  )
}

/** The reading each of the model's eval rows leads with, as BenchmarkDetail
 *  hands it to the overlaps builder: eval_summary_id -> the reading
 *  view-data flags `is_lead_metric`. */
export function leadReadingsOf(summary: ModelEvaluationSummary): Map<string, OverlapLeadReading> {
  const leads = new Map<string, OverlapLeadReading>()
  for (const evaluations of Object.values(summary.evaluations_by_tag)) {
    for (const evaluation of evaluations) {
      for (const result of evaluation.evaluation_results) {
        if (evaluation.eval_summary_id && result.is_lead_metric && result.metric_summary_id) {
          leads.set(evaluation.eval_summary_id, {
            metricSummaryId: result.metric_summary_id,
            split: result.split ?? null,
            rank:
              result.position != null && result.total != null
                ? { position: result.position, total: result.total }
                : null,
          })
        }
      }
    }
  }
  return leads
}
