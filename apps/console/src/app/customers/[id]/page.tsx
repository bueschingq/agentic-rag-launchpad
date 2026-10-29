// One customer: spend against budget, daily questions and cost, each deployment, and answer
// quality per deployment.

import Link from "next/link";
import { notFound } from "next/navigation";
import { BarChart } from "@/components/bar-chart.tsx";
import { Alerts, Meter, QualityValue, StatTile, StatusBadge } from "@/components/ui.tsx";
import { loadDashboard } from "@/lib/dashboard.ts";
import { currency } from "@/lib/env.ts";
import {
  formatAgo,
  formatChange,
  formatCount,
  formatDay,
  formatMoney,
  formatMoneyTick,
  formatPercent,
  formatScore,
  formatSigned,
} from "@/lib/format.ts";
import { shiftDay } from "@/lib/metrics.ts";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export default async function CustomerPage({ params }: Params) {
  const { id } = await params;
  const now = new Date();
  const dash = await loadDashboard(now);
  const tenant = dash.tenants.find((t) => t.id === id);
  if (!tenant) notFound();

  const code = currency();
  const money = (cents: number) => formatMoney(cents, code);
  const { usage, quality } = tenant;
  const budget = tenant.monthlyBudgetCents;
  const days = usage.daily;
  const busiest = days.reduce((a, b) => (b.questions > a.questions ? b : a));
  const totalCost = days.reduce((n, p) => n + p.costCents, 0);
  const plural = tenant.deployments.length === 1 ? "deployment" : "deployments";
  const subtitle = `${tenant.deployments.length} ${plural} · figures to ${formatDay(shiftDay(dash.today, -1))}`;
  const change = formatChange(usage.questions30, usage.questionsPrev30);
  const trend = quality.trend === undefined ? "REMi score out of 5" : `${formatSigned(quality.trend)} on the week before`;
  const peak = `most on ${formatDay(busiest.day)} (${busiest.questions})`;
  const questionSummary = `${formatCount(usage.questions30)} questions over the last 30 days, ${peak}.`;

  return (
    <main className="shell">
      <p className="crumbs">
        <Link href="/">Fleet</Link>
      </p>
      <div className="page-head">
        <h1>{tenant.name}</h1>
        <p className="muted">{subtitle}</p>
      </div>

      {tenant.alerts.length > 0 && (
        <section className="callout" aria-label="Alerts">
          <Alerts alerts={tenant.alerts} />
        </section>
      )}

      <section className="tiles" aria-label="Summary">
        <StatTile
          label="Cost this month"
          value={money(usage.monthCents)}
          detail={budget ? `${formatPercent(usage.monthCents / budget)} of the ${money(budget)} budget` : "No monthly budget set"}
        >
          {budget ? <Meter ratio={usage.monthCents / budget} /> : null}
        </StatTile>
        <StatTile label="Projected by month end" value={money(usage.projectedCents)} detail="At the last 7 days' pace" />
        <StatTile
          label="Questions, last 30 days"
          value={formatCount(usage.questions30)}
          detail={change && `${change} on the 30 days before`}
        />
        <StatTile label="Answer relevance, last 30 days" value={formatScore(quality.answerRelevance)} detail={trend} />
      </section>

      <section className="panel charts">
        <BarChart
          title="Questions per day"
          summary={questionSummary}
          points={days.map((p) => ({ key: p.day, label: formatDay(p.day), value: p.questions, display: formatCount(p.questions) }))}
          tick={formatCount}
        />
        <BarChart
          title="Cost per day"
          summary={`${money(totalCost)} over the last 30 days.`}
          points={days.map((p) => ({ key: p.day, label: formatDay(p.day), value: p.costCents, display: money(p.costCents) }))}
          tick={(cents) => formatMoneyTick(cents, code)}
        />
        <details className="daily">
          <summary>Daily figures</summary>
          <table>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col" className="num">
                  Questions
                </th>
                <th scope="col" className="num">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody>
              {days.map((p) => (
                <tr key={p.day}>
                  <th scope="row">{formatDay(p.day)}</th>
                  <td className="num">{formatCount(p.questions)}</td>
                  <td className="num">{money(p.costCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>

      <section className="panel">
        <h2>Deployments</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Deployment</th>
                <th scope="col">Status</th>
                <th scope="col">Knowledge Box</th>
                <th scope="col">Last sync</th>
                <th scope="col" className="num">
                  Questions, 7 days
                </th>
                <th scope="col" className="num">
                  Questions, 30 days
                </th>
                <th scope="col" className="num">
                  Cost this month
                </th>
                <th scope="col">Alerts</th>
              </tr>
            </thead>
            <tbody>
              {tenant.deployments.map((d) => (
                <tr key={d.id}>
                  <th scope="row">
                    {d.name}
                    <a className="sub" href={d.siteUrl} rel="noreferrer" target="_blank">
                      {new URL(d.siteUrl).host}
                    </a>
                  </th>
                  <td>
                    <StatusBadge status={d.status} />
                  </td>
                  <td>
                    <code>{d.kbSlug}</code>
                  </td>
                  <td>{d.sync?.lastSyncedAt ? formatAgo(d.sync.lastSyncedAt, now) : <span className="muted">Never</span>}</td>
                  <td className="num">{formatCount(d.usage.questions7)}</td>
                  <td className="num">{formatCount(d.usage.questions30)}</td>
                  <td className="num">{money(d.usage.monthCents)}</td>
                  <td>
                    <Alerts alerts={d.alerts} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Answer quality</h2>
        <p className="muted">REMi scores out of 5 over the last 30 days, weighted by questions; arrows compare this week with last.</p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Deployment</th>
                <th scope="col" className="num">
                  Answer relevance
                </th>
                <th scope="col" className="num">
                  Context relevance
                </th>
                <th scope="col" className="num">
                  Groundedness
                </th>
              </tr>
            </thead>
            <tbody>
              {tenant.deployments.map((d) => (
                <tr key={d.id}>
                  <th scope="row">{d.name}</th>
                  <td className="num">
                    <QualityValue quality={d.quality} />
                  </td>
                  <td className="num">{formatScore(d.quality.contextRelevance)}</td>
                  <td className="num">{formatScore(d.quality.groundedness)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
