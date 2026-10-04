import { gzipJson } from "@/lib/cached-json-response"
import { MAX_EVAL_IDS } from "@/lib/comparison-table"
import { fetchComparisonSlice } from "@/lib/hf-data"

// Serves the comparison index sliced to one page: `?model=<route_id>` for a
// model page and its embeds, `?evals=<id,id,...>` for the cross-suite siblings
// an eval page reads. Slices are small queries over in-memory tables, so each
// request builds its own; the gzip + ETag/304 headers stay as before.

function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 })
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const model = params.get("model")
  const evalsParam = params.get("evals")

  let slice
  if (model && evalsParam == null) {
    slice = await fetchComparisonSlice({ model })
  } else if (evalsParam != null && !model) {
    const ids = [...new Set(evalsParam.split(",").filter(Boolean))].sort()
    if (ids.length === 0) return badRequest("evals must list at least one evaluation id")
    if (ids.length > MAX_EVAL_IDS) return badRequest(`evals accepts at most ${MAX_EVAL_IDS} ids`)
    slice = await fetchComparisonSlice({ evals: ids })
  } else {
    return badRequest("pass exactly one of ?model=<route_id> or ?evals=<id,id,...>")
  }

  if (!slice) {
    return Response.json({ error: "comparison data unavailable for this snapshot" }, { status: 503 })
  }
  return gzipJson(request, slice)
}
