import { notFound } from "next/navigation"

import { EvaluatorDetailView } from "@/components/evaluator/evaluator-detail-view"
import { getEvaluatorSummaryBySlug } from "@/lib/data-backend"
import { routeIdFromSegments } from "@/lib/utils"

/**
 * Server shell for the evaluator (reporting-org) detail page. The slug is
 * resolved here so a slug that names no org answers with a real 404
 * instead of a 200 whose body says "Evaluator not found". The status is
 * what crawlers, link checkers and anything but a human reader go by.
 */
export default async function EvaluatorDetailPage(props: {
  params: Promise<{ id: string | string[] }>
}) {
  const { id } = await props.params
  const summary = await getEvaluatorSummaryBySlug(routeIdFromSegments(id))
  if (!summary) notFound()

  return <EvaluatorDetailView />
}
