// The dashboard: a greeting with Add, four headline figures, what needs attention, the cost trend
// and the latest activity, then the Fleet view below them.
//
// Fleet view: every customer and deployment with usage, cost against budget, answer quality
// and anything that needs a look. Figures come from the worker's daily rollups. Deployments
// signed off under older checks have a tile and a filter of their own, oldest first, and one
// button that has all their pages read again tonight, so bringing them up to date in the
// morning is decisions, not waiting.

import { auditLog, deployments as deploymentsTable, tenants as tenantsTable, usageDaily } from "@launchpad/db";
import { and, eq, max, min, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CapacityNotice, KbLimitForm } from "@/components/capacity.tsx";
import { FocusNotice } from "@/components/focus.tsx";
import { Icon } from "@/components/icon.tsx";
import { Menu } from "@/components/shell.tsx";
import { CostTrend, Sparkline } from "@/components/trend-chart.tsx";
import { Alerts, Badge, BudgetCell, KpiCard, QualityValue, StatTile, StatusBadge, TableScroll } from "@/components/ui.tsx";
import { blockedMessage } from "@/lib/account-block.ts";
import { blockNotice } from "@/lib/ask-refusal.ts";
import { actorId, currentUser, isAdmin } from "@/lib/auth.ts";
import { kbAllowance } from "@/lib/capacity.ts";
import { connections } from "@/lib/connections.ts";
import { fleetRateLimited, lastSyncLabel, queueReread } from "@/lib/content.ts";
import { fleetSnapshot, loadSettings, olderChecksDeployments, recentActivity, stageFlag } from "@/lib/dashboard.ts";
import { db } from "@/lib/db.ts";
import { currency } from "@/lib/env.ts";
import { formatAgo, formatChange, formatCount, formatDay, formatMoney, formatMoneyTick } from "@/lib/format.ts";
import { monthOf, olderChecksFirst, shiftDay } from "@/lib/metrics.ts";
import { formatMinutes, onboardingClock, onboardingHeldAt, onboardingStart } from "@/lib/onboarding.ts";
import { cumulative, greeting, headlineFigures } from "@/lib/overview.ts";
import { ANSWERING_RULES } from "@/lib/prompt.ts";

export const dynamic = "force-dynamic";
export const metadata = { title: { absolute: "Fleet · Launchpad" } };

type Props = {
  searchParams: Promise<{ q?: string; show?: string; older?: string; queued?: string; pages?: string; saved?: string; error?: string }>;
};

// "Read the pages again for all, tonight": the pages of every deployment signed off under older
// checks go into tonight's re-read (the overnight job, 00:00 to 06:00 server time). The chats keep answering from the current copy
// meanwhile, and in the morning each one's Bring up to date has its first step done (exec review
// round 5: 10 minutes each, 8.5 of them waiting).
async function readAgainTonight() {
  "use server";
  const ids = (await olderChecksDeployments()).map((d) => d.id);
  // Pages queued per deployment; one still in its first sync isn't listed (it reads every page anyway).
  const queued = ids.length ? await queueReread(ids, await actorId()) : new Map<string, number>();
  const pages = [...queued.values()].reduce((n, p) => n + p, 0);
  revalidatePath("/");
  redirect(`/?older=1&queued=${queued.size}&pages=${pages}`);
}

// Medians from start to the first sign-off, to a sign-off that held after the first sync
// (SignOff.heldAt), and to the first answer, over deployments a person signed off (the audit
// log's first deployment.signoff). A heldAt an upgrade stamped doesn't count (onboardingHeldAt).
async function onboardingTimes() {
  const rows = await db()
    .select({
      created: deploymentsTable.createdAt,
      customer: tenantsTable.createdAt,
      firstSeen: deploymentsTable.firstSeenAt,
      signOff: deploymentsTable.signOff,
      signedOff: min(auditLog.at),
      upgradedAt: sql<Date | null>`min(${auditLog.at}) filter (where ${auditLog.detail}->>'previousChecksVersion' is not null)`.mapWith(
        (v) => (v ? new Date(v) : null),
      ),
    })
    .from(deploymentsTable)
    .innerJoin(tenantsTable, eq(tenantsTable.id, deploymentsTable.tenantId))
    // audit_log.target_id is text (it also holds user and share ids).
    .innerJoin(auditLog, and(eq(auditLog.targetId, sql`${deploymentsTable.id}::text`), eq(auditLog.action, "deployment.signoff")))
    .groupBy(deploymentsTable.id, tenantsTable.createdAt);
  return onboardingClock(
    rows.map((r) => ({
      start: onboardingStart(r.customer, r.created),
      signedOff: r.signedOff!,
      firstAnswer: r.firstSeen,
      heldAt: onboardingHeldAt(r.signOff, r.upgradedAt),
    })),
  );
}

export default async function FleetPage({ searchParams }: Props) {
  const { q = "", show, older: olderParam, queued, pages: pagesParam, saved, error } = await searchParams;
  const limitSaved = saved === "1";
  const limitError = error === "kbLimit";
  // The fleet, the account's block and what needs attention: shared with the bell in the top bar.
  const [{ now, dash, blocked, attention: attentionItems }, settings, onboarding, [rolled], user, activity, rateLimited] =
    await Promise.all([
      fleetSnapshot(),
      loadSettings(),
      onboardingTimes(),
      db()
        .select({ at: max(usageDaily.updatedAt) })
        .from(usageDaily),
      currentUser(),
      recentActivity().catch(() => []),
      fleetRateLimited().catch(() => undefined),
    ]);
  // Figures older than a day mean the worker's roll-up has stopped.
  const stale = rolled?.at && now.getTime() - rolled.at.getTime() > 26 * 3_600_000 ? rolled.at : undefined;
  const needle = q.trim().toLowerCase();
  const attentionOnly = show === "attention";
  const code = currency();
  const money = (cents: number) => formatMoney(cents, code);
  const needsLook = (d: (typeof dash.tenants)[number]["deployments"][number]) =>
    d.alerts.length > 0 || d.stage?.tone === "critical" || d.stage?.key === "failed";
  const attention = dash.tenants.filter((t) => t.alerts.length > 0 || t.deployments.some(needsLook));
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);
  const all = dash.tenants.flatMap((t) => t.deployments.map((d) => ({ ...d, tenant: t })));
  // Signed off under older checks, oldest sign-off first: the tile, and the filter.
  const older = olderChecksFirst(all);
  const olderOnly = olderParam === "1";
  // Published chats on older answering rules (item 6): held by a re-check, or waiting for one.
  const olderRules = all.filter((d) => d.olderRules);
  const olderRulesNames = `${olderRules
    .slice(0, 3)
    .map((d) => `${d.tenant.name} › ${d.name}`)
    .join(", ")}${olderRules.length > 3 ? "…" : ""}`;
  const oldest = older[0]?.signedOffAt?.slice(0, 10);
  const visibleTenants = dash.tenants.filter(
    (t) =>
      (!attentionOnly || attention.includes(t)) &&
      (!olderOnly || older.some((d) => d.tenant.id === t.id)) &&
      (matches(t.name) || t.deployments.some((d) => matches(d.name) || matches(d.siteUrl))),
  );
  const deployments = (olderOnly ? older : all).filter(
    (d) =>
      (!attentionOnly || needsLook(d) || d.tenant.alerts.length > 0) && (matches(d.name) || matches(d.siteUrl) || matches(d.tenant.name)),
  );
  const count = (value: string | undefined) => (value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined);
  const queuedCount = count(queued);
  const queuedPages = count(pagesParam) ?? 0;
  const change = formatChange(dash.usage.questions30, dash.usage.questionsPrev30);
  // The headline figures and the attention table.
  const attentionDeployments = attentionItems.filter((i) => i.deployment);
  const attentionCustomers = new Set(attentionDeployments.map((i) => i.customer?.id)).size;
  const byId = new Map(all.map((d) => [d.id, d]));
  // This month's days among the last 30 (rollups end yesterday).
  const monthDays = dash.usage.daily.filter((p) => monthOf(p.day) === monthOf(dash.today));
  // Labelled by the month, or the last 30 days on the 1st, with no 0 beside an up arrow.
  const figures = headlineFigures(dash.usage, dash.today);
  const counts = `${dash.tenants.length} customers · ${dash.tenants.reduce((n, t) => n + t.deployments.length, 0)} deployments`;
  const subtitle = `${settings?.partnerName || "Your agency"} · ${counts} · figures to ${formatDay(shiftDay(dash.today, -1))}`;

  // First run: before the first customer, the account's Knowledge Box limit, read or entered, so
  // the first refusal never comes mid-call. Skipping it leaves the warning in place.
  if (dash.tenants.length === 0) {
    const conn = await connections();
    const allowance = conn.agenticRag.ok ? await kbAllowance() : undefined;
    return (
      <main id="main" className="shell">
        <div className="page-head">
          <h1>{greeting(user.name, user.setupMode)}</h1>
        </div>
        <section className="panel" aria-labelledby="setup-title">
          <h2 id="setup-title">Before the first customer</h2>
          {limitSaved && (
            <p className="notice" role="status">
              Limit saved.
            </p>
          )}
          {!allowance ? (
            <p className="notice" data-tone="warning" role="note">
              The console can't count the account's Knowledge Boxes:{" "}
              {conn.agenticRag.ok ? "Agentic RAG didn't answer." : "it isn't connected to an account."} Each deployment needs one.{" "}
              <Link href="/settings">Settings</Link>
            </p>
          ) : (
            <>
              <CapacityNotice allowance={allowance} />
              {allowance.source === "unknown" &&
                (isAdmin(user) ? (
                  <KbLimitForm allowance={allowance} next="/" invalid={limitError} />
                ) : (
                  <p className="help">Ask an admin to enter the limit in Settings.</p>
                ))}
            </>
          )}
          <p className="muted">No customers yet.</p>
          <Link className="button" href="/customers/new">
            Add your first customer
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main id="main" className="shell">
      <div className="page-head with-actions greeting">
        <div>
          <h1>{greeting(user.name, user.setupMode)}</h1>
          <p className="muted">{subtitle}</p>
        </div>
        <Menu
          buttonClass="button add-button"
          panelClass="add-panel"
          button={
            <>
              <Icon name="plus" size={18} />
              Add
              <Icon name="chevron" size={18} />
            </>
          }
        >
          <ul>
            <li>
              <Link href="/customers/new">
                <Icon name="customers" size={18} />
                Customer
              </Link>
            </li>
            <li>
              <Link href="/deployments/new">
                <Icon name="deployments" size={18} />
                Deployment
              </Link>
            </li>
          </ul>
        </Menu>
      </div>

      {blocked && (
        <p className="notice" data-tone="critical" role="alert">
          {blockedMessage(blocked.state)}. Since {blocked.since.toISOString().slice(0, 16).replace("T", " ")} UTC:{" "}
          {blockNotice(blocked.state)} Visitors see each chat's offline message meanwhile.
        </p>
      )}

      {stale && (
        <p className="notice" data-tone="warning" role="note">
          Usage figures were last updated {formatAgo(stale, now)} ({stale.toISOString().slice(0, 16).replace("T", " ")} UTC). The worker's
          roll-up may have stopped: check that the worker is running.
        </p>
      )}

      <section className="kpis" aria-label="Headline figures">
        <KpiCard
          icon="alert"
          label="Deployments that need attention"
          value={attentionDeployments.length}
          detail={
            attentionDeployments.length
              ? `At ${attentionCustomers} ${attentionCustomers === 1 ? "customer" : "customers"}`
              : "Nothing needs a look"
          }
          link={attentionItems.length ? { href: "#attention", label: "Review them" } : undefined}
        />
        <KpiCard
          icon="dollar"
          label={figures.cost.label}
          value={money(figures.cost.cents)}
          detail="The line: cost day by day, last 30 days"
          chart={<Sparkline values={dash.usage.daily.map((p) => p.costCents)} />}
        />
        <KpiCard
          icon="forecast"
          label={figures.projection.label}
          value={money(dash.usage.projectedCents)}
          detail={figures.projection.detail}
          chart={<Sparkline values={cumulative(monthDays.map((p) => p.costCents))} />}
        />
        <KpiCard
          icon="chat"
          label={figures.questions.label}
          value={formatCount(figures.questions.count)}
          detail={`${formatCount(dash.usage.questions30)} in the last 30 days; the line shows them day by day`}
          trend={change && figures.questions.showChange ? { change, against: "last 30 days, on the 30 days before" } : undefined}
          chart={<Sparkline values={dash.usage.daily.map((p) => p.questions)} />}
        />
      </section>

      {rateLimited && (
        <p className="notice" data-tone="warning" role="status">
          {rateLimited}
        </p>
      )}

      <section className="panel" id="attention" aria-labelledby="attention-title">
        <div className="panel-head">
          <h2 id="attention-title">
            <Icon name="alert" size={22} /> Needs attention
          </h2>
          {attentionItems.length > 0 && (
            <Link href="/?show=attention#fleet" className="panel-link">
              Filter the fleet to these
            </Link>
          )}
        </div>
        {attentionItems.length === 0 ? (
          <p className="muted">Nothing needs a look: every deployment is on today's checks and rules, with no alerts.</p>
        ) : (
          <TableScroll label="Needs attention, by deployment">
            <table className="attention-table">
              <thead>
                <tr>
                  <th scope="col">Deployment and customer</th>
                  <th scope="col">Issue</th>
                  <th scope="col">Last sync</th>
                  <th scope="col">
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {attentionItems.map((item) => {
                  const d = item.deployment && byId.get(item.deployment.id);
                  const name = item.deployment?.name ?? item.customer?.name ?? "Agentic RAG account";
                  return (
                    <tr key={item.key}>
                      <th scope="row">
                        {item.deployment && item.customer ? (
                          <>
                            {/* Review is the row's link: to the panel that explains it. */}
                            {item.deployment.name}
                            <span className="sub">
                              <Link href={`/customers/${item.customer.id}`}>{item.customer.name}</Link> ·{" "}
                              {new URL(item.deployment.siteUrl).host}
                            </span>
                          </>
                        ) : item.customer ? (
                          <>
                            <Link href={`/customers/${item.customer.id}`}>{item.customer.name}</Link>
                            <span className="sub">Customer budget</span>
                          </>
                        ) : (
                          <>
                            Agentic RAG account
                            <span className="sub">Every customer's chats</span>
                          </>
                        )}
                      </th>
                      <td>
                        <ul className="alerts">
                          {item.issues.map((issue) => (
                            <li key={issue.text}>
                              <Badge tone={issue.tone}>{issue.text}</Badge>
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td>{d ? lastSyncLabel(d.sync, (at) => formatAgo(at, now)) : "—"}</td>
                      <td>
                        <Link className="button secondary small" href={item.href}>
                          Review<span className="sr-only"> {name}</span>
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>

      <div className="dash-columns">
        <section className="panel" aria-labelledby="trend-title">
          <div className="panel-head">
            <h2 id="trend-title">
              <Icon name="trend" size={22} /> Cost trend
            </h2>
            <Link href="/costs" className="panel-link">
              Costs by customer
            </Link>
          </div>
          <CostTrend
            points={dash.usage.daily.map((p) => ({ day: p.day, cents: p.costCents }))}
            ranges={[7, 14, 30]}
            money={money}
            tick={(cents) => formatMoneyTick(cents, code)}
          />
        </section>

        <section className="panel" aria-labelledby="activity-title">
          <div className="panel-head">
            <h2 id="activity-title">
              <Icon name="activity" size={22} /> Recent activity
            </h2>
          </div>
          {activity.length === 0 ? (
            <p className="muted">Nothing yet: what people and the console do on each deployment shows here.</p>
          ) : (
            <ol className="activity">
              {activity.map((a) => (
                <li key={a.id}>
                  <div>
                    <p className="activity-what">
                      {a.who} {a.what}
                    </p>
                    <p className="activity-where">
                      <Link href={`${a.deployment.href}#history`}>{a.deployment.name}</Link> · {a.customer} ·{" "}
                      <time dateTime={a.at.toISOString()}>{formatAgo(a.at, now)}</time>
                    </p>
                  </div>
                  <Badge tone={a.chip.tone}>{a.chip.label}</Badge>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section className="tiles" aria-labelledby="health-title">
        <h2 id="health-title" className="tiles-title">
          Fleet health
        </h2>
        <StatTile
          label="Customers needing attention"
          value={attention.length}
          detail={attention.length ? attention.map((t) => t.name).join(", ") : "Nothing needs a look"}
        />
        <StatTile
          label="Onboarding, start to sign-off"
          value={onboarding ? formatMinutes(onboarding.toSignOff) : "No onboardings yet"}
          detail={
            onboarding
              ? `Median of ${onboarding.count} signed off${onboarding.toFirstAnswer !== undefined ? `; first answer on the site after ${formatMinutes(onboarding.toFirstAnswer)} (${onboarding.answered})` : ""}`
              : "Timed from each new customer to a person's sign-off"
          }
        />
        <StatTile
          label="Held after the first sync"
          value={onboarding?.toHeld !== undefined ? formatMinutes(onboarding.toHeld) : onboarding ? "Not yet" : "No onboardings yet"}
          detail={
            onboarding?.toHeld !== undefined
              ? `Median of ${onboarding.held} from start to a sign-off the re-run after the first sync left standing`
              : "From start until the re-run after the first sync leaves nothing open, or a person resolves what it opened"
          }
        />
        <StatTile
          label="Signed off under older checks"
          value={older.length}
          detail={
            older.length
              ? `Oldest signed off ${formatDay(oldest!)}: each needs Bring up to date and a new sign-off`
              : "Every signed-off chat is on today's checks"
          }
        >
          {older.length > 0 && !olderOnly && (
            <p className="tile-detail">
              <Link href="/?older=1#deployments">Show them, oldest first</Link>
            </p>
          )}
        </StatTile>
        <StatTile
          label="On older answering rules"
          value={olderRules.length}
          detail={
            olderRules.length
              ? `${olderRulesNames}: held by their re-check, or waiting for it. Review shows what would change.`
              : `Every live chat runs the latest answering rules (v${ANSWERING_RULES})`
          }
        />
      </section>

      <form className="fleet-filter" id="fleet" aria-label="Find in the fleet" action="/#fleet">
        <label className="sr-only" htmlFor="q">
          Find a customer, deployment or site
        </label>
        <input id="q" name="q" type="search" defaultValue={q} placeholder="Find a customer, deployment or site" />
        <label className="inline">
          <input type="checkbox" name="show" value="attention" defaultChecked={attentionOnly} /> Needs attention only
        </label>
        <label className="inline">
          <input type="checkbox" name="older" value="1" defaultChecked={olderOnly} /> Signed off under older checks, oldest first
        </label>
        <button className="button secondary" type="submit">
          Filter
        </button>
        {(needle || attentionOnly || olderOnly) && <Link href="/#fleet">Clear</Link>}
      </form>

      {queuedCount !== undefined && (
        <FocusNotice tone="good">
          {!queuedCount
            ? "Nothing to read again: no deployment signed off under older checks has finished its first sync."
            : queuedPages
              ? `${formatCount(queuedPages)} ${queuedPages === 1 ? "page" : "pages"} of ${queuedCount === 1 ? "1 deployment" : `${queuedCount} deployments`} will be read again tonight, between 00:00 and 06:00 server time. The chats keep answering from the current copy meanwhile. In the morning, each one's Bring up to date has its first step done.`
              : `The pages of ${queuedCount === 1 ? "this deployment" : `these ${queuedCount} deployments`} are already read by today's extractor and rules: open each one's Bring up to date.`}
        </FocusNotice>
      )}

      <section className="panel" id="customers">
        <h2>Customers</h2>
        <TableScroll label="Customers">
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
              {visibleTenants.map((t) => (
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
        </TableScroll>
      </section>

      <section className="panel" id="deployments">
        <h2>{olderOnly ? "Deployments signed off under older checks, oldest first" : "Deployments"}</h2>
        {olderOnly && older.length > 0 && (
          <form action={readAgainTonight} className="fleet-batch">
            <p className="help">
              Bringing one up to date starts with reading its pages again, about 8 minutes of waiting each. Have all {older.length} read
              again tonight instead: the chats keep answering meanwhile, and the morning's work is decisions.
            </p>
            <button type="submit" className="button">
              Read the pages again for all {older.length}, tonight
            </button>
          </form>
        )}
        <TableScroll label="Deployments">
          <table>
            <thead>
              <tr>
                <th scope="col">Deployment</th>
                <th scope="col">Customer</th>
                <th scope="col">Stage</th>
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
                    <Link href={`/customers/${d.tenant.id}/deployments/${d.id}`}>{d.name}</Link>
                    <span className="sub">{new URL(d.siteUrl).host}</span>
                  </th>
                  <td>
                    <Link href={`/customers/${d.tenant.id}`}>{d.tenant.name}</Link>
                  </td>
                  <td>
                    {d.stage ? <Badge tone={d.stage.tone}>{d.stage.label}</Badge> : <StatusBadge status={d.status} />}
                    {stageFlag(d.stage) && (
                      <span className="sub">
                        {stageFlag(d.stage)}
                        {d.olderChecks && d.signedOffAt && `, ${formatDay(d.signedOffAt.slice(0, 10))}`}
                      </span>
                    )}
                    {d.olderRules && <span className="sub">On older answering rules</span>}
                  </td>
                  <td>{lastSyncLabel(d.sync, (at) => formatAgo(at, now))}</td>
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
        </TableScroll>
      </section>
    </main>
  );
}
