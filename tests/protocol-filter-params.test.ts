import { describe, expect, it } from "vitest"

import { parseProtocolFilters } from "@/lib/use-protocol-filters"

// Axis names come from the URL, so a crafted one must not be able to
// reach an inherited property or invent a filter the page has no column
// for. `?protocol.__proto__=x` read through a plain object hands back
// Object.prototype, which the caller then tries to spread.

const AXES = ["token_limit", "reasoning_tokens"]

const parse = (query: string, axes: string[] = AXES) =>
  parseProtocolFilters(new URLSearchParams(query), axes)

describe("parseProtocolFilters", () => {
  it("reads the selected values of a known axis", () => {
    const selected = parse("protocol.token_limit=number%3A50000000&metric=accuracy")
    expect(Array.from(selected.entries())).toEqual([
      ["token_limit", ["number:50000000"]],
    ])
  })

  it("keeps every repeated value for one axis", () => {
    const selected = parse(
      "protocol.reasoning_tokens=number%3A16000&protocol.reasoning_tokens=missing%3Anot_reported",
    )
    expect(selected.get("reasoning_tokens")).toEqual([
      "number:16000",
      "missing:not_reported",
    ])
  })

  it("survives prototype-shaped axis names", () => {
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const selected = parse(`protocol.${name}=x`)
      expect(selected.size).toBe(0)
      expect(selected.get(name)).toBeUndefined()
      // Whatever the caller does with the result, it is an array or nothing.
      expect(Array.isArray(selected.get(name) ?? [])).toBe(true)
    }
  })

  it("accepts a prototype-shaped name only when the page has that column", () => {
    const selected = parse("protocol.constructor=string%3Ax", ["constructor"])
    expect(selected.get("constructor")).toEqual(["string:x"])
  })

  it("ignores an axis the page has no column for, and an empty axis name", () => {
    expect(parse("protocol.made_up=number%3A1").size).toBe(0)
    expect(parse("protocol.=number%3A1").size).toBe(0)
    expect(parse("protocol=number%3A1").size).toBe(0)
  })
})
