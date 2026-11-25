"use client"

import { useEffect, useMemo, useState } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { ScoreDistribution } from "@/components/score-distribution"
import { EmbedSourcePicker, useEmbedEvalSummary } from "@/components/embed-eval-source"
import { EmbedStudyContext } from "@/components/embed-study-context"
import {
  buildDistributionSeries,
  buildDistributionSliceAxis,
} from "@/lib/distribution-series"
import { getMetricChipLabel } from "@/lib/metric-labels"
import { routeIdFromSegments } from "@/lib/utils"

/**
 * Embed-only render of the Pareto-frontier (score vs release date)
 * scatter for one eval. Reuses ScoreDistribution but opens it in
 * frontier view by default.
 *
 * Slice-aware: when the eval has subtask slices (e.g. Global MMLU's
 * per-language splits), renders a SPLIT dropdown above the plot —
 * mirroring the distribution embed.
 *
 * Query params:
 *   ?slice=<subtask_key> — start with this slice selected
 *
 * Merged (single-segment) ids default to the MERGED all-sources data and
 * render a Source selector; ?source=<composite_slug> pins one source's
 * instantiation, ?metric=<metric_id> selects the merged metric.
 */
export default function EmbedEvalFrontier() {
  const params = useParams()
  const searchParams = useSearchParams()
  const evalId = routeIdFromSegments(params.id)
  const sliceParam = searchParams.get("slice")

  const { summary, error, sources, activeSource, setActiveSource } = useEmbedEvalSummary(
    evalId,
    { metricParam: searchParams.get("metric"), sourceParam: searchParams.get("source") },
  )

  // Slice axis — present when the eval has multiple subtask-scope metrics
  // sharing a primary root metric (e.g. Global MMLU's 24 language splits).
  const sliceAxis = useMemo(
    () => (summary ? buildDistributionSliceAxis(summary) : null),
    [summary],
  )

  const ALL_SLICE_KEY = "__all__"
  const [activeSlice, setActiveSlice] = useState<string>(() => {
    if (sliceParam && sliceParam.trim()) return sliceParam.trim()
    return ALL_SLICE_KEY
  })
  useEffect(() => {
    if (!sliceAxis) return
    if (activeSlice === ALL_SLICE_KEY) return
    if (!sliceAxis.slices.some((s) => s.key === activeSlice)) {
      setActiveSlice(ALL_SLICE_KEY)
    }
  }, [activeSlice, sliceAxis])

  const series = useMemo(
    () => (summary ? buildDistributionSeries(summary, sliceAxis, activeSlice, ALL_SLICE_KEY) : null),
    [summary, sliceAxis, activeSlice],
  )

  const requestedMetricParam = searchParams.get("metric")?.trim() || null
  const requestedMetricMeta = useMemo(() => {
    if (!requestedMetricParam || !summary) return null
    const metrics = summary.leaderboard_metrics ?? []
    return (
      metrics.find(
        (m) =>
          m.scope !== "subtask" &&
          (m.metric_id === requestedMetricParam || m.column_key === requestedMetricParam),
      ) ??
      metrics.find(
        (m) => m.metric_id === requestedMetricParam || m.column_key === requestedMetricParam,
      ) ??
      null
    )
  }, [requestedMetricParam, summary])

  const requestedMetricMissingSeries = useMemo(() => {
    if (!requestedMetricParam || !summary || summary.merged_view) return false
    if (!requestedMetricMeta) return false
    const key = requestedMetricMeta.column_key ?? requestedMetricMeta.metric_summary_id
    if (!key) return false
    if (sliceAxis && key === sliceAxis.primaryColumn) return false
    return !series || !series.some((s) => s.key === key)
  }, [requestedMetricMeta, requestedMetricParam, series, sliceAxis, summary])

  const initialMetricKey = useMemo(() => {
    if (!requestedMetricParam || !series) return undefined
    if (series.some((s) => s.key === requestedMetricParam)) return requestedMetricParam
    const key = requestedMetricMeta?.column_key ?? requestedMetricMeta?.metric_summary_id
    return key && series.some((s) => s.key === key) ? key : undefined
  }, [requestedMetricMeta, requestedMetricParam, series])

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
  if (!summary) {
    return (
      <div
        className="font-mono uppercase"
        style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--fg-subtle)" }}
      >
        Loading…
      </div>
    )
  }
  if (requestedMetricMissingSeries && requestedMetricMeta) {
    return (
      <div>
        <EmbedSourcePicker sources={sources} value={activeSource} onChange={setActiveSource} />
        <EmbedStudyContext summary={summary} />
        <div className="font-mono" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
          Pareto frontier requires at least 3 models reporting{" "}
          {getMetricChipLabel(requestedMetricMeta)}.
        </div>
      </div>
    )
  }

  if (!series) {
    return (
      <div className="font-mono" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
        No score data available for this evaluation yet.
      </div>
    )
  }

  return (
    <div>
      <div className="mb-3">
        <div
          className="font-mono uppercase"
          style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
        >
          Pareto frontier
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
      <EmbedStudyContext summary={summary} />
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
      <ScoreDistribution
        series={series}
        initialKey={initialMetricKey}
        defaultView="frontier"
        showViewToggle={false}
      />
    </div>
  )
}
