// What each customer cost in a month at the contract rate, and what to bill them with the
// partner's markup. The CSV export carries the same lines for invoicing. A question the widget
// asked again counts once; its retries show here, as "N retries", because their spend is real.

import Link from "next/link";
import { TableScroll } from "@/components/ui.tsx";
import { customerCostCents } from "@/lib/costs.ts";
import { loadCosts, loadSettings } from "@/lib/dashboard.ts";
import { currency } from "@/lib/env.ts";
import { formatCount, formatMoney, formatMonth, formatPercent, formatTokens } from "@/lib/format.ts";
import { isMonth, isoDay, withMarkup } from "@/lib/metrics.ts";
import { retriesByTenant } from "@/lib/report.ts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Costs" };

type Props = { searchParams: Promise<{ month?: string | string[] }> };

export default async function CostsPage({ searchParams }: Props) {
  const { month: requested } = await searchParams;
  const thisMonth = isoDay(new Date()).slice(0, 7);
  const month = isMonth(requested) ? requested : thisMonth;
  const [report, settings, retries] = await Promise.all([loadCosts(month), loadSettings(), retriesByTenant(month)]);

  const code = currency();
  const money = (cents: number) => formatMoney(cents, code);
  const markup = settings?.markupPercent ?? 0;
  const rate = settings?.contractRates.nuclia_tokens;
  const months = [...new Set([thisMonth, month, ...report.months])].sort().reverse();
  const total = (key: "questions" | "costCents" | "unpricedDays") => report.lines.reduce((n, l) => n + l[key], 0);
  const totalTokens = report.lines.reduce((n, l) => n + l.queryTokens, 0);
  const totalRetries = report.lines.reduce((n, l) => n + (retries.get(l.tenantId) ?? 0), 0);
  const testQuestions = report.lines.reduce((n, l) => n + l.test.questions, 0);
  const testCost = report.lines.reduce((n, l) => n + l.test.costCents, 0);
  const customerCost = report.lines.reduce((n, l) => n + customerCostCents(l.costCents, l.test), 0);
  const retryNote = (n: number) => (n ? <span className="muted"> · {`${formatCount(n)} ${n === 1 ? "retry" : "retries"}`}</span> : null);
  const rateText = rate === undefined ? "no contract rate set" : `${rate} ${code} per nuclia token`;

  return (
    <main id="main" className="shell">
      <div className="page-head">
        <h1>Costs</h1>
        <p className="muted">{`Query cost at ${rateText}, with a ${markup}% markup for the customer price. Test traffic isn't in the customer price.`}</p>
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
          <TableScroll label="Costs by customer">
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
                    Test traffic
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
                    <td className="num">
                      {formatCount(l.questions)}
                      {retryNote(retries.get(l.tenantId) ?? 0)}
                    </td>
                    <td className="num">{formatTokens(l.queryTokens)}</td>
                    <td className="num">{money(l.costCents)}</td>
                    <td className="num">
                      {l.test.questions
                        ? `${money(l.test.costCents)} · ${formatCount(l.test.questions)} ${l.test.questions === 1 ? "question" : "questions"}`
                        : "—"}
                    </td>
                    <td className="num">{money(withMarkup(customerCostCents(l.costCents, l.test), markup))}</td>
                    <td className="num">{l.monthlyBudgetCents ? formatPercent(l.costCents / l.monthlyBudgetCents) : "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  <td className="num">
                    {formatCount(total("questions"))}
                    {retryNote(totalRetries)}
                  </td>
                  <td className="num">{formatTokens(totalTokens)}</td>
                  <td className="num">{money(total("costCents"))}</td>
                  <td className="num">
                    {testQuestions
                      ? `${money(testCost)} · ${formatCount(testQuestions)} ${testQuestions === 1 ? "question" : "questions"}`
                      : "—"}
                  </td>
                  <td className="num">{money(withMarkup(customerCost, markup))}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </TableScroll>
        )}
        {totalRetries > 0 && (
          <p className="note">
            Retries: the chat asked a question again after a reply with no answer. Each counts once in Questions and in the client's report;
            the tokens of every attempt are in the cost.
          </p>
        )}
        {testQuestions > 0 && (
          <p className="note">
            Test traffic: questions from a deployment's staging domains or asked by your staff, with the part of the cost they account for.
            It's in Cost, and left out of the customer price, as the client's report leaves it out.
          </p>
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
