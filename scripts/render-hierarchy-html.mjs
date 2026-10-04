#!/usr/bin/env node
// Emit a single-file HTML viewer for the cleaned hierarchy.json.
//
// Usage:
//   node scripts/render-hierarchy-html.mjs [path/to/hierarchy.json] [out.html]
//
// Defaults:
//   in  = .cache/hf-data/warehouse/latest/hierarchy.json
//   out = output/hierarchy_explorer.html
//
// The viewer mirrors the family > composite > benchmark > slice > metric
// shape produced by build_hierarchy_v2.py (and the warehouse pipeline),
// after running through `lib/clean-hierarchy.ts`'s consolidation pass so
// what you see matches what the model-detail page renders.

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { register } from "node:module"

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

// We need cleanHierarchy from a TS source; spawn `tsx` if available, else
// fall back to dynamic import via the registered loader. Simpler: shell out
// to `tsx` once and read the result back through stdout. To avoid that
// dependency, re-implement the minimum in JS — but cleanHierarchy is
// non-trivial. Easiest path: run via tsx if present, else fall back to
// untouched hierarchy with a banner.
async function loadCleanHierarchy() {
  try {
    // Use tsx-loader. `node --import tsx` is the common pattern, but here we
    // just dynamically import the .ts file under tsx's hooks if invoked via
    // `tsx` (the user can also run via plain `node` and we'll skip cleaning).
    const url = pathToFileURL(path.join(ROOT, "lib/clean-hierarchy.ts")).href
    const mod = await import(url)
    return mod.cleanHierarchy
  } catch {
    return null
  }
}

const inPath = process.argv[2] ?? path.join(ROOT, ".cache/hf-data/warehouse/latest/hierarchy.json")
const outPath = process.argv[3] ?? path.join(ROOT, "output/hierarchy_explorer.html")

if (!fs.existsSync(inPath)) {
  console.error(`hierarchy.json not found at ${inPath}`)
  process.exit(1)
}

const raw = JSON.parse(fs.readFileSync(inPath, "utf8"))

// Try to read the comparison tables from the same snapshot dir so the
// cleaner can do score-equality-based aggregator dedup (llm-stats vs
// canonical sources). The cleaner needs each eval's metrics in order and
// each score row's model and score.
let comparisonIndex = null
const tablePath = (name) => path.join(path.dirname(inPath), `${name}.parquet`)
const comparisonTables = ["comparison_evals", "comparison_metrics", "comparison_scores"]
if (comparisonTables.every((name) => fs.existsSync(tablePath(name)))) {
  try {
    const { DuckDBConnection } = await import("@duckdb/node-api")
    const connection = await DuckDBConnection.create()
    const read = async (sql) => (await connection.runAndReadAll(sql)).getRowObjectsJS()
    const source = (name) => `read_parquet('${tablePath(name).replace(/'/g, "''")}')`
    const evals = {}
    for (const row of await read(`SELECT evaluation_id FROM ${source("comparison_evals")} ORDER BY evaluation_id`)) {
      evals[row.evaluation_id] = { metrics: [] }
    }
    const metrics = new Map()
    for (const row of await read(
      `SELECT evaluation_id, metric_summary_id, metric_name FROM ${source("comparison_metrics")} ORDER BY evaluation_id, metric_ord`,
    )) {
      const metric = { metric_summary_id: row.metric_summary_id, metric_name: row.metric_name, scores: [] }
      evals[row.evaluation_id]?.metrics.push(metric)
      metrics.set(`${row.evaluation_id}|${row.metric_summary_id}`, metric)
    }
    for (const row of await read(
      `SELECT evaluation_id, metric_summary_id, model_route_id, score FROM ${source("comparison_scores")}
       ORDER BY evaluation_id, metric_summary_id, row_ord`,
    )) {
      metrics.get(`${row.evaluation_id}|${row.metric_summary_id}`)?.scores.push({
        model_route_id: row.model_route_id,
        score: row.score,
      })
    }
    comparisonIndex = { evals }
  } catch (err) {
    console.error(`comparison tables unreadable: ${err.message ?? err}`)
  }
}

let cleaned = raw
let cleanerStatus = "skipped — run via tsx to apply lib/clean-hierarchy.ts"
const cleanFn = await loadCleanHierarchy()
if (cleanFn) {
  try {
    cleaned = cleanFn(structuredClone(raw), comparisonIndex)
    cleanerStatus = comparisonIndex
      ? "applied lib/clean-hierarchy.ts (with comparison tables)"
      : "applied lib/clean-hierarchy.ts (without comparison tables — score dedup skipped)"
  } catch (err) {
    cleanerStatus = `cleaner threw: ${err.message ?? err}`
  }
}
if (process.env.HIERARCHY_DEBUG) {
  const focus = ["big-bench","big-bench-hard","mmlu-pro","mmlu-pro-leaderboard","apex-v1","apex-agents","math-mc","mt-bench","gsm-mc"]
  for (const fam of cleaned.families ?? []) {
    if (!focus.includes(fam.key)) continue
    console.error("---", fam.display_name, "(" + fam.key + ")", "---")
    for (const c of fam.composites||[]) console.error("  composite", c.key, c.benchmarks?.map(b=>b.key))
    for (const b of fam.standalone_benchmarks||[]) console.error("  standalone", b.key, "splits:", (b.slices||[]).length)
    for (const b of fam.benchmarks||[]) console.error("  direct", b.key, "splits:", (b.slices||[]).length)
  }
}

const families = cleaned.families ?? []
const benchmarkIndex = cleaned.benchmark_index ?? []
const stats = cleaned.stats ?? {}

function flattenBenchmarks(family) {
  const out = []
  for (const b of family.benchmarks ?? []) out.push({ ...b, _scope: "family" })
  for (const b of family.standalone_benchmarks ?? []) out.push({ ...b, _scope: "standalone" })
  for (const c of family.composites ?? []) {
    for (const b of c.benchmarks ?? []) out.push({ ...b, _scope: "composite", _compositeKey: c.key, _compositeName: c.display_name })
  }
  return out
}

const totalBenchmarks = families.reduce((sum, f) => sum + flattenBenchmarks(f).length, 0)
const overlapsCount = benchmarkIndex.length

// Pre-compute per-family overlap appearances so the family panel can show
// "appears in X of this family's benchmarks" without scanning the entire
// index per render.
const overlapsByFamily = new Map()
for (const entry of benchmarkIndex) {
  for (const app of entry.appearances ?? []) {
    const list = overlapsByFamily.get(app.family_key) ?? []
    list.push({ canonicalKey: entry.key, canonicalDisplayName: entry.display_name, ...app })
    overlapsByFamily.set(app.family_key, list)
  }
}

const payload = {
  cleanerStatus,
  generatedAt: cleaned.generated_at ?? null,
  schemaVersion: cleaned.schema_version ?? null,
  stats: {
    families: families.length,
    benchmarks: totalBenchmarks,
    overlaps: overlapsCount,
    ...stats,
  },
  families,
  benchmarkIndex,
  overlapsByFamily: Array.from(overlapsByFamily.entries()),
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Hierarchy explorer · cleaned</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --fg: #111;
    --fg-muted: #444;
    --fg-subtle: #888;
    --bg: #fff;
    --bg-warm: #f7f5f2;
    --border-soft: #e5e2dc;
    --border-strong: #1a1a1a;
    --accent: #c2410c;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg: #f5f4f1;
      --fg-muted: #c8c4be;
      --fg-subtle: #888884;
      --bg: #15140f;
      --bg-warm: #1d1c17;
      --border-soft: #2a2924;
      --border-strong: #f5f4f1;
      --accent: #ff6b35;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  header { padding: 24px 32px; border-bottom: 1px solid var(--border-soft); }
  header h1 { margin: 0 0 6px; font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
  header .meta { color: var(--fg-subtle); font: 11px/1.6 ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace; text-transform: uppercase; letter-spacing: 0.12em; }
  header .stats { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 16px; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header .stats span { color: var(--fg-muted); }
  header .stats b { color: var(--fg); font-weight: 600; margin-right: 4px; }
  .toolbar { padding: 12px 32px; border-bottom: 1px solid var(--border-soft); display: flex; flex-wrap: wrap; gap: 12px; align-items: center; background: var(--bg-warm); position: sticky; top: 0; z-index: 5; }
  .toolbar input[type="text"] { font: 13px ui-sans-serif, system-ui, sans-serif; padding: 6px 10px; border: 1px solid var(--border-soft); background: var(--bg); color: var(--fg); width: 280px; }
  .toolbar select { font: 12px ui-sans-serif, system-ui, sans-serif; padding: 6px 8px; border: 1px solid var(--border-soft); background: var(--bg); color: var(--fg); }
  .toolbar button { font: 11px ui-monospace, Menlo, monospace; text-transform: uppercase; letter-spacing: 0.1em; padding: 6px 10px; border: 1px solid var(--border-soft); background: var(--bg); color: var(--fg); cursor: pointer; }
  .toolbar button:hover { border-color: var(--border-strong); }
  .toolbar .grow { flex: 1; }
  .toolbar .count { font: 11px ui-monospace, Menlo, monospace; color: var(--fg-subtle); text-transform: uppercase; letter-spacing: 0.1em; }
  main { padding: 0 32px 64px; }
  .tab-bar { display: flex; gap: 0; border-bottom: 1px solid var(--border-soft); margin-bottom: 16px; }
  .tab-bar button { font: 11px ui-monospace, Menlo, monospace; text-transform: uppercase; letter-spacing: 0.1em; padding: 12px 16px; border: none; background: transparent; color: var(--fg-subtle); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tab-bar button.on { color: var(--fg); border-bottom-color: var(--accent); }
  details { border-bottom: 1px solid var(--border-soft); padding: 6px 0; }
  details > summary { list-style: none; cursor: pointer; padding: 6px 0; user-select: none; }
  details > summary::-webkit-details-marker { display: none; }
  details > summary:hover { background: var(--bg-warm); }
  .fam { padding: 8px 0; }
  .fam-head { display: flex; align-items: baseline; gap: 12px; }
  .fam-head .name { font-weight: 600; font-size: 14px; }
  .fam-head .key { font: 10px ui-monospace, Menlo, monospace; color: var(--fg-subtle); text-transform: uppercase; letter-spacing: 0.1em; }
  .fam-head .badges { margin-left: auto; display: flex; gap: 8px; align-items: baseline; }
  .badge { font: 10px ui-monospace, Menlo, monospace; padding: 2px 6px; border: 1px solid var(--border-soft); color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.08em; }
  .badge.cat { color: var(--accent); border-color: var(--accent); }
  .badge.size { color: var(--fg-subtle); }
  .badge.level { color: var(--bg); background: var(--fg); border-color: var(--fg); font-weight: 600; }
  .badge.level.slice-tag { background: var(--fg-muted); border-color: var(--fg-muted); margin-right: 6px; }
  .pill-level { font-size: 8px; opacity: 0.6; margin-right: 4px; padding: 1px 3px; background: var(--fg); color: var(--bg); }
  .indent { padding-left: 24px; }
  .composite { margin: 6px 0; padding: 6px 0 6px 0; border-left: 2px solid var(--border-soft); }
  .composite-head { display: flex; align-items: baseline; gap: 10px; padding: 4px 0 4px 8px; cursor: pointer; }
  .composite-head:hover { background: var(--bg-warm); }
  .composite-head .name { font-weight: 600; font-size: 12.5px; }
  .composite-head .key { font: 10px ui-monospace, Menlo, monospace; color: var(--fg-subtle); }
  .bench { margin: 4px 0; padding: 4px 8px; border-left: 1px dashed var(--border-soft); }
  .bench-head { display: flex; align-items: baseline; gap: 10px; cursor: pointer; }
  .bench-head .name { font-weight: 500; font-size: 12.5px; }
  .bench-head .key { font: 10px ui-monospace, Menlo, monospace; color: var(--fg-subtle); }
  .bench-head .star { color: var(--accent); }
  .bench-detail { margin-top: 6px; padding: 8px 12px; background: var(--bg-warm); font-size: 12px; }
  .bench-detail dl { margin: 0; display: grid; grid-template-columns: 130px 1fr; gap: 4px 12px; }
  .bench-detail dt { color: var(--fg-subtle); font: 10px ui-monospace, Menlo, monospace; text-transform: uppercase; letter-spacing: 0.1em; }
  .bench-detail dd { margin: 0; }
  .slice-list { list-style: none; padding: 0; margin: 6px 0 0; }
  .slice-list li { padding: 3px 0; border-top: 1px dashed var(--border-soft); font-size: 12px; }
  .slice-list li:first-child { border-top: none; }
  .slice-list .slice-name { color: var(--fg); font-weight: 500; }
  .slice-list .slice-key { color: var(--fg-subtle); font: 10px ui-monospace, Menlo, monospace; margin-left: 8px; }
  .metric-pill { display: inline-block; font: 10px ui-monospace, Menlo, monospace; padding: 1px 6px; border: 1px solid var(--border-soft); margin: 1px 3px 1px 0; color: var(--fg-muted); }
  .metric-pill.primary { color: var(--accent); border-color: var(--accent); }
  .tag-pill { display: inline-block; font: 10px ui-monospace, Menlo, monospace; padding: 1px 5px; background: var(--bg-warm); margin: 1px 3px 1px 0; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .overlap-row { display: grid; grid-template-columns: minmax(0, 2fr) 60px minmax(0, 3fr); gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border-soft); align-items: baseline; }
  .overlap-row .canonical-name { font-weight: 600; font-size: 13px; }
  .overlap-row .canonical-key { font: 10px ui-monospace, Menlo, monospace; color: var(--fg-subtle); }
  .overlap-row .n { text-align: center; font: 12px ui-monospace, Menlo, monospace; color: var(--fg-muted); }
  .overlap-row .apps { display: flex; flex-wrap: wrap; gap: 4px 8px; font-size: 11px; }
  .overlap-row .apps span { padding: 2px 6px; border: 1px solid var(--border-soft); }
  .overlap-row .apps b { color: var(--accent); font-weight: 600; margin-right: 4px; }
  .empty { padding: 32px; text-align: center; color: var(--fg-subtle); font: 11px ui-monospace, Menlo, monospace; text-transform: uppercase; letter-spacing: 0.15em; }
  .hidden { display: none; }
  .pane { display: none; }
  .pane.on { display: block; }
</style>
</head>
<body>
<header>
  <h1>Hierarchy explorer</h1>
  <div class="meta" id="meta"></div>
  <div class="stats" id="stats"></div>
</header>
<div class="toolbar">
  <input type="text" id="search" placeholder="Search families, composites, benchmarks, splits, tags…" autocomplete="off">
  <select id="categoryFilter"><option value="">All categories</option></select>
  <button id="expandAll" type="button">Expand all</button>
  <button id="collapseAll" type="button">Collapse all</button>
  <span class="grow"></span>
  <span class="count" id="resultCount"></span>
</div>
<main>
  <div class="tab-bar">
    <button data-tab="hierarchy" class="on" type="button">Hierarchy</button>
    <button data-tab="overlaps" type="button">Cross-suite overlaps (${overlapsCount})</button>
  </div>
  <div class="pane on" id="pane-hierarchy"></div>
  <div class="pane" id="pane-overlaps"></div>
</main>
<script>
const DATA = ${JSON.stringify(payload).replace(/</g, "\\u003c")};

const meta = document.getElementById("meta");
meta.textContent = [
  DATA.schemaVersion ? "schema=" + DATA.schemaVersion : null,
  DATA.generatedAt ? "generated=" + new Date(DATA.generatedAt).toISOString().slice(0, 19) : null,
  "cleaner: " + DATA.cleanerStatus,
].filter(Boolean).join(" · ");

const statsEl = document.getElementById("stats");
const statRows = [
  ["Families", DATA.stats.families],
  ["Benchmarks", DATA.stats.benchmarks],
  ["Cross-suite overlaps", DATA.stats.overlaps],
  ["Composites", DATA.stats.composite_count],
  ["Splits", DATA.stats.slice_count],
  ["Metrics", DATA.stats.metric_count],
].filter(([, v]) => v != null);
statsEl.innerHTML = statRows.map(([k, v]) => "<span><b>" + v + "</b>" + k + "</span>").join("");

// Categories on a parent (family / composite) are the simple union of its
// children's curated tags. cleanHierarchy already does this union via
// decorateHierarchyDerivedTags, so reading derivedTags directly gives us
// the full set. Fall back to the legacy category field only when the
// node has no derivedTags at all.
function nodeCategories(node) {
  if (Array.isArray(node?.derivedTags) && node.derivedTags.length > 0) {
    return node.derivedTags.slice();
  }
  return node?.category ? [node.category] : [];
}

// Populate category filter with the union across every family.
const categories = Array.from(
  new Set(DATA.families.flatMap(nodeCategories))
).filter(Boolean).sort();
const catSelect = document.getElementById("categoryFilter");
for (const cat of categories) {
  const opt = document.createElement("option");
  opt.value = cat;
  opt.textContent = cat;
  catSelect.appendChild(opt);
}

// Acronyms preserved verbatim in upper-case when prettifying slugs.
const ACRONYMS = new Set([
  "AI","API","ARC","BBH","BFCL","CTF","CVE","CYSE","ELO","GAIA","GPQA","GSM",
  "HELM","HF","HLE","IFEVAL","IMO","JSON","LLM","ML","MMLU","MMMU","MT",
  "OPENAI","RLHF","SWE","TAU","USACO","VQA","WASP","CSV","API","SQL",
  "AIME","GSM8K","BOOLQ","HRM","MCP","MQA","XML","CV","PDF",
]);

// Title-case a single word/segment, preserving known acronyms in caps.
function prettifySegment(seg) {
  if (!seg) return seg;
  const upper = seg.toUpperCase();
  if (ACRONYMS.has(upper)) return upper;
  if (/^v\\d+(?:\\.\\d+)?$/i.test(seg)) return seg.toLowerCase();
  if (/^\\d/.test(seg)) return seg;
  // Already mixed-case (probably a CamelCase or Acronym + suffix) — keep
  // verbatim. e.g. "APEX" stays "APEX", "iOS" stays "iOS".
  if (seg !== seg.toLowerCase()) return seg;
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

function titleCase(s) {
  if (!s) return "";
  // Split on whitespace, underscores, hyphens, AND slashes so path-like
  // slice names ("livebench/coding/coding_completion") flatten to
  // "Livebench Coding Coding Completion". Em-dashes / en-dashes are
  // preserved as visible separators (warehouse already uses " — "
  // between benchmark and slice in some display names).
  return String(s)
    .trim()
    .split(/[\\s_/-]+/)
    .filter(Boolean)
    .map((tok) => (tok === "—" || tok === "–" ? "—" : prettifySegment(tok)))
    .join(" ");
}

function prettifyKey(key) { return titleCase(key); }

// Pick the best human name for a node. Title-cases everything to a
// uniform "Words With Spaces" form. Falls back to the prettified key
// when the upstream display_name leaked from another row (e.g. gsm-mc
// once arrived labelled with WASP's name) — detected by zero token
// overlap with the key. Trailing contributor handles in parens are
// stripped.
function cleanDisplayName(name, key) {
  const hasTokenOverlap = (a, b) => {
    if (!a || !b) return false;
    const tokens = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]+/g) || []);
    const at = tokens(a), bt = tokens(b);
    for (const t of at) if (t.length >= 2 && bt.has(t)) return true;
    return false;
  };
  let candidate = name && String(name).trim();
  if (!candidate || (key && !hasTokenOverlap(candidate, key))) {
    candidate = key || "";
  }
  candidate = String(candidate || "")
    .replace(/\\s*\\(([A-Za-z][A-Za-z0-9_-]*)\\)\\s*$/u, (_, tok) => {
      if (/\\s/.test(tok)) return " (" + tok + ")";
      if (/[0-9]/.test(tok)) return " (" + tok + ")";
      if (tok === tok.toUpperCase() && tok.length <= 6) return " (" + tok + ")";
      return "";
    })
    .trim();
  return titleCase(candidate);
}

function isMeaningfulTag(t) {
  if (!t) return false;
  const norm = String(t).trim().toLowerCase();
  return norm.length > 0 && norm !== "not specified" && norm !== "n/a" && norm !== "unknown";
}

function tagBlock(tags) {
  if (!tags) return "";
  const out = [];
  for (const k of ["domains", "languages", "tasks"]) {
    const xs = (tags[k] || []).filter(isMeaningfulTag);
    for (const x of xs) out.push('<span class="tag-pill">' + escapeHtml(x) + "</span>");
  }
  if (Array.isArray(tags.derivedTags)) {
    for (const x of tags.derivedTags.filter(isMeaningfulTag)) {
      out.push('<span class="tag-pill" style="background:var(--accent);color:white">' + escapeHtml(x) + "</span>");
    }
  }
  return out.join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function renderBench(b, level, parentFamily) {
  // Schema: a benchmark carries slices[], each slice has key,
  // display_name, is_bare_stem, metrics[]. Metrics use key and
  // display_name. The "root" slice is the one with is_bare_stem true
  // (its metrics live at benchmark scope rather than under a sub-slice).
  const slices = b.slices || [];
  const sliceName = (s) => s.display_name ?? s.slice_name ?? s.key ?? s.slice_key;
  const sliceKey = (s) => s.key ?? s.slice_key;
  const metricName = (m) => m.display_name ?? m.metric_name ?? m.key ?? m.metric_key;
  const metricKey = (m) => m.key ?? m.metric_key;
  const metricLowerBetter = (m) => m.lower_is_better === true;
  const isMetric = (m) => m && (metricName(m) || metricKey(m))
  // Normalise slice/family/benchmark keys to a canonical form so a slice
  // labelled "vals ai aime" matches the synthesised "vals-ai aime"
  // family+benchmark concatenation.
  const norm = (s) => String(s || "").toLowerCase().replace(/[_\\s/-]+/g, " ").trim();
  const isRolledUpSlice = (s) => {
    if (s.is_bare_stem === true) return true;
    if (s.slice_key == null && s.is_bare_stem !== false) return true;
    const k = norm(sliceKey(s));
    if (!k) return false;
    if (k === norm(b.key)) return true;
    if (parentFamily && k === norm(parentFamily.key + " " + b.key)) return true;
    if (parentFamily && k === norm(parentFamily.key)) return true;
    return false;
  };
  const root = slices.find(isRolledUpSlice) ?? null;
  const sliceItems = slices.filter(s => s !== root);
  const metricsRaw = (root?.metrics ?? b.metrics ?? []);
  const metrics = metricsRaw.filter(isMetric);
  const primaryMetricKey = b.primary_metric_key;
  const evalIds = b.summary_eval_ids || [];
  const benchCats = nodeCategories(b);
  const benchName = cleanDisplayName(b.display_name, b.key);
  // level is one of: "benchmark" (under composite), "standalone", "single"
  // (sole benchmark in a family with no composite), "slice-promoted".
  const levelLabel = level || "benchmark";

  return \`
  <details class="bench">
    <summary class="bench-head">
      <span class="star">\${b.is_overall ? "★" : "·"}</span>
      <span class="name">\${escapeHtml(benchName)}</span>
      <span class="key">\${escapeHtml(b.key)}</span>
      <span class="badges">
        <span class="badge level">\${escapeHtml(levelLabel)}</span>
        \${benchCats.map(c => \`<span class="badge cat">\${escapeHtml(c)}</span>\`).join("")}
        \${b.is_primary ? '<span class="badge cat">primary</span>' : ""}
        <span class="badge size">\${slices.length} slice\${slices.length === 1 ? "" : "s"}</span>
        <span class="badge size">\${metrics.length} metric\${metrics.length === 1 ? "" : "s"}</span>
      </span>
    </summary>
    <div class="bench-detail">
      <dl>
        \${b.family_id ? \`<dt>Family ID</dt><dd>\${escapeHtml(b.family_id)}</dd>\` : ""}
        \${b.has_card != null ? \`<dt>Has card</dt><dd>\${b.has_card ? "yes" : "no"}</dd>\` : ""}
        \${primaryMetricKey ? \`<dt>Primary metric</dt><dd>\${escapeHtml(primaryMetricKey)}</dd>\` : ""}
        \${evalIds.length ? \`<dt>Eval summary IDs</dt><dd style="font:10px ui-monospace,Menlo,monospace;color:var(--fg-muted);word-break:break-all;">\${evalIds.map(escapeHtml).join("<br>")}</dd>\` : ""}
      </dl>
      \${metrics.length ? \`<div style="margin-top:6px"><b style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--fg-subtle);font-weight:600">Metrics (root scope)</b><br>\${metrics.map(m => \`<span class="metric-pill \${metricKey(m) === primaryMetricKey ? "primary" : ""}" title="metric · \${escapeHtml(metricName(m) || metricKey(m) || "")}\${metricLowerBetter(m) ? " · lower is better" : ""}"><span class="pill-level">metric</span>\${escapeHtml(metricName(m) || metricKey(m) || "—")}</span>\`).join("")}</div>\` : ""}
      \${sliceItems.length ? \`<div style="margin-top:8px"><b style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--fg-subtle);font-weight:600">Splits</b><ul class="slice-list">\${sliceItems.map(s => \`<li><span class="badge level slice-tag">split</span><span class="slice-name">\${escapeHtml(cleanDisplayName(sliceName(s), sliceKey(s)) || "—")}</span><span class="slice-key">\${escapeHtml(sliceKey(s) || "")}</span> \${(s.metrics||[]).filter(isMetric).map(m => \`<span class="metric-pill" title="metric · \${escapeHtml(metricName(m) || metricKey(m) || "")}"><span class="pill-level">metric</span>\${escapeHtml(metricName(m) || metricKey(m) || "—")}</span>\`).join("")}</li>\`).join("")}</ul></div>\` : ""}
    </div>
  </details>\`;
}

function categoryBadges(node) {
  const cats = nodeCategories(node);
  if (!cats.length) return "";
  return cats.map(c => \`<span class="badge cat">\${escapeHtml(c)}</span>\`).join("");
}

function renderComposite(c, parentFamily) {
  return \`
  <details class="composite" open>
    <summary class="composite-head">
      <span class="badge level">composite</span>
      <span class="name">\${escapeHtml(cleanDisplayName(c.display_name, c.key))}</span>
      <span class="key">\${escapeHtml(c.key)}</span>
      <span class="badges" style="margin-left:auto">
        \${categoryBadges(c)}
        <span class="badge size">\${(c.benchmarks||[]).length} bench\${(c.benchmarks||[]).length === 1 ? "" : "s"}</span>
      </span>
    </summary>
    <div class="indent">
      \${[...(c.benchmarks||[])].sort((a,b) => (a.display_name||a.key||"").toLowerCase().localeCompare((b.display_name||b.key||"").toLowerCase())).map(b => renderBench(b, "benchmark", parentFamily)).join("")}
    </div>
  </details>\`;
}

function renderFamily(f) {
  const byName = (a, b) => (a.display_name || a.key || "").toLowerCase().localeCompare((b.display_name || b.key || "").toLowerCase());
  const compositesHtml = [...(f.composites||[])].sort(byName).map(c => renderComposite(c, f)).join("");
  // Family-direct children. "standalone" = the family carries a single
  // overall benchmark (family.standalone_benchmarks). "single" = the
  // family's only direct child is a lone benchmark (no composite). "direct"
  // = family carries multiple direct benchmarks (no composite wrapper).
  const standalonesHtml = [...(f.standalone_benchmarks||[])].sort(byName).map(b => renderBench(b, "standalone", f)).join("");
  const totalDirect = (f.benchmarks||[]).length + (f.composites||[]).length + (f.standalone_benchmarks||[]).length;
  const directLevel = totalDirect === 1 ? "single benchmark" : "benchmark";
  const directHtml = [...(f.benchmarks||[])].sort(byName).map(b => renderBench(b, directLevel, f)).join("");
  const benchmarkCount = flattenLen(f);
  const cats = nodeCategories(f);
  return \`
  <details class="fam" data-key="\${escapeHtml(f.key)}" data-categories="\${escapeHtml(cats.join("|"))}" data-search="\${escapeHtml(searchableText(f))}">
    <summary class="fam-head">
      <span class="badge level">family</span>
      <span class="name">\${escapeHtml(cleanDisplayName(f.display_name, f.key))}</span>
      <span class="key">\${escapeHtml(f.key)}</span>
      <span class="badges">
        \${categoryBadges(f)}
        <span class="badge size">\${benchmarkCount} bench\${benchmarkCount === 1 ? "" : "s"}</span>
        <span class="badge size">\${(f.eval_summary_ids||[]).length} eval ids</span>
      </span>
    </summary>
    <div class="indent">
      \${compositesHtml}
      \${standalonesHtml}
      \${directHtml}
    </div>
  </details>\`;
}

function flattenLen(f) {
  return (f.benchmarks||[]).length
    + (f.standalone_benchmarks||[]).length
    + (f.composites||[]).reduce((s, c) => s + (c.benchmarks||[]).length, 0);
}

function searchableText(f) {
  const parts = [f.key, f.display_name, f.category];
  for (const c of f.composites || []) {
    parts.push(c.key, c.display_name);
    for (const b of c.benchmarks || []) parts.push(b.key, b.display_name);
  }
  for (const b of f.standalone_benchmarks || []) parts.push(b.key, b.display_name);
  for (const b of f.benchmarks || []) parts.push(b.key, b.display_name);
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function renderHierarchy() {
  const pane = document.getElementById("pane-hierarchy");
  // Alphabetical sort by *cleaned* display name (case-insensitive) so
  // the reader can audit one by one.
  const sortedFamilies = [...DATA.families].sort((a, b) => {
    const an = cleanDisplayName(a.display_name, a.key).toLowerCase();
    const bn = cleanDisplayName(b.display_name, b.key).toLowerCase();
    return an.localeCompare(bn);
  });
  pane.innerHTML = sortedFamilies.map(renderFamily).join("");
}

function renderOverlaps() {
  const pane = document.getElementById("pane-overlaps");
  if (DATA.benchmarkIndex.length === 0) {
    pane.innerHTML = '<div class="empty">No cross-suite overlaps detected</div>';
    return;
  }
  pane.innerHTML = DATA.benchmarkIndex.map(entry => {
    const apps = (entry.appearances || []).map(a =>
      \`<span><b>\${escapeHtml(a.family_key)}</b>\${escapeHtml(a.benchmark_key || "")}</span>\`
    ).join("");
    return \`
    <div class="overlap-row" data-search="\${escapeHtml(((entry.key||"") + " " + (entry.display_name||"") + " " + (entry.appearances||[]).map(a => a.family_key + " " + a.benchmark_key).join(" ")).toLowerCase())}">
      <div>
        <div class="canonical-name">\${escapeHtml(entry.display_name || entry.key)}</div>
        <div class="canonical-key">\${escapeHtml(entry.key)}</div>
      </div>
      <div class="n">\${(entry.appearances||[]).length}</div>
      <div class="apps">\${apps}</div>
    </div>\`;
  }).join("");
}

renderHierarchy();
renderOverlaps();

const searchEl = document.getElementById("search");
const catEl = document.getElementById("categoryFilter");
const countEl = document.getElementById("resultCount");

function applyFilters() {
  const q = searchEl.value.trim().toLowerCase();
  const cat = catEl.value;
  let visibleFam = 0;
  for (const fam of document.querySelectorAll(".fam")) {
    const matchesQ = !q || fam.dataset.search.includes(q);
    const famCats = (fam.dataset.categories || "").split("|").filter(Boolean);
    const matchesC = !cat || famCats.includes(cat);
    const visible = matchesQ && matchesC;
    fam.classList.toggle("hidden", !visible);
    if (visible) visibleFam++;
  }
  let visibleOverlap = 0;
  for (const row of document.querySelectorAll(".overlap-row")) {
    const visible = !q || row.dataset.search.includes(q);
    row.classList.toggle("hidden", !visible);
    if (visible) visibleOverlap++;
  }
  countEl.textContent = \`\${visibleFam} families · \${visibleOverlap} overlaps shown\`;
}

searchEl.addEventListener("input", applyFilters);
catEl.addEventListener("change", applyFilters);
applyFilters();

document.getElementById("expandAll").addEventListener("click", () => {
  for (const d of document.querySelectorAll("details")) d.open = true;
});
document.getElementById("collapseAll").addEventListener("click", () => {
  for (const d of document.querySelectorAll("details")) d.open = false;
});

for (const tab of document.querySelectorAll(".tab-bar button")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab-bar button")) t.classList.toggle("on", t === tab);
    for (const p of document.querySelectorAll(".pane")) p.classList.toggle("on", p.id === "pane-" + tab.dataset.tab);
  });
}
</script>
</body>
</html>
`

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, html)
const kb = Math.round(fs.statSync(outPath).size / 1024)
console.error(`Wrote ${outPath} (${kb} KB)`)
console.error(`  cleaner: ${cleanerStatus}`)
console.error(`  ${families.length} families, ${totalBenchmarks} benchmarks, ${overlapsCount} cross-suite overlaps`)
