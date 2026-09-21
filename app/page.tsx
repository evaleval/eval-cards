import { Fragment } from "react"
import Link from "next/link"
import { ArrowRight } from "lucide-react"

import { Navigation } from "@/components/navigation"
import { CorpusSignalsStrip } from "@/components/signals/corpus-signals-strip"
import { getDeveloperList, getEvalList } from "@/lib/data-backend"
import {
  fetchBackendManifest,
  fetchCorpusAggregates,
  fetchEvalHierarchy,
} from "@/lib/hf-data"
import { familyEvalsHref } from "@/lib/utils"

function formatGeneratedAt(value: string | null | undefined) {
  if (!value) return null
  try {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    })
  } catch {
    return value
  }
}

function formatNumber(value: number | undefined | null): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return value.toLocaleString("en-US")
}

const FAMILY_KIND_LABELS: Record<string, string> = {
  General: "General capability",
  Reasoning: "Reasoning",
  Agentic: "Agentic",
  Safety: "Safety",
  Code: "Code",
  Math: "Math",
  Multilingual: "Multilingual",
}

export default async function HomePage() {
  const [aggregates, manifest, hierarchy, developers, evals] = await Promise.all([
    fetchCorpusAggregates(),
    fetchBackendManifest(),
    fetchEvalHierarchy(),
    getDeveloperList().catch(() => []),
    getEvalList().catch(() => [] as Awaited<ReturnType<typeof getEvalList>>),
  ])

  const stats = hierarchy.stats
  const familyCount = stats?.family_count ?? hierarchy.families.length
  const compositeCount = stats?.composite_count ?? 0
  // v3 hierarchy ships `benchmark_count` directly. The legacy
  // `single_benchmark_count` / `standalone_benchmark_count` synthesis
  // is gone with the adapter; v3's `benchmark_count` is the
  // distinct (composite, benchmark) row count from the dim.
  const benchmarkLeafCount = stats?.benchmark_count ?? 0
  const sliceCount = stats?.slice_count ?? 0
  const metricCount = stats?.metric_count ?? 0
  const tripleCount = stats?.metric_rows_scanned ?? 0
  const modelCount = manifest?.model_count ?? 0
  const developerCount = developers.length
  // Distinct eval-provider organizations across the corpus. Sourced from
  // `headline.reporting_org_count` (precomputed in the producer's
  // sidecars.py) so the page doesn't have to scan parquet at request
  // time. The producer derives this from `eval_results_view.reporting_orgs`
  // which carries the de-aliased identity per fact row — canonical
  // display_name when the registry has the org (folds Ai2 ≡ Allen
  // Institute for AI), raw upstream string otherwise. Falls back to
  // evals.length only if a pre-sidecar snapshot is loaded.
  const evaluatorCount = aggregates?.reporting_org_count ?? evals.length
  const generatedAt = formatGeneratedAt(manifest?.generated_at)

  // Featured family cards — pick the first six families with summaries.
  // Curated multi-benchmark families (BFCL, MMLU, JudgeBench, …) put
  // their benchmarks under composites[].benchmarks[] after the adapter;
  // singletons land in standalone_benchmarks[] or benchmarks[]. Pull
  // from all four shapes so the count reflects the union (matches
  // the benchmark-counting logic in family-table.tsx).
  const featuredFamilies = hierarchy.families.slice(0, 6).map((family) => {
    // v3 family layouts: exactly one of standalone_benchmarks / benchmarks /
    // composites is present per family. Walk all three to count benchmarks.
    const benches: unknown[] = [
      ...(family.standalone_benchmarks ?? []),
      ...(family.benchmarks ?? []),
      ...((family.composites ?? []).flatMap((c) => c.benchmarks ?? [])),
    ]
    let slices = 0
    for (const b of benches) {
      const benchSlices = (b as { slices?: unknown[] }).slices
      if (Array.isArray(benchSlices)) slices += benchSlices.length
    }
    return {
      key: family.key,
      name: family.display_name,
      kind: FAMILY_KIND_LABELS[family.category] ?? family.category ?? "Benchmark family",
      benchCount: benches.length,
      sliceCount: slices,
    }
  })

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <main className="mx-auto w-full max-w-[96rem] px-4 pb-24 pt-12 sm:px-8 lg:pt-12">
        {/* HERO ----------------------------------------------------------- */}
        <section className="home-hero">
          <div>
            <h1 className="home-hero-h1">
              A reporting layer
              <br />
              over evaluation
              <br />
              infrastructure.
            </h1>
            <p className="home-hero-lede">
              <strong>Evaluation Cards</strong> is a collection of reported model–benchmark results,
              organized under a five-level rollout hierarchy and four interpretive signals
              computed over the joined record.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/models" className="btn-ec">
                Browse models
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
              <Link href="/evals" className="btn-ec outline">
                Browse evaluations
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
              <Link href="/about" className="btn-ec ghost">
                About
              </Link>
            </div>
          </div>

          <div>
            <div className="corpus-meta">
              <div className="kicker">
                Corpus snapshot{generatedAt ? (
                  <>
                    {" · "}
                    <span style={{ color: "var(--accent)" }}>{generatedAt}</span>
                  </>
                ) : ""}
              </div>
              <div className="corpus-grid">
                <CorpusStat
                  value={formatNumber(modelCount)}
                  label="Models"
                  detail="Tracked across reporting sources"
                />
                <CorpusStat
                  value={formatNumber(tripleCount)}
                  label="Reported results"
                  detail="(model, benchmark, metric) triples"
                />
                <CorpusStat
                  value={formatNumber(evaluatorCount)}
                  label="Reporting organizations"
                  detail="Distinct evaluator initiatives in this corpus"
                />
                <CorpusStat
                  value={formatNumber(developerCount)}
                  label="Model developers"
                  detail="Distinct model-publishing organizations"
                />
                <CorpusStat
                  value={formatNumber(familyCount)}
                  label="Benchmark families"
                  detail="Top of the rollout hierarchy"
                />
                <CorpusStat
                  value={formatNumber(benchmarkLeafCount)}
                  label="Single benchmarks"
                  detail={`${formatNumber(sliceCount)} slices · ${formatNumber(metricCount)} metrics`}
                />
              </div>
            </div>
          </div>
        </section>

        {/* FOUR INTERPRETIVE SIGNALS -------------------------------------- */}
        <section className="signals-section">
          <h2 className="signals-h2">Interpretive signals</h2>
          <p className="signals-lede">
            Four signals computed over each <em>(model, benchmark, metric-path)</em> record and
            aggregated to the corpus level. Per-record instances appear on every model and
            benchmark page.
          </p>

          {aggregates ? (
            <CorpusSignalsStrip aggregates={aggregates} />
          ) : (
            <div className="border border-dashed border-[color:var(--border-soft)] bg-[color:var(--bg-warm)] p-8 text-center">
              <h3 className="text-lg font-semibold tracking-tight">
                Corpus aggregates unavailable
              </h3>
              <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-[color:var(--fg-muted)]">
                The current backend snapshot does not include{" "}
                <code className="rounded-sm bg-[color:var(--bg-surface)] px-1.5 py-0.5 font-mono text-xs">
                  headline.json
                </code>
                . When it does, this section will render the four corpus-level rollups.
              </p>
            </div>
          )}
        </section>

        {/* FEATURED BENCHMARK FAMILIES ------------------------------------ */}
        {featuredFamilies.length > 0 && (
          <section className="mb-24">
            <div className="section-head">
              <h2>Benchmark families</h2>
              <Link href="/evals" className="micro-meta-link">
                All {formatNumber(familyCount)} →
              </Link>
            </div>
            <div className="fam-grid">
              {featuredFamilies.map((fam) => (
                <Link
                  key={fam.key}
                  href={familyEvalsHref(fam.key)}
                  className="fam-card"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <div className="fam-card-kind">{fam.kind}</div>
                    <div className="fam-card-counts">
                      {fam.benchCount} bench · {fam.sliceCount} slices
                    </div>
                  </div>
                  <h3 className="fam-card-name">{fam.name}</h3>
                  <p className="fam-card-summary">
                    {fam.benchCount > 0
                      ? `${fam.benchCount} reported benchmark${fam.benchCount === 1 ? "" : "s"} across this family.`
                      : "No reported results yet for this family."}
                  </p>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* FIVE-LEVEL HIERARCHY STRIP -------------------------------------- */}
        <section className="hierarchy-strip">
          <div className="kicker">Five-level rollout hierarchy</div>
          <div className="hierarchy-row">
            {[
              {
                name: "Family",
                count: formatNumber(familyCount),
                ex: "SWE-bench family, MMLU family",
                def: "A curated group of related benchmarks under one umbrella.",
                href: "/evals",
              },
              {
                name: "Composite",
                count: formatNumber(compositeCount),
                ex: "Open LLM Leaderboard v2, HELM Instruct",
                def: "A leaderboard or suite that bundles several benchmarks into one report.",
                href: "/evals",
              },
              {
                name: "Single benchmark",
                count: formatNumber(benchmarkLeafCount),
                ex: "GSM8K, IFEval, MMLU-Pro",
                def: "An individual evaluation dataset with its own protocol.",
                href: "/benchmarks",
              },
              {
                name: "Slice",
                count: formatNumber(sliceCount),
                ex: "algebra (within MATH), level-5, multi-turn",
                def: "A subset of a benchmark scored separately (e.g. a category or difficulty).",
                href: "/benchmarks",
              },
              {
                name: "Metric",
                count: formatNumber(metricCount),
                ex: "pass@1, accuracy, F1",
                def: "The number reported for a slice, i.e. what was actually measured.",
                href: "/benchmarks",
              },
            ].map((node, i, arr) => (
              <Fragment key={node.name}>
                <Link href={node.href} className="hierarchy-node">
                  <div className="hier-num">{String(i + 1).padStart(2, "0")}</div>
                  <div className="hier-name">{node.name}</div>
                  <div className="hier-count">{node.count}</div>
                  <div className="hier-ex">{node.ex}</div>
                  <div className="hier-def">{node.def}</div>
                </Link>
                {i < arr.length - 1 && (
                  <div className="hier-arrow" aria-hidden>
                    →
                  </div>
                )}
              </Fragment>
            ))}
          </div>
          <p className="hierarchy-note">
            Every score resolves to an explicit path through this hierarchy, so aggregate claims
            drill down to the evidence supporting them.
          </p>
        </section>
      </main>
    </div>
  )
}

function CorpusStat({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail: string
}) {
  return (
    <div>
      <div className="corpus-stat-n">{value}</div>
      <div className="corpus-stat-l">{label}</div>
      <div className="corpus-stat-sub">{detail}</div>
    </div>
  )
}
