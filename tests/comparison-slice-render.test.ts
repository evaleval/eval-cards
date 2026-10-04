// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react"
import { createRoot } from "react-dom/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import type { ComparisonIndex, EvalHierarchy } from "@/lib/backend-artifacts"
import type { BenchmarkEvalSummary, ModelEvaluationSummary } from "@/lib/eval-processing"

import { fixtureIndex, fixtureRawHierarchy, useSnapshot } from "./comparison-fixture"

vi.mock("next/navigation", () => import("./next-navigation-stub"))
vi.mock("@/lib/dashboard-data-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard-data-client")>()),
  fetchPeerRanks: () => Promise.resolve({}),
}))

// Renders each surface that reads the comparison index once with the whole
// index and once with the slice its page now requests, drives the same
// interactions on both, and requires identical markup at every step. One
// witness model or eval per UI branch; every model and eval is covered at the
// data level in comparison-table.test.ts.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let restore: () => void
let full: ComparisonIndex
let hierarchy: EvalHierarchy
let summaries: ModelEvaluationSummary[]
let table: typeof import("@/lib/comparison-table")

beforeAll(async () => {
  restore = useSnapshot()
  table = await import("@/lib/comparison-table")
  full = fixtureIndex()
  const { cleanHierarchy } = await import("@/lib/clean-hierarchy")
  const { decorateHierarchyDerivedTags } = await import("@/lib/benchmark-tags")
  hierarchy = decorateHierarchyDerivedTags(cleanHierarchy(fixtureRawHierarchy(), full))
  const backend = await import("@/lib/data-backend")
  summaries = []
  for (const routeId of Object.keys(full.by_model ?? {})) {
    const summary = await backend.getModelSummaryById(routeId)
    if (summary) summaries.push(summary as ModelEvaluationSummary)
  }
})

afterAll(() => restore?.())

const normalise = (html: string) => html.replace(/«r[0-9a-z]+»|:r[0-9a-z]+:/g, "«id»")

/** Mount `element`, run `steps`, and return the page markup after mounting
 *  and after every step. */
async function session(element: ReactElement, steps: (snap: () => void) => Promise<void>) {
  const { AudienceModeProvider } = await import("@/components/audience-mode-provider")
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  const snapshots: string[] = []
  const snap = () => snapshots.push(normalise(document.body.innerHTML))
  await act(async () => {
    root.render(createElement(AudienceModeProvider, null, element))
  })
  snap()
  try {
    await steps(snap)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    document.body.innerHTML = ""
  }
  return snapshots
}

async function click(element: Element | null | undefined, what: string) {
  expect(element, `${what} is not rendered`).toBeTruthy()
  await act(async () => {
    ;(element as HTMLElement).click()
  })
}

const button = (label: string) => document.querySelector(`button[aria-label="${label}"]`)
const text = () => document.body.textContent ?? ""

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

/** Every plotbox view and metric tab, then (outside the embed) the table
 *  view. `metricTabs` names the eval tabs that must render, in group order;
 *  `untouched` says no tab has been clicked yet, so the first is selected. */
async function exercisePlots(
  snap: () => void,
  { embed, metricTabs, untouched = true }: { embed: boolean; metricTabs?: string[]; untouched?: boolean },
) {
  if (metricTabs) {
    expect(document.querySelectorAll("select.ec-select").length, "plotbox view selector").toBeGreaterThan(0)
    const tabs = Array.from(document.querySelectorAll("button.ec-pill"))
      .map((b) => ({ label: b.textContent, on: b.classList.contains("on") }))
      .filter((tab) => metricTabs.includes(tab.label ?? ""))
    expect(tabs.map((tab) => tab.label).slice(0, metricTabs.length), "metric tabs in group order").toEqual(metricTabs)
    if (untouched) expect(tabs[0].on, `${metricTabs[0]} is the selected tab`).toBe(true)
  }
  if (!embed) expect(document.querySelectorAll("button.ec-pill").length, "filter pills").toBeGreaterThan(0)
  for (let i = 0; i < document.querySelectorAll("select.ec-select").length; i++) {
    const select = document.querySelectorAll<HTMLSelectElement>("select.ec-select")[i]
    for (const option of Array.from(select.options).map((o) => o.value)) {
      await choose(document.querySelectorAll<HTMLSelectElement>("select.ec-select")[i], option)
      snap()
    }
  }
  for (let i = 0; i < document.querySelectorAll("button.ec-pill").length; i++) {
    await click(document.querySelectorAll("button.ec-pill")[i], `pill ${i}`)
    snap()
  }
  if (embed) {
    expect(button("Table view"), "the embed has no table toggle").toBeNull()
    return
  }
  await click(button("Table view"), "Table view")
  snap()
  await click(button("Plots view"), "Plots view")
}

interface Witnesses {
  splitPeers: ModelEvaluationSummary
  metricTabs: ModelEvaluationSummary
  overlaps: ModelEvaluationSummary
  protocol: ModelEvaluationSummary
}

/** What each witness's branch must put on the page. */
interface Markers {
  /** The split-peer caption line of the splitPeers witness. */
  splitCaption: string
  /** Metric tab labels per eval of the metricTabs witness, in group order. */
  metricTabs: Record<string, string[]>
  /** Evals where the protocol witness's own row is a protocol-axis row. */
  protocolEvals: string[]
}

async function pickWitnesses(): Promise<{ witnesses: Witnesses; markers: Markers }> {
  const { buildBenchmarkHistograms, comparisonRouteIdOf } = await import("@/components/benchmark-detail")
  const { buildOverlapRows } = await import("@/lib/overlaps")
  const { identityKeysOf } = await import("./comparison-fixture")
  const familyDisplayByKey = new Map(hierarchy.families.map((f) => [f.key, f.display_name]))
  const own = (summary: ModelEvaluationSummary) => Object.keys(full.by_model?.[comparisonRouteIdOf(summary)] ?? {})
  const find = (label: string, test: (summary: ModelEvaluationSummary) => boolean) => {
    const found = summaries.find(test)
    expect(found, `no fixture model for the ${label} branch`).toBeDefined()
    return found!
  }
  const captions = (summary: ModelEvaluationSummary) =>
    [
      ...buildBenchmarkHistograms({
        comparisonIndex: full,
        wantedEvalIds: new Set(own(summary)),
        currentModelIdentityKeys: identityKeysOf(summary),
        currentModelRouteId: comparisonRouteIdOf(summary),
        currentModelName: summary.model_info.name,
        extraModelsByBenchmark: {},
      }).values(),
    ].flatMap((h) => (h.caption ? [h.caption.base] : []))
  const isProtocolRow = (summary: ModelEvaluationSummary) => (evalId: string) =>
    full.evals[evalId].metrics.some((m) =>
      m.scores.some(
        (s) => s.model_route_id === comparisonRouteIdOf(summary) && (s.submission_axis as string) === "protocol",
      ),
    )
  const witnesses: Witnesses = {
    splitPeers: find("split-peer caption", (summary) => captions(summary).length > 0),
    metricTabs: find("metric tab order", (summary) =>
      own(summary).some((evalId) => full.evals[evalId].metrics.length > 1),
    ),
    overlaps: find("overlaps default view", (summary) =>
      buildOverlapRows({
        benchmarkIndex: hierarchy.benchmark_index,
        comparisonIndex: full,
        currentModelRouteId: comparisonRouteIdOf(summary),
        currentModelIdentityKeys: identityKeysOf(summary),
        familyDisplayByKey,
      }).some((row) => row.appearances.length > 1),
    ),
    protocol: find("protocol submission chip", (summary) => own(summary).some(isProtocolRow(summary))),
  }
  const metricTabs: Record<string, string[]> = {}
  for (const evalId of own(witnesses.metricTabs)) {
    const metrics = full.evals[evalId].metrics
    if (metrics.length < 2) continue
    metricTabs[evalId] = [...metrics].sort((a, b) => a.group_order - b.group_order).map((m) => m.metric_name)
    // Only a witness whose group order differs from alphabetical order can
    // tell the two apart.
    expect(metricTabs[evalId][0], evalId).not.toBe(metrics.map((m) => m.metric_name).sort()[0])
  }
  return {
    witnesses,
    markers: {
      splitCaption: captions(witnesses.splitPeers)[0],
      metricTabs,
      protocolEvals: own(witnesses.protocol).filter(isProtocolRow(witnesses.protocol)),
    },
  }
}

describe("BenchmarkDetail renders the same from the model slice", () => {
  let witnesses: Witnesses
  let markers: Markers
  beforeAll(async () => {
    ;({ witnesses, markers } = await pickWitnesses())
  })

  /** The tabs the model page's first plotbox must show for `branch`. */
  const firstTabs = (branch: keyof Witnesses) =>
    branch === "metricTabs" ? Object.values(markers.metricTabs)[0] : undefined

  it.each(["splitPeers", "metricTabs", "overlaps", "protocol"] as const)(
    "on the model page, every view and deep dive (%s witness)",
    async (branch) => {
      const { BenchmarkDetail, comparisonRouteIdOf } = await import("@/components/benchmark-detail")
      const summary = witnesses[branch]
      const slice = await table.sliceForModel(comparisonRouteIdOf(summary))
      const render = (index: ComparisonIndex | null) =>
        session(createElement(BenchmarkDetail, { summary, evalHierarchy: hierarchy, comparisonIndex: index }), async (snap) => {
          for (const label of ["Scores", "Plots by source", "Plots by category"]) {
            await click(button(label), label)
            snap()
            if (label === "Scores") {
              if (branch === "overlaps" && index) {
                const multi = /^Overlaps only \((\d+)\)$/.exec(
                  Array.from(document.querySelectorAll("button.ec-pill")).map((b) => b.textContent ?? "").find((t) => t.startsWith("Overlaps only")) ?? "",
                )
                expect(Number(multi?.[1] ?? 0), "multi-source overlap rows").toBeGreaterThan(0)
                await click(
                  Array.from(document.querySelectorAll("button.ec-pill")).find((b) => b.textContent?.startsWith("Overlaps only")),
                  "Overlaps only",
                )
                snap()
                const rows = Array.from(document.querySelectorAll("button.grid[aria-expanded]"))
                expect(rows.length).toBe(Number(multi![1]))
                for (const row of rows) expect(row.textContent).toMatch(/([2-9]|\d\d+) sources/)
              }
              for (const row of Array.from(document.querySelectorAll("button.grid[aria-expanded]"))) {
                await click(row, "overlap row")
                snap()
              }
              continue
            }
            if (index && branch === "splitPeers") expect(text()).toContain(markers.splitCaption)
            await exercisePlots(snap, {
              embed: false,
              metricTabs: index ? firstTabs(branch) : undefined,
              untouched: label === "Plots by source",
            })
          }
          const deepDives = Array.from(document.querySelectorAll("button")).filter((b) =>
            b.textContent?.startsWith("View deep dive"),
          )
          if (index) expect(deepDives.length, "deep-dive buttons").toBeGreaterThan(0)
          for (const deepDive of deepDives) {
            await click(deepDive, "View deep dive")
            expect(document.querySelector('[role="dialog"]'), "deep-dive dialog").not.toBeNull()
            snap()
          }
        })
      const fromFull = await render(full)
      expect(fromFull.length).toBeGreaterThan(3)
      expect(await render(slice)).toEqual(fromFull)
      expect(await render(null)).not.toEqual(fromFull)
    },
  )

  it.each(["splitPeers", "metricTabs", "overlaps", "protocol"] as const)(
    "on the histogram embed, for each eval of the %s witness",
    async (branch) => {
      const { BenchmarkDetail, comparisonRouteIdOf } = await import("@/components/benchmark-detail")
      const summary = witnesses[branch]
      const routeId = comparisonRouteIdOf(summary)
      const slice = await table.sliceForModel(routeId)
      for (const evalId of Object.keys(full.by_model?.[routeId] ?? {})) {
        const render = (index: ComparisonIndex | null) =>
          session(
            createElement(BenchmarkDetail, {
              summary,
              evalHierarchy: hierarchy,
              comparisonIndex: index,
              embedSurface: "histogram",
              embedTargetEvalId: evalId,
            }),
            async (snap) => {
              if (index && branch === "protocol" && markers.protocolEvals.includes(evalId)) {
                expect(
                  document.querySelector(`div.font-semibold[title="${summary.model_info.name}"]`),
                  "the protocol witness's own bar",
                ).not.toBeNull()
              }
              await exercisePlots(snap, { embed: true, metricTabs: index ? markers.metricTabs[evalId] : undefined })
            },
          )
        expect(await render(slice), evalId).toEqual(await render(full))
      }
    },
  )

  it("on the reported-metrics embed", async () => {
    const { BenchmarkDetail, comparisonRouteIdOf } = await import("@/components/benchmark-detail")
    const summary = witnesses.overlaps
    const slice = await table.sliceForModel(comparisonRouteIdOf(summary))
    const render = (index: ComparisonIndex | null) =>
      session(
        createElement(BenchmarkDetail, {
          summary,
          evalHierarchy: hierarchy,
          comparisonIndex: index,
          embedSurface: "reported-metrics",
        }),
        async () => {},
      )
    expect(await render(slice)).toEqual(await render(full))
  })
})

describe("BenchmarkSignalsStrip renders the same from the eval slice", () => {
  it.each(["llm-stats%2Fwmdp", "wmdp"])("on the %s page, with each signal dialog open", async (evalId) => {
    const { BenchmarkSignalsStrip, buildCrossSuiteAggregate, crossSuiteSiblingEvalIds } = await import(
      "@/components/signals/benchmark-signals-strip"
    )
    const backend = await import("@/lib/data-backend")
    const { isMergedBenchmarkSummary, mergedSummaryToEvalSummary } = await import("@/lib/merged-adapter")
    let summary: BenchmarkEvalSummary | null
    if (full.evals[evalId].is_merged) {
      const merged = await backend.getMergedBenchmarkSummary(evalId)
      summary = isMergedBenchmarkSummary(merged) ? mergedSummaryToEvalSummary(merged) : null
    } else {
      summary = await backend.getEvalSummaryById(evalId)
    }
    expect(buildCrossSuiteAggregate(summary!, hierarchy, full)).not.toBeNull()
    const slice = await table.sliceForEvals(crossSuiteSiblingEvalIds(summary!, hierarchy))
    for (let tile = 0; tile < 4; tile++) {
      const render = (index: ComparisonIndex | null) =>
        session(
          createElement(BenchmarkSignalsStrip, { summary: summary!, evalHierarchy: hierarchy, comparisonIndex: index }),
          async (snap) => {
            const tileButton = document.querySelectorAll("button")[tile]
            expect(document.querySelector('[role="dialog"]')).toBeNull()
            await click(tileButton, `signal tile ${tile}`)
            const heading = document.querySelector('[role="dialog"] h2')?.textContent ?? ""
            expect(heading, `tile ${tile} dialog`).not.toBe("")
            expect(tileButton.textContent).toContain(heading.split(" · ")[0])
            snap()
          },
        )
      expect(await render(slice), `tile ${tile}`).toEqual(await render(full))
    }
  })
})
