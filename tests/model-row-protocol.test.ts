import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { RunProtocolSummary } from "@/components/protocol-axis-fields"
import type { CollectionProtocolAxis, CollectionsSidecarEntry } from "@/lib/collections"

vi.mock("next/navigation", () => import("./next-navigation-stub"))

// A model page shows a study's HEADLINE run per benchmark, one point out
// of a grid the study reported at several budgets. These pin that the
// point says which budget it is, in the study's own units, and that the
// generic generation argument is never mistaken for it.

const PROTOCOL_AXES: CollectionProtocolAxis[] = [
  { key: "scaffold", type: "categorical", values: ["S-adaptive", "ReAct"] },
  { key: "compaction", type: "boolean" },
  { key: "feedback", type: "categorical", values: ["none", "answer_feedback"] },
  { key: "token_limit", type: "int", unit: "tokens" },
  { key: "reasoning_tokens", type: "int", unit: "tokens" },
  { key: "reasoning_effort", type: "categorical", values: ["high", "xhigh"] },
]

const ENTRY: CollectionsSidecarEntry = {
  curated: true,
  display_name: "How Inference Compute Shapes Frontier LLM Evaluation",
  kind: "paper_study",
  url: "https://example.test/paper",
  protocol_axes: PROTOCOL_AXES,
}

function condition(fields: Record<string, unknown>): string {
  return JSON.stringify({ scaffold: "S-adaptive", feedback: "none", compaction: false, ...fields })
}

describe("representative protocol on a model row", () => {
  const collections = { "uk-aisi-inference-scaling": ENTRY }

  it("labels the run's own settings and links to the study and the full grid", () => {
    const html = renderToStaticMarkup(
      createElement(RunProtocolSummary, {
        collectionId: "uk-aisi-inference-scaling",
        protocolCondition: condition({
          token_limit: 10_000_000,
          reasoning_tokens: 64_000,
          reasoning_effort: "xhigh",
        }),
        familyKey: "aisi-inference-scaling",
        evalSummaryId: "aisi-inference-scaling%2Fterminal-bench-2",
        collections,
      }),
    )

    expect(html).toContain("Token budget")
    expect(html).toContain("10M tokens")
    expect(html).toContain("Thinking tokens")
    expect(html).toContain("64k tokens")
    expect(html).toContain("Effort")
    expect(html).toContain("X-high")
    expect(html).toContain('href="/evals/aisi-inference-scaling/terminal-bench-2"')
    // The study name goes to the listing of its own benchmarks, by the
    // same convention every other family link in the app follows.
    expect(html).toContain('href="/evals?family=aisi-inference-scaling"')
    expect(html).toContain("How Inference Compute Shapes Frontier LLM Evaluation")
    // The generic generation argument is a different quantity and is
    // never what a study's token budget is read from.
    expect(html).not.toContain("Max tokens")
  })

  it("says a declared budget was not reported rather than dropping it", () => {
    // The cyber shape: the study declares a thinking-token budget and
    // reports none here. Dropping the axis is indistinguishable from the
    // axis not applying, which is a different claim about the score.
    const html = renderToStaticMarkup(
      createElement(RunProtocolSummary, {
        collectionId: "uk-aisi-inference-scaling",
        protocolCondition: condition({ token_limit: 100_000_000, reasoning_tokens: null }),
        evalSummaryId: "aisi-inference-scaling%2Fcyber-ctfs",
        collections,
      }),
    )
    expect(html).toContain("100M tokens")
    expect(html).toContain("Thinking tokens")
    expect(html).toContain("Not reported")
    expect(html).not.toContain("Not applicable")
    // A unitless axis the run says nothing about stays out: it explains
    // nothing and the group has to stay inline.
    expect(html).not.toContain("Effort")
  })

  it("still names the declared budgets when the run carries no protocol at all", () => {
    const html = renderToStaticMarkup(
      createElement(RunProtocolSummary, {
        collectionId: "uk-aisi-inference-scaling",
        protocolCondition: null,
        evalSummaryId: "aisi-inference-scaling%2Fhle",
        collections,
      }),
    )
    expect(html).toContain("Token budget")
    expect(html).toContain("Thinking tokens")
    expect(html).toContain("Not reported")
    expect(html).not.toContain("Not applicable")
  })

  it("renders nothing for a curated study that declares no axes", () => {
    expect(
      renderToStaticMarkup(
        createElement(RunProtocolSummary, {
          collectionId: "uk-aisi-inference-scaling",
          protocolCondition: null,
          evalSummaryId: "aisi-inference-scaling%2Fhle",
          collections: {
            "uk-aisi-inference-scaling": { curated: true, display_name: ENTRY.display_name },
          },
        }),
      ),
    ).toBe("")
  })

  it("names the study as plain text when the row carries no family to send the reader to", () => {
    const html = renderToStaticMarkup(
      createElement(RunProtocolSummary, {
        collectionId: "uk-aisi-inference-scaling",
        protocolCondition: condition({ token_limit: 10_000_000 }),
        familyKey: null,
        evalSummaryId: "aisi-inference-scaling%2Fhle",
        collections,
      }),
    )
    expect(html).toContain("How Inference Compute Shapes Frontier LLM Evaluation")
    expect(html).not.toContain("?family=")
  })

  it("renders nothing for a row outside a curated study", () => {
    expect(
      renderToStaticMarkup(
        createElement(RunProtocolSummary, {
          collectionId: "openai/simple-evals",
          protocolCondition: null,
          evalSummaryId: "openai-simple-evals%2Fmmlu",
          collections,
        }),
      ),
    ).toBe("")
    expect(
      renderToStaticMarkup(
        createElement(RunProtocolSummary, {
          collectionId: null,
          protocolCondition: condition({ token_limit: 10_000_000 }),
          evalSummaryId: "somewhere%2Felse",
          collections,
        }),
      ),
    ).toBe("")
  })
})
