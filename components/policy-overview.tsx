"use client"

import { useMemo, useState } from "react"
import { BookOpen, ChevronDown, ChevronUp, ExternalLink, FileText, Globe, Layers, ScrollText, Tag, Users } from "lucide-react"
import { SignalTooltip } from "@/components/signals/signal-tooltip"
import { AutoBenchmarkCardsInfo } from "@/components/auto-benchmarkcards-info"
import type { BenchmarkEvalSummary } from "@/lib/eval-processing"
import { getKnownIssues } from "@/lib/known-issues"
import { KnownIssuesPanel } from "@/components/known-issues-panel"

interface PolicyOverviewProps {
  summary: BenchmarkEvalSummary
}

const SUMMARY_PREVIEW_CHARS = 280

function classifyResource(url: string): { kind: "paper" | "dataset" | "leaderboard" | "site"; label: string } {
  const lower = url.toLowerCase()
  if (lower.includes("arxiv.org") || lower.endsWith(".pdf") || lower.includes("/papers/")) {
    return { kind: "paper", label: "Paper" }
  }
  if (lower.includes("huggingface.co/datasets") || lower.includes("/dataset")) {
    return { kind: "dataset", label: "Dataset" }
  }
  if (lower.includes("leaderboard")) {
    return { kind: "leaderboard", label: "Leaderboard" }
  }
  return { kind: "site", label: "Source" }
}

function shortHost(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "")
}

/**
 * Plain-language summary surface shown at the top of the benchmark page in
 * policy mode. Designed to answer three questions a non-technical reader has:
 * what does this measure, who built it, and where does it come from?
 *
 * Technical detail (variants, metric specifications, score scales) lives in
 * the existing overview card below this and is collapsed by default.
 */
function normalizeId(value: string | undefined | null): string {
  if (!value) return ""
  return value
    .toLowerCase()
    .trim()
    .replace(/[\s_\-/]+/g, "")
}

export function PolicyOverview({ summary }: PolicyOverviewProps) {
  const card = summary.benchmark_card

  // Defensive check: pipelines older than the "ancestor card leak" fix
  // sometimes attach the parent composite's card to a leaf benchmark (e.g.
  // helm_classic's card embedded under XSUM). Detect when the card's own
  // name is clearly not this benchmark and ignore its narrative text — the
  // synthesized fallback below produces something accurate instead.
  const cardName = card?.benchmark_details?.name
  const cardNameNorm = normalizeId(cardName)
  const evalIdentifiers = [
    summary.evaluation_name,
    summary.benchmark_id,
    summary.composite_benchmark_key,
    summary.composite_benchmark_name,
    summary.canonical_display_name,
    summary.evaluation_id,
  ].map(normalizeId)
  // Treat the card as belonging to this eval when its name fuzzily appears in
  // any of the eval's identifiers (or vice versa). Otherwise the card is from
  // a different (typically ancestor) benchmark.
  const cardMatchesEval =
    !cardName ||
    evalIdentifiers.some(
      (id) =>
        id.length > 0 &&
        cardNameNorm.length > 0 &&
        (id.includes(cardNameNorm) || cardNameNorm.includes(id)),
    )

  const overview = cardMatchesEval ? card?.benchmark_details?.overview?.trim() || "" : ""
  const goal = cardMatchesEval ? card?.purpose_and_intended_users?.goal?.trim() || "" : ""

  // Detect "parent" benchmark pages — either an aggregated composite or a
  // multi-metric matrix where each column is a slice. In both cases the
  // per-evaluation `metric_config.evaluation_description` belongs to whichever
  // component was processed first (e.g. just the "airline" subset of Tau
  // Bench 2) and would mislead a policy reader. Synthesize parent framing
  // instead and surface the slices separately.
  // Note: at the data layer the backend still ships these as `subtasks` /
  // `metric.scope === "subtask"`; we read those fields directly but label
  // them "slice" in the UI.
  const isAggregated = summary.is_aggregated === true
  const aggregateNames = (summary.aggregate_sources ?? [])
    .map((s) => s.composite_benchmark_name)
    .filter((s): s is string => typeof s === "string" && s.length > 0)

  const splitLabels = useMemo(() => {
    const seen = new Set<string>()
    const labels: string[] = []
    const add = (raw: string | undefined | null) => {
      if (!raw) return
      const trimmed = raw.trim()
      if (!trimmed) return
      const key = trimmed.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      labels.push(trimmed)
    }
    for (const split of summary.subtasks ?? []) {
      add(split.display_name || split.subtask_name)
    }
    for (const metric of summary.leaderboard_metrics ?? []) {
      if (metric.scope === "subtask") {
        add(metric.subtask_name || metric.display_name)
      }
    }
    for (const name of aggregateNames) add(name)
    return labels
  }, [summary.subtasks, summary.leaderboard_metrics, aggregateNames])

  const isMatrix = (summary.leaderboard_metrics?.length ?? 0) > 1
  const isParentPage = isAggregated || (isMatrix && splitLabels.length > 1)
  const useComponentDescription = !isParentPage

  const parentFallback = isParentPage && splitLabels.length > 1
    ? `${summary.evaluation_name} reports results across ${splitLabels.length} ${
        isAggregated ? "component benchmarks" : "splits"
      }. Each is evaluated separately; the score shown is the ${
        isAggregated ? "average" : "per-split result"
      }.`
    : null

  const summaryText =
    overview ||
    goal ||
    parentFallback ||
    (useComponentDescription ? summary.metric_config.evaluation_description : summary.evaluation_name) ||
    summary.evaluation_name ||
    ""

  const [expanded, setExpanded] = useState(false)
  const [splitsOpen, setSplitsOpen] = useState(false)
  const isLong = summaryText.length > SUMMARY_PREVIEW_CHARS
  const visibleText = expanded || !isLong
    ? summaryText
    : summaryText.slice(0, SUMMARY_PREVIEW_CHARS).replace(/\s+\S*$/, "") + "…"

  const domains = useMemo(() => {
    const fromTags = summary.tags?.domains ?? []
    const fromCard = cardMatchesEval ? card?.benchmark_details?.domains ?? [] : []
    return Array.from(new Set([...fromTags, ...fromCard].map((d) => d.trim()).filter(Boolean)))
      .filter((d) => d.toLowerCase() !== "not specified")
      .slice(0, 6)
  }, [summary.tags?.domains, card?.benchmark_details?.domains, cardMatchesEval])

  const languages = useMemo(() => {
    const fromTags = summary.tags?.languages ?? []
    const fromCard = cardMatchesEval ? card?.benchmark_details?.languages ?? [] : []
    return Array.from(new Set([...fromTags, ...fromCard].map((d) => d.trim()).filter(Boolean)))
      .filter((d) => d.toLowerCase() !== "not specified")
      .slice(0, 4)
  }, [summary.tags?.languages, card?.benchmark_details?.languages, cardMatchesEval])

  const license = card?.ethical_and_legal_considerations?.data_licensing
  const showLicense = license && license !== "Not specified"

  const resources = useMemo(() => {
    if (!cardMatchesEval) return []
    const urls = (card?.benchmark_details?.resources ?? []).filter((r) => typeof r === "string" && r.startsWith("http"))
    const seen = new Map<string, { kind: ReturnType<typeof classifyResource>["kind"]; label: string; url: string }>()
    for (const url of urls) {
      const c = classifyResource(url)
      if (!seen.has(c.kind)) {
        seen.set(c.kind, { ...c, url })
      }
    }
    return Array.from(seen.values())
  }, [card?.benchmark_details?.resources, cardMatchesEval])

  const evaluators = (summary.evaluator_names ?? []).slice(0, 3)
  const hasMoreEvaluators = (summary.evaluator_names?.length ?? 0) > evaluators.length

  const knownIssues = useMemo(
    () =>
      getKnownIssues(
        summary.evaluation_name,
        summary.composite_benchmark_name,
        summary.composite_benchmark_key,
        summary.family_id,
        summary.benchmark_id,
        card?.benchmark_details?.name,
      ),
    [
      summary.evaluation_name,
      summary.composite_benchmark_name,
      summary.composite_benchmark_key,
      summary.family_id,
      summary.benchmark_id,
      card?.benchmark_details?.name,
    ],
  )

  const directionLabel = summary.metric_config.lower_is_better
    ? "Lower scores are better"
    : "Higher scores are better"

  // Policy-note triple: What it measures · Main caveat · Intended for.
  // Filter the literal "Not specified" sentinel so the row collapses
  // entirely instead of rendering a placeholder.
  const measuresText = visibleText
  const rawCaveat = card?.purpose_and_intended_users?.limitations?.trim() || ""
  const caveatText =
    rawCaveat && rawCaveat.toLowerCase() !== "not specified" ? rawCaveat : null
  const audienceArr = card?.purpose_and_intended_users?.audience
  const audienceJoined = Array.isArray(audienceArr)
    ? audienceArr.filter(Boolean).join("; ")
    : typeof audienceArr === "string"
      ? audienceArr
      : ""
  const audienceText =
    audienceJoined && audienceJoined.toLowerCase() !== "not specified"
      ? audienceJoined
      : ""
  const hasCardMetadata = Boolean(
    overview || goal || caveatText || audienceText || showLicense || resources.length > 0 ||
    (cardMatchesEval && ((card?.benchmark_details?.domains?.length ?? 0) > 0 ||
      (card?.benchmark_details?.languages?.length ?? 0) > 0)),
  )

  return (
    <section className="ec-card warm" style={{ padding: "20px 24px" }}>
      <header className="mb-3 flex flex-wrap items-center gap-3">
        <BookOpen className="h-4 w-4" style={{ color: "var(--fg-muted)" }} />
        <span className="kicker kicker-fg" style={{ fontSize: 12, letterSpacing: "0.16em" }}>
          At a glance
        </span>
        {hasCardMetadata && <AutoBenchmarkCardsInfo sourcePath={summary.benchmark_card_source_path} />}
        <span
          className="font-mono text-[10px] uppercase tracking-[0.12em]"
          style={{ color: "var(--fg-subtle)" }}
        >
          {summary.evaluation_name}
        </span>
      </header>

      {knownIssues.length > 0 && (
        <div className="mb-3">
          <KnownIssuesPanel issues={knownIssues} variant="compact" />
        </div>
      )}

      <dl
        className="grid gap-y-3 text-[14px]"
        style={{ gridTemplateColumns: "max-content 1fr", columnGap: 24 }}
      >
        <dt
          className="font-mono uppercase tracking-[0.14em]"
          style={{ fontSize: 10, color: "var(--fg-subtle)", paddingTop: 3 }}
        >
          Measures
        </dt>
        <dd style={{ color: "var(--fg)", lineHeight: 1.6, margin: 0 }}>
          {measuresText}
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="ml-1 text-[13px] font-medium underline-offset-4 hover:underline"
              style={{ color: "var(--accent)" }}
            >
              {expanded ? "Show less" : "Read more"}
            </button>
          )}
        </dd>

        {caveatText && (
          <>
            <dt
              className="font-mono uppercase tracking-[0.14em]"
              style={{ fontSize: 10, color: "var(--accent)", paddingTop: 3 }}
            >
              Caveat
            </dt>
            <dd style={{ color: "var(--fg)", lineHeight: 1.6, margin: 0 }}>{caveatText}</dd>
          </>
        )}

        {audienceText && (
          <>
            <dt
              className="font-mono uppercase tracking-[0.14em]"
              style={{ fontSize: 10, color: "var(--fg-subtle)", paddingTop: 3 }}
            >
              Intended for
            </dt>
            <dd style={{ color: "var(--fg)", lineHeight: 1.6, margin: 0 }}>{audienceText}</dd>
          </>
        )}

        <dt
          className="font-mono uppercase tracking-[0.14em]"
          style={{ fontSize: 10, color: "var(--fg-subtle)", paddingTop: 3 }}
        >
          How to read
        </dt>
        <dd style={{ color: "var(--fg)", lineHeight: 1.6, margin: 0 }}>
          <SignalTooltip
            content={
              summary.metric_config.lower_is_better
                ? "On this benchmark, a lower number means the model did better."
                : "On this benchmark, a higher number means the model did better."
            }
          >
            <span
              className="underline decoration-dotted underline-offset-4 cursor-help"
              style={{ textDecorationColor: "var(--fg-subtle)" }}
            >
              {directionLabel}.
            </span>
          </SignalTooltip>{" "}
          <span style={{ color: "var(--fg-muted)" }}>
            Compared across {summary.models_count} model{summary.models_count === 1 ? "" : "s"}.
          </span>
        </dd>
      </dl>

      {isParentPage && splitLabels.length > 1 && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setSplitsOpen((v) => !v)}
            aria-expanded={splitsOpen}
            className="inline-flex items-center gap-1.5 cursor-pointer hover:text-[color:var(--fg)] transition-colors"
            style={{
              background: "transparent",
              border: 0,
              padding: 0,
              color: "var(--fg-subtle)",
            }}
          >
            <Layers className="h-3.5 w-3.5" />
            <span
              className="font-mono uppercase"
              style={{ fontSize: 10, letterSpacing: "0.14em" }}
            >
              {isAggregated
                ? `Component benchmarks · ${splitLabels.length}`
                : `Splits · ${splitLabels.length}`}
            </span>
            {splitsOpen ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
          {splitsOpen && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {splitLabels.map((name) => (
                <span
                  key={name}
                  className="ec-tag outline"
                  style={{
                    textTransform: "none",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    letterSpacing: "0.02em",
                  }}
                >
                  {name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {(domains.length > 0 || languages.length > 0 || showLicense) && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {domains.map((d) => (
            <span
              key={`d-${d}`}
              className="ec-tag"
              style={{ textTransform: "uppercase" }}
            >
              <Tag className="h-3 w-3 shrink-0" />
              {d}
            </span>
          ))}
          {languages.map((l) => (
            <span key={`l-${l}`} className="ec-tag accent" style={{ textTransform: "uppercase" }}>
              <Globe className="h-3 w-3 shrink-0" />
              {l}
            </span>
          ))}
          {showLicense && (
            <SignalTooltip content="The license under which the benchmark dataset is released.">
              <span className="ec-tag outline cursor-help">
                <ScrollText className="h-3 w-3 shrink-0" />
                {license}
              </span>
            </SignalTooltip>
          )}
        </div>
      )}

      {(resources.length > 0 || evaluators.length > 0) && (
        <div
          className="mt-5 pt-4"
          style={{ borderTop: "1px dashed var(--border-soft)" }}
        >
          <div
            className="mb-2 font-mono uppercase"
            style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-subtle)" }}
          >
            Where this comes from
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {resources.map((r) => (
              <a
                key={r.url}
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="ec-tag outline inline-flex items-center gap-1.5"
                style={{ textDecoration: "none" }}
              >
                <FileText className="h-3 w-3 shrink-0" />
                <span style={{ color: "var(--fg)" }}>{r.label}</span>
                <span style={{ color: "var(--fg-muted)" }}>{shortHost(r.url)}</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            ))}
            {evaluators.length > 0 && (
              <SignalTooltip
                content={
                  <span className="block space-y-1">
                    <span className="block font-semibold">Who reported these scores</span>
                    <span className="block">{summary.evaluator_names?.join(", ")}</span>
                    {summary.third_party_ratio > 0 && (
                      <span className="block text-muted-foreground">
                        {Math.round(summary.third_party_ratio * 100)}% of results come from independent evaluators (not the model's own developer).
                      </span>
                    )}
                  </span>
                }
              >
                <span className="ec-tag outline cursor-help inline-flex items-center gap-1.5">
                  <Users className="h-3 w-3 shrink-0" />
                  <span style={{ color: "var(--fg)" }}>Reported by</span>
                  <span style={{ color: "var(--fg-muted)" }}>
                    {evaluators.join(", ")}
                    {hasMoreEvaluators ? ` +${(summary.evaluator_names?.length ?? 0) - evaluators.length} more` : ""}
                  </span>
                </span>
              </SignalTooltip>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
