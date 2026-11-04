// GET ?month=YYYY-MM: the costs page as CSV, one line per customer, for invoicing. Test traffic
// (staging domains, partner staff) has its own columns and is left out of the customer price.

import { customerCostCents } from "@/lib/costs.ts";
import { loadCosts, loadSettings } from "@/lib/dashboard.ts";
import { currency } from "@/lib/env.ts";
import { isMonth, toCsv, withMarkup } from "@/lib/metrics.ts";
import { retriesByTenant } from "@/lib/report.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const month = new URL(request.url).searchParams.get("month");
  if (!isMonth(month)) return new Response("month must be YYYY-MM", { status: 400 });

  const [report, settings, retries] = await Promise.all([loadCosts(month), loadSettings(), retriesByTenant(month)]);
  const code = currency();
  const markup = settings?.markupPercent ?? 0;
  const amount = (cents: number) => (cents / 100).toFixed(2);
  const csv = toCsv([
    [
      "Customer",
      "Month",
      "Questions",
      "Nuclia tokens",
      `Cost (${code})`,
      "Test questions",
      `Test traffic cost (${code})`,
      `Customer price (${code})`,
      "Days without a cost",
      "Retries",
    ],
    ...report.lines.map((l) => [
      l.name,
      month,
      l.questions,
      l.queryTokens.toFixed(6),
      amount(l.costCents),
      l.test.questions,
      amount(l.test.costCents),
      amount(withMarkup(customerCostCents(l.costCents, l.test), markup)),
      l.unpricedDays,
      retries.get(l.tenantId) ?? 0,
    ]),
  ]);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="launchpad-costs-${month}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
