"use client"

import { useEffect, useMemo, useState } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { EmbedSourcePicker, useEmbedEvalSummary } from "@/components/embed-eval-source"
import {
  ProtocolSortButton,
  ProtocolValueText,
  protocolHeaderTitle,
} from "@/components/protocol-axis-fields"
import {
  chooseProtocolColumns,
  compareProtocolRows,
  declaredAxisKeys,
  readProtocolAxis,
  unionProtocolAxes,
  type ProtocolColumn,
} from "@/lib/collections"
import {
  isAssistedResult,
  isHeadlineResult,
  scoreStandings,
  type ModelResultForBenchmark,
} from "@/lib/eval-processing"
import { getMetricChipLabel } from "@/lib/metric-labels"
import { routeIdFromSegments } from "@/lib/utils"

/**
 * Embed-only leaderboard for one eval. Single-metric evals render as a
 * compact ranked list; multi-metric evals (e.g. agentharm with
 * Copyright / Cybercrime / … columns) render as a multi-column table,
 * mirroring the eval page's MultiMetricLeaderboard layout.
 *
 * Slice-aware: when the eval has subtask slices (e.g. Global MMLU's
 * per-language splits), shows a SPLIT dropdown above the table.
 *
 * Query params:
 *   ?limit=25            — cap rows (default 25, max 100)
 *   ?metric=<column_key> — for multi-metric evals, sort by this column
 *                          (doubles as the merged metric id for merged ids)
 *   ?slice=<subtask_key> — start with this slice selected
 *
 * Merged (single-segment) ids default to the MERGED all-sources data and
 * render a Source selector; ?source=<composite_slug> pins one source's
 * instantiation of the benchmark.
 */
export default function EmbedEvalLeaderboard() {
  const params = useParams()
  const searchParams = useSearchParams()
  const evalId = routeIdFromSegments(params.id)
  const limitRaw = Number(searchParams.get("limit") ?? "25")
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 25
  const sortMetricKey = searchParams.get("metric")
  const sliceParam = searchParams.get("slice")

  const { summary, error, sources, activeSource, setActiveSource } = useEmbedEvalSummary(
    evalId,
    { metricParam: sortMetricKey, sourceParam: searchParams.get("source") },
  )

  type LbMetric = {
    column_key?: string
    metric_summary_id?: string
    metric_name?: string
    metric_id?: string
    display_name?: string
    canonical_display_name?: string
    unit?: string | null
    lower_is_better?: boolean | null
    scope?: string
    subtask_key?: string
    subtask_name?: string
  }

  // Slice axis — present when the eval has multiple subtask-scope metrics
  // sharing a primary root metric (e.g. Global MMLU's 24 language splits).
  const sliceAxis = useMemo(() => {
    if (!summary) return null
    const metrics = (summary.leaderboard_metrics ?? []) as LbMetric[]
    const primary = metrics.find((m) => m.scope !== "subtask")
    if (!primary?.column_key) return null
    const seen = new Map<string, string>()
    for (const m of metrics) {
      if (m.scope === "subtask" && m.subtask_key && !seen.has(m.subtask_key)) {
        seen.set(m.subtask_key, m.subtask_name ?? m.subtask_key)
      }
    }
    if (seen.size <= 1) return null
    return {
      primaryColumn: primary.column_key,
      slices: Array.from(seen, ([key, label]) => ({ key, label })),
    }
  }, [summary])

  const ALL_SLICE_KEY = "__all__"
  const [activeSlice, setActiveSlice] = useState<string>(() => {
    if (sliceParam && sliceParam.trim()) return sliceParam.trim()
    return ALL_SLICE_KEY
  })
  // Sort key — URL param seeds the initial value; column-header clicks
  // override it without touching the URL. Null means "fall back to the
  // first non-subtask metric in the data".
  const [sortOverride, setSortOverride] = useState<string | null>(
    sortMetricKey && sortMetricKey.trim() ? sortMetricKey.trim() : null,
  )
  // Sort direction override. Null = derive from the metric's
  // lower_is_better (default behavior). Clicking the active column flips
  // this; clicking a different column resets to null so the new column
  // picks up its own default direction.
  const [sortDirOverride, setSortDirOverride] = useState<"asc" | "desc" | null>(null)
  useEffect(() => {
    if (!sliceAxis) return
    if (activeSlice === ALL_SLICE_KEY) return
    if (!sliceAxis.slices.some((s) => s.key === activeSlice)) {
      setActiveSlice(ALL_SLICE_KEY)
    }
  }, [activeSlice, sliceAxis])

  // Protocol axes for a study embed. `leaderboard_rows` carries scores
  // only, so a page whose rows are runs at different budgets would show
  // the same model several times with nothing to tell the runs apart;
  // the observation rows carry the condition, so they become the table.
  //
  // Only a curated per-source study takes this grain. A merged embed
  // pools one observation per (model, source) and has no protocol grid to
  // show, and an ordinary eval that happens to carry varying conditions
  // must not silently turn into a list of runs.
  const protocol = useMemo(() => {
    if (!summary) return null
    if (!summary.collection?.curated || summary.merged_view) return null
    const results = summary.model_results ?? []
    if (results.length === 0) return null
    const axesByCollection = summary.protocol_axes_by_collection
    const declared = axesByCollection
      ? unionProtocolAxes(axesByCollection)
      : summary.collection?.protocol_axes
    const columns = chooseProtocolColumns(
      results.map((result) => result.protocol_condition),
      declared,
    )
    if (columns.length === 0) return null
    const readingFor = (result: ModelResultForBenchmark, column: ProtocolColumn) =>
      readProtocolAxis(
        result.protocol_condition,
        column,
        axesByCollection ? declaredAxisKeys(axesByCollection, result.collection_id) : null,
      )
    return { columns, results, readingFor }
  }, [summary])

  const [protocolSort, setProtocolSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(
    null,
  )

  const view = useMemo(() => {
    if (!summary) return null
    const allMetrics = (summary.leaderboard_metrics ?? []) as LbMetric[]
    const rows = summary.leaderboard_rows ?? []
    // When a slice axis is present, restrict columns to just the active
    // slice (or the primary column for "Overall"). Without this filter the
    // table would explode to 25+ columns of per-language scores.
    const metrics = sliceAxis
      ? (() => {
          if (activeSlice === ALL_SLICE_KEY) {
            return allMetrics.filter((m) => m.column_key === sliceAxis.primaryColumn)
          }
          const targetKey = `${sliceAxis.primaryColumn}::${activeSlice}`
          return allMetrics.filter((m) => m.column_key === targetKey)
        })()
      : (() => {
          // Mirror the eval page / distribution + frontier embeds: when there
          // is no real slice axis, only root-scope metrics become columns. The
          // producer emits a redundant self-slice subtask for some evals (e.g.
          // vals-ai/math-500's `accuracy::vals ai math500`, same
          // metric_summary_id as the root `accuracy`); without this filter it
          // renders as a duplicate "Accuracy" column. Fall back to all metrics
          // only if an eval somehow carries no root metric.
          const roots = allMetrics.filter((m) => m.scope !== "subtask")
          return roots.length > 0 ? roots : allMetrics
        })()
    // Top-level metrics first; subtask metrics keep their order after them.
    // We display all metrics that have at least one numeric score in the
    // rows — pruning empty columns keeps the table readable.
    const metricsWithData = metrics.filter((m) => {
      const key = m.column_key ?? m.metric_summary_id
      if (!key) return false
      for (const row of rows) {
        const raw = (row.values as Record<string, unknown> | undefined)?.[key]
        const n = typeof raw === "number" ? raw : Number(raw)
        if (Number.isFinite(n)) return true
      }
      return false
    })
    if (metricsWithData.length === 0) return null
    const isMulti = metricsWithData.length > 1

    // Sort key: explicit override wins, else first non-subtask metric.
    const sortMetric =
      (sortOverride && metricsWithData.find((m) => m.column_key === sortOverride)) ||
      metricsWithData.find((m) => m.scope !== "subtask") ||
      metricsWithData[0]
    const sortKey = sortMetric?.column_key ?? sortMetric?.metric_summary_id ?? ""
    const defaultSortLower = Boolean(
      sortMetric?.lower_is_better ?? summary.metric_config.lower_is_better,
    )
    const sortLower =
      sortDirOverride === "asc"
        ? true
        : sortDirOverride === "desc"
          ? false
          : defaultSortLower

    type TableRow = {
      modelName: string
      developer: string | null
      values: Record<string, number>
      sortScore: number | null
      /** The model's standing in the field, assigned once from the
       *  unassisted headline runs. 0 means the row takes no rank. */
      rank: number
      assisted: boolean
      result?: ModelResultForBenchmark
    }

    // A study embed takes its rows from the observation grain, where the
    // protocol lives; every other embed keeps the metric matrix.
    const protocolMode = protocol && !isMulti && !sliceAxis ? protocol : null
    let sourceRows: TableRow[]
    if (protocolMode) {
      // Assisted runs, where the model is told when its answer is
      // correct, are shown and never ranked, exactly as the benchmark
      // page shows them. Rank comes from the unassisted headline runs in
      // score order and then stays on the row, so sorting by a budget
      // reorders the table without reassigning a single standing.
      const runs = protocolMode.results.filter((result) => Number.isFinite(result.score))
      const byScore = [...runs].sort((a, b) =>
        sortLower ? a.score - b.score : b.score - a.score,
      )
      const ranked = (result: ModelResultForBenchmark) =>
        isHeadlineResult(result) && !isAssistedResult(result.protocol_condition)
      const standings = scoreStandings(byScore, (result) => result.score, ranked)
      const rankByRun = new Map<ModelResultForBenchmark, number>()
      byScore.forEach((result, i) => rankByRun.set(result, standings[i]))

      sourceRows = byScore.map((result) => ({
        modelName: result.model_info?.name ?? "Unknown",
        developer: result.model_info?.developer ?? null,
        values: { [sortKey]: result.score },
        sortScore: result.score,
        rank: rankByRun.get(result) ?? 0,
        assisted: isAssistedResult(result.protocol_condition),
        result,
      }))
    } else {
      sourceRows = rows
        .map((row) => {
          const values: Record<string, number> = {}
          let anyScore = false
          for (const m of metricsWithData) {
            const key = m.column_key ?? m.metric_summary_id ?? ""
            const raw = (row.values as Record<string, unknown> | undefined)?.[key]
            const n = typeof raw === "number" ? raw : Number(raw)
            if (Number.isFinite(n)) {
              values[key] = n
              anyScore = true
            }
          }
          if (!anyScore) return null
          const modelInfo =
            (row as { model_info?: { name?: string; developer?: string } }).model_info ?? {}
          return {
            modelName:
              modelInfo.name ??
              (row as { model_name?: string }).model_name ??
              "Unknown",
            developer:
              modelInfo.developer ??
              (row as { developer?: string | null }).developer ??
              null,
            values,
            sortScore: values[sortKey] ?? null,
            rank: 0,
            assisted: false,
          }
        })
        .filter((r) => r !== null) as TableRow[]
    }

    const protocolColumn =
      protocolMode && protocolSort
        ? protocolMode.columns.find((column) => column.key === protocolSort.key) ?? null
        : null

    let tableRows: TableRow[]
    if (protocolMode && protocolColumn && protocolSort) {
      const readingFor = protocolMode.readingFor
      tableRows = sourceRows
        .map((row, index) => ({ row: row.result!, index, source: row }))
        .sort((a, b) =>
          compareProtocolRows(a, b, protocolColumn, protocolSort.dir, readingFor),
        )
        .map(({ source }) => source)
    } else {
      tableRows = [...sourceRows].sort((a, b) => {
        const av = a.sortScore
        const bv = b.sortScore
        if (av == null && bv == null) return 0
        if (av == null) return 1
        if (bv == null) return -1
        return sortLower ? av - bv : bv - av
      })
    }

    return {
      metrics: metricsWithData,
      rows: tableRows,
      sortKey,
      sortLower,
      isMulti,
      protocol: protocolMode,
    }
  }, [summary, sortOverride, sortDirOverride, sliceAxis, activeSlice, protocol, protocolSort])

  if (error) {
    // Keep the source picker reachable so a failed pinned-source fetch
    // isn't a dead end — switching back to Merged (or another source)
    // clears the error and refetches.
    return (
      <div>
        <EmbedSourcePicker sources={sources} value={activeSource} onChange={setActiveSource} />
        <div className="font-mono" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
          Failed to load: {error}
        </div>
      </div>
    )
  }
  if (!summary || !view) {
    return (
      <div
        className="font-mono uppercase"
        style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--fg-subtle)" }}
      >
        Loading…
      </div>
    )
  }

  const visible = view.rows.slice(0, limit)
  const hiddenCount = view.rows.length - visible.length

  const formatScore = (v: number, unit?: string | null): string => {
    const u = (unit || summary.metric_config.unit || "").toLowerCase()
    const isPercentish = !u || /percent|proportion|accuracy|score|pass@|exact|f1|%/.test(u)
    if (isPercentish) {
      const value = Math.abs(v) <= 1 ? v * 100 : v
      const abs = Math.abs(value)
      const decimals = abs < 1 ? 2 : abs < 10 ? 2 : 1
      return `${value.toFixed(decimals)}%`
    }
    return v.toFixed(3).replace(/0+$/g, "").replace(/\.$/, "")
  }

  const sortMetric = view.metrics.find(
    (m) => (m.column_key ?? m.metric_summary_id) === view.sortKey,
  )
  const headerKicker = view.isMulti ? (
    <>
      Leaderboard · {view.metrics.length} metrics ·{" "}
      {view.sortLower ? "lower is better" : "higher is better"} (sorted by{" "}
      {sortMetric ? getMetricChipLabel(sortMetric) : view.sortKey})
    </>
  ) : (
    <>
      Leaderboard ·{" "}
      {view.metrics[0] ? getMetricChipLabel(view.metrics[0]) : "Score"}
      {view.sortLower ? " · lower is better" : " · higher is better"}
    </>
  )

  return (
    <div>
      <div className="mb-3">
        <div
          className="font-mono uppercase"
          style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
        >
          {headerKicker}
        </div>
        <div
          style={{
            fontSize: 19,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            lineHeight: 1.2,
            color: "var(--fg)",
            marginTop: 2,
          }}
        >
          {summary.evaluation_name}
        </div>
      </div>
      <EmbedSourcePicker sources={sources} value={activeSource} onChange={setActiveSource} />
      {sliceAxis && (
        <div className="mb-3 flex items-center gap-3">
          <span
            className="font-mono uppercase shrink-0"
            style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
          >
            Split
          </span>
          <select
            className="ec-select"
            value={activeSlice}
            onChange={(e) => setActiveSlice(e.target.value)}
          >
            <option value={ALL_SLICE_KEY}>Overall</option>
            {sliceAxis.slices.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 13,
          }}
        >
          <thead>
            <tr style={{ borderBottom: "1px solid var(--fg)" }}>
              <th
                className="font-mono uppercase text-left"
                style={{
                  fontSize: 10,
                  letterSpacing: "0.12em",
                  color: "var(--fg-muted)",
                  padding: "6px 8px 6px 0",
                  width: 40,
                }}
              >
                #
              </th>
              <th
                className="font-mono uppercase text-left"
                style={{
                  fontSize: 10,
                  letterSpacing: "0.12em",
                  color: "var(--fg-muted)",
                  padding: "6px 8px",
                }}
              >
                Model
              </th>
              {(view.protocol?.columns ?? []).map((column) => {
                const active = protocolSort?.key === column.key
                return (
                  <th
                    key={`protocol-${column.key}`}
                    className="font-mono uppercase text-left"
                    aria-sort={
                      active
                        ? protocolSort?.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    style={{
                      fontSize: 10,
                      letterSpacing: "0.12em",
                      color: active ? "var(--fg)" : "var(--fg-muted)",
                      padding: "6px 12px 6px 0",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {/* A real button inside the header, so the sort is
                        reachable by keyboard as well as by pointer. */}
                    <ProtocolSortButton
                      label={column.label}
                      active={active}
                      indicator={active ? (protocolSort?.dir === "asc" ? "↑" : "↓") : null}
                      title={protocolHeaderTitle(column, Boolean(summary.merged_view))}
                      onClick={() =>
                        setProtocolSort((current) =>
                          current?.key !== column.key
                            ? { key: column.key, dir: "asc" }
                            : current.dir === "asc"
                              ? { key: column.key, dir: "desc" }
                              : null,
                        )
                      }
                    />
                  </th>
                )
              })}
              {view.metrics.map((m) => {
                const key = m.column_key ?? m.metric_summary_id ?? ""
                const label = getMetricChipLabel(m)
                const isSort = key === view.sortKey
                const sortable = Boolean(m.column_key)
                return (
                  <th
                    key={key}
                    className="font-mono uppercase text-right"
                    aria-sort={isSort ? (view.sortLower ? "ascending" : "descending") : "none"}
                    style={{
                      fontSize: 10,
                      letterSpacing: "0.12em",
                      color: isSort ? "var(--fg)" : "var(--fg-muted)",
                      padding: "6px 0 6px 12px",
                      whiteSpace: "nowrap",
                      cursor: sortable ? "pointer" : "default",
                      userSelect: "none",
                    }}
                    title={
                      sortable
                        ? `${label} — click to sort`
                        : label
                    }
                    onClick={
                      sortable && m.column_key
                        ? () => {
                            if (key === view.sortKey) {
                              // Toggle direction on the active column.
                              setSortDirOverride((cur) => {
                                const current = cur ?? (view.sortLower ? "asc" : "desc")
                                return current === "desc" ? "asc" : "desc"
                              })
                            } else {
                              setSortOverride(m.column_key!)
                              setSortDirOverride(null)
                            }
                          }
                        : undefined
                    }
                  >
                    {label}
                    {isSort ? (view.sortLower ? " ▲" : " ▼") : ""}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, i) => (
              <tr
                key={`${row.modelName}-${i}`}
                style={{ borderBottom: "1px solid var(--border-soft)" }}
              >
                <td
                  className="font-mono tabular-nums"
                  style={{
                    fontSize: 11,
                    color: "var(--fg-subtle)",
                    padding: "5px 8px 5px 0",
                    width: 40,
                  }}
                >
                  {/* In protocol mode the standing was assigned from the
                      scores; elsewhere the row's position is its rank. */}
                  {view.protocol ? (row.rank === 0 ? "—" : row.rank) : i + 1}
                </td>
                <td style={{ padding: "5px 8px", color: "var(--fg)" }}>
                  <span style={{ fontWeight: 500 }}>{row.modelName}</span>
                  {row.developer && (
                    <span
                      className="ml-2"
                      style={{ fontSize: 11, color: "var(--fg-muted)" }}
                    >
                      · {row.developer}
                    </span>
                  )}
                  {row.assisted && (
                    <span
                      className="ml-2 font-mono uppercase"
                      style={{ fontSize: 9, letterSpacing: "0.12em", color: "var(--fg-subtle)" }}
                      title="Assisted run (answer feedback): shown, not ranked"
                    >
                      Assisted
                    </span>
                  )}
                </td>
                {(view.protocol?.columns ?? []).map((column) => (
                  <td
                    key={`protocol-${column.key}`}
                    className="font-mono"
                    style={{ fontSize: 11.5, padding: "5px 12px 5px 0", whiteSpace: "nowrap" }}
                  >
                    {row.result ? (
                      <ProtocolValueText
                        reading={view.protocol!.readingFor(row.result, column)}
                        column={column}
                      />
                    ) : (
                      "—"
                    )}
                  </td>
                ))}
                {view.metrics.map((m) => {
                  const key = m.column_key ?? m.metric_summary_id ?? ""
                  const val = row.values[key]
                  const isSort = key === view.sortKey
                  return (
                    <td
                      key={key}
                      className="font-mono tabular-nums text-right"
                      style={{
                        fontSize: 12.5,
                        fontWeight: isSort ? 600 : 400,
                        color: val == null ? "var(--fg-subtle)" : "var(--fg)",
                        padding: "5px 0 5px 12px",
                      }}
                    >
                      {val == null ? "—" : formatScore(val, m.unit)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hiddenCount > 0 && (
        <div
          className="font-mono mt-3"
          style={{ fontSize: 11, color: "var(--fg-subtle)" }}
        >
          {/* In protocol mode a row is a run, not a model: several rows
              can belong to one model. */}
          + {hiddenCount} more {view.protocol ? "run" : "model"}
          {hiddenCount === 1 ? "" : "s"} not shown. See the
          full leaderboard on the eval page.
        </div>
      )}
    </div>
  )
}
