// Fleet view: every customer and deployment with usage, cost against budget, answer quality
// and anything that needs a look. Figures come from the worker's daily rollups.

import Link from "next/link";
import { Alerts, BudgetCell, QualityValue, StatTile, StatusBadge } from "@/components/ui.tsx";
import { loadDashboard, loadSettings } from "@/lib/dashboard.ts";
import { currency } from "@/lib/env.ts";
import { formatAgo, formatChange, formatCount, formatDay, formatMoney, formatScore } from "@/lib/format.ts";
import { shiftDay } from "@/lib/metrics.ts";

export const dynamic = "force-dynamic";

export default async function FleetPage() {
  const now = new Date();
  const [dash, settings] = await Promise.all([loadDashboard(now), loadSettings()]);
  const code = currency();
  const money = (cents: number) => formatMoney(cents, code);
  const deployments = dash.tenants.flatMap((t) => t.deployments.map((d) => ({ ...d, tenant: t })));
  const attention = dash.tenants.filter((t) => t.alerts.length > 0);
  const change = formatChange(dash.usage.questions30, dash.usage.questionsPrev30);
  const counts = `${dash.tenants.length} customers · ${deployments.length} deployments`;
  const subtitle = `${settings?.partnerName || "Your agency"} · ${counts} · figures to ${formatDay(shiftDay(dash.today, -1))}`;

  if (dash.tenants.length === 0) {
    return (
      <main className="shell">
        <h1>Fleet</h1>
        <div className="panel">
          <p className="muted">No customers yet. The provisioning wizard creates the first one from a site URL.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <div className="page-head">
        <h1>Fleet</h1>
        <p className="muted">{subtitle}</p>
      </div>

      <section className="tiles" aria-label="Summary">
        <StatTile
          label="Questions, last 30 days"
          value={formatCount(dash.usage.questions30)}
          detail={change && `${change} on the 30 days before`}
        />
        <StatTile
          label="Cost this month"
          value={money(dash.usage.monthCents)}
          detail={`Projected ${money(dash.usage.projectedCents)} by month end`}
        />
        <StatTile
          label="Customers needing attention"
          value={attention.length}
          detail={attention.length ? attention.map((t) => t.name).join(", ") : "Nothing needs a look"}
        />
        <StatTile label="Answer relevance, last 30 days" value={formatScore(dash.quality.answerRelevance)} detail="REMi score out of 5" />
      </section>

      <section className="panel">
        <h2>Customers</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col" className="num">
                  Questions, 30 days
                </th>
                <th scope="col" className="num">
                  Cost this month
                </th>
                <th scope="col">Budget</th>
                <th scope="col" className="num">
                  Projected
                </th>
                <th scope="col" className="num">
                  Answer relevance
                </th>
                <th scope="col">Alerts</th>
              </tr>
            </thead>
            <tbody>
              {dash.tenants.map((t) => (
                <tr key={t.id}>
                  <th scope="row">
                    <Link href={`/customers/${t.id}`}>{t.name}</Link>
                  </th>
                  <td className="num">{formatCount(t.usage.questions30)}</td>
                  <td className="num">{money(t.usage.monthCents)}</td>
                  <td>
                    <BudgetCell spentCents={t.usage.monthCents} budgetCents={t.monthlyBudgetCents} money={money} />
                  </td>
                  <td className="num">{money(t.usage.projectedCents)}</td>
                  <td className="num">
                    <QualityValue quality={t.quality} />
                  </td>
                  <td>
                    <Alerts alerts={t.alerts} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Deployments</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Deployment</th>
                <th scope="col">Customer</th>
                <th scope="col">Status</th>
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
                <th scope="col" className="num">
                  Answer relevance
                </th>
                <th scope="col">Alerts</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((d) => (
                <tr key={d.id}>
                  <th scope="row">
                    {d.name}
                    <span className="sub">{new URL(d.siteUrl).host}</span>
                  </th>
                  <td>
                    <Link href={`/customers/${d.tenant.id}`}>{d.tenant.name}</Link>
                  </td>
                  <td>
                    <StatusBadge status={d.status} />
                  </td>
                  <td>{d.sync?.lastSyncedAt ? formatAgo(d.sync.lastSyncedAt, now) : <span className="muted">Never</span>}</td>
                  <td className="num">{formatCount(d.usage.questions7)}</td>
                  <td className="num">{formatCount(d.usage.questions30)}</td>
                  <td className="num">{money(d.usage.monthCents)}</td>
                  <td className="num">
                    <QualityValue quality={d.quality} />
                  </td>
                  <td>
                    <Alerts alerts={d.alerts} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
