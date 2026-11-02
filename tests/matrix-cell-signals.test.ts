import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import { SignalsRowBadges } from "@/components/signals/signals-row-badges"
import type { ComparabilityStatus, RowAnnotations } from "@/lib/backend-artifacts"

// Multi-metric matrix cells get their verdict from the prebaked matrix, not
// from an annotation struct — the builder carries `comparability_status` per
// column precisely so a cell can say "not assessable" rather than showing
// the silence that reads as "checked, nothing found".

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
  it("renders 'not assessable' for a mixed_scale or no_bounds cell with no annotation struct", () => {
    expect(renderCell(null, "mixed_scale")).toContain("Not assessable")
    expect(renderCell(null, "no_bounds")).toContain("Not assessable")
  })

  it("stays silent for an assessed cell and for a cell with no verdict at all", () => {
    // `ok` with NULL flags is the common case — the group simply had
    // nothing to compare against. It is not "not assessable".
    expect(renderCell(null, "ok")).toBe("")
    expect(renderCell(CLEAN_ANNOTATIONS, "ok")).toBe("")
    // A matrix baked before the status column existed: no verdict, no chip.
    expect(renderCell(null, null)).toBe("")
    expect(renderCell(null, undefined)).toBe("")
  })

  it("lets the cell's own status override a clean annotation block", () => {
    expect(renderCell(CLEAN_ANNOTATIONS, "mixed_scale")).toContain("Not assessable")
    // One chip per row, not two: the cross-party badge stays silent.
    expect((renderCell(CLEAN_ANNOTATIONS, "mixed_scale").match(/Not assessable/g) ?? []).length).toBe(1)
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
