import type { BenchmarkSummarySubtask } from "@/lib/eval-processing"
import { sharedLeadingWordCount, splitSharedPrefix } from "@/lib/split-names"

/**
 * The splits of one benchmark with the best score any model reached on each.
 *
 * Names are shown whole and wrap; nothing is cut off. The words every split
 * shares are set back so the part that tells the splits apart reads first.
 * When every split reports the same single metric, the metric and its unit
 * are stated once in the header instead of on every row.
 */
export function SplitBreakdown({
  subtasks,
  metricLabel,
  formatScore,
}: {
  subtasks: BenchmarkSummarySubtask[]
  metricLabel: (name: string | undefined) => string
  formatScore: (score: number | null | undefined, unit?: string) => string
}) {
  const nameOf = (slice: BenchmarkSummarySubtask) => slice.display_name || slice.subtask_name
  const sharedWords = sharedLeadingWordCount(subtasks.map(nameOf))
  const firstMetric = subtasks[0]?.metrics?.[0]
  const uniformSingleMetric =
    !!firstMetric &&
    subtasks.every(
      (s) =>
        s.metrics.length === 1 &&
        metricLabel(s.metrics[0].display_name) === metricLabel(firstMetric.display_name) &&
        (s.metrics[0].unit ?? null) === (firstMetric.unit ?? null),
    )
  const headerSuffix = uniformSingleMetric
    ? ` · ${metricLabel(firstMetric!.display_name)}${firstMetric!.unit ? ` (${firstMetric!.unit.toLowerCase()})` : ""}`
    : ""

  const renderName = (slice: BenchmarkSummarySubtask) => {
    const { shared, rest } = splitSharedPrefix(nameOf(slice), sharedWords)
    return (
      <>
        {shared && <span style={{ color: "var(--fg-subtle)" }}>{shared} </span>}
        {rest}
      </>
    )
  }

  return (
    <div className="space-y-2">
      <div
        className="font-mono uppercase mb-1"
        style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
      >
        Split breakdown · {subtasks.length}
        {headerSuffix} · best score among models
      </div>
      {uniformSingleMetric ? (
        <div
          className="grid"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", columnGap: 24 }}
        >
          {subtasks.map((slice) => (
            <div
              key={slice.subtask_key}
              className="flex items-baseline justify-between gap-3 py-1.5 min-w-0"
              style={{ borderBottom: "1px solid var(--border-soft)" }}
            >
              <span className="text-[12.5px] min-w-0 break-words">{renderName(slice)}</span>
              <span className="font-mono text-[12px] tabular-nums shrink-0" style={{ color: "var(--fg)" }}>
                {formatScore(slice.metrics[0].top_score)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <ul className="flex flex-col" style={{ borderTop: "1px solid var(--border-soft)" }}>
          {subtasks.map((slice) => (
            <li
              key={slice.subtask_key}
              className="grid gap-x-4 py-3"
              style={{
                gridTemplateColumns: "minmax(160px, 280px) 1fr",
                borderBottom: "1px solid var(--border-soft)",
              }}
            >
              <div className="min-w-0">
                <div className="font-semibold text-[13px] break-words">{renderName(slice)}</div>
                {slice.canonical_display_name && slice.canonical_display_name !== nameOf(slice) && (
                  <div
                    className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.08em] break-words"
                    style={{ color: "var(--fg-subtle)" }}
                  >
                    {slice.canonical_display_name}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {slice.metrics.map((metric) => (
                  <span
                    key={metric.metric_summary_id}
                    className="ec-tag"
                    title={metric.canonical_display_name || metric.display_name}
                  >
                    {metricLabel(metric.display_name)}
                    {typeof metric.top_score === "number" ? ` · ${formatScore(metric.top_score, metric.unit)}` : ""}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
