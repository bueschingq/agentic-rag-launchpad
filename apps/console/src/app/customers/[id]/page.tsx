// One customer: spend against budget, daily questions and cost, each deployment, answer
// quality per deployment, and who to contact and bill.

import { languageSetting } from "@launchpad/theme";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BarChart } from "@/components/bar-chart.tsx";
import { Alerts, Badge, Meter, QualityValue, StatTile, StatusBadge, TableScroll } from "@/components/ui.tsx";
import { clientNameDetail } from "@/lib/client-name.ts";
import { lastSyncLabel } from "@/lib/content.ts";
import { clientNaming } from "@/lib/customers.ts";
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
import { BILLING_METHOD_LABELS, KB_ACCESS_LABELS, languageLabel, PAYMENT_TERMS_LABELS } from "@/lib/labels.ts";
import { shiftDay } from "@/lib/metrics.ts";
import { loadCustomerProfile } from "@/lib/provisioning.ts";
import { pauseCustomer, updateClientName } from "./edit/actions.ts";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string; saved?: string; paused?: string; resumed?: string; renamed?: string; renameFailed?: string }>;
};

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = /^[0-9a-f-]{36}$/i.test(id) ? await loadCustomerProfile(id) : undefined;
  return { title: profile?.name ?? "Customer" };
}

export default async function CustomerPage({ params, searchParams }: Params) {
  const { id } = await params;
  const { created, saved, paused, resumed, renamed, renameFailed } = await searchParams;
  const now = new Date();
  const [dash, profile, jar, naming] = await Promise.all([loadDashboard(now), loadCustomerProfile(id), cookies(), clientNaming(id)]);
  // Presenting to the client (the Present button): the partner's cost, projection and budget stay hidden.
  const presenting = jar.get("lp_presenting")?.value === id;
  const tenant = dash.tenants.find((t) => t.id === id);
  if (!tenant || !profile) notFound();
  const { billing } = profile;
  const address = billing.address && Object.values(billing.address).filter(Boolean).join(", ");

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
  const anyUsage = days.some((p) => p.questions > 0 || p.costCents > 0);
  // Deployments whose prompt, widget or lead email don't call the client by the name visitors see.
  const misnamed = (naming?.deployments ?? []).flatMap((d) => {
    const problems = d.problems.filter((p) => p.kind === "other-name" || p.kind === "missing");
    return problems.length ? [{ ...d, problems }] : [];
  });
  const renameable = misnamed.some((d) => d.problems.some((p) => p.kind === "other-name"));
  const questionSummary = busiest.questions
    ? `${formatCount(usage.questions30)} questions over the last 30 days, most on ${formatDay(busiest.day)} (${busiest.questions}).`
    : "No questions in the last 30 days.";

  return (
    <main id="main" className="shell">
      <p className="crumbs">
        <Link href="/">Fleet</Link>
      </p>
      <div className="page-head with-actions">
        <div>
          <h1>{tenant.name}</h1>
          <p className="muted">
            {tenant.status === "paused" && (
              <>
                <StatusBadge status="paused" />{" "}
              </>
            )}
            {subtitle}
          </p>
        </div>
        <div className="actions">
          <Link className="button" href={`/deployments/new?customer=${id}`}>
            Add deployment
          </Link>
          <Link className="button secondary" href={`/customers/${id}/report`}>
            Report
          </Link>
          <Link className="button secondary" href={`/customers/${id}/edit`}>
            Edit
          </Link>
          <a
            className="button secondary"
            href={`/present/${id}`}
            title="Hides the fleet, costs and other customers while you share your screen"
          >
            Present
          </a>
          <form action={pauseCustomer.bind(null, id, tenant.status !== "paused")}>
            <button className="button secondary" type="submit">
              {tenant.status === "paused" ? "Resume all chats" : "Pause all chats"}
            </button>
          </form>
        </div>
      </div>

      {created && (
        <p className="notice" role="status">
          Customer created. Next, add a deployment: the site the chat goes on.
        </p>
      )}
      {saved && (
        <p className="notice" role="status">
          Customer saved.
        </p>
      )}
      {paused && (
        <p className="notice" data-tone="warning" role="status">
          Paused. Within a minute, every one of {tenant.name}'s chats shows the offline message.
        </p>
      )}
      {resumed && (
        <p className="notice" role="status">
          Resumed. The chats are back within a minute.
        </p>
      )}
      {naming && naming.deployments.length > 0 && (!naming.visible || misnamed.length > 0 || renamed) && (
        <section className="panel" id="client-name" aria-labelledby="client-name-title">
          <h2 id="client-name-title">The client's name in the chat</h2>
          {renamed && (
            <p className="notice" data-tone={renameFailed ? "warning" : "good"} role="status">
              {renamed === "1" ? "1 deployment updated" : `${renamed} deployments updated`}
              {renameFailed ? `; ${renameFailed} couldn't be saved to Agentic RAG: try again` : ""}. Each now needs a new sign-off.
            </p>
          )}
          {!naming.visible ? (
            <p>
              Name visitors see isn't set, so the console can't check what the chat calls the client.{" "}
              <Link href={`/customers/${id}/edit#displayName`}>Set it</Link>
            </p>
          ) : misnamed.length ? (
            <>
              <p>
                {misnamed.length === 1 ? "1 deployment doesn't" : `${misnamed.length} deployments don't`} call the client "{naming.visible}"
                yet. Each shows "Changed since sign-off: the client's name" once the name has changed, and its sign-off waits until the
                prompt says "{naming.visible}".
              </p>
              <ul className="plain">
                {misnamed.map((d) => (
                  <li key={d.id}>
                    <Link href={`/customers/${id}/deployments/${d.id}`}>{d.name}</Link>
                    <span className="step-detail">
                      {clientNameDetail(d.problems, { internal: naming.internal, visible: naming.visible })}{" "}
                      <Link href={`/customers/${id}/deployments/${d.id}/review/prompt`}>Update the prompt</Link>
                    </span>
                  </li>
                ))}
              </ul>
              {renameable && (
                <form action={updateClientName.bind(null, id)}>
                  <button className="button" type="submit">
                    Update all
                  </button>
                  <p className="help">
                    Changes{" "}
                    {[naming.internal, ...naming.previous]
                      .filter((n) => n !== naming.visible)
                      .map((n) => `"${n}"`)
                      .join(" and ")}{" "}
                    to "{naming.visible}" in each prompt and in the widget's text, in every language. A prompt that never names the client
                    is left for you: use Update the prompt on it.
                  </p>
                </form>
              )}
            </>
          ) : (
            <p>Every deployment's prompt, widget and lead email call the client "{naming.visible}".</p>
          )}
        </section>
      )}
      {tenant.deployments.length === 0 && (
        <section className="panel empty-state">
          <h2>No deployments yet</h2>
          <p>A deployment is one site with its own chatbot: its Knowledge Box, content, widget and snippet.</p>
          <Link className="button" href={`/deployments/new?customer=${id}`}>
            Add deployment
          </Link>
        </section>
      )}

      {tenant.alerts.length > 0 && (
        <section className="callout" aria-label="Alerts">
          <Alerts alerts={tenant.alerts} />
        </section>
      )}

      {tenant.deployments.length > 0 && (
        <section className="tiles" aria-label="Summary">
          {!presenting && (
            <>
              <StatTile
                label="Cost this month"
                value={money(usage.monthCents)}
                detail={budget ? `${formatPercent(usage.monthCents / budget)} of the ${money(budget)} budget` : "No monthly budget set"}
              >
                {budget ? <Meter ratio={usage.monthCents / budget} /> : null}
              </StatTile>
              <StatTile label="Projected by month end" value={money(usage.projectedCents)} detail="At the last 7 days' pace" />
            </>
          )}
          <StatTile
            label="Questions, last 30 days"
            value={formatCount(usage.questions30)}
            detail={change && `${change} on the 30 days before`}
          />
          <StatTile label="Answer relevance, last 30 days" value={formatScore(quality.answerRelevance)} detail={trend} />
        </section>
      )}

      {tenant.deployments.length > 0 && !anyUsage && (
        <p className="panel muted">No questions yet: daily figures appear here once visitors use the chat.</p>
      )}
      {anyUsage && (
        <section className="panel charts">
          <BarChart
            title="Questions per day"
            summary={questionSummary}
            points={days.map((p) => ({ key: p.day, label: formatDay(p.day), value: p.questions, display: formatCount(p.questions) }))}
            tick={formatCount}
          />
          {!presenting && (
            <BarChart
              title="Cost per day"
              summary={`${money(totalCost)} over the last 30 days.`}
              points={days.map((p) => ({ key: p.day, label: formatDay(p.day), value: p.costCents, display: money(p.costCents) }))}
              tick={(cents) => formatMoneyTick(cents, code)}
            />
          )}
          <details className="daily">
            <summary>Daily figures</summary>
            <table>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col" className="num">
                    Questions
                  </th>
                  {!presenting && (
                    <th scope="col" className="num">
                      Cost
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {days.map((p) => (
                  <tr key={p.day}>
                    <th scope="row">{formatDay(p.day)}</th>
                    <td className="num">{formatCount(p.questions)}</td>
                    {!presenting && <td className="num">{money(p.costCents)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </section>
      )}

      <section className="panel">
        <h2>Deployments</h2>
        <TableScroll label="Deployments">
          <table>
            <thead>
              <tr>
                <th scope="col">Deployment</th>
                <th scope="col">Stage</th>
                <th scope="col">Last sync</th>
                <th scope="col" className="num">
                  Questions, 7 days
                </th>
                <th scope="col" className="num">
                  Questions, 30 days
                </th>
                {!presenting && (
                  <th scope="col" className="num">
                    Cost this month
                  </th>
                )}
                <th scope="col">Alerts</th>
              </tr>
            </thead>
            <tbody>
              {tenant.deployments.map((d) => (
                <tr key={d.id}>
                  <th scope="row">
                    <Link href={`/customers/${id}/deployments/${d.id}`}>{d.name}</Link>
                    <a className="sub" href={d.siteUrl} rel="noreferrer" target="_blank">
                      {new URL(d.siteUrl).host}
                    </a>
                  </th>
                  <td>
                    {d.stage ? (
                      <>
                        <Badge tone={d.stage.tone}>{d.stage.label}</Badge>
                        <span className="sub">{d.stage.detail}</span>
                      </>
                    ) : (
                      <StatusBadge status={d.status} />
                    )}
                  </td>
                  <td>{lastSyncLabel(d.sync, (at) => formatAgo(at, now))}</td>
                  <td className="num">{formatCount(d.usage.questions7)}</td>
                  <td className="num">{formatCount(d.usage.questions30)}</td>
                  {!presenting && <td className="num">{money(d.usage.monthCents)}</td>}
                  <td>
                    <Alerts alerts={d.alerts} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </section>

      <section className="panel" id="quality">
        <h2>Answer quality</h2>
        <p className="muted">REMi scores out of 5 over the last 30 days, weighted by questions; arrows compare this week with last.</p>
        <TableScroll label="Answer quality">
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
        </TableScroll>
      </section>

      <section className="panel">
        <h2>Contacts</h2>
        <p className="muted">Default language: {languageLabel(languageSetting(profile.language))}.</p>
        {profile.contacts.length === 0 ? (
          <p className="muted">No contacts recorded.</p>
        ) : (
          <TableScroll label="Contacts">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Phone</th>
                  <th scope="col">Language</th>
                  <th scope="col">Knowledge Box access</th>
                </tr>
              </thead>
              <tbody>
                {profile.contacts.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">
                      {c.name}
                      {c.isPrimary && <span className="sub">Primary contact</span>}
                      {c.title && <span className="sub">{c.title}</span>}
                    </th>
                    <td>
                      <a href={`mailto:${c.email}`}>{c.email}</a>
                    </td>
                    <td>{c.phone ?? <span className="muted">—</span>}</td>
                    <td>{languageLabel(languageSetting(c.language))}</td>
                    <td>{c.kbRole ? KB_ACCESS_LABELS[c.kbRole] : <span className="muted">Not invited</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>

      <section className="panel">
        <h2>Billing</h2>
        {Object.keys(billing).length === 0 ? (
          <p className="muted">No billing details recorded.</p>
        ) : (
          <dl className="details">
            {(billing.contactName || billing.contactEmail) && (
              <>
                <dt>Bill to</dt>
                <dd>
                  {billing.contactName}
                  {billing.contactEmail && <span className={billing.contactName ? "sub" : undefined}>{billing.contactEmail}</span>}
                </dd>
              </>
            )}
            {address && (
              <>
                <dt>Address</dt>
                <dd>{address}</dd>
              </>
            )}
            {billing.method && (
              <>
                <dt>Payment method</dt>
                <dd>{BILLING_METHOD_LABELS[billing.method]}</dd>
              </>
            )}
            {billing.terms && (
              <>
                <dt>Terms</dt>
                <dd>{PAYMENT_TERMS_LABELS[billing.terms]}</dd>
              </>
            )}
            {billing.poNumber && (
              <>
                <dt>PO number</dt>
                <dd>{billing.poNumber}</dd>
              </>
            )}
            {billing.taxId && (
              <>
                <dt>Tax ID</dt>
                <dd>{billing.taxId}</dd>
              </>
            )}
            {billing.externalRef && (
              <>
                <dt>Billing system reference</dt>
                <dd>
                  <code>{billing.externalRef}</code>
                </dd>
              </>
            )}
          </dl>
        )}
      </section>
    </main>
  );
}
