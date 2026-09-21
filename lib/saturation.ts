export type SaturationCategory = "very_low" | "low" | "moderate" | "high" | "very_high"

/**
 * Compute effective sample size.
 *
 * @param n Actual test set size
 * @param alpha Exponent for effective sample size (default 0.5).
 *   alpha ∈ [0,1], where alpha=0.5 gives n_eff = sqrt(n)
 * @returns Effective sample size n_eff = n^alpha
 */
export function computeNEff(n: number, alpha = 0.5): number {
  if (n <= 0) throw new Error(`Test set size must be positive, got ${n}`)
  if (alpha < 0 || alpha > 1) throw new Error(`Alpha must be in [0, 1], got ${alpha}`)
  return Math.pow(n, alpha)
}

/**
 * Compute standard error for a model score.
 *
 * @param score Model performance score (assumed to be in [0, 1])
 * @param nEff Effective sample size
 * @returns Standard error SE(s) ≈ sqrt(s(1-s) / n_eff)
 */
export function computeStandardError(score: number, nEff: number): number {
  if (score < 0 || score > 1) throw new Error(`Score must be in [0, 1], got ${score}`)
  if (nEff <= 0) throw new Error(`Effective sample size must be positive, got ${nEff}`)
  if (score === 0 || score === 1) return 0
  return Math.sqrt((score * (1 - score)) / nEff)
}

/**
 * Compute standard error of the difference between top and Nth model.
 *
 * @param s1 Top model score
 * @param sN Nth model score
 * @param nEff Effective sample size
 * @returns SE_Δ ≈ sqrt(SE(s1)^2 + SE(sN)^2)
 */
export function computeSeDelta(s1: number, sN: number, nEff: number): number {
  const se1 = computeStandardError(s1, nEff)
  const seN = computeStandardError(sN, nEff)
  return Math.sqrt(se1 ** 2 + seN ** 2)
}

/**
 * Compute normalized score range.
 *
 * @param s1 Top model score
 * @param sN Nth model score
 * @param seDelta Standard error of the difference
 * @returns R_norm = (s1 - sN) / SE_Δ
 *
 * Note: When se_delta is 0 (all models have identical scores at boundaries),
 * returns 0.0 to indicate maximum compression.
 */
export function computeNormalizedRange(s1: number, sN: number, seDelta: number): number {
  if (seDelta === 0) return s1 === sN ? 0 : Number.POSITIVE_INFINITY
  return (s1 - sN) / seDelta
}

/**
 * Compute saturation index from normalized range.
 *
 * @param rNorm Normalized score range
 * @returns S_index = exp(-R_norm^2) ∈ [0, 1]
 *
 * Higher values indicate stronger saturation (top models are clustered
 * within evaluation uncertainty).
 */
export function computeSaturationIndex(rNorm: number): number {
  return Math.exp(-(rNorm ** 2))
}

/**
 * Categorize saturation level based on S_index value.
 *
 * @param sIndex Saturation index in [0, 1]
 * @returns One of: "very_low", "low", "moderate", "high", "very_high"
 *
 * Categories:
 * - very_low: S_index < 0.01 (strong discriminative power)
 * - low: 0.01 ≤ S_index < 0.3 (some clustering, meaningful separations remain)
 * - moderate: 0.3 ≤ S_index < 0.7 (compression observed, sensitivity weakening)
 * - high: 0.7 ≤ S_index < 0.9 (models largely indistinguishable)
 * - very_high: S_index ≥ 0.9 (no reliable signal for comparison)
 */
export function categorizeSaturation(sIndex: number): SaturationCategory {
  if (sIndex < 0 || sIndex > 1) throw new Error(`S_index must be in [0, 1], got ${sIndex}`)
  if (sIndex < 0.01) return "very_low"
  if (sIndex < 0.3) return "low"
  if (sIndex < 0.7) return "moderate"
  if (sIndex < 0.9) return "high"
  return "very_high"
}

export interface SaturationMetrics {
  s1: number
  sN: number
  scoreRange: number
  meanScore: number
  nEff: number
  seDelta: number
  rNorm: number
  sIndex: number
  category: SaturationCategory
  isStatisticallySimilar: boolean
}

/**
 * Compute comprehensive saturation metrics for a group of models.
 *
 * @param scores List of model scores (should be at least topN scores)
 * @param testSetSize Size of the test set
 * @param topN Number of top models to compare. The paper hardcodes this at
 *   5; here it's a parameter so callers with fewer reported models can pass
 *   a smaller N (default 5, matching the paper).
 * @param alpha Exponent for effective sample size (default 0.5)
 * @param z Standard normal quantile for confidence (default 1.96 for 95%)
 * @returns Object containing:
 *   - s1, sN: Top and Nth model scores
 *   - scoreRange: s1 - sN
 *   - meanScore: Average of all scores
 *   - nEff: Effective sample size
 *   - seDelta: Standard error of difference
 *   - rNorm: Normalized score range
 *   - sIndex: Saturation index
 *   - category: Saturation category
 *   - isStatisticallySimilar: Whether Δ ≤ z * SE_Δ
 */
export function computeSaturationMetrics(
  scores: number[],
  testSetSize: number,
  topN = 5,
  alpha = 0.5,
  z = 1.96,
): SaturationMetrics {
  if (scores.length < topN) {
    throw new Error(`Need at least ${topN} scores, got ${scores.length}`)
  }

  const sorted = [...scores].sort((a, b) => b - a)
  const s1 = sorted[0]
  const sN = sorted[topN - 1]

  const nEff = computeNEff(testSetSize, alpha)
  const seDelta = computeSeDelta(s1, sN, nEff)
  const rNorm = computeNormalizedRange(s1, sN, seDelta)
  const sIndexRaw = computeSaturationIndex(rNorm)
  const sIndex = Math.min(1, Math.max(0, sIndexRaw))
  const category = categorizeSaturation(sIndex)

  const delta = s1 - sN
  const isStatisticallySimilar = delta <= z * seDelta

  return {
    s1,
    sN,
    scoreRange: delta,
    meanScore: scores.reduce((a, b) => a + b, 0) / scores.length,
    nEff,
    seDelta,
    rNorm,
    sIndex,
    category,
    isStatisticallySimilar,
  }
}
