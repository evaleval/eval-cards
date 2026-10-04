import type {
  BenchmarkIndexAppearance,
  BenchmarkIndexEntry,
  EvalHierarchy,
  HierarchyBenchmark,
  HierarchyComposite,
  HierarchyFamily,
} from "@/lib/backend-artifacts"
import { decorateHierarchyDerivedTags } from "@/lib/benchmark-tags"

const CLEANED_MARKER = "_evalCardCleaned" as const

type CleanableHierarchy = EvalHierarchy & { [CLEANED_MARKER]?: boolean }

// Families where the warehouse splits ONE underlying benchmark into N
// parallel children. Two collapse strategies:
//
//   mode: "composite" — the children stay as distinct benchmarks but get
//     wrapped in one synthetic composite. Used for Fibble Arena (1-/2-/
//     3-/…-lies are genuinely different game variants) and CapArena-Auto
//     (vs-cogvlm / vs-gpt-4o / … are different reference comparators).
//
//   mode: "slices" — the children collapse into a single standalone
//     benchmark whose `slices[]` are the former children. Used for
//     AgentHarm where each child is a category score (Harassment, Fraud,
//     Disinformation, …) of one underlying benchmark. The synthetic
//     standalone owns the union of constituent_evaluation_ids; each slice carries
//     its source child's metrics verbatim.
//
// Keyed by `family.key`.
type SplitFamilyRule =
  | { mode: "composite"; syntheticKey: string; syntheticDisplayName: string }
  | { mode: "slices"; syntheticKey: string; syntheticDisplayName: string }
  // Group sibling benchmarks by stripping a trailing "(...)" suffix from
  // their display_name; each prefix becomes its own standalone benchmark
  // with language/variant splits underneath. Used for SWE-PolyBench
  // (8 benches → 2 standalones × 4 language splits) and Multi-SWE-Bench.
  | { mode: "paren-suffix-splits" }
  // Hoist all composite children up to family.benchmarks. Used for
  // reward-bench whose composites group siblings that should sit at the
  // family level (RewardBench, RewardBench 2, RewardBench Safety = 3
  // distinct benchmarks, not nested inside two composite wrappers).
  | { mode: "flatten-composites" }
  // Group siblings by display_name prefix and fold the parenthetical
  // suffix INTO a metric label rather than into a split. Used when the
  // suffix denotes a metric ("Humanity's Last Exam (accuracy)" /
  // "(calibration error)" → one benchmark with two metrics).
  | { mode: "paren-suffix-metrics" }

const SPLIT_FAMILIES: Record<string, SplitFamilyRule> = {
  // Fibble Arena: the warehouse already ships the canonical "fibble-arena"
  // benchmark with 6 internal slices (fibble_arena_*lie, 3 metrics each).
  // The fibble1-arena .. fibble5-arena composites are warehouse-duplicates
  // of those slices. "slices" mode auto-detects this (parent already has
  // slices → drop siblings) and we end up with one standalone benchmark.
  "fibble-arena": {
    mode: "slices",
    syntheticKey: "fibble-arena",
    syntheticDisplayName: "Fibble Arena",
  },
  // CapArena-Auto: 5 sibling benchmarks (Caparena AUTO AVG, Caption
  // Length, vs-cogvlm-19b, vs-gpt-4o, vs-minicpm-8b) that should fold
  // into a single CapArena-Auto benchmark with 5 splits.
  caparena: {
    mode: "slices",
    syntheticKey: "caparena-auto",
    syntheticDisplayName: "CapArena-Auto",
  },
  // AgentHarm: the warehouse ships an `agentharm` benchmark with no
  // slices alongside ~8 sibling category-scored benchmarks (Copyright,
  // Cybercrime, Drugs, Hate, Sexual, air-bench-2024-*, disinformation).
  // Those siblings are category-level scores of the same benchmark and
  // belong as slices. "slices" mode folds them into the parent.
  agentharm: {
    mode: "slices",
    syntheticKey: "agentharm",
    syntheticDisplayName: "AgentHarm",
  },
  // MATH-MC: 5 sibling Level-1..Level-5 benchmarks should fold into one
  // math-mc benchmark with 5 splits.
  "math-mc": {
    mode: "slices",
    syntheticKey: "math-mc",
    syntheticDisplayName: "MATH-MC",
  },
  // GSM-MC: lone GSM-MC sibling under a same-named family — collapse to
  // a single standalone (the family wrapper is redundant).
  "gsm-mc": {
    mode: "slices",
    syntheticKey: "gsm-mc",
    syntheticDisplayName: "GSM-MC",
  },
  // MT-Bench: overall / turn 1 / turn 2 are splits of the same benchmark.
  "mt-bench": {
    mode: "slices",
    syntheticKey: "mt-bench",
    syntheticDisplayName: "MT-Bench",
  },
  // SWE-PolyBench: 8 sibling benches → 2 standalones (PolyBench /
  // PolyBench Verified) × 4 language splits.
  "swe-polybench-leaderboard": { mode: "paren-suffix-splits" },
  // Multi-SWE-Bench: 6 language siblings → 1 standalone × 6 language splits.
  "multi-swe-bench-leaderboard": { mode: "paren-suffix-splits" },
  // RewardBench: composites currently wrap 3 benchmarks (rewardbench,
  // rewardbench-2, rewardbench-safety) that should sit at family level.
  "reward-bench": { mode: "flatten-composites" },
  // CySE2: 3 composite-wrapped sibling benchmarks (interpreter-abuse,
  // prompt-injection, vulnerability-exploit) that are category-level
  // scores of one CySE2 benchmark. Fold into one standalone with 3
  // splits.
  cyse2: {
    mode: "slices",
    syntheticKey: "cyse2",
    syntheticDisplayName: "CySE2",
  },
  // HLE: "Humanity's Last Exam (accuracy)" / "(calibration error)" are
  // the same benchmark with two different metrics. Fold into one
  // benchmark whose metrics are accuracy + calibration error.
  hle: { mode: "paren-suffix-metrics" },
  // BFCL: 7 sibling category benchmarks (Live, Multi Turn, Non Live,
  // Web Search, Format Sensitivity, Memory, Relevance) are all category
  // splits of one BFCL benchmark.
  bfcl: {
    mode: "slices",
    syntheticKey: "bfcl",
    syntheticDisplayName: "BFCL",
  },
  // HF Open LLM v2: 6 curated benchmarks (BBH, GPQA, IFEval, MATH-Lvl 5,
  // MMLU-Pro, MuSR) that together define the leaderboard. Wrap them in a
  // synthetic composite so the family card surfaces it as one composite
  // benchmark with 6 children. The members are also protected from the
  // `isPoorerDuplicate` filter (see PROTECTED_LEADERBOARD_FAMILIES) since
  // richer copies elsewhere (mmlu-pro-leaderboard, ifeval) would otherwise
  // strip them out of this family.
  "hf-open-llm-v2": {
    mode: "composite",
    syntheticKey: "hf-open-llm-v2",
    syntheticDisplayName: "HF Open LLM v2",
  },
}

/**
 * Families whose member benchmarks are integral to a curated leaderboard
 * and must survive `consolidateDedicatedHomeBenchmarks` even when richer
 * copies of the same benchmark exist elsewhere. Without this guard the
 * dedup filter strips e.g. MMLU-Pro and IFEval from the HF Open LLM v2
 * family because mmlu-pro-leaderboard / ifeval families publish them
 * with more slices.
 */
const PROTECTED_LEADERBOARD_FAMILIES = new Set<string>(["hf-open-llm-v2"])

/**
 * NOTE: this hierarchy cleaning belongs in the producer pipeline; it lives
 * here as a stopgap until that backend refactor lands.
 *
 * One-shot post-processor that turns the warehouse's raw hierarchy into a
 * frontend-ready artefact:
 *   1. Sanitises display names that the upstream pipeline accidentally
 *      leaks across families (e.g. WASP's name landing on `math-mc` /
 *      `gsm-mc`). Empty / missing names fall back to a humanised slug.
 *   2. Decorates every node with `derivedTags` from
 *      data/benchmarks/categories.json — top-down inheritance + a
 *      bottom-up union so families inherit their children's tags. Powers
 *      the `/evals` category chips and the model-view re-bucketing.
 *   3. Filters `benchmark_index[]` to drop family-rollup entries (the
 *      producer occasionally emits one entry per family enumerating
 *      every sibling benchmark — `key="artificial analysis"` listing 11
 *      of them, `key="llm stats"` listing 34). Real cross-family
 *      duplicates collapse to ≤2 distinct `benchmark_key` values; rollups
 *      span every benchmark in a family. Also dedupes `(family_key,
 *      eval_summary_id)` pairs since the producer occasionally lists the
 *      same eval row under multiple "families" (math-500 appears under
 *      both family=math and family=artificial-analysis pointing at the
 *      same `artificial-analysis-llms%2Fmath-500` row).
 *
 * Mutates in place and tags the returned object with `_evalCardCleaned:
 * true` so re-applying the cleaner is a no-op. Designed to run server-
 * side once per snapshot fetch and persist via the sidecar disk cache;
 * client-side `decorateHierarchyDerivedTags` calls become no-ops on
 * already-cleaned data.
 */
/**
 * Optional comparison-index payload — when supplied, the cleaner can
 * dedupe aggregator (llm-stats) appearances by checking whether their
 * scores literally match a non-aggregator family's scores for the same
 * canonical benchmark. Doing this at hierarchy-build time means the
 * frontend never has to think about aggregator dedup again.
 */
export type ComparisonIndexLike = {
  evals: Record<
    string,
    {
      metrics: Array<{
        metric_summary_id: string
        metric_name?: string | null
        scores: Array<{
          model_route_id?: string | null
          model_group_id?: string | null
          score?: number | null
        }>
      }>
    }
  >
}

export function cleanHierarchy(
  raw: EvalHierarchy,
  comparisonIndex?: ComparisonIndexLike | null,
): EvalHierarchy {
  const h = raw as CleanableHierarchy
  if (h[CLEANED_MARKER]) return h
  consolidateAirBench(h)
  consolidateDedicatedHomeBenchmarks(h)
  collapseValsAiSetupVariants(h)
  dedupValsAiAliasedBenches(h)
  flattenSplitFamilies(h)
  dropGroupingLeaderboardRollups(h)
  if (comparisonIndex) {
    dedupAggregatorBenchesByScore(h, comparisonIndex)
  }
  decorateHierarchyDerivedTags(h)
  // Run AFTER the sanitizer so it can't clobber our suffixed bench
  // display_names (`MMLU-Pro · Arcadia Impact` etc.) — the merged-in
  // bench keys deliberately use a non-shareToken-matching form to
  // keep them distinct, which would otherwise trip the humanizeKey
  // fallback in benchmark-tags.sanitizeName.
  groupSameBenchAcrossSources(h)
  if (h.benchmark_index) {
    const survivingFamilyKeys = new Set<string>(
      (h.families ?? []).map((f) => f.key),
    )
    h.benchmark_index = filterBenchmarkIndex(
      h.benchmark_index,
      survivingFamilyKeys,
    )
  }
  recomputeStats(h)
  if (comparisonIndex) {
    h._modelCoverageMap = buildModelCoverageMap(h, comparisonIndex)
  }
  h[CLEANED_MARKER] = true
  return h
}

/**
 * Build a { model_id → distinct_benchmark_count } map from the cleaned
 * hierarchy and the comparison-index scores. Emitted under both the
 * comparison-index's `model_route_id` (dunder form, e.g. `openai__gpt-5`)
 * AND its slash-form equivalent (`openai/gpt-5`) so lookups from the
 * model-card layer — which exposes the slash-form `route_id` — resolve.
 *
 * Steps:
 *   1. Walk every surviving benchmark's constituent_evaluation_ids to build
 *      eval_summary_id → benchmark_key.
 *   2. Walk comparison-index scores to collect, per model, the set of
 *      constituent_evaluation_ids it has a finite score for.
 *   3. For each model, count the distinct benchmark_keys reachable
 *      from its covered eval ids; emit under both id surfaces.
 */
function buildModelCoverageMap(
  h: CleanableHierarchy,
  comparisonIndex: ComparisonIndexLike,
): Record<string, number> {
  // Step 1: eval_summary_id → benchmark_key
  const evalToBenchmark = new Map<string, string>()
  const visitBench = (b: HierarchyBenchmark) => {
    for (const id of b.constituent_evaluation_ids ?? []) {
      if (!evalToBenchmark.has(id)) evalToBenchmark.set(id, b.key)
    }
  }
  for (const fam of h.families ?? []) {
    for (const b of fam.benchmarks ?? []) visitBench(b)
    for (const b of fam.standalone_benchmarks ?? []) visitBench(b)
    for (const c of fam.composites ?? []) {
      for (const b of c.benchmarks ?? []) visitBench(b)
    }
  }

  // Step 2: model_route_id → Set<eval_summary_id with a finite score>
  const modelEvals = new Map<string, Set<string>>()
  for (const [evalId, entry] of Object.entries(comparisonIndex.evals ?? {})) {
    for (const metric of entry.metrics ?? []) {
      for (const row of metric.scores ?? []) {
        const modelId = row.model_route_id || row.model_group_id
        if (!modelId || row.score == null || !Number.isFinite(row.score as number)) continue
        const set = modelEvals.get(modelId) ?? new Set<string>()
        set.add(evalId)
        modelEvals.set(modelId, set)
      }
    }
  }

  // Step 3: count distinct benchmark keys per model; emit under both
  // the dunder form (matches comparison-index keys) and the slash form
  // (matches the model card's `route_id`). Without the slash alias the
  // data-backend lookup misses every row.
  const coverage: Record<string, number> = {}
  for (const [modelId, evalIds] of modelEvals) {
    const benchKeys = new Set<string>()
    for (const id of evalIds) {
      const bKey = evalToBenchmark.get(id)
      if (bKey) benchKeys.add(bKey)
    }
    if (benchKeys.size === 0) continue
    coverage[modelId] = benchKeys.size
    if (modelId.includes("__")) {
      coverage[modelId.replace(/__/g, "/")] = benchKeys.size
    }
  }
  return coverage
}

/**
 * Recompute the headline counts on `stats` so the home / evals pages
 * reflect the post-consolidation hierarchy. Upstream's `stats` block is
 * derived from the raw warehouse output, but the cleaner drops
 * aggregator duplicates, leaderboard wrappers, and folds split families
 * — so families / composites / benchmarks / slices / metrics all
 * shrink. `metric_rows_scanned` measures the raw producer's input
 * volume and stays as-is.
 */
function recomputeStats(h: CleanableHierarchy) {
  let familyCount = 0
  let compositeCount = 0
  let benchmarkCount = 0
  let sliceCount = 0
  let metricCount = 0
  for (const fam of h.families ?? []) {
    familyCount++
    const visit = (b: HierarchyBenchmark) => {
      benchmarkCount++
      const slices = (b.slices ?? []) as Array<{ metrics?: unknown[] }>
      sliceCount += slices.length
      for (const s of slices) {
        metricCount += s.metrics?.length ?? 0
      }
    }
    for (const b of fam.benchmarks ?? []) visit(b)
    for (const b of fam.standalone_benchmarks ?? []) visit(b)
    for (const c of fam.composites ?? []) {
      compositeCount++
      for (const b of c.benchmarks ?? []) visit(b)
    }
  }
  const stats = (h as { stats?: Record<string, number> }).stats ?? {}
  stats.family_count = familyCount
  stats.composite_count = compositeCount
  stats.benchmark_count = benchmarkCount
  stats.slice_count = sliceCount
  stats.metric_count = metricCount
  ;(h as { stats?: Record<string, number> }).stats = stats
}

const AGGREGATOR_FAMILY_KEYS = new Set<string>(["llm-stats"])

/**
 * Drop an aggregator family's benchmark when its scores match a
 * non-aggregator family's benchmark with the same key, for every model
 * they share. Same scores across the entire shared model set is the
 * "literally the same data" signal: aggregators republish numbers from
 * canonical sources, so when the numbers line up exactly they're not
 * an independent report. We compare with tight tolerance (1e-9) so true
 * floating-point equality counts but rounding differences (3-decimal
 * vs 4-decimal precision in the source) leave the appearances alone.
 */
function dedupAggregatorBenchesByScore(
  h: CleanableHierarchy,
  comparisonIndex: ComparisonIndexLike,
) {
  type BenchHandle = {
    fam: HierarchyFamily
    bench: HierarchyBenchmark
    container: HierarchyBenchmark[]
  }
  const allHandles: BenchHandle[] = []
  for (const fam of h.families ?? []) {
    if (fam.benchmarks) {
      for (const b of fam.benchmarks)
        allHandles.push({ fam, bench: b, container: fam.benchmarks })
    }
    if (fam.standalone_benchmarks) {
      for (const b of fam.standalone_benchmarks)
        allHandles.push({ fam, bench: b, container: fam.standalone_benchmarks })
    }
    for (const c of fam.composites ?? []) {
      if (c.benchmarks) {
        for (const b of c.benchmarks)
          allHandles.push({ fam, bench: b, container: c.benchmarks })
      }
    }
  }

  // Map model_route_id → score for a given eval id, picking the metric
  // whose summary id local part most closely matches `metricHint` (so
  // accuracy compares to accuracy, not accuracy vs stderr). When no
  // hint is provided, use the eval's primary metric (first non-stderr).
  const STDERR_PATTERN = /_(stderr|std_err|standard_error)$/i
  const isStderr = (id: string) => STDERR_PATTERN.test(id)
  const metricLocal = (id: string) =>
    id.split("%3A").pop()?.toLowerCase().trim() ?? ""
  const buildScoreMap = (
    evalId: string,
    metricHint: string | null,
  ): Map<string, number> | null => {
    const evalEntry = comparisonIndex.evals[evalId]
    if (!evalEntry || !evalEntry.metrics?.length) return null
    const usableMetrics = evalEntry.metrics.filter(
      (m) => !isStderr(m.metric_summary_id ?? ""),
    )
    if (usableMetrics.length === 0) return null
    const target =
      (metricHint &&
        usableMetrics.find(
          (m) => metricLocal(m.metric_summary_id) === metricHint,
        )) ||
      usableMetrics[0]
    const map = new Map<string, number>()
    for (const row of target.scores ?? []) {
      const id = row.model_route_id || row.model_group_id
      if (!id || row.score == null || !Number.isFinite(row.score)) continue
      map.set(id, row.score as number)
    }
    return map
  }

  const scoresEqual = (a: number, b: number) => Math.abs(a - b) <= 1e-9

  // Group handles by benchmark key (the canonical identity). For each
  // key with both aggregator and non-aggregator copies, compare their
  // scores; if every shared model agrees exactly, drop the aggregator
  // bench from its family.
  const byKey = new Map<string, BenchHandle[]>()
  for (const h of allHandles) {
    const list = byKey.get(h.bench.key) ?? []
    list.push(h)
    byKey.set(h.bench.key, list)
  }
  const drops = new Set<HierarchyBenchmark>()
  for (const handles of byKey.values()) {
    if (handles.length < 2) continue
    const aggHandles = handles.filter((h) =>
      AGGREGATOR_FAMILY_KEYS.has(h.fam.key),
    )
    const nonAgg = handles.filter((h) => !AGGREGATOR_FAMILY_KEYS.has(h.fam.key))
    if (aggHandles.length === 0 || nonAgg.length === 0) continue

    for (const agg of aggHandles) {
      const aggIds = agg.bench.constituent_evaluation_ids ?? []
      if (aggIds.length === 0) continue
      for (const peer of nonAgg) {
        const peerIds = peer.bench.constituent_evaluation_ids ?? []
        if (peerIds.length === 0) continue
        // Try to match scores between aggregator's eval and peer's
        // eval. Compare against the first eval id pair where both
        // sides have a score map.
        let matched = false
        outer: for (const aId of aggIds) {
          const aMap = buildScoreMap(aId, null)
          if (!aMap || aMap.size === 0) continue
          for (const pId of peerIds) {
            const pMap = buildScoreMap(pId, null)
            if (!pMap || pMap.size === 0) continue
            // Need at least 3 shared models for a confident match;
            // sub-3-model overlaps are easy to coincide by chance.
            const shared: Array<[number, number]> = []
            for (const [model, aScore] of aMap) {
              const pScore = pMap.get(model)
              if (pScore != null) shared.push([aScore, pScore])
            }
            if (shared.length < 3) continue
            const allEqual = shared.every(([x, y]) => scoresEqual(x, y))
            if (allEqual) {
              matched = true
              break outer
            }
          }
        }
        if (matched) {
          drops.add(agg.bench)
          break
        }
      }
    }
  }

  if (drops.size === 0) return
  for (const fam of h.families ?? []) {
    if (fam.benchmarks)
      fam.benchmarks = fam.benchmarks.filter((b) => !drops.has(b))
    if (fam.standalone_benchmarks)
      fam.standalone_benchmarks = fam.standalone_benchmarks.filter(
        (b) => !drops.has(b),
      )
    for (const c of fam.composites ?? []) {
      if (c.benchmarks)
        c.benchmarks = c.benchmarks.filter((b) => !drops.has(b))
    }
    if (fam.composites) {
      fam.composites = fam.composites.filter(
        (c) => (c.benchmarks ?? []).length > 0,
      )
    }
  }
  // Drop emptied aggregator families.
  h.families = (h.families ?? []).filter((fam) => {
    const total =
      (fam.benchmarks ?? []).length +
      (fam.standalone_benchmarks ?? []).length +
      (fam.composites ?? []).reduce(
        (n, c) => n + (c.benchmarks ?? []).length,
        0,
      )
    return total > 0
  })
}

/**
 * Drop strictly-poorer duplicate appearances of the same benchmark
 * across families. Two snapshots in the wild:
 *
 *   APEX v1 — appears under `apex-v1/apex-v1` with 5 slices AND under
 *   `apex-agents/apex-v1` with 1 slice. The 1-slice copy is a partial
 *   duplicate that just clutters apex-agents.
 *
 *   MMLU-Pro — appears under `mmlu-pro/mmlu-pro` with 1 slice/metric
 *   AND under `mmlu-pro-leaderboard/mmlu-pro` with 15 slices/15
 *   metrics. The 1-slice copy is the impoverished one.
 *
 * Rule: if benchmark.key appears in multiple families, score each copy
 * by `slice_count + metric_count` and drop strictly poorer copies. Ties
 * stay (e.g. `big-bench` and `big-bench-hard` both list the same
 * 1-slice BBH — without a richness gap we can't pick a winner, so we
 * leave the warehouse's intended grouping in place). Families that end
 * up with zero benchmarks after the drop are removed too.
 */
function consolidateDedicatedHomeBenchmarks(h: CleanableHierarchy) {
  const richness = (b: HierarchyBenchmark): number => {
    const slices = b.slices ?? []
    const sliceCount = slices.length
    const metricCount = slices.reduce(
      (n, s) => n + ((s as { metrics?: unknown[] }).metrics?.length ?? 0),
      0,
    )
    return sliceCount + metricCount
  }

  // Collect every appearance of every benchmark, indexed by key, so the
  // duplicate check can compare each instance against its peers.
  const instancesByKey = new Map<string, HierarchyBenchmark[]>()
  const visit = (b: HierarchyBenchmark) => {
    const list = instancesByKey.get(b.key)
    if (list) list.push(b)
    else instancesByKey.set(b.key, [b])
  }
  for (const fam of h.families ?? []) {
    for (const b of fam.benchmarks ?? []) visit(b)
    for (const b of fam.standalone_benchmarks ?? []) visit(b)
    for (const c of fam.composites ?? []) {
      for (const b of c.benchmarks ?? []) visit(b)
    }
  }

  const sharesAnyEvalId = (a: HierarchyBenchmark, b: HierarchyBenchmark) => {
    const aIds = new Set(a.constituent_evaluation_ids ?? [])
    if (aIds.size === 0) return false
    for (const id of b.constituent_evaluation_ids ?? []) if (aIds.has(id)) return true
    return false
  }

  // Drop strictly-poorer copies, BUT only when the poor copy shares an
  // eval_summary_id with a richer instance. Without that gate, a curated
  // family (e.g. `gaia` reporting GAIA at richness 2 with eval_id
  // `gaia%2Fgaia`) gets nuked just because some unrelated source family
  // (`hal` reporting GAIA at richness 8 with eval_id `hal%2Fgaia`)
  // happens to use the same bench key — they're different physical
  // rows and both deserve to surface. With the gate, livebench's
  // structurally-poorer rows still lose to live-bench since they share
  // eval_ids (`live-bench%2Flivebench-coding` lives in both).
  const isPoorerDuplicate = (b: HierarchyBenchmark): boolean => {
    const peers = instancesByKey.get(b.key) ?? []
    const r = richness(b)
    return peers.some(
      (peer) => peer !== b && richness(peer) > r && sharesAnyEvalId(peer, b),
    )
  }

  for (const fam of h.families ?? []) {
    // Skip dedup for curated-leaderboard families whose constituent
    // benchmarks define the leaderboard's identity (HF Open LLM v2 etc.).
    // Without this, richer copies elsewhere strip the leaderboard down.
    if (PROTECTED_LEADERBOARD_FAMILIES.has(fam.key)) continue
    if (fam.benchmarks) {
      fam.benchmarks = fam.benchmarks.filter((b) => !isPoorerDuplicate(b))
    }
    if (fam.standalone_benchmarks) {
      fam.standalone_benchmarks = fam.standalone_benchmarks.filter(
        (b) => !isPoorerDuplicate(b),
      )
    }
    for (const c of fam.composites ?? []) {
      if (c.benchmarks) {
        c.benchmarks = c.benchmarks.filter((b) => !isPoorerDuplicate(b))
      }
    }
    if (fam.composites) {
      fam.composites = fam.composites.filter(
        (c) => (c.benchmarks ?? []).length > 0,
      )
    }
  }

  // Drop emptied families.
  h.families = (h.families ?? []).filter((fam) => {
    const total =
      (fam.benchmarks ?? []).length +
      (fam.standalone_benchmarks ?? []).length +
      (fam.composites ?? []).reduce(
        (n, c) => n + (c.benchmarks ?? []).length,
        0,
      )
    return total > 0
  })

  // Final pass: drop redundant wrapper families. Two cases:
  //
  //   (a) Strict-subset wrapper: family A's benchmark set is a STRICT
  //       subset of family B's, with each shared bench having equal-or-
  //       better richness in B. Drop A, keep B. Catches the
  //       `livebench` family (3 benches) being a subset of `live-bench`
  //       (4 benches). Apex-v1 is safe because its copy is unique.
  //
  //   (b) Self-wrapper tie: family.key == its sole benchmark.key AND
  //       another family also carries that benchmark at equal richness.
  //       Drop the self-wrapper, keep the other (parent) family.
  //       Catches `big-bench-hard` family being redundant when
  //       `big-bench` also lists it; same for `global-mmlu-lite`.
  //
  // Order matters: apply (a) first since it can leave a single
  // benchmark behind that triggers (b).
  type BenchHandle = { fam: HierarchyFamily; bench: HierarchyBenchmark }
  const allFamilies = [...h.families]
  const benchesByFam = new Map<HierarchyFamily, BenchHandle[]>()
  for (const fam of allFamilies) {
    const list: BenchHandle[] = []
    for (const b of fam.benchmarks ?? []) list.push({ fam, bench: b })
    for (const b of fam.standalone_benchmarks ?? []) list.push({ fam, bench: b })
    for (const c of fam.composites ?? []) {
      for (const b of c.benchmarks ?? []) list.push({ fam, bench: b })
    }
    benchesByFam.set(fam, list)
  }

  const dropped = new Set<HierarchyFamily>()

  // Two appearances of the same benchmark key are "physically the
  // same" only when they share at least one eval_summary_id. Different
  // constituent_evaluation_ids mean different sources independently reporting on
  // the same canonical benchmark (e.g. llm-stats and openai-humaneval
  // both list HumanEval but report it from their own data). Don't
  // collapse those.
  const evalIds = (b: HierarchyBenchmark) =>
    new Set(b.constituent_evaluation_ids ?? [])
  const sharesEvalId = (
    a: HierarchyBenchmark,
    b: HierarchyBenchmark,
  ): boolean => {
    const aIds = evalIds(a)
    for (const id of evalIds(b)) if (aIds.has(id)) return true
    return false
  }

  // (a) strict-subset.
  //
  // Only fires when A's family key is textually related to B's — they
  // slugify the same, or one's slug contains the other. Without that
  // gate the rule was eating curated benchmark families like
  // `tau2-bench` whenever its rows happened to all be republished by a
  // single source family (`exgentic-open-agent`). Those aren't redundant
  // wrappers — they're separate curated leaderboards that the upstream
  // pipeline intentionally surfaces. The intended target is wrappers
  // like `livebench` (slug `livebench`) being a strict subset of
  // `live-bench` (slug `livebench`), where the slugs match exactly.
  const slugForKey = (key: string) =>
    key.toLowerCase().replace(/[^a-z0-9]+/g, "")
  const familyKeysRelated = (aKey: string, bKey: string) => {
    const aSlug = slugForKey(aKey)
    const bSlug = slugForKey(bKey)
    if (!aSlug || !bSlug) return false
    return aSlug === bSlug || aSlug.includes(bSlug) || bSlug.includes(aSlug)
  }

  for (const a of allFamilies) {
    if (dropped.has(a)) continue
    if (PROTECTED_LEADERBOARD_FAMILIES.has(a.key)) continue
    const aBenches = benchesByFam.get(a) ?? []
    if (aBenches.length === 0) continue
    for (const b of allFamilies) {
      if (a === b || dropped.has(b)) continue
      if (!familyKeysRelated(a.key, b.key)) continue
      const bBenches = benchesByFam.get(b) ?? []
      if (bBenches.length <= aBenches.length) continue
      const bByKey = new Map(bBenches.map((h) => [h.bench.key, h.bench]))
      const aSubset = aBenches.every((h) => {
        const peer = bByKey.get(h.bench.key)
        if (peer == null) return false
        if (!sharesEvalId(peer, h.bench)) return false
        return richness(peer) >= richness(h.bench)
      })
      if (aSubset) {
        dropped.add(a)
        break
      }
    }
  }

  // (b) self-wrapper tie
  for (const a of allFamilies) {
    if (dropped.has(a)) continue
    if (PROTECTED_LEADERBOARD_FAMILIES.has(a.key)) continue
    const aBenches = benchesByFam.get(a) ?? []
    if (aBenches.length !== 1) continue
    const sole = aBenches[0].bench
    if (sole.key !== a.key) continue
    // Look for another (kept) family that carries this bench at >=
    // richness AND with a shared eval_summary_id (= physical duplicate).
    const elsewhere = allFamilies.some((b) => {
      if (b === a || dropped.has(b)) return false
      const peers = benchesByFam.get(b) ?? []
      return peers.some(
        (h) =>
          h.bench.key === sole.key &&
          richness(h.bench) >= richness(sole) &&
          sharesEvalId(h.bench, sole),
      )
    })
    if (elsewhere) dropped.add(a)
  }

  // (b2) leaderboard-wrapper merge. A family whose key ends in
  // "-leaderboard" and contains exactly one benchmark whose key matches
  // the family key minus that suffix is a thin wrapper around a
  // benchmark that's already covered by another family. Merge the
  // wrapper's constituent_evaluation_ids into the canonical bench so we don't
  // lose the leaderboard's source row, then drop the wrapper family.
  // Example: `swe-bench-verified-leaderboard` family with sole bench
  // `swe-bench-verified` — merge its `swe-bench-verified-leaderboard%
  // 2Fswe-bench-verified` eval id into swe-bench's `swe-bench-verified`
  // bench.
  // Aggregator families (e.g. llm-stats) republish numbers from other
  // sources, but at hierarchy-build time we keep them as their own
  // family. Score-equality-based aggregator dedup (per the user's
  // earlier guidance) lives in the Overlaps view, not here. We use this
  // set only as a tie-breaker when deciding which family inherits a
  // wrapper's constituent_evaluation_ids.
  const AGGREGATOR_KEYS = new Set<string>(["llm-stats"])
  const isAggregator = (fam: HierarchyFamily) => AGGREGATOR_KEYS.has(fam.key)

  // (b2) leaderboard-wrapper merge. A `*-leaderboard` family with one
  // benchmark whose key matches its parent name is a thin wrapper
  // around that benchmark. Merge its constituent_evaluation_ids into a sibling
  // family that already carries the same bench, then drop the wrapper.
  // Prefer a non-aggregator merge target so the leaderboard's row lands
  // in the canonical paper home rather than llm-stats.
  for (const a of allFamilies) {
    if (dropped.has(a)) continue
    if (!a.key.endsWith("-leaderboard")) continue
    const aBenches = benchesByFam.get(a) ?? []
    if (aBenches.length !== 1) continue
    const sole = aBenches[0].bench
    const stripped = a.key.replace(/-leaderboard$/, "")
    if (sole.key !== stripped) continue
    // Only merge the wrapper when a candidate carries the bench at
    // equal-or-better richness. Without this, a thin one-slice copy of
    // the bench in another family (e.g. hf-open-llm-v2's 1-slice
    // mmlu-pro) would absorb a much richer wrapper (mmlu-pro-leaderboard
    // with 15 slices) and silently drop the slice data.
    const soleRichness = richness(sole)
    const candidates = allFamilies.filter((b) => {
      if (a === b || dropped.has(b)) return false
      const peers = benchesByFam.get(b) ?? []
      return peers.some(
        (h) => h.bench.key === sole.key && richness(h.bench) >= soleRichness,
      )
    })
    candidates.sort((x, y) => {
      const xAgg = isAggregator(x) ? 1 : 0
      const yAgg = isAggregator(y) ? 1 : 0
      return xAgg - yAgg
    })
    const target = candidates[0]
    if (!target) continue
    const peer = (benchesByFam.get(target) ?? []).find(
      (h) => h.bench.key === sole.key,
    )
    if (!peer) continue
    const merged = new Set<string>()
    for (const id of peer.bench.constituent_evaluation_ids ?? []) merged.add(id)
    for (const id of sole.constituent_evaluation_ids ?? []) merged.add(id)
    peer.bench.constituent_evaluation_ids = [...merged]
    dropped.add(a)
  }

  // (c) sole-bench / shared-eval-id tie. Two families that each carry a
  // single benchmark with the SAME constituent_evaluation_ids are surfacing the
  // same physical data under different family keys — keys can differ
  // (livecodebench vs livecodebenchpro both wrap the
  // `livecodebenchpro%2Flivecodebench-pro` row). Drop one, preferring
  // the family whose key best matches the benchmark's key (after
  // stripping dashes / underscores), tie-broken alphabetically.
  const flat = (s: string) =>
    String(s ?? "").toLowerCase().replace(/[_\s-]+/g, "")
  for (const a of allFamilies) {
    if (dropped.has(a)) continue
    const aBenches = benchesByFam.get(a) ?? []
    if (aBenches.length !== 1) continue
    const aSole = aBenches[0].bench
    const aIds = new Set(aSole.constituent_evaluation_ids ?? [])
    if (aIds.size === 0) continue
    for (const b of allFamilies) {
      if (a === b || dropped.has(b)) continue
      const bBenches = benchesByFam.get(b) ?? []
      if (bBenches.length !== 1) continue
      const bSole = bBenches[0].bench
      const bIds = new Set(bSole.constituent_evaluation_ids ?? [])
      if (bIds.size !== aIds.size) continue
      let same = true
      for (const id of aIds) if (!bIds.has(id)) { same = false; break }
      if (!same) continue
      // Tie-break: pick the loser. The family whose flattened key
      // doesn't match the bench's flattened key loses; if both match or
      // neither matches, alphabetically-later loses.
      const aMatch = flat(a.key) === flat(aSole.key)
      const bMatch = flat(b.key) === flat(bSole.key)
      let loser: HierarchyFamily | null = null
      if (aMatch && !bMatch) loser = b
      else if (bMatch && !aMatch) loser = a
      else loser = a.key < b.key ? b : a
      dropped.add(loser)
      if (loser === a) break
    }
  }

  // (d) Drop single-bench families that are pure aliases of bench
  // rows already published under another family.
  //
  // The upstream registry occasionally lists the same physical eval
  // row under two family names — the canonical example is the `mmlu`
  // family, whose sole bench `mmlu-pro` carries eval_id
  // `artificial-analysis-llms%2Fmmlu-pro`. That id is ALREADY covered
  // by the `artificial-analysis` family's mmlu-pro bench, so the
  // `mmlu` family is just a duplicate breadcrumb that doesn't add any
  // new data path.
  //
  // A family qualifies for drop only when (1) it has exactly one
  // bench, and (2) every one of that bench's constituent_evaluation_ids is
  // already carried by some other surviving family. That keeps
  // independent sources alive — `mmlu-pro` (eval_id
  // `mmlu-pro%2Fmmlu-pro`) and `mmlu-pro-leaderboard` (eval_id
  // `mmlu-pro-leaderboard%2Fmmlu-pro`) each have a unique source row,
  // so neither is a pure alias and both stay.
  const idsCoveredByFamily = new Map<HierarchyFamily, Set<string>>()
  for (const fam of allFamilies) {
    if (dropped.has(fam)) continue
    const ids = new Set<string>()
    for (const handle of benchesByFam.get(fam) ?? []) {
      for (const id of handle.bench.constituent_evaluation_ids ?? []) ids.add(id)
    }
    idsCoveredByFamily.set(fam, ids)
  }
  // Pre-compute the set of surviving family keys so we can also gate
  // on "the bench key has its own canonical family". Without this gate
  // we'd incorrectly drop curated leaderboards (`tau-bench` whose sole
  // bench `tau-bench-airline` is only covered by the `hal` source
  // family) just because some other family already publishes the row.
  const familyKeysAlive = new Set<string>()
  for (const fam of allFamilies) {
    if (!dropped.has(fam)) familyKeysAlive.add(fam.key)
  }
  for (const fam of allFamilies) {
    if (dropped.has(fam)) continue
    const benches = benchesByFam.get(fam) ?? []
    if (benches.length !== 1) continue
    const soleBench = benches[0].bench
    // Bench key must already belong to another family — that family is
    // the canonical home; this single-bench family is just a stray
    // breadcrumb. (Skipping when the bench key equals the family key
    // itself, since that's the family BEING the canonical home.)
    if (soleBench.key === fam.key) continue
    if (!familyKeysAlive.has(soleBench.key)) continue
    const soleIds = soleBench.constituent_evaluation_ids ?? []
    if (soleIds.length === 0) continue
    const allCoveredElsewhere = soleIds.every((id) => {
      for (const [otherFam, otherIds] of idsCoveredByFamily) {
        if (otherFam === fam || dropped.has(otherFam)) continue
        if (otherIds.has(id)) return true
      }
      return false
    })
    if (allCoveredElsewhere) dropped.add(fam)
  }

  h.families = allFamilies.filter((fam) => !dropped.has(fam))
}

/**
 * Group single-bench families that publish the same conceptual benchmark
 * from different upstream sources into one merged family card.
 *
 * Triggered when ≥2 single-bench families share a bench key but their
 * bench rows have non-overlapping constituent_evaluation_ids — i.e. independent
 * sources publishing the same benchmark. The richest family (most
 * models) keeps its slot; other families contribute their bench under
 * the survivor as siblings, with each bench's display_name suffixed
 * with " · <Source>" so the user can tell which run a row came from.
 *
 * Runs AFTER decorateHierarchyDerivedTags so the sanitizer's
 * shareToken / humanizeKey passes don't clobber the suffixed names
 * (the merged-in bench keys like `mmlu-pro__arcadia` deliberately
 * don't share tokens with "MMLU-Pro · Arcadia Impact").
 */
function groupSameBenchAcrossSources(h: CleanableHierarchy) {
  const sourceLabel = (
    bench: HierarchyBenchmark,
    fallback: string,
  ): string => {
    const sources = (bench.metrics ?? []).flatMap((m) => m.sources ?? [])
    for (const s of sources) {
      const trimmed = String(s ?? "").trim()
      if (trimmed) return trimmed
    }
    return fallback
  }
  const slugifyShort = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")

  type Handle = { fam: HierarchyFamily; bench: HierarchyBenchmark }
  const collectBenches = (fam: HierarchyFamily): HierarchyBenchmark[] => [
    ...(fam.benchmarks ?? []),
    ...(fam.standalone_benchmarks ?? []),
    ...(fam.composites ?? []).flatMap((c) => c.benchmarks ?? []),
  ]
  const candidatesByKey = new Map<string, Handle[]>()
  for (const fam of h.families ?? []) {
    const benches = collectBenches(fam)
    if (benches.length !== 1) continue
    const sole = benches[0]
    const list = candidatesByKey.get(sole.key) ?? []
    list.push({ fam, bench: sole })
    candidatesByKey.set(sole.key, list)
  }

  const dropped = new Set<HierarchyFamily>()
  for (const [, group] of candidatesByKey) {
    if (group.length < 2) continue
    // eval_ids must be disjoint (otherwise an earlier rule should have
    // caught them as aliases of the same row).
    const seenIds = new Set<string>()
    let disjoint = true
    for (const entry of group) {
      for (const id of entry.bench.constituent_evaluation_ids ?? []) {
        if (seenIds.has(id)) { disjoint = false; break }
        seenIds.add(id)
      }
      if (!disjoint) break
    }
    if (!disjoint) continue

    const sortedGroup = [...group].sort((x, y) => {
      const xModels = x.bench.metrics?.[0]?.models_count ?? 0
      const yModels = y.bench.metrics?.[0]?.models_count ?? 0
      if (xModels !== yModels) return yModels - xModels
      return x.fam.key.localeCompare(y.fam.key)
    })
    const survivor = sortedGroup[0]
    const baseDisplay =
      survivor.bench.display_name?.trim() ||
      survivor.fam.display_name?.trim() ||
      survivor.bench.key

    for (const entry of sortedGroup) {
      const src = sourceLabel(
        entry.bench,
        entry.fam.display_name || entry.fam.key,
      )
      entry.bench.display_name = `${baseDisplay} · ${src}`
      if (entry !== survivor) {
        entry.bench.key = `${survivor.bench.key}__${slugifyShort(src) || slugifyShort(entry.fam.key)}`
        survivor.fam.benchmarks = survivor.fam.benchmarks ?? []
        survivor.fam.benchmarks.push(entry.bench)
        dropped.add(entry.fam)
      }
    }
    survivor.fam.display_name = baseDisplay
  }

  if (dropped.size === 0) return
  h.families = (h.families ?? []).filter((fam) => !dropped.has(fam))
}

/**
 * AIR-Bench 2024 is a single safety benchmark with a 4-tier taxonomy
 * (314 leaf risk categories per the spec, ~30 of which the HELM
 * leaderboard exposes). The warehouse currently surfaces it in three
 * places:
 *   1. `helm` family > `helm-air-bench` composite (the canonical HELM
 *      shape, with one `air-bench-2024` benchmark whose `slices[]`
 *      enumerate the categories — 60 leaf eval rows).
 *   2. `agentharm` family — 2 cherry-picked rows
 *      (`agentharm%2Fair-bench-2024-13-harassment`,
 *      `…32-fraud`) sitting alongside unrelated AgentHarm scores.
 *   3. A standalone `air-bench-2024` family carrying the same 2 rows
 *      from #2.
 *
 * Consolidate everything under HELM AIR-Bench: drop the standalone
 * family, strip AIR-Bench rows out of agentharm, and plant the union
 * of every AIR-Bench eval id under helm's `constituent_evaluation_ids` and the
 * helm-air-bench composite's benchmark `constituent_evaluation_ids`. The
 * benchmark-id heuristic — `air-bench-2024` prefix — is narrow enough
 * to be safe and broad enough to catch alternate sources.
 */
/**
 * Drop "vals ai X" duplicates inside the vals-ai family.
 *
 * The upstream feed publishes some benchmarks twice under the same family
 * — once with a canonical key (`mgsm`, `gpqa-overall`) and once with a
 * `"vals ai <suffix>"` alias (`vals ai mgsm`, `vals ai gpqa`). The aliases
 * are pure surface duplicates: same family, same models_count, same metric
 * config, scores within rounding of each other. Keeping both makes the
 * family card render the same benchmark twice. We drop the alias when a
 * non-aliased sibling already carries the suffix.
 *
 * Aliases without a non-aliased sibling (`vals ai finance agent`) are
 * preserved, and `vals_ai.swebench.<bucket>` time-buckets are untouched
 * because they use `vals_ai.` (dot/underscore) instead of the `"vals ai "`
 * (space) alias prefix.
 */
/**
 * vals_ai records ship eval_names shaped "vals_ai.<benchmark>.<setup-variant>"
 * — e.g. "vals_ai.swebench.>4 hours", "vals_ai.swebench.<15 min fix". The
 * pre-patch producer treats those as separate benchmarks. They're really
 * setup variants (time budgets) of a single benchmark; we collapse each
 * leaked sibling into a new slice on the canonical bench.
 *
 * Once the producer (build_hierarchy_v2.py:EVAL_NAME_SHAPE) is re-run, this
 * cleaner is a no-op — the leaked keys never appear.
 */
function collapseValsAiSetupVariants(h: CleanableHierarchy) {
  const PATTERN = /^vals_ai\.([a-z0-9_-]+)\.(.+)$/i
  // Tokenise for fuzzy "swebench" ↔ "swe-bench" matching.
  const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")

  for (const fam of h.families ?? []) {
    if (fam.key !== "vals-ai") continue
    const benches: HierarchyBenchmark[] = [
      ...(fam.benchmarks ?? []),
      ...(fam.standalone_benchmarks ?? []),
    ]

    // Group leaked benches by bench label (e.g. "swebench") so we know
    // which canonical sibling to merge each set into.
    const leakedByBench = new Map<string, HierarchyBenchmark[]>()
    for (const b of benches) {
      const m = b.key.match(PATTERN)
      if (!m) continue
      const label = compact(m[1])
      const arr = leakedByBench.get(label) ?? []
      arr.push(b)
      leakedByBench.set(label, arr)
    }
    if (leakedByBench.size === 0) continue

    const removeKeys = new Set<string>()
    for (const [benchLabel, leaked] of leakedByBench) {
      const canonical = benches.find((b) => {
        if (PATTERN.test(b.key)) return false
        return compact(b.key) === benchLabel
      })
      if (!canonical) continue

      const existingSliceKeys = new Set((canonical.slices ?? []).map((s) => s.key))
      const mergedEvalIds = new Set(canonical.constituent_evaluation_ids ?? [])

      for (const l of leaked) {
        const m = l.key.match(PATTERN)
        if (!m) continue
        const variant = m[2].trim()
        const sliceKey = `vals-ai-${variant
          .toLowerCase()
          .replace(/[^a-z0-9<>]+/g, "-")
          .replace(/^-|-$/g, "") || "variant"}`
        if (!existingSliceKeys.has(sliceKey)) {
          canonical.slices = canonical.slices ?? []
          canonical.slices.push({
            key: sliceKey,
            display_name: `Vals.ai · ${variant}`,
            metrics: l.metrics ?? [],
          })
          existingSliceKeys.add(sliceKey)
        }
        for (const id of l.constituent_evaluation_ids ?? []) mergedEvalIds.add(id)
        removeKeys.add(l.key)
      }
      canonical.constituent_evaluation_ids = Array.from(mergedEvalIds)
    }

    if (removeKeys.size > 0) {
      if (fam.benchmarks) fam.benchmarks = fam.benchmarks.filter((b) => !removeKeys.has(b.key))
      if (fam.standalone_benchmarks) {
        fam.standalone_benchmarks = fam.standalone_benchmarks.filter((b) => !removeKeys.has(b.key))
      }
      for (const c of fam.composites ?? []) {
        if (c.benchmarks) c.benchmarks = c.benchmarks.filter((b) => !removeKeys.has(b.key))
      }
    }
  }
}

function dedupValsAiAliasedBenches(h: CleanableHierarchy) {
  const ALIAS_PREFIX = "vals ai "
  // Normalise to a set of word tokens so suffix "gpqa" matches sibling
  // "gpqa-overall" but suffix "finance agent" doesn't match unrelated
  // siblings.
  const tokens = (key: string): Set<string> =>
    new Set(
      key
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    )

  for (const fam of h.families ?? []) {
    if (fam.key !== "vals-ai") continue

    const benches = [
      ...(fam.benchmarks ?? []),
      ...(fam.standalone_benchmarks ?? []),
    ]
    const siblingTokens = benches
      .filter((b) => !b.key.startsWith(ALIAS_PREFIX))
      .map((b) => ({ key: b.key, tokens: tokens(b.key) }))

    const isAliasedDuplicate = (b: HierarchyBenchmark): boolean => {
      if (!b.key.startsWith(ALIAS_PREFIX)) return false
      const suffixTokens = tokens(b.key.slice(ALIAS_PREFIX.length))
      if (suffixTokens.size === 0) return false
      return siblingTokens.some(({ tokens: tks }) => {
        for (const t of suffixTokens) if (!tks.has(t)) return false
        return true
      })
    }

    if (fam.benchmarks) {
      fam.benchmarks = fam.benchmarks.filter((b) => !isAliasedDuplicate(b))
    }
    if (fam.standalone_benchmarks) {
      fam.standalone_benchmarks = fam.standalone_benchmarks.filter(
        (b) => !isAliasedDuplicate(b),
      )
    }
    for (const c of fam.composites ?? []) {
      if (c.benchmarks) {
        c.benchmarks = c.benchmarks.filter((b) => !isAliasedDuplicate(b))
      }
    }
  }
}

/**
 * Every `evaluation_id` the raw hierarchy actually vouches for: the union of
 * `constituent_evaluation_ids` on families, composites, benchmarks and
 * `benchmark_index[]` appearances. Used to validate ids that the cleaner
 * would otherwise reconstruct by string concatenation, so a synthesised id
 * that no eval backs can never reach the page as a "split" (each phantom
 * costs one 404 on every sibling page view).
 */
function collectRealEvaluationIds(h: CleanableHierarchy): Set<string> {
  const ids = new Set<string>()
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node == null || typeof node !== "object") return
    const record = node as Record<string, unknown>
    const constituents = record.constituent_evaluation_ids
    if (Array.isArray(constituents)) {
      for (const id of constituents) if (typeof id === "string" && id) ids.add(id)
    }
    for (const value of Object.values(record)) {
      if (value != null && typeof value === "object") walk(value)
    }
  }
  walk(h.families ?? [])
  walk((h as { benchmark_index?: unknown }).benchmark_index ?? [])
  return ids
}

function consolidateAirBench(h: CleanableHierarchy) {
  const isAirBenchEvalId = (id: string) =>
    /(?:^|%2F)air-bench-2024(?:[-%]|$)/i.test(id)
  const isAirBenchBenchmarkKey = (key: string) =>
    /^air-bench-2024(?:[-_]|$)/i.test(key)
  const realEvalIds = collectRealEvaluationIds(h)

  // Collect every AIR-Bench eval id surfaced anywhere in the hierarchy.
  const airBenchEvalIds = new Set<string>()
  for (const fam of h.families ?? []) {
    for (const id of fam.constituent_evaluation_ids ?? []) {
      if (isAirBenchEvalId(id)) airBenchEvalIds.add(id)
    }
    // The HELM AIR-Bench composite historically shipped its 60+ leaf
    // categories as entries on the rollup benchmark's `slices[]` rather than
    // as constituent ids, so the cleaner reconstructs the slice eval ids and
    // plants them under helm. Without that the leaves orphan to
    // evalEntry.family_id and either land under their own ad-hoc section or
    // vanish entirely when the standalone `air-bench-2024` family is dropped
    // below.
    //
    // Reconstruction is a guess, so nothing is planted that the hierarchy
    // does not already vouch for. When more than one source reports the
    // rollup, prefix × slice-key is a CROSS PRODUCT: with `helm-air-bench`
    // (60 real category rows) and `llm-stats` (the rollup only) both present,
    // it used to invent 59 `llm-stats%2F<slice>` ids, and every AIR-Bench
    // page then fetched all 59 as siblings and 404'd on each.
    //
    // The real fix belongs upstream: the producer should emit real slice
    // `evaluation_id`s on `bench.slices[]` (or in
    // `constituent_evaluation_ids`) and this reconstruction can be deleted.
    for (const composite of fam.composites ?? []) {
      for (const bench of composite.benchmarks ?? []) {
        if (!isAirBenchBenchmarkKey(bench.key)) continue
        const sourcePrefixes = new Set<string>()
        for (const id of bench.constituent_evaluation_ids ?? []) {
          if (id.includes("%2F")) sourcePrefixes.add(id.split("%2F")[0])
        }
        if (sourcePrefixes.size === 0) sourcePrefixes.add(composite.key)
        for (const slice of bench.slices ?? []) {
          // Only synthesise ids for real category slices (clean slugs). The
          // raw fine-subtask keys ("airbench 2024 - #1.1: ...") aren't real
          // evals.
          if (!/^[a-z0-9][a-z0-9._-]*$/.test(slice.key)) continue
          for (const prefix of sourcePrefixes) {
            const candidate = `${prefix}%2F${slice.key}`
            if (realEvalIds.has(candidate)) airBenchEvalIds.add(candidate)
          }
        }
      }
    }
  }

  // 1. Drop the standalone `air-bench-2024` family.
  h.families = (h.families ?? []).filter((f) => f.key !== "air-bench-2024")

  // 2. Strip AIR-Bench from non-HELM families (agentharm in practice).
  for (const fam of h.families) {
    if (fam.key === "helm") continue
    fam.constituent_evaluation_ids = (fam.constituent_evaluation_ids ?? []).filter(
      (id) => !airBenchEvalIds.has(id),
    )
    if (fam.benchmarks) {
      fam.benchmarks = fam.benchmarks.filter(
        (b) => !isAirBenchBenchmarkKey(b.key),
      )
    }
    if (fam.standalone_benchmarks) {
      fam.standalone_benchmarks = fam.standalone_benchmarks.filter(
        (b) => !isAirBenchBenchmarkKey(b.key),
      )
    }
    for (const c of fam.composites ?? []) {
      c.benchmarks = (c.benchmarks ?? []).filter(
        (b) => !isAirBenchBenchmarkKey(b.key),
      )
    }
  }

  // 3. Plant every AIR-Bench eval id under helm > helm-air-bench, and
  //    extend the composite's benchmark `constituent_evaluation_ids` so the
  //    hierarchy lookup routes them all to the same composite.
  const helm = h.families.find((f) => f.key === "helm")
  if (helm) {
    const helmIds = new Set(helm.constituent_evaluation_ids ?? [])
    for (const id of airBenchEvalIds) helmIds.add(id)
    helm.constituent_evaluation_ids = [...helmIds]

    const composite = (helm.composites ?? []).find(
      (c) => c.key === "helm-air-bench",
    )
    if (composite) {
      const bench =
        (composite.benchmarks ?? []).find((b) => b.key === "air-bench-2024") ??
        (composite.benchmarks ?? [])[0]
      if (bench) {
        const benchIds = new Set(bench.constituent_evaluation_ids ?? [])
        for (const id of airBenchEvalIds) benchIds.add(id)
        bench.constituent_evaluation_ids = [...benchIds]
      }
    }
  }
}

function flattenSplitFamilies(h: CleanableHierarchy) {
  for (const family of h.families ?? []) {
    const rule = SPLIT_FAMILIES[family.key]
    if (!rule) continue
    const fam = family as HierarchyFamily
    const collected: HierarchyBenchmark[] = [
      ...(fam.benchmarks ?? []),
      ...(fam.standalone_benchmarks ?? []),
      ...(fam.composites ?? []).flatMap((c) => c.benchmarks ?? []),
    ]
    if (collected.length === 0) continue
    const seenKeys = new Set<string>()
    const benchmarks = collected.filter((b) => {
      if (seenKeys.has(b.key)) return false
      seenKeys.add(b.key)
      return true
    })

    if (rule.mode === "composite") {
      const synthetic: HierarchyComposite = {
        key: rule.syntheticKey,
        display_name: rule.syntheticDisplayName,
        category: fam.category,
        tags: { domains: [], languages: [], tasks: [] },
        benchmarks,
      }
      fam.composites = [synthetic]
      fam.benchmarks = []
      fam.standalone_benchmarks = []
      fam.display_name = rule.syntheticDisplayName
      continue
    }

    if (rule.mode === "flatten-composites") {
      // Hoist every composite's children up to family.benchmarks so the
      // composites disappear and their children sit at the family level.
      // Drops empty composites entirely. Used for reward-bench (3
      // benchmarks artificially split across 2 composite wrappers).
      const seen = new Set<string>()
      const flat: HierarchyBenchmark[] = []
      for (const b of benchmarks) {
        if (seen.has(b.key)) continue
        seen.add(b.key)
        flat.push(b)
      }
      fam.benchmarks = flat
      fam.standalone_benchmarks = []
      fam.composites = []
      continue
    }

    if (rule.mode === "paren-suffix-metrics") {
      // Group siblings by display_name prefix; the parenthetical suffix
      // is treated as a metric label, not a split. HLE example:
      //   "Humanity's Last Exam (accuracy)" + "(calibration error)"
      //   → one benchmark "Humanity's Last Exam" with two metrics:
      //     "Accuracy", "Calibration Error".
      type Group = {
        prefix: string
        metrics: any[]
        summaryIds: Set<string>
      }
      const slugify = (s: string) =>
        s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      const titleize = (s: string) =>
        s
          .split(/\s+/)
          .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
          .join(" ")
      const groups = new Map<string, Group>()
      for (const child of benchmarks) {
        const display = String(child.display_name ?? child.key ?? "")
        const m = display.match(/^(.*?)\s*\(([^)]+)\)\s*$/u)
        const prefix = m ? m[1].trim() : display.trim()
        const metricLabel = m ? m[2].trim() : "Score"
        const group = groups.get(prefix) ?? {
          prefix,
          metrics: [],
          summaryIds: new Set<string>(),
        }
        // Collect this child's existing metric(s); rename their display
        // name to the parenthetical so the merged benchmark surfaces
        // "Accuracy" and "Calibration Error" rather than the upstream's
        // "Accuracy" / "Score".
        const childRoot =
          (child.slices ?? []).find((s: any) => s?.is_bare_stem === true) ??
          (child.slices ?? []).find((s: any) => (s?.metrics ?? []).length > 0) ??
          null
        const childMetrics = childRoot?.metrics ?? (child as any).metrics ?? []
        if (childMetrics.length > 0) {
          for (const metric of childMetrics) {
            group.metrics.push({
              ...metric,
              key: slugify(metricLabel) || metric.key,
              display_name: titleize(metricLabel),
            })
          }
        } else {
          group.metrics.push({
            key: slugify(metricLabel),
            display_name: titleize(metricLabel),
          })
        }
        for (const id of child.constituent_evaluation_ids ?? []) group.summaryIds.add(id)
        groups.set(prefix, group)
      }
      const standalones: HierarchyBenchmark[] = []
      for (const group of groups.values()) {
        const rootSlice = {
          key: slugify(group.prefix),
          display_name: group.prefix,
          slice_key: null,
          is_bare_stem: true,
          metrics: group.metrics,
        }
        standalones.push({
          key: slugify(group.prefix),
          display_name: group.prefix,
          tags: { domains: [], languages: [], tasks: [] },
          constituent_evaluation_ids: [...group.summaryIds],
          slices: [rootSlice],
        } as unknown as HierarchyBenchmark)
      }
      // Re-route family-level eval lookup to the merged benchmarks.
      const famIdsM = new Set<string>(fam.constituent_evaluation_ids ?? [])
      for (const s of standalones)
        for (const id of s.constituent_evaluation_ids ?? []) famIdsM.add(id)
      fam.constituent_evaluation_ids = [...famIdsM]
      fam.standalone_benchmarks = standalones
      fam.benchmarks = []
      fam.composites = []
      continue
    }

    if (rule.mode === "paren-suffix-splits") {
      // Group benchmarks by display_name prefix (everything before the
      // trailing "(...)" parenthetical). Each prefix becomes its own
      // standalone benchmark; the parenthetical content becomes the
      // split label. SWE-PolyBench Verified (Java) / (Python) / ... fold
      // into ONE standalone "SWE-PolyBench Verified" with 4 splits.
      type Group = {
        prefix: string
        slices: any[]
        summaryIds: Set<string>
      }
      const slugify = (s: string) =>
        s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      const groups = new Map<string, Group>()
      for (const child of benchmarks) {
        const display = String(child.display_name ?? child.key ?? "")
        const m = display.match(/^(.*?)\s*\(([^)]+)\)\s*$/u)
        const prefix = m ? m[1].trim() : display.trim()
        const splitLabel = m ? m[2].trim() : "Overall"
        const group = groups.get(prefix) ?? {
          prefix,
          slices: [],
          summaryIds: new Set<string>(),
        }
        const childRoot =
          (child.slices ?? []).find((s: any) => s?.is_bare_stem === true) ??
          (child.slices ?? []).find((s: any) => (s?.metrics ?? []).length > 0) ??
          null
        const childMetrics = childRoot?.metrics ?? (child as any).metrics ?? []
        for (const id of child.constituent_evaluation_ids ?? []) group.summaryIds.add(id)
        group.slices.push({
          key: slugify(splitLabel),
          display_name: splitLabel,
          slice_key: slugify(splitLabel),
          is_bare_stem: false,
          metrics: childMetrics,
        })
        groups.set(prefix, group)
      }
      const standalones: HierarchyBenchmark[] = []
      for (const group of groups.values()) {
        standalones.push({
          key: slugify(group.prefix),
          display_name: group.prefix,
          tags: { domains: [], languages: [], tasks: [] },
          constituent_evaluation_ids: [...group.summaryIds],
          slices: group.slices,
        } as unknown as HierarchyBenchmark)
      }
      // Re-route family-level eval lookup so split eval ids resolve to
      // the surviving benchmarks (frontend's plotbox builder otherwise
      // splits them back out into separate grids).
      const famIdsS = new Set<string>(fam.constituent_evaluation_ids ?? [])
      for (const s of standalones)
        for (const id of s.constituent_evaluation_ids ?? []) famIdsS.add(id)
      fam.constituent_evaluation_ids = [...famIdsS]
      fam.standalone_benchmarks = standalones
      fam.benchmarks = []
      fam.composites = []
      continue
    }

    // mode === "slices": collapse to a single standalone benchmark.
    // Two sub-cases:
    //   (a) one of the children already IS the canonical parent (key ==
    //       syntheticKey) AND carries its own slices — Fibble Arena's
    //       "fibble-arena" benchmark already ships the per-N-lies slices.
    //       Promote it as-is and drop the sibling duplicates.
    //   (b) parent has no slices (or no parent exists) — fold every child
    //       in as a slice (AgentHarm: parent benchmark + 8 category
    //       siblings, none with their own slices).
    const parent =
      benchmarks.find((b) => b.key === rule.syntheticKey) ?? null
    const parentSlices = (parent?.slices as any[] | undefined) ?? []
    if (parent && parentSlices.length > 0) {
      // Case (a): keep parent verbatim. Merge each dropped sibling's
      // `constituent_evaluation_ids` into the parent so the hierarchy lookup
      // routes orphaned eval rows (e.g. `fibble1-arena%2F…`) back to
      // the surviving Fibble Arena benchmark — without this the
      // model-detail plotbox builder rebuilds the splits as separate
      // grids.
      const mergedIds = new Set<string>(parent.constituent_evaluation_ids ?? [])
      for (const child of benchmarks) {
        if (child.key === parent.key) continue
        for (const id of child.constituent_evaluation_ids ?? []) mergedIds.add(id)
      }
      const standalone = {
        ...parent,
        display_name: rule.syntheticDisplayName,
        constituent_evaluation_ids: [...mergedIds],
      } as HierarchyBenchmark
      // Same fix at family level — `family.constituent_evaluation_ids` drives
      // `buildHierarchyEvalIndex`, so missing sibling ids would orphan
      // the lookup.
      const famIds = new Set<string>(fam.constituent_evaluation_ids ?? [])
      for (const id of mergedIds) famIds.add(id)
      fam.constituent_evaluation_ids = [...famIds]
      fam.standalone_benchmarks = [standalone]
      fam.benchmarks = []
      fam.composites = []
      fam.display_name = rule.syntheticDisplayName
      continue
    }

    // Case (b): synthesise slices from children.
    const allSummaryIds = new Set<string>()
    const slices: any[] = []
    if (parent) {
      for (const id of parent.constituent_evaluation_ids ?? []) allSummaryIds.add(id)
      const parentMetrics = (parent as any).metrics ?? []
      // Synthesise a root slice carrying the parent's own metrics so the
      // overall benchmark scope is preserved (AgentHarm rollup metrics).
      slices.push({
        key: rule.syntheticKey,
        display_name: rule.syntheticDisplayName,
        slice_key: null,
        is_bare_stem: true,
        metrics: parentMetrics,
      })
    } else {
      slices.push({
        key: rule.syntheticKey,
        display_name: rule.syntheticDisplayName,
        slice_key: null,
        is_bare_stem: true,
        metrics: [],
      })
    }
    for (const child of benchmarks) {
      if (child.key === rule.syntheticKey) continue
      for (const id of child.constituent_evaluation_ids ?? []) allSummaryIds.add(id)
      const childRoot =
        (child.slices ?? []).find((s: any) => s?.is_bare_stem === true) ??
        (child.slices ?? []).find((s: any) => (s?.metrics ?? []).length > 0) ??
        null
      const childMetrics = childRoot?.metrics ?? (child as any).metrics ?? []
      slices.push({
        key: child.key,
        display_name: child.display_name ?? child.key,
        slice_key: child.key,
        is_bare_stem: false,
        metrics: childMetrics,
      })
    }
    const standalone = {
      ...(parent ?? {}),
      key: rule.syntheticKey,
      display_name: rule.syntheticDisplayName,
      tags: parent?.tags ?? { domains: [], languages: [], tasks: [] },
      constituent_evaluation_ids: [...allSummaryIds],
      slices,
    } as unknown as HierarchyBenchmark
    // Make sure family-level lookup routes these eval ids back to the
    // surviving benchmark too (otherwise the model-detail plotbox
    // builder rebuilds the splits as separate grids).
    const famIds = new Set<string>(fam.constituent_evaluation_ids ?? [])
    for (const id of allSummaryIds) famIds.add(id)
    fam.constituent_evaluation_ids = [...famIds]
    fam.standalone_benchmarks = [standalone]
    fam.benchmarks = []
    fam.composites = []
    fam.display_name = (rule as { syntheticDisplayName: string }).syntheticDisplayName
  }
}

/**
 * Drop a grouping's own aggregate "leaderboard" rollup benchmark.
 *
 * Some sources ship, inside a composite (or a multi-benchmark family), an
 * extra benchmark that is just the aggregate score for the whole group —
 * e.g. HELM's `helm-safety` composite ("HELM Safety") carries a
 * `helm-safety-leaderboard` benchmark ("HELM-Safety-Leaderboard") that is
 * the composite's own rollup. Listing it as a sibling benchmark makes the
 * grouping show up as BOTH a family/group AND a benchmark — a semantic
 * duplicate ("HELM Safety" is only a family, not a benchmark). We strip the
 * rollup leaf so the group is only ever a group; the real member benchmarks
 * (BBQ, HarmBench, …) stay.
 *
 * Detection is deliberately narrow: a leaf qualifies only when its key is
 * the parent grouping's key plus a `-leaderboard` suffix
 * (`${parentKey}-leaderboard`). That suffix is an unambiguous rollup signal
 * — it catches all six HELM composites without touching real sibling
 * benchmarks whose slug merely coincides with the family (e.g.
 * `reward-bench`'s genuine `rewardbench` benchmark sitting beside
 * RewardBench 2 / Safety / Reasoning). We only strip within groups that
 * keep at least one other benchmark, so single-benchmark families — where
 * the lone bench legitimately IS the family — are never touched.
 *
 * We drop only the benchmark leaf, NOT the rollup's eval ids from
 * `family.constituent_evaluation_ids`. Those ids stay so the rollup eval row
 * still resolves to its family/composite in the hierarchy lookup (it just
 * no longer carries a benchmark-leaf label) — the row is an aggregate, not
 * a distinct benchmark, which is exactly the outcome we want.
 */
function dropGroupingLeaderboardRollups(h: CleanableHierarchy) {
  const slug = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "")
  const isSelfRollup = (b: HierarchyBenchmark, parentKey: string): boolean =>
    Boolean(b.key) &&
    b.key.endsWith("-leaderboard") &&
    slug(b.key.replace(/-leaderboard$/, "")) === slug(parentKey)

  const strip = (
    benches: HierarchyBenchmark[],
    parentKey: string,
  ): HierarchyBenchmark[] => {
    if (benches.length < 2) return benches
    const kept = benches.filter((b) => !isSelfRollup(b, parentKey))
    // Never empty a group; only apply when something actually dropped.
    return kept.length > 0 && kept.length < benches.length ? kept : benches
  }

  for (const fam of h.families ?? []) {
    // Composites are always groupings — strip their self-rollup leaf.
    for (const c of fam.composites ?? []) {
      if (c.benchmarks) c.benchmarks = strip(c.benchmarks, c.key)
    }
    // Family-level rollup (a `${family.key}-leaderboard` bench sitting
    // directly under a multi-benchmark family). None in the current
    // snapshot, but keep the hierarchy consistent if one appears.
    if (fam.benchmarks) fam.benchmarks = strip(fam.benchmarks, fam.key)
    if (fam.standalone_benchmarks) {
      fam.standalone_benchmarks = strip(fam.standalone_benchmarks, fam.key)
    }
  }
}

export function isHierarchyCleaned(h: EvalHierarchy | null | undefined): boolean {
  return Boolean((h as CleanableHierarchy | null | undefined)?.[CLEANED_MARKER])
}

function filterBenchmarkIndex(
  entries: BenchmarkIndexEntry[],
  survivingFamilyKeys: Set<string>,
): BenchmarkIndexEntry[] {
  const out: BenchmarkIndexEntry[] = []
  for (const entry of entries) {
    const distinctBenchKeys = new Set<string>()
    for (const app of entry.appearances ?? []) {
      if (app.benchmark_key) distinctBenchKeys.add(app.benchmark_key)
    }
    // True cross-family duplicates carry one canonical benchmark and so
    // collapse to ≤2 distinct keys (104/121 entries in a recent snapshot
    // are 1-key, 15 are 2-key; the bad rollups are 11 and 34).
    if (distinctBenchKeys.size > 2) continue

    const seenPair = new Set<string>()
    // First pass: drop appearances under families that no longer exist
    // post-consolidation, then dedupe (family, eval_summary_id) pairs.
    const cleanedApps: BenchmarkIndexAppearance[] = []
    for (const app of entry.appearances ?? []) {
      if (!survivingFamilyKeys.has(app.family_key)) continue
      const newIds: string[] = []
      for (const id of app.constituent_evaluation_ids ?? []) {
        const pair = `${app.family_key}::${id}`
        if (seenPair.has(pair)) continue
        seenPair.add(pair)
        newIds.push(id)
      }
      if (newIds.length === 0) continue
      cleanedApps.push({ ...app, constituent_evaluation_ids: newIds })
    }

    // Second pass: drop appearances whose eval_summary_id set is fully
    // contained in another appearance's set. Two appearances sharing the
    // same eval_summary_id are physically the same data plumbed under
    // different family keys (BBH was listed under both `big-bench` and
    // `big-bench-hard` families with the same `big-bench-hard%2Fbig-
    // bench-hard` id). Keep one — preferring an appearance whose
    // family.key matches the entry's canonical key, then by family-key
    // sort order so the choice is stable.
    const dedupedApps: BenchmarkIndexAppearance[] = []
    const dropped = new Set<number>()
    const idSet = (a: BenchmarkIndexAppearance) =>
      new Set(a.constituent_evaluation_ids ?? [])
    const isStrictlyContainedOrEqualWithLossTie = (
      iA: number,
      iB: number,
    ): boolean => {
      const a = cleanedApps[iA]
      const b = cleanedApps[iB]
      const aIds = idSet(a)
      const bIds = idSet(b)
      // a's ids ⊆ b's ids?
      for (const id of aIds) if (!bIds.has(id)) return false
      // strict subset OR tie where b is the canonical-home wrapper
      if (aIds.size < bIds.size) return true
      // tie — drop a if b's family key matches the entry's canonical key
      if (b.family_key === entry.key) return true
      return false
    }
    for (let i = 0; i < cleanedApps.length; i++) {
      if (dropped.has(i)) continue
      let drop = false
      for (let j = 0; j < cleanedApps.length; j++) {
        if (i === j || dropped.has(j)) continue
        if (isStrictlyContainedOrEqualWithLossTie(i, j)) {
          drop = true
          break
        }
      }
      if (drop) dropped.add(i)
    }
    for (let i = 0; i < cleanedApps.length; i++) {
      if (!dropped.has(i)) dedupedApps.push(cleanedApps[i])
    }

    // Skip degenerate entries: need ≥2 families AND ≥2 distinct
    // constituent_evaluation_ids for there to be something to cross-reference.
    const distinctFamilies = new Set(dedupedApps.map((a) => a.family_key))
    const distinctIds = new Set<string>()
    for (const a of dedupedApps) for (const id of a.constituent_evaluation_ids) distinctIds.add(id)
    if (distinctFamilies.size <= 1 || distinctIds.size <= 1) continue

    out.push({ ...entry, appearances: dedupedApps })
  }
  return out
}
