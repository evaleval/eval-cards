import { gunzipSync } from "node:zlib"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { parseJsonWithBounds } from "@/lib/json-bounds"

import { useSnapshot } from "./comparison-fixture"

// The slice route keeps the response contract the whole-index route had:
// gzip when accepted, identical JSON either way, a stable ETag and 304s.

const CACHE_CONTROL = "public, max-age=600, stale-while-revalidate=3600"

const CASES = [
  { label: "model slice", query: `?model=${encodeURIComponent("openai%2Fgpt-5.5")}` },
  {
    label: "evals slice",
    query: `?evals=${["llm-stats%2Fwmdp", "benchpress%2Fwmdp", "wmdp"].map(encodeURIComponent).join(",")}`,
  },
]

let restore: () => void
let GET: (request: Request) => Promise<Response>

beforeAll(async () => {
  restore = useSnapshot()
  GET = (await import("@/app/api/comparison-index/route")).GET
})

afterAll(() => restore?.())

const call = (query: string, headers: Record<string, string> = {}) =>
  GET(new Request(`http://localhost/api/comparison-index${query}`, { headers }))

const bodyText = async (response: Response) => {
  const bytes = Buffer.from(await response.arrayBuffer())
  return response.headers.get("content-encoding") === "gzip" ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8")
}

describe.each(CASES)("GET /api/comparison-index $label", ({ query }) => {
  it("serves the same JSON gzipped or not, with the content headers", async () => {
    const gz = await call(query, { "accept-encoding": "gzip, deflate" })
    const plain = await call(query)
    for (const response of [gz, plain]) {
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
      expect(response.headers.get("vary")).toBe("Accept-Encoding")
      expect(response.headers.get("cache-control")).toBe(CACHE_CONTROL)
    }
    expect(gz.headers.get("content-encoding")).toBe("gzip")
    expect(plain.headers.get("content-encoding")).toBeNull()
    const [gzText, plainText] = await Promise.all([bodyText(gz), bodyText(plain)])
    expect(gzText).toBe(plainText)
    expect(parseJsonWithBounds(gzText)).toStrictEqual(parseJsonWithBounds(plainText))
  })

  it("keeps one ETag across identical requests and encodings", async () => {
    const etags = [
      (await call(query, { "accept-encoding": "gzip" })).headers.get("etag"),
      (await call(query, { "accept-encoding": "gzip" })).headers.get("etag"),
      (await call(query)).headers.get("etag"),
    ]
    expect(etags[0]).toBeTruthy()
    expect(new Set(etags).size).toBe(1)
  })

  it("answers a matching If-None-Match with an empty 304", async () => {
    const etag = (await call(query)).headers.get("etag")!
    const response = await call(query, { "if-none-match": etag, "accept-encoding": "gzip" })
    expect(response.status).toBe(304)
    expect(response.headers.get("etag")).toBe(etag)
    expect(response.headers.get("cache-control")).toBe(CACHE_CONTROL)
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  })
})
