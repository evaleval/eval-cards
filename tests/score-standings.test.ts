import { describe, expect, it } from "vitest"

import {
  isAssistedResult,
  isHeadlineResult,
  scoreStandings,
} from "@/lib/eval-processing"

// A standing is the model's position in the field, not the row's position
// on screen. The benchmark table and the study leaderboard embed both
// assign it here, once, from the unassisted headline runs in score order,
// so sorting by a protocol axis reorders rows without renumbering anyone.

interface Run {
  name: string
  score: number
  is_headline?: boolean
  protocol_condition?: string
}

const run = (name: string, score: number, over: Partial<Run> = {}): Run => ({
  name,
  score,
  is_headline: true,
  ...over,
})

const assisted = JSON.stringify({ feedback: "answer_feedback" })

const standingsOf = (runs: Run[]) =>
  scoreStandings(
    runs,
    (r) => r.score,
    (r) => isHeadlineResult(r) && !isAssistedResult(r.protocol_condition),
  )

describe("scoreStandings", () => {
  it("ranks the headline runs and leaves the rest unranked", () => {
    const runs = [
      run("A", 0.9),
      run("A-secondary", 0.8, { is_headline: false }),
      run("B", 0.7),
      run("B-assisted", 1.0, { is_headline: false, protocol_condition: assisted }),
      run("C", 0.5),
    ]
    expect(standingsOf(runs)).toEqual([1, 0, 2, 0, 3])
  })

  it("never ranks an assisted run, even one served as a headline", () => {
    // The oracle told the model when it was right; that is not a standing.
    const runs = [run("A-assisted", 1.0, { protocol_condition: assisted }), run("A", 0.9)]
    expect(standingsOf(runs)).toEqual([0, 1])
  })

  it("gives tied scores the same standing and skips the numbers they share", () => {
    const runs = [run("A", 0.9), run("B", 0.9), run("C", 0.4)]
    expect(standingsOf(runs)).toEqual([1, 1, 3])
  })

  it("depends on the score order it is given, not on any later display order", () => {
    const runs = [run("A", 0.9), run("B", 0.7), run("C", 0.5)]
    const ranks = standingsOf(runs)
    // Whatever a protocol sort does to the rows afterwards, each row
    // carries the standing computed here.
    const carried = runs.map((r, i) => ({ name: r.name, rank: ranks[i] }))
    const reordered = [...carried].reverse()
    expect(reordered.map((r) => r.rank)).toEqual([3, 2, 1])
    expect(new Set(carried.map((r) => r.rank)).size).toBe(3)
  })

  it("counts one standing per ranked run, so a six-model study has six", () => {
    const models = ["a", "b", "c", "d", "e", "f"]
    const runs: Run[] = []
    models.forEach((name, i) => {
      runs.push(run(name, 1 - i / 10))
      // Each model also has secondary protocol points and assisted runs.
      runs.push(run(`${name}-2`, 0.3, { is_headline: false }))
      runs.push(run(`${name}-assisted`, 0.95, { is_headline: false, protocol_condition: assisted }))
    })
    const ranks = standingsOf(runs)
    expect(ranks.filter((rank) => rank > 0)).toHaveLength(6)
    expect(ranks.filter((rank) => rank === 0)).toHaveLength(12)
  })
})
