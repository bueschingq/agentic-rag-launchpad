// GET ?month=YYYY-MM[&test=1]: the client report as CSV: its funnel, counts and question lists, never
// the cost. Hidden questions and test traffic are left out as on the report.

import { isMonth, toCsv } from "@/lib/metrics.ts";
import { loadReport, reportRows } from "@/lib/report.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const query = new URL(request.url).searchParams;
  const month = query.get("month");
  if (!isMonth(month)) return new Response("month must be YYYY-MM", { status: 400 });
  const report = await loadReport(id, month, { withTest: query.get("test") === "1" });
  if (!report) return new Response("Not found", { status: 404 });
  if (report.empty) return new Response("This customer has no deployments yet.", { status: 404 });
  return new Response(toCsv(reportRows(report)), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="report-${month}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
