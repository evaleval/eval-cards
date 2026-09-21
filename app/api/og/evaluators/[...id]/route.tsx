import { ImageResponse } from "next/og"

import { OG_CONTENT_TYPE, OG_SIZE, ellipsize, resolveBrandLogoUrl } from "@/app/api/og/_shared"
import { getEvaluatorSummaryBySlug } from "@/lib/data-backend"
import { routeIdFromSegments } from "@/lib/utils"

export const runtime = "nodejs"

/**
 * Dynamic OpenGraph image for an evaluator (reporting-org) page. Resolves
 * the org slug to its name + evals-reported/verified counts (same
 * derivation as the page) so the unfurl identifies the specific evaluator
 * rather than rendering the generic site card. Co-located under /api/og/
 * rather than as an `opengraph-image.tsx` sibling of the page because
 * Next.js 15 rejects metadata files inside catch-all (`[...id]`) folders.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string | string[] }> },
) {
  const { id } = await context.params
  const slug = routeIdFromSegments(id)

  let evaluatorName = "Evaluator"
  let evalCount: number | null = null
  let verifiedCount: number | null = null
  let resolved = true

  try {
    const summary = await getEvaluatorSummaryBySlug(slug)
    if (summary) {
      evaluatorName = summary.name ?? evaluatorName
      evalCount = summary.evalCount ?? null
      verifiedCount = summary.verifiedCount ?? null
    } else {
      resolved = false
    }
  } catch {
    // A failed read is not evidence that the org does not exist, so
    // keep the generic card rather than claiming the evaluator is gone.
  }

  // No org behind the slug means no card: the page is a 404 and its
  // unfurl must not answer 200 with a plausible-looking evaluator.
  if (!resolved) {
    return new Response("Evaluator not found", { status: 404 })
  }

  const logoUrl = resolveBrandLogoUrl(request)
  const displayName = ellipsize(evaluatorName, 64)

  const response = new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#faf9f6",
          color: "#1a1916",
          fontFamily: "Inter, sans-serif",
          padding: "72px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={logoUrl}
            width={56}
            height={56}
            alt=""
            style={{ borderRadius: "4px" }}
          />
          <div style={{ fontSize: "26px", fontWeight: 700, letterSpacing: "-0.01em" }}>
            Evaluation Cards
          </div>
          <div
            style={{
              fontFamily: "monospace",
              fontSize: "14px",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: "#9c9a95",
              paddingLeft: "20px",
              marginLeft: "8px",
              borderLeft: "1px solid #e8e6e1",
              display: "flex",
              alignItems: "center",
              height: "32px",
            }}
          >
            Evaluator
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "20px",
            flex: 1,
            justifyContent: "center",
            paddingTop: "8px",
          }}
        >
          <div
            style={{
              fontFamily: "monospace",
              fontSize: "16px",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: "#5bacd1",
              fontWeight: 600,
            }}
          >
            Evaluator
          </div>
          <div
            style={{
              fontSize: "88px",
              lineHeight: 1.02,
              letterSpacing: "-0.04em",
              fontWeight: 700,
              maxWidth: "1060px",
              wordBreak: "break-word",
            }}
          >
            {displayName}
          </div>
          {evalCount != null && (
            <div style={{ fontSize: "26px", color: "#5c5a55", lineHeight: 1.4 }}>
              {[
                `${evalCount.toLocaleString("en-US")} ${evalCount === 1 ? "evaluation reported" : "evaluations reported"}`,
                verifiedCount != null && verifiedCount > 0
                  ? `${verifiedCount.toLocaleString("en-US")} verified`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingTop: "26px",
            borderTop: "1px solid #1a1916",
            fontFamily: "monospace",
            fontSize: "15px",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "#5c5a55",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            <span style={{ color: "#1a1916", fontWeight: 600 }}>Reproducibility</span>
            <span style={{ color: "#9c9a95" }}>·</span>
            <span style={{ color: "#1a1916", fontWeight: 600 }}>Completeness</span>
            <span style={{ color: "#9c9a95" }}>·</span>
            <span style={{ color: "#1a1916", fontWeight: 600 }}>Provenance</span>
            <span style={{ color: "#9c9a95" }}>·</span>
            <span style={{ color: "#1a1916", fontWeight: 600 }}>Comparability</span>
          </div>
          <div style={{ color: "#9c9a95" }}>Evaluation Cards</div>
        </div>
      </div>
    ),
    OG_SIZE,
  )
  response.headers.set("content-type", OG_CONTENT_TYPE)
  response.headers.set("cache-control", "public, max-age=3600, s-maxage=86400")
  return response
}
