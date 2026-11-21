import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import { SignalsRowBadges } from "@/components/signals/signals-row-badges"
import type { ComparabilityStatus, RowAnnotations } from "@/lib/backend-artifacts"

// Table cells stay clean for `no_bounds` and `mixed_scale` verdicts —
// repeating a "Not assessable" pill on every cell of an unbounded metric
// column clutters the leaderboard and drowns genuine divergence flags.
// Those verdicts are surfaced in the clickable Comparability (X) signal
// dialog, ComparabilityPanel, and the expanded row detail card.

function renderCell(
  annotations: RowAnnotations | null,
  comparabilityStatus?: ComparabilityStatus | null,
): string {
  return renderToStaticMarkup(
    createElement(
      AudienceModeProvider,
      null,
      createElement(SignalsRowBadges, { annotations, comparabilityStatus }),
    ),
  )
}

const CLEAN_ANNOTATIONS = {
  reproducibility_gap: null,
  provenance: null,
  variant_divergence: {
    has_variant_divergence: false,
    divergence_magnitude: 0.01,
    threshold_used: 0.05,
    differing_setup_fields: [],
  },
  cross_party_divergence: null,
} as unknown as RowAnnotations

describe("matrix cell comparability badges", () => {
  it("stays quiet for mixed_scale and no_bounds cells instead of repeating a per-cell pill", () => {
    expect(renderCell(null, "mixed_scale")).toBe("")
    expect(renderCell(null, "no_bounds")).toBe("")
    expect(renderCell(CLEAN_ANNOTATIONS, "mixed_scale")).toBe("")
    expect(renderCell(CLEAN_ANNOTATIONS, "no_bounds")).toBe("")
  })

  it("stays silent for an assessed cell and for a cell with no verdict at all", () => {
    expect(renderCell(null, "ok")).toBe("")
    expect(renderCell(CLEAN_ANNOTATIONS, "ok")).toBe("")
    expect(renderCell(null, null)).toBe("")
    expect(renderCell(null, undefined)).toBe("")
  })

  it("still renders positive variant and cross-party divergence badges", () => {
    const html = renderCell(
      {
        ...CLEAN_ANNOTATIONS,
        variant_divergence: {
          has_variant_divergence: true,
          divergence_magnitude: 0.14,
          threshold_used: 0.05,
          differing_setup_fields: [],
        },
        cross_party_divergence: {
          has_cross_party_divergence: true,
          divergence_magnitude: 0.11,
          organization_count: 2,
        },
      } as unknown as RowAnnotations,
      "ok",
    )
    expect(html).toContain("Variant divergence")
    expect(html).toContain("Cross-party divergence")
    expect(html).not.toContain("Not assessable")
  })
})

// The reproducibility gap fires on most rows, so the row strip leaves it to
// the merged view's R flag square and the eval page's signals strip. The
// strip has no audience-mode branch, so this holds in research and policy
// views alike.
const GAP_ANNOTATIONS = {
  ...CLEAN_ANNOTATIONS,
  reproducibility_gap: {
    has_reproducibility_gap: true,
    missing_fields: ["harness_version"],
    item_states: null,
  },
} as unknown as RowAnnotations

describe("row badges and the reproducibility gap", () => {
  it("renders nothing for a row whose only signal is a reproducibility gap", () => {
    expect(renderCell(GAP_ANNOTATIONS, "ok")).toBe("")
  })

  it("shows a gap row's divergence badge without a reproducibility label", () => {
    const html = renderCell(
      {
        ...GAP_ANNOTATIONS,
        variant_divergence: {
          has_variant_divergence: true,
          divergence_magnitude: 0.12,
          threshold_used: 0.05,
          differing_setup_fields: [],
        },
      } as unknown as RowAnnotations,
      "ok",
    )
    expect(html).toContain("Variant divergence")
    expect(html).not.toMatch(/Reproducibility gap|Setup not documented/)
  })
})
