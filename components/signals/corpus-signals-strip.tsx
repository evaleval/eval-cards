import Link from "next/link"
import { ArrowUpRight } from "lucide-react"

import type { CorpusAggregates } from "@/lib/backend-artifacts"
import { setupItemLabel } from "@/lib/setup-items"

type SignalId =
  | "reproducibility"
  | "completeness"
  | "provenance"
  | "comparability"

const SIGNAL_GLYPHS: Record<SignalId, string> = {
  reproducibility: "R",
  completeness: "C",
  provenance: "P",
  comparability: "X",
}

/**
 * Corpus-level rollup of the four interpretive signals.
 * Renders as a 4-up grid of "signal tiles" matching the EvalEval design system:
 * monochrome typography, mono numerals, glyphs that double as colour anchors.
 */
export function CorpusSignalsStrip({
  aggregates,
}: {
  aggregates: CorpusAggregates
}) {
  // Each block can be partly missing if the backend hasn't computed it
  // for the snapshot in use; guard every read so a partial payload
  // renders as "—" instead of crashing the route.
  const repro = aggregates.reproducibility?.overall ?? null
  const comp = aggregates.completeness?.overall ?? null
  const prov = aggregates.provenance?.overall ?? null
  const cmp = aggregates.comparability?.overall ?? null

  // Invert the gap rate to read as "documented", which matches reader intuition.
  const reproGapRate = repro?.reproducibility_gap_rate ?? null
  const reproDocumented = reproGapRate == null ? null : Math.max(0, 1 - reproGapRate)
  const reproDetail = topMissingFields(repro?.per_field_missingness ?? {}, 2)

  const totalReports = prov?.total_triples ?? 0
  const sourceDist = prov?.source_type_distribution
  const tpShare = totalReports > 0 && sourceDist?.third_party != null
    ? sourceDist.third_party / totalReports
    : null
  const fpShare = totalReports > 0 && sourceDist?.first_party != null
    ? sourceDist.first_party / totalReports
    : null

  const multiSourceRate = rate(prov?.multi_source_triples, prov?.total_triples)
  const cmpRate = rate(cmp?.variant_divergent_count, cmp?.groups_with_variant_check)
  const crossPartyRate = rate(
    cmp?.cross_party_divergent_count,
    cmp?.groups_with_cross_party_check,
  )
  const crossPartyAvailable = (cmp?.groups_with_cross_party_check ?? 0) > 0
  const variantDivergent = cmp?.variant_divergent_count ?? null
  const variantEligible = cmp?.groups_with_variant_check ?? null
  const completenessTotal = comp?.total_triples ?? null

  return (
    <div className="signals-grid">
      <SignalTile
        id="reproducibility"
        statValue={pctNum(reproDocumented)}
        statUnit="%"
        headline="of results, by model, benchmark, split and metric, disclose every setup item that applies. The rest cannot be independently re-run."
        detail={
          reproDetail
            ? `${formatPct(reproGapRate)} leave at least one setup item undisclosed. Most often undisclosed: ${reproDetail}.`
            : `${formatPct(reproGapRate)} leave at least one setup item undisclosed.`
        }
        asks="Can someone else run this evaluation and get the same number?"
      />
      <SignalTile
        id="completeness"
        statValue={pctNum(comp?.completeness_avg)}
        statUnit="%"
        headline={
          completenessTotal != null
            ? `mean across ${completenessTotal.toLocaleString()} reported score triples.`
            : "mean across reported score triples."
        }
        detail={`Observed range: ${formatPct(comp?.completeness_min)} to ${formatPct(comp?.completeness_max)}.`}
        asks="Is the benchmark itself documented well enough to interpret a score on it?"
      />
      <SignalTile
        id="provenance"
        statValue={pctNum(multiSourceRate)}
        statUnit="%"
        headline="of reported score triples have reports from more than one party."
        detail={`${formatPct(tpShare)} third-party, ${formatPct(fpShare)} first-party of ${totalReports.toLocaleString()} unique triples.`}
        asks="Who reported this score, and have others reproduced it?"
      />
      <SignalTile
        id="comparability"
        statValue={pctNum(cmpRate)}
        statUnit="%"
        headline={
          variantEligible != null && variantDivergent != null
            ? `of setup-eligible groups diverge across variants (${variantDivergent.toLocaleString()} of ${variantEligible.toLocaleString()}).`
            : "of setup-eligible groups diverge across variants."
        }
        detail={
          crossPartyAvailable
            ? `Cross-party divergence: ${formatPct(crossPartyRate)}.`
            : "Cross-party divergence not yet computable: too few multi-org reports."
        }
        asks="Are scores on the same benchmark actually measuring the same thing?"
      />
    </div>
  )
}

function SignalTile({
  id,
  statValue,
  statUnit,
  headline,
  detail,
  asks,
}: {
  id: SignalId
  statValue: string
  statUnit: string
  headline: string
  detail: string
  asks: string
}) {
  const name =
    id === "reproducibility"
      ? "Reproducibility"
      : id === "completeness"
      ? "Completeness"
      : id === "provenance"
      ? "Provenance"
      : "Comparability"

  const anchor = id === "provenance" ? "provenance" : id
  return (
    <Link
      href={`/about#signal-${anchor}`}
      className="sig-tile group"
      title={`Read how ${name.toLowerCase()} is measured`}
    >
      <div className="sig-tile-head">
        <span
          className={`sig-glyph sig-${id}`}
          style={{ width: 32, height: 32, fontSize: "0.825rem" }}
        >
          <span>{SIGNAL_GLYPHS[id]}</span>
        </span>
        <span className="sig-tile-name">{name}</span>
        <ArrowUpRight
          className="ml-auto h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100"
          style={{ color: "var(--accent)" }}
          aria-hidden
        />
      </div>

      <div className="sig-tile-stat">
        <span className="sig-tile-num">{statValue}</span>
        <span className="sig-tile-unit">{statUnit}</span>
      </div>

      <p className="sig-tile-headline">{headline}</p>
      <p className="sig-tile-detail">{detail}</p>

      <div className="sig-tile-asks">
        <span className="kicker">Asks</span>
        <span className="sig-tile-asks-text">{asks}</span>
      </div>
    </Link>
  )
}

function pctNum(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  if (value === 0) return "0"
  if (value > 0 && value < 0.01) return "<1"
  return `${Math.round(value * 100)}`
}

function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  if (value === 0) return "0%"
  if (value > 0 && value < 0.01) return "<1%"
  return `${Math.round(value * 100)}%`
}

function rate(numerator: number | null | undefined, denominator: number | null | undefined) {
  if (numerator == null || denominator == null || denominator <= 0) return null
  return numerator / denominator
}

function topMissingFields(
  perField: Record<
    string,
    { missing_count: number; missing_rate: number | null; denominator: string }
  >,
  n: number,
): string {
  const entries = Object.entries(perField)
    .filter(([, v]) => v.missing_count > 0)
    .sort((a, b) => b[1].missing_count - a[1].missing_count)
    .slice(0, n)

  if (entries.length === 0) return ""

  return entries
    .map(([key, v]) => `${setupItemLabel(key)} (${formatPct(v.missing_rate)})`)
    .join(", ")
}
