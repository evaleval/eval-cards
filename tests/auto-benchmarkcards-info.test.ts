// @vitest-environment happy-dom

import { act, createElement, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AudienceModeProvider } from "@/components/audience-mode-provider"
import { AutoBenchmarkCardsInfo } from "@/components/auto-benchmarkcards-info"
import { EvalDetail } from "@/components/eval-detail"
import { PolicyOverview } from "@/components/policy-overview"
import EvalDetailPage from "@/app/evals/[...id]/page"
import type { BenchmarkCard } from "@/lib/benchmark-schema"
import type { BenchmarkEvalSummary } from "@/lib/eval-processing"

const routeParams = vi.hoisted(() => ({ id: ["source", "aa-lcr"] }))
const fetchEvalSummary = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", async () => ({
  ...await import("./next-navigation-stub"),
  useParams: () => routeParams,
}))
vi.mock("@/lib/dashboard-data-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/dashboard-data-client")>(),
  fetchEvalSummary,
  fetchEvalHierarchy: async () => null,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TRIGGER = 'button[aria-label="About Auto-BenchmarkCards metadata"]'
const POPOVER = '[role="dialog"][aria-label="Auto-BenchmarkCards metadata"]'
const DATASET_URL = "https://huggingface.co/datasets/evaleval/auto-benchmarkcards"
const card: BenchmarkCard = {
  benchmark_details: {
    name: "AA-LCR", overview: "A benchmark overview.", data_type: "text",
    domains: ["reasoning"], languages: [], similar_benchmarks: [], resources: [],
  },
  purpose_and_intended_users: {
    goal: "Measure reasoning.", audience: [], tasks: [], limitations: "", out_of_scope_uses: [],
  },
  data: { source: "", size: "", format: "", annotation: "" },
  methodology: { methods: [], metrics: [], calculation: "", interpretation: "", baseline_results: "", validation: "" },
  ethical_and_legal_considerations: {
    privacy_and_anonymity: "", data_licensing: "", consent_procedures: "", compliance_with_regulations: "",
  },
  possible_risks: [], flagged_fields: {}, missing_fields: [],
  card_info: { created_at: "", llm: "" },
}
const emptyCard: BenchmarkCard = {
  ...card,
  benchmark_details: { ...card.benchmark_details, overview: "", data_type: "", domains: [] },
  purpose_and_intended_users: { ...card.purpose_and_intended_users, goal: "" },
}

function summary(benchmarkCard?: BenchmarkCard, sourcePath?: string | null): BenchmarkEvalSummary {
  return {
    evaluation_id: "source%2Faa-lcr", evaluation_name: "AA-LCR",
    composite_benchmark_key: "source", composite_benchmark_name: "Source",
    metric_config: { evaluation_description: "Reported accuracy.", lower_is_better: false, score_type: "continuous" },
    model_results: [], models_count: 0, evaluator_names: [], source_types: [],
    third_party_ratio: 0, missing_generation_config_count: 0,
    best_model: null, worst_model: null, avg_score: 0, avg_score_norm: null,
    benchmark_card: benchmarkCard,
    benchmark_card_source_path: sourcePath,
  } as BenchmarkEvalSummary
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  window.localStorage.clear()
})

async function render(element: ReactElement) {
  await act(async () => root.render(createElement(AudienceModeProvider, null, element)))
}

async function click(element: HTMLElement) {
  await act(async () => element.click())
}

async function escape() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe("Auto-BenchmarkCards feedback", () => {
  it.each([
    ["cards/aa-lcr.json", `${DATASET_URL}/blob/main/cards/aa-lcr.json`],
    ["cards/éval #1?100%.json", `${DATASET_URL}/blob/main/cards/%C3%A9val%20%231%3F100%25.json`],
    ["cards/a%2Fb.json", `${DATASET_URL}/blob/main/cards/a%252Fb.json`],
    [undefined, DATASET_URL],
    [null, DATASET_URL],
    ["", DATASET_URL],
    ["../cards/a.json", DATASET_URL],
    ["/cards/a.json", DATASET_URL],
  ])("links source path %s to %s", async (sourcePath, expected) => {
    await render(createElement(AutoBenchmarkCardsInfo, { sourcePath }))
    await click(container.querySelector<HTMLButtonElement>(TRIGGER)!)
    expect(document.querySelector<HTMLAnchorElement>(`${POPOVER} a`)?.href).toBe(expected)
  })

  it("opens on activation, exposes source links, and keeps clicks inside a navigable card", async () => {
    const navigate = vi.fn()
    await render(createElement("div", { onClick: navigate }, createElement(AutoBenchmarkCardsInfo)))
    const trigger = container.querySelector<HTMLButtonElement>(TRIGGER)!
    expect(trigger.type).toBe("button")
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog")
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    await click(trigger)
    const popover = document.querySelector<HTMLElement>(POPOVER)!
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(popover.textContent).toContain("This metadata is generated via Auto-BenchmarkCards.Spotted an error?")
    expect(document.getElementById(popover.getAttribute("aria-describedby")!)).not.toBeNull()
    const links = [...popover.querySelectorAll("a")]
    expect(links.map((link) => link.href)).toEqual([DATASET_URL])
    expect(links[0].textContent).toBe("Suggest corrections")
    for (const link of links) {
      expect(link.target).toBe("_blank")
      expect(link.rel).toBe("noopener noreferrer")
      link.addEventListener("click", (event) => event.preventDefault())
      await click(link)
    }
    expect(navigate).not.toHaveBeenCalled()

    await escape()
    expect(document.querySelector(POPOVER)).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it("dismisses when a pointer interaction occurs outside", async () => {
    await render(createElement(AutoBenchmarkCardsInfo))
    await click(container.querySelector<HTMLButtonElement>(TRIGGER)!)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      document.body.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }))
      document.body.click()
    })
    expect(document.querySelector(POPOVER)).toBeNull()
  })

  it("labels policy metadata but leaves fallback descriptions unattributed", async () => {
    await render(createElement(PolicyOverview, { summary: summary(card, "cards/aa-lcr.json") }))
    expect(container.querySelector(TRIGGER)).not.toBeNull()
    await click(container.querySelector<HTMLButtonElement>(TRIGGER)!)
    expect(document.querySelector<HTMLAnchorElement>(`${POPOVER} a`)?.href)
      .toBe(`${DATASET_URL}/blob/main/cards/aa-lcr.json`)
    await render(createElement(PolicyOverview, { summary: summary() }))
    expect(container.textContent).toContain("Reported accuracy.")
    expect(container.querySelector(TRIGGER)).toBeNull()
  })

  it("does not attribute fallback-only content to an empty metadata card", async () => {
    const fallback = { ...summary(emptyCard), source_data: { dataset_name: "Reported dataset" } }
    await render(createElement(PolicyOverview, { summary: fallback }))
    expect(container.querySelector(TRIGGER)).toBeNull()
    await render(createElement(EvalDetail, { summary: fallback }))
    expect(container.textContent).toContain("Reported dataset")
    expect(container.querySelector(TRIGGER)).toBeNull()
  })

  it("labels card quality badges in policy mode even when the prose is missing", async () => {
    window.localStorage.setItem("eval-cards-audience-mode", "policy")
    const qualityOnly = {
      ...summary({ ...emptyCard, missing_fields: ["methodology.validation"] }),
      source_data: { dataset_name: "Reported dataset" },
    }
    await render(createElement(EvalDetail, { summary: qualityOnly }))
    const sectionToggle = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Benchmark card"))!
    if (sectionToggle.getAttribute("aria-expanded") === "false") await click(sectionToggle)
    expect(container.textContent).toContain("0 flagged · 1 missing")
    expect(container.querySelector(TRIGGER)).not.toBeNull()
  })

  it("opens beside the benchmark section without toggling it or nesting buttons", async () => {
    await render(createElement(EvalDetail, { summary: summary(card, "cards/aa-lcr.json") }))
    const trigger = container.querySelector<HTMLButtonElement>(TRIGGER)!
    expect(trigger.parentElement?.closest("button, a")).toBeNull()
    const sectionToggle = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Benchmark card"))!
    expect(sectionToggle.getAttribute("aria-expanded")).toBe("true")
    await click(trigger)
    expect(sectionToggle.getAttribute("aria-expanded")).toBe("true")
    expect(document.querySelector<HTMLAnchorElement>(`${POPOVER} a`)?.href)
      .toBe(`${DATASET_URL}/blob/main/cards/aa-lcr.json`)
    await escape()
    await click(sectionToggle)
    expect(sectionToggle.getAttribute("aria-expanded")).toBe("false")
    await click(trigger)
    expect(document.querySelector(POPOVER)).not.toBeNull()
    expect(sectionToggle.getAttribute("aria-expanded")).toBe("false")
  })

  it("names every toggle on the benchmark card bar, even with no section links", async () => {
    const goalOnly = {
      ...emptyCard,
      purpose_and_intended_users: { ...emptyCard.purpose_and_intended_users, goal: "Measure reasoning." },
    }
    await render(createElement(EvalDetail, { summary: summary(goalOnly, "cards/aa-lcr.json") }))
    const bar = container.querySelector<HTMLButtonElement>(TRIGGER)!.closest(".ec-card")!
    const buttons = [...bar.querySelectorAll<HTMLButtonElement>("button")]
    expect(buttons.filter((button) => button.hasAttribute("aria-expanded"))).toHaveLength(3)
    for (const button of buttons) {
      expect(button.getAttribute("aria-label") || button.textContent?.trim()).toBeTruthy()
    }
  })

  it("links composite lede and At a glance metadata to the composite card", async () => {
    window.localStorage.setItem("eval-cards-audience-mode", "policy")
    const composite = {
      ...summary(card, "cards/composite.json"),
      is_aggregated: true,
      aggregate_sources: [
        { evaluation_id: "source%2Fsub-a" },
        { evaluation_id: "source%2Fsub-b" },
      ],
    }
    fetchEvalSummary.mockImplementation(async (id) =>
      id === "source%2Faa-lcr" ? composite : summary(card, "cards/component.json")
    )
    await render(createElement(EvalDetailPage))
    const triggers = [...container.querySelectorAll<HTMLButtonElement>(TRIGGER)]
    expect(triggers).toHaveLength(2)
    for (const trigger of triggers) {
      await click(trigger)
      expect(document.querySelector<HTMLAnchorElement>(`${POPOVER} a`)?.href)
        .toBe(`${DATASET_URL}/blob/main/cards/composite.json`)
      await escape()
    }
  })
})
