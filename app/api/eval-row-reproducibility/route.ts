import { NextResponse } from "next/server"

import { getEvalRowReproducibility } from "@/lib/data-backend"

// Setup-item evidence for one leaderboard row, fetched when the researcher
// card opens: ?row=<result_row>&snapshot=<the page's snapshot_id>. 404 when
// this server holds another snapshot or has no such row.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const rowParam = searchParams.get("row")
  const snapshot = searchParams.get("snapshot")
  const resultRow = Number(rowParam)

  if (!rowParam || !Number.isInteger(resultRow) || resultRow < 0 || !snapshot) {
    return NextResponse.json({ error: "Missing or invalid row or snapshot" }, { status: 400 })
  }

  const payload = await getEvalRowReproducibility(resultRow, snapshot)

  if (!payload) {
    return NextResponse.json({ error: "No reproducibility data for this row" }, { status: 404 })
  }

  return NextResponse.json(payload)
}
