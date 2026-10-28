/**
 * Shared benchmark name normalization utilities.
 * This file has NO "server-only" restriction so it can be imported from client components.
 */

export const AUTO_BENCHMARKCARDS_DATASET_URL = "https://huggingface.co/datasets/evaleval/auto-benchmarkcards"

/**
 * Normalize a benchmark name to a stable lookup key.
 * Strips composite prefixes like "hfopenllm_v2/", lowercases, collapses whitespace.
 */
export function normalizeBenchmarkKey(name: string): string {
  if (!name) return ""
  return name
    .replace(/^[a-z0-9_]+ ?\//i, "") // strip "hfopenllm_v2/" etc.
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Build multiple candidate lookup keys for a benchmark name.
 */
export function candidateBenchmarkKeys(name: string): string[] {
  const base = normalizeBenchmarkKey(name)
  return Array.from(
    new Set([
      base,
      base.replace(/-/g, " "),
      base.replace(/ /g, "-"),
      base.replace(/[^a-z0-9]/g, ""),
    ])
  )
}

/**
 * Given a record of BenchmarkCards and a benchmark name, find the matching card.
 */
export function lookupBenchmarkCard<T>(
  cards: Record<string, T>,
  benchmarkName: string
): T | undefined {
  for (const key of candidateBenchmarkKeys(benchmarkName)) {
    if (cards[key]) return cards[key]
  }
  // Fuzzy: check if any card key starts with or contains the name
  const base = normalizeBenchmarkKey(benchmarkName)
  for (const [cardKey, card] of Object.entries(cards)) {
    if (cardKey.includes(base) || base.includes(cardKey)) return card
  }
  return undefined
}
