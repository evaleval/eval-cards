import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import { EvalDetail } from "@/components/eval-detail"
import type { EvalHierarchy } from "@/lib/backend-artifacts"
import type { BenchmarkEvalSummary } from "@/lib/eval-processing"

vi.mock("next/navigation", () => import("./next-navigation-stub"))

// "Part of <study>" names the study a result belongs to. The name is a
// way back to the study's other benchmarks, which already have a listing
// of their own, so it links there by the app's family convention. When
// the visible rows span more than one family, or the key is not a
// family the listing can resolve, there is no single listing to send
// anyone to, and the name stays plain text rather than pointing at the
// wrong one. The paper stays its own external link either way.

const STUDY_NAME = "How Inference Compute Shapes Frontier LLM Evaluation"
const PAPER_URL = "https://example.test/paper"

function modelResult(score: number) {
  return {
    model_info: { name: "GPT-5.2", id: "openai/gpt-5.2" },
    model_route_id: "openai%2Fgpt-5.2",
    score,
    score_details: { score },
    evaluation_timestamp: "2026-09-16T00:00:00Z",
    source_metadata: {
      source_name: "UK AI Security Institute",
      source_type: "paper",
      source_organization_name: "UK AI Security Institute",
      evaluator_relationship: "third_party",
    },
    source_data: { dataset_name: "Humanity's Last Exam" },
    is_headline: true,
    result: {
      evaluation_name: "accuracy",
      evaluation_timestamp: "2026-09-16T00:00:00Z",
      metric_config: {
        evaluation_description: "accuracy",
        lower_is_better: false,
        score_type: "continuous",
      },
      score_details: { score },
    },
  }
}

function summaryWith(extra: Record<string, unknown>): BenchmarkEvalSummary {
  return {
    evaluation_id: "aisi-inference-scaling%2Fhle",
    evaluation_name: "Humanity's Last Exam",
    composite_benchmark_key: "aisi-inference-scaling",
    composite_benchmark_name: "AISI inference scaling",
    metric_config: {
      evaluation_description: "accuracy",
      lower_is_better: false,
      score_type: "continuous",
      min_score: 0,
      max_score: 1,
    },
    model_results: [modelResult(0.42)],
    models_count: 1,
    evaluator_names: ["UK AI Security Institute"],
    source_types: [],
    third_party_ratio: 1,
    missing_generation_config_count: 0,
    best_model: { name: "GPT-5.2", score: 0.42 },
    worst_model: null,
    avg_score: 0.42,
    avg_score_norm: 0.42,
    ...extra,
  } as unknown as BenchmarkEvalSummary
}

/** Only the field the study link is resolved against. */
const HIERARCHY = {
  families: [{ key: "aisi-inference-scaling", display_name: STUDY_NAME }],
} as unknown as EvalHierarchy

function render(summary: BenchmarkEvalSummary, evalHierarchy: EvalHierarchy | null = HIERARCHY): string {
  return renderToStaticMarkup(
    createElement(
      AudienceModeProvider,
      null,
      createElement(EvalDetail, { summary, evalHierarchy }),
    ),
  )
}

describe("study attribution link", () => {
  it("sends a per-source page's study name to that study's own family listing", () => {
    const html = render(
      summaryWith({
        composite_slug: "aisi-inference-scaling",
        // The benchmark's own family, which must NOT be what the study
        // name links to: it lists every source of this one benchmark,
        // not the study's seven.
        family_id: "hle",
        collection: {
          collection_id: "uk-aisi-inference-scaling",
          display_name: STUDY_NAME,
          url: PAPER_URL,
          curated: true,
          kind: "paper_study",
          compute_axis: null,
        },
      }),
    )

    expect(html).toContain("Part of")
    expect(html).toContain('href="/evals?family=aisi-inference-scaling"')
    expect(html).toContain(`href="${PAPER_URL}"`)
  })

  it("does the same for a merged page's study attribution", () => {
    const html = render(
      summaryWith({
        merged_view: true,
        study_refs: [
          {
            collection_id: "uk-aisi-inference-scaling",
            name: STUDY_NAME,
            url: PAPER_URL,
            family_key: "aisi-inference-scaling",
          },
        ],
      }),
    )

    expect(html).toContain('href="/evals?family=aisi-inference-scaling"')
    expect(html).toContain(`href="${PAPER_URL}"`)
  })

  it("leaves the name plain until the hierarchy can resolve the key", () => {
    // The hierarchy arrives after first paint, and it can nest or drop a
    // composite, so a key it does not carry as a top-level family would
    // land the reader on the full unfiltered list.
    const study = {
      collection_id: "uk-aisi-inference-scaling",
      name: STUDY_NAME,
      url: PAPER_URL,
      family_key: "aisi-inference-scaling",
    }
    expect(render(summaryWith({ merged_view: true, study_refs: [study] }), null)).not.toContain(
      "?family=",
    )
    expect(
      render(
        summaryWith({ merged_view: true, study_refs: [{ ...study, family_key: "not-a-family" }] }),
      ),
    ).not.toContain("?family=")
  })

  it("leaves the name plain when no single family backs it", () => {
    const html = render(
      summaryWith({
        merged_view: true,
        study_refs: [{ collection_id: "uk-aisi-inference-scaling", name: STUDY_NAME, url: PAPER_URL }],
      }),
    )

    expect(html).toContain(STUDY_NAME)
    expect(html).not.toContain("?family=")
    // The paper is a separate link and is unaffected.
    expect(html).toContain(`href="${PAPER_URL}"`)
  })
})
