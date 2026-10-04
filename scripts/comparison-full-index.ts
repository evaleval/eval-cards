import type { ComparisonIndex } from "@/lib/backend-artifacts"
import { comparisonTableInternals as t } from "@/lib/comparison-table"

/** The whole comparison index rebuilt from the tables, to verify them against
 *  the producer's comparison-index.json. Verification and tests only: no page,
 *  route or build step may load the whole index. */
export async function fullComparisonIndex(): Promise<ComparisonIndex | null> {
  const rows = await t.fetchRows(async (read) => {
    if (!(await t.tablesAvailable(read))) return null
    return {
      meta: await t.readMeta(read),
      evalRows: await read(`SELECT ${t.EVAL_COLUMNS} FROM comparison_evals`),
      metricRows: await read(`SELECT ${t.METRIC_COLUMNS} FROM comparison_metrics ORDER BY evaluation_id, metric_ord`),
      scoreRows: await read(
        `SELECT ${t.SCORE_COLUMNS} FROM comparison_scores ORDER BY evaluation_id, metric_summary_id, row_ord`,
      ),
    }
  })
  if (!rows) return null
  const evals = t.buildEvals(rows.evalRows, rows.metricRows, rows.scoreRows)
  return t.assemble(rows.meta, evals, t.buildByModel(rows.scoreRows, evals))
}
