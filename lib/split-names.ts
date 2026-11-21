/**
 * How many leading whole words every split name shares.
 *
 * Splits of one benchmark usually repeat its name ("big bench hard boolean
 * expressions", "big bench hard causal judgement"), so the part that tells
 * them apart comes last. The count lets a list set the shared words back
 * and lead with the rest. It never removes anything: 0 for a single name,
 * and a name made only of the shared words keeps them all.
 */
export function sharedLeadingWordCount(names: string[]): number {
  if (names.length < 2) return 0
  const words = names.map((name) => name.trim().split(/\s+/))
  const shortest = Math.min(...words.map((w) => w.length))
  let count = 0
  while (count < shortest && words.every((w) => w[count].toLowerCase() === words[0][count].toLowerCase())) {
    count += 1
  }
  return count
}

/** A split name cut into the words it shares with its siblings and the rest. */
export function splitSharedPrefix(name: string, sharedWords: number): { shared: string; rest: string } {
  const words = name.trim().split(/\s+/)
  if (sharedWords <= 0 || words.length <= sharedWords) return { shared: "", rest: name.trim() }
  return { shared: words.slice(0, sharedWords).join(" "), rest: words.slice(sharedWords).join(" ") }
}
