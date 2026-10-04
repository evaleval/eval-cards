import { DuckDBConnection } from "@duckdb/node-api"
import { expect, test, type Browser } from "@playwright/test"

// Frontend correctness e2e — the layer naive "page returns 200" checks miss.
// Opt-in via `SNAPSHOT_URL=<warehouse> pnpm test:e2e`; self-skips otherwise.
// Verifies, against the live server + the snapshot's comparison tables as ground truth:
//  - model/eval/developer pages render (incl. folded-id + encoded-name regressions),
//  - 100% of folded model ids resolve (the raw_model_ids fallback),
//  - comparison charts render real PEER bars (not just the current model), 0 "Unknown Model".
// Full bug taxonomy + known limitations: tests/PREFLIGHT.md.

const BASE = `http://localhost:${process.env.PORT || 3211}`
const SNAPSHOT = (process.env.SNAPSHOT_URL || "").replace(/\/+$/, "")
const SAMPLE = 30
const CHART_MODELS = 16

test.describe.configure({ mode: "serial" })
test.skip(!SNAPSHOT, "set SNAPSHOT_URL to run the frontend preflight e2e")

// Matched case-INSENSITIVELY: the error text renders inside `.kicker`,
// which sets `text-transform: uppercase` (app/globals.css), and innerText
// returns the transformed string ("FAILED TO LOAD MODEL DATA"). With a
// case-sensitive match these never fire, and a page that dies quietly —
// error text, no console error — passes.
const ERROR_MARKERS = [
  "Model not found", "Failed to load model data", "Eval not found",
  "Benchmark not found", "Failed to load", "Application error",
  "Something went wrong", "This page could not be found",
]

// The first-visit onboarding tour (components/quick-start.tsx) overlays the
// page and intercepts pointer events; every Playwright page is a fresh
// profile, so seed its seen-flag before any page script runs. Without this
// the chart test's click into the plots view times out behind the overlay.
const newPreppedPage = async (browser: Browser) => {
  const page = await browser.newPage()
  await page.addInitScript(() => {
    try { localStorage.setItem("eval-cards-onboarding-seen", "1") } catch { /* privacy mode */ }
  })
  return page
}

const enc = (s: unknown) => encodeURIComponent(String(s))
const norm = (s: unknown) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "")
const asArray = (j: any): any[] => Array.isArray(j) ? j
  : (j && typeof j === "object" && ["models", "evals", "developers", "items", "rows", "cards", "data"].map((k) => j[k]).find(Array.isArray)) || []
const sample = <T>(a: T[], n: number): T[] => a.length <= n ? a.slice() : Array.from({ length: n }, (_, i) => a[Math.floor(i * (a.length / n))])
const listItems = (v: any): string[] => Array.isArray(v) ? v.map(String) : Array.isArray(v?.items) ? v.items.map(String) : []
const getJson = async (p: string) => { const r = await fetch(`${BASE}${p}`); return r.ok ? r.json() : null }
const getJsonT = async (p: string, ms = 90_000, tries = 2) => {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`${BASE}${p}`, { signal: AbortSignal.timeout(ms) }); if (r.ok) return r.json() } catch { /* retry */ }
  }
  return null
}
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]) }
  }))
  return out
}

let models: any[] = []
let evals: any[] = []
let devs: any[] = []
let folded: string[] = []
let con: DuckDBConnection

// What a model's comparison slice must contain, read straight from the
// snapshot's comparison tables (never from the endpoint under test, so a slice
// that drops evals or peers cannot shrink its own expectation).
//  - ownEvals: evals the model has a score cell in (the slice's by_model keys).
//  - familyPeers: normalised peer family names over those evals.
//  - peerRoutes: peer route ids over every eval the slice carries rows for
//    (own evals + per-source evals sharing their benchmark_id).
type Expected = { ownEvals: Set<string>; familyPeers: Set<string>; peerRoutes: Set<string> }

const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`

async function expectedFromTables(routeIds: string[]): Promise<Map<string, Expected>> {
  const out = new Map<string, Expected>()
  for (const r of routeIds) out.set(r, { ownEvals: new Set(), familyPeers: new Set(), peerRoutes: new Set() })
  if (routeIds.length === 0) return out
  const t = (name: string) => `read_parquet('${SNAPSHOT}/${name}.parquet')`
  const rows = (await con.runAndReadAll(`
    WITH sampled(route) AS (VALUES ${routeIds.map((r) => `(${sqlStr(r)})`).join(", ")}),
    own AS (
      SELECT DISTINCT route, evaluation_id
      FROM ${t("comparison_scores")} JOIN sampled ON model_route_id = route
    ),
    scope AS (
      SELECT route, evaluation_id, bool_or(own_eval) AS own_eval FROM (
        SELECT route, evaluation_id, true AS own_eval FROM own
        UNION ALL
        SELECT o.route, e.evaluation_id, false
        FROM own o
        JOIN ${t("comparison_evals")} oe ON oe.evaluation_id = o.evaluation_id
        JOIN ${t("comparison_evals")} e ON e.benchmark_id = oe.benchmark_id AND NOT e.is_merged
      ) GROUP BY route, evaluation_id
    ),
    cells AS (
      SELECT sc.route, sc.own_eval, s.model_route_id, s.model_family_name, s.model_family_id
      FROM scope sc
      JOIN ${t("comparison_metrics")} m ON m.evaluation_id = sc.evaluation_id
      JOIN ${t("comparison_scores")} s
        ON s.evaluation_id = m.evaluation_id AND s.metric_summary_id = m.metric_summary_id
      WHERE s.model_route_id IS DISTINCT FROM sc.route
    )
    SELECT route, 'own' AS kind, evaluation_id AS a, NULL AS b FROM own
    UNION ALL
    SELECT DISTINCT route, 'family', model_family_name, model_family_id FROM cells WHERE own_eval
    UNION ALL
    SELECT DISTINCT route, 'route', model_route_id, NULL FROM cells
  `)).getRowObjects()
  for (const r of rows) {
    const e = out.get(String(r.route))!
    if (r.kind === "own") e.ownEvals.add(String(r.a))
    else if (r.kind === "route") e.peerRoutes.add(String(r.a))
    else {
      const n = norm(r.a || r.b)
      if (n) e.familyPeers.add(n)
    }
  }
  return out
}

// The same three sets as seen through /api/comparison-index?model=…
function expectedFromSlice(ci: any, routeId: string): Expected {
  const byModel = ci?.by_model?.[routeId] ?? {}
  const familyPeers = new Set<string>()
  const peerRoutes = new Set<string>()
  for (const [evalId, entry] of Object.entries<any>(ci?.evals ?? {})) {
    for (const metric of (entry?.metrics ?? [])) {
      for (const s of metric.scores) {
        if (s.model_route_id === routeId) continue
        peerRoutes.add(String(s.model_route_id))
        if (!(evalId in byModel)) continue
        const n = norm(s.model_family_name || s.model_family_id)
        if (n) familyPeers.add(n)
      }
    }
  }
  return { ownEvals: new Set(Object.keys(byModel)), familyPeers, peerRoutes }
}

const setDiff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x))

test.beforeAll(async () => {
  models = asArray(await getJson("/api/model-cards-lite"))
  evals = asArray(await getJson("/api/eval-list-lite"))
  devs = asArray(await getJson("/api/developers"))
  expect(models.length, "model-cards-lite empty").toBeGreaterThan(0)

  con = await DuckDBConnection.create()
  await con.run("INSTALL httpfs; LOAD httpfs;")

  // Comparison-index is the chart ground truth — unavailable must be a HARD fail,
  // not a silent skip (else the whole chart layer disables itself).
  const probe = await getJsonT(`/api/comparison-index?model=${enc(enc(models[0].model_id || models[0].id || models[0].model_key))}`)
  expect(probe?.by_model && probe?.evals, "comparison-index unavailable — chart check cannot run").toBeTruthy()

  // Discover folded ids exhaustively from the warehouse (not a tiny stride).
  const rows = (await con.runAndReadAll(
    `SELECT model_id, raw_model_ids FROM read_parquet('${SNAPSHOT}/models_view.parquet') WHERE len(raw_model_ids) > 0`,
  )).getRowObjects()
  const set = new Set<string>()
  for (const r of rows) for (const raw of listItems(r.raw_model_ids)) {
    if (String(raw).toLowerCase() !== String(r.model_id).toLowerCase()) set.add(String(raw))
  }
  folded = [...set]
  expect(folded.length, "folded-id regression set empty — discovery/data path changed").toBeGreaterThan(0)
})

test("100% of folded model ids resolve (raw_model_ids fallback)", async () => {
  const statuses = await mapLimit(folded, 12, async (raw) => {
    const r = await fetch(`${BASE}/api/model-summary?id=${enc(raw)}`, { signal: AbortSignal.timeout(30_000) }).catch(() => null)
    return { raw, status: r ? r.status : 0 }
  })
  const bad = statuses.filter((s) => s.status !== 200).map((s) => s.raw)
  expect(bad, `${bad.length}/${folded.length} folded ids do not resolve: ${bad.slice(0, 8)}`).toEqual([])
})

test("model / eval / developer pages render (incl. regression sets)", async ({ browser }) => {
  const seen = new Set<string>()
  const targets: { cls: string; url: string }[] = []
  const add = (cls: string, url: string) => { if (url && !seen.has(url)) { seen.add(url); targets.push({ cls, url }) } }

  for (const m of sample(models, SAMPLE)) add("model", `/models/${enc(m.model_id || m.id || m.model_key)}`)
  for (const raw of sample(folded, 25)) add("model(folded)", `/models/${enc(raw)}`)
  for (const e of sample(evals, SAMPLE)) { const id = e.evaluation_id || e.id || e.benchmark_id; if (id) add("eval", `/evals/${String(id).replace(/%2F/g, "/")}`) }
  const devUrl = (rid: string) => `/developers/${String(rid).replace(/%2F/g, "/")}`
  const encodedDevs = devs.filter((d) => /[^A-Za-z0-9._/-]/.test(String(d.developer || "")) || /%(?!2F)/i.test(String(d.route_id || "")))
  expect(encodedDevs.length, "encoded-developer regression set empty — data path changed").toBeGreaterThan(0)
  for (const d of encodedDevs) if (d.route_id) add("developer(encoded)", devUrl(d.route_id))
  for (const d of sample(devs, 20)) if (d.route_id) add("developer", devUrl(d.route_id))

  const results = await mapLimit(targets, 6, async (t) => {
    const page = await newPreppedPage(browser)
    const errs: string[] = []
    page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 120)) })
    page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)))
    let status = 0
    try { const r = await page.goto(`${BASE}${t.url}`, { waitUntil: "networkidle", timeout: 45_000 }); status = r ? r.status() : 0; await page.waitForTimeout(700) }
    catch (e) { errs.push(`goto: ${String(e).slice(0, 120)}`) }
    const text = await page.evaluate(() => document.body?.innerText || "").catch(() => "")
    const haystack = text.toLowerCase()
  const marker = ERROR_MARKERS.find((m) => haystack.includes(m.toLowerCase()))
    await page.close()
    return (!(status > 0 && status < 400) || marker || errs.length)
      ? `${t.url} [${status}]${marker ? ` "${marker}"` : ""}${errs.length ? ` ${JSON.stringify(errs.slice(0, 2))}` : ""}`
      : null
  })
  const broken = results.filter(Boolean) as string[]
  expect(broken, `${broken.length} broken pages:\n  ${broken.slice(0, 15).join("\n  ")}`).toEqual([])
})

test("comparison charts render real peer bars (not only the current model)", async ({ browser }) => {
  const sampled = sample(models, CHART_MODELS).map((m) => enc(m.model_id || m.id || m.model_key))
  const expectedByRoute = await expectedFromTables(sampled)

  // The served slice must carry exactly what the tables say: same own evals,
  // same peer families, same peer route ids.
  const sliceProblems = (await mapLimit(sampled, 6, async (routeId) => {
    const want = expectedByRoute.get(routeId)!
    const ci = await getJsonT(`/api/comparison-index?model=${enc(routeId)}`)
    if (!ci?.evals) return [`${routeId}: slice unavailable`]
    const got = expectedFromSlice(ci, routeId)
    const out: string[] = []
    for (const [k, label] of [["ownEvals", "own evals"], ["familyPeers", "peer families"], ["peerRoutes", "peer routes"]] as const) {
      const missing = setDiff(want[k], got[k])
      const extra = setDiff(got[k], want[k])
      if (missing.length || extra.length) {
        out.push(`${routeId}: ${label} differ from tables (missing ${missing.length} ${JSON.stringify(missing.slice(0, 3))}, extra ${extra.length} ${JSON.stringify(extra.slice(0, 3))})`)
      }
    }
    return out
  })).flat()
  expect(sliceProblems, `comparison slices disagree with the snapshot tables:\n  ${sliceProblems.slice(0, 15).join("\n  ")}`).toEqual([])

  const candidates = sampled.filter((routeId) => expectedByRoute.get(routeId)!.familyPeers.size > 0)
  const per = await mapLimit(candidates, 6, async (routeId) => {
    const want = expectedByRoute.get(routeId)!
    const expected = [...want.familyPeers]
    const page = await newPreppedPage(browser)
    const problems: string[] = []
    let bars: { id: string | null; cur: boolean }[] = []
    try {
      await page.goto(`${BASE}/models/${routeId}`, { waitUntil: "networkidle", timeout: 45_000 })
      await page.waitForTimeout(1000)
      // The researcher view defaults to the Scores TABLE; the comparison
      // plotboxes render only in the plots views. A page expected to have
      // peers but missing the toggle is itself a failure.
      const plotsToggle = page.getByRole("button", { name: "Plots by source" }).first()
      const toggled = await plotsToggle.click({ timeout: 10_000 }).then(() => true).catch(() => false)
      if (!toggled) problems.push(`${routeId}: "Plots by source" toggle not found/clickable — charts unreachable`)
      await page.waitForTimeout(1200)
      const unknown = ((await page.evaluate(() => document.body?.innerText || "")).match(/Unknown Model/g) || []).length
      bars = await page.$$eval("[data-model-bar]", (els) =>
        els.map((e) => ({ id: e.getAttribute("data-model-bar"), cur: e.getAttribute("data-bar-current") === "1" })))
      const peerBars = bars.filter((b) => !b.cur)
      const currentBars = bars.length - peerBars.length
      // MULTIPLE charts rendered but NONE show a peer bar => the only-current-model bug.
      if (currentBars >= 2 && peerBars.length === 0) problems.push(`${routeId}: ${expected.length} peers in index but 0 peer bars`)
      if (peerBars.some((b) => b.id === routeId)) problems.push(`${routeId}: current model rendered as its own peer (double-count)`)
      const strays = [...new Set(peerBars.map((b) => String(b.id)).filter((id) => id !== routeId && !want.peerRoutes.has(id)))]
      if (strays.length) problems.push(`${routeId}: ${strays.length} peer bars not in the snapshot tables ${JSON.stringify(strays.slice(0, 3))}`)
      if (unknown > 0) problems.push(`${routeId}: ${unknown} "Unknown Model" labels`)
    } catch (e) { problems.push(`${routeId}: ${String(e).slice(0, 80)}`) }
    await page.close()
    return { bars: bars.length, problems }
  })
  const charted = candidates.length
  const totalBars = per.reduce((n, r) => n + r.bars, 0)
  const broken = per.flatMap((r) => r.problems)
  expect(charted, "no sampled model had expected peers — chart check was vacuous").toBeGreaterThan(0)
  // Suite-wide: peers expected but NO bars anywhere => the data-model-bar hook was
  // dropped or charts don't render — the chart check silently disabled itself.
  expect(totalBars, "0 chart bars across charted pages — data-model-bar hook missing or charts broken").toBeGreaterThan(0)
  expect(broken, `chart problems:\n  ${broken.slice(0, 15).join("\n  ")}`).toEqual([])
})
