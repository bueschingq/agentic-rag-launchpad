// What each customer cost in a month at the contract rate, and what to bill them with the
// partner's markup. The CSV export carries the same lines for invoicing.

import Link from "next/link";
import { loadCosts, loadSettings } from "@/lib/dashboard.ts";
import { currency } from "@/lib/env.ts";
import { formatCount, formatMoney, formatMonth, formatPercent } from "@/lib/format.ts";
import { isoDay, isMonth, withMarkup } from "@/lib/metrics.ts";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ month?: string | string[] }> };

export default async function CostsPage({ searchParams }: Props) {
  const { month: requested } = await searchParams;
  const thisMonth = isoDay(new Date()).slice(0, 7);
  const month = isMonth(requested) ? requested : thisMonth;
  const [report, settings] = await Promise.all([loadCosts(month), loadSettings()]);

  const code = currency();
  const money = (cents: number) => formatMoney(cents, code);
  const markup = settings?.markupPercent ?? 0;
  const rate = settings?.contractRates.nuclia_tokens;
  const months = [...new Set([thisMonth, month, ...report.months])].sort().reverse();
  const total = (key: "questions" | "costCents" | "unpricedDays") => report.lines.reduce((n, l) => n + l[key], 0);
  const totalTokens = report.lines.reduce((n, l) => n + l.queryTokens, 0);
  const rateText = rate === undefined ? "no contract rate set" : `${rate} ${code} per nuclia token`;

  return (
    <main className="shell">
      <div className="page-head">
        <h1>Costs</h1>
        <p className="muted">{`Query cost at ${rateText}, with a ${markup}% markup for the customer price.`}</p>
      </div>

      <nav className="months" aria-label="Month">
        <ul>
          {months.map((m) => (
            <li key={m}>
              <Link href={`/costs?month=${m}`} aria-current={m === month ? "page" : undefined}>
                {formatMonth(m)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <section className="panel">
        <div className="panel-head">
          <h2>{formatMonth(month)}</h2>
          {report.lines.length > 0 && (
            <a className="button" href={`/costs/export?month=${month}`} download>
              Download CSV
            </a>
          )}
        </div>
        {report.lines.length === 0 ? (
          <p className="muted">No usage was recorded in {formatMonth(month)}.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col" className="num">
                    Questions
                  </th>
                  <th scope="col" className="num">
                    Nuclia tokens
                  </th>
                  <th scope="col" className="num">
                    Cost
                  </th>
                  <th scope="col" className="num">
                    Customer price
                  </th>
                  <th scope="col" className="num">
                    Budget used
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.lines.map((l) => (
                  <tr key={l.tenantId}>
                    <th scope="row">
                      <Link href={`/customers/${l.tenantId}`}>{l.name}</Link>
                    </th>
                    <td className="num">{formatCount(l.questions)}</td>
                    <td className="num">{l.queryTokens.toFixed(1)}</td>
                    <td className="num">{money(l.costCents)}</td>
                    <td className="num">{money(withMarkup(l.costCents, markup))}</td>
                    <td className="num">{l.monthlyBudgetCents ? formatPercent(l.costCents / l.monthlyBudgetCents) : "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  <td className="num">{formatCount(total("questions"))}</td>
                  <td className="num">{totalTokens.toFixed(1)}</td>
                  <td className="num">{money(total("costCents"))}</td>
                  <td className="num">{money(withMarkup(total("costCents"), markup))}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {total("unpricedDays") > 0 && (
          <p className="note">
            {total("unpricedDays")} customer-days have questions but no cost, because no contract rate was set when they were rolled up.
          </p>
        )}
      </section>
    </main>
  );
}
