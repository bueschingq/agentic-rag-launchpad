// Database reads behind the dashboard pages. The arithmetic lives in metrics.ts.
//
// Each page loads the whole fleet's last 60 days and works in memory. A partner with 200
// sites has about 12,000 usage rows in that window, so this stays cheap well past v1.

import {
  answerEvents,
  auditLog,
  deployments,
  qualityDaily,
  type SignOff,
  settings,
  syncSources,
  tenants,
  usageDaily,
  users,
} from "@launchpad/db";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { cache } from "react";
import { accountBlock, blockedMessage } from "./account-block.ts";
import { CONTENT_CHANGE_ACTIONS, contentChangesSince, pageCounts } from "./content.ts";
import { questionsByDay, type TestTraffic, testTrafficByTenant } from "./costs.ts";
import { nameChanges } from "./customers.ts";
import { db } from "./db.ts";
import { historyActor, historyWhat, typedNames, typedNear } from "./history.ts";
import { snippetSightings } from "./install.ts";
import {
  type AfterSignOff,
  buildDashboard,
  type Dashboard,
  isoDay,
  type MonthLine,
  monthTotals,
  olderChecksFirst,
  openSinceSignOff,
  shiftDay,
  startersRemoved,
  type UsageDay,
} from "./metrics.ts";
import { deploymentStage, type Stage } from "./onboarding.ts";
import { type AttentionItem, activityChip, attentionItems, priceTableIssue } from "./overview.ts";
import { ANSWERING_RULES } from "./prompt.ts";
import { priceTableChanged, signOffState, underOlderChecks, visitorSettingsHash } from "./review.ts";

// What's unresolved on each signed-off deployment since its sign-off: what its latest run left
// open, and starters the automatic re-run took off the chat that nobody has picked again. Fleet
// keeps the customer under "needing attention" until both are gone.
export async function afterSignOff(
  rows: readonly { id: string; signOff: SignOff | null; validation: Parameters<typeof openSinceSignOff>[1] }[],
  now: Date,
): Promise<Map<string, AfterSignOff>> {
  const signed = rows.filter((r) => r.signOff);
  const out = new Map<string, AfterSignOff>();
  if (!signed.length) return out;
  const since = new Date(Math.min(...signed.map((r) => Date.parse(r.signOff!.at) || now.getTime())));
  const entries = await db()
    .select({ targetId: auditLog.targetId, action: auditLog.action, at: auditLog.at, detail: auditLog.detail })
    .from(auditLog)
    .where(
      and(
        inArray(auditLog.action, ["deployment.starters.removed", "deployment.starters", "deployment.signoff"]),
        inArray(
          auditLog.targetId,
          signed.map((r) => r.id),
        ),
        gte(auditLog.at, since),
      ),
    );
  for (const r of signed) {
    const removed = startersRemoved(
      entries.filter((e) => e.targetId === r.id),
      new Date(r.signOff!.at),
    );
    const open = openSinceSignOff(true, r.validation, now);
    if (removed.length || open) out.set(r.id, { removed, ...(open && { open }) });
  }
  return out;
}

// The latest content change since each signed-off deployment's sign-off that still stands
// (contentChangesSince), so Fleet's stage says "Changed since sign-off" as the deployment page
// does. One lookup finds the deployments with any content entry since; only those are read.
export async function contentChangedAt(rows: readonly { id: string; signOff: SignOff | null }[]): Promise<Map<string, string>> {
  const signed = rows.filter((r) => r.signOff);
  const out = new Map<string, string>();
  if (!signed.length) return out;
  const latest = await db()
    .select({ targetId: auditLog.targetId, at: sql<string>`max(${auditLog.at})` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetType, "deployment"),
        inArray(auditLog.action, [...CONTENT_CHANGE_ACTIONS]),
        inArray(
          auditLog.targetId,
          signed.map((r) => r.id),
        ),
      ),
    )
    .groupBy(auditLog.targetId);
  const last = new Map(latest.map((l) => [l.targetId, new Date(l.at).getTime()]));
  await Promise.all(
    signed
      .filter((r) => (last.get(r.id) ?? 0) > Date.parse(r.signOff!.at))
      .map(async (r) => {
        const at = (await contentChangesSince(r.id, r.signOff!.at).catch(() => [])).at(-1)?.at;
        if (at) out.set(r.id, at);
      }),
  );
  return out;
}

// Every deployment signed off under older checks, oldest sign-off first, customers archived left
// out: what Fleet's "Read the pages again for all, tonight" queues.
export async function olderChecksDeployments(): Promise<{ id: string; signedOffAt: string }[]> {
  const rows = await db()
    .select({ id: deployments.id, signOff: deployments.signOff })
    .from(deployments)
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .where(and(isNotNull(deployments.signOff), ne(tenants.status, "archived")));
  return olderChecksFirst(rows.map((r) => ({ id: r.id, olderChecks: underOlderChecks(r.signOff), signedOffAt: r.signOff?.at }))).map(
    (r) => ({ id: r.id, signedOffAt: r.signedOffAt ?? "" }),
  );
}

// What Fleet says beside a deployment's stage badge ("signed off under older checks"). The
// dashboard's stage type (metrics.ts) predates the flag.
export const stageFlag = (stage: object | undefined): string | undefined => (stage as Stage | undefined)?.flag;

// The page origins each deployment answered visitors on lately (the widget's answer events), for
// "Live on staging" against "Live on www.client.com".
export async function answeredOrigins(since: Date, deploymentId?: string): Promise<Map<string, string[]>> {
  const rows = await db()
    .selectDistinct({ deploymentId: answerEvents.deploymentId, origin: answerEvents.origin })
    .from(answerEvents)
    .where(
      and(
        gte(answerEvents.at, since),
        isNotNull(answerEvents.origin),
        ...(deploymentId ? [eq(answerEvents.deploymentId, deploymentId)] : []),
      ),
    );
  const out = new Map<string, string[]>();
  for (const r of rows) if (r.origin) out.set(r.deploymentId, [...(out.get(r.deploymentId) ?? []), r.origin]);
  return out;
}

export type Settings = typeof settings.$inferSelect;

const usageColumns = {
  deploymentId: usageDaily.deploymentId,
  day: usageDaily.day,
  questions: usageDaily.questions,
  queryTokens: usageDaily.queryTokens,
  costCents: usageDaily.costCents,
};

// Postgres numerics arrive as strings.
function toUsageDay(r: Omit<UsageDay, "queryTokens"> & { queryTokens: string }): UsageDay {
  return { ...r, queryTokens: Number(r.queryTokens) };
}

export async function loadSettings(): Promise<Settings | undefined> {
  const [row] = await db().select().from(settings).where(eq(settings.id, 1));
  return row;
}

function loadTenants() {
  return db()
    .select({
      id: tenants.id,
      name: tenants.name,
      status: tenants.status,
      monthlyBudgetCents: tenants.monthlyBudgetCents,
      budgetMode: tenants.budgetMode,
      createdAt: tenants.createdAt,
    })
    .from(tenants)
    .where(ne(tenants.status, "archived"))
    .orderBy(asc(tenants.name));
}

export async function loadDashboard(now: Date): Promise<Dashboard> {
  const today = isoDay(now);
  const recentUsage = gte(usageDaily.day, shiftDay(today, -60));
  const recentQuality = gte(qualityDaily.day, shiftDay(today, -30));
  const [tenantRows, deploymentRows, usage, quality, syncs] = await Promise.all([
    loadTenants(),
    db()
      .select({
        id: deployments.id,
        tenantId: deployments.tenantId,
        name: deployments.name,
        siteUrl: deployments.siteUrl,
        stagingDomains: deployments.stagingDomains,
        status: deployments.status,
        kbSlug: deployments.kbSlug,
        contentPath: deployments.contentPath,
        createdAt: deployments.createdAt,
        readyAt: deployments.readyAt,
        firstSeenAt: deployments.firstSeenAt,
        firstSeenOrigin: deployments.firstSeenOrigin,
        validation: deployments.validation,
        preflight: deployments.preflight,
        signOff: deployments.signOff,
        theme: deployments.theme,
        widgetSettings: deployments.widgetSettings,
        systemPrompt: deployments.systemPrompt,
        language: deployments.language,
        published: deployments.published,
        answeringRules: deployments.answeringRules,
        priceTable: deployments.priceTable,
        priceTableConfirmation: deployments.priceTableConfirmation,
      })
      .from(deployments)
      .orderBy(asc(deployments.name)),
    db().select(usageColumns).from(usageDaily).where(recentUsage),
    db()
      .select({
        deploymentId: qualityDaily.deploymentId,
        day: qualityDaily.day,
        answerRelevance: qualityDaily.answerRelevance,
        contextRelevance: qualityDaily.contextRelevance,
        groundedness: qualityDaily.groundedness,
      })
      .from(qualityDaily)
      .where(recentQuality),
    db()
      .select({ deploymentId: syncSources.deploymentId, lastJobStatus: syncSources.lastJobStatus, lastSyncedAt: syncSources.lastSyncedAt })
      .from(syncSources),
  ]);
  const dash = buildDashboard({
    now,
    tenants: tenantRows,
    deployments: deploymentRows,
    usage: usage.map(toUsageDay),
    quality,
    syncs,
    afterSignOff: await afterSignOff(deploymentRows, now),
  });
  // Each deployment's stage, from the same rules as its page (onboarding.ts).
  const rows = new Map(deploymentRows.map((d) => [d.id, d]));
  const tenantById = new Map(tenantRows.map((t) => [t.id, t]));
  const [pages, renamed, origins, sightings, contentChanged] = await Promise.all([
    pageCounts(deploymentRows.map((d) => d.id)),
    nameChanges(tenantRows.map((t) => t.id)),
    answeredOrigins(new Date(now.getTime() - 30 * 86_400_000)),
    // Only a signed-off deployment no visitor has chatted with yet says where its snippet is.
    snippetSightings(deploymentRows.filter((d) => d.signOff && !d.firstSeenAt).map((d) => d.id)),
    contentChangedAt(deploymentRows).catch(() => new Map<string, string>()),
  ]);
  for (const t of dash.tenants) {
    const tenant = tenantById.get(t.id);
    for (const d of t.deployments) {
      const row = rows.get(d.id)!;
      // For Fleet's "Signed off under older checks" tile and filter, oldest first.
      d.olderChecks = underOlderChecks(row.signOff);
      if (row.signOff) d.signedOffAt = row.signOff.at;
      // A published chat still on older answering rules: its re-check held it, or hasn't run yet
      // (prompt.ts ANSWERING_RULES; imported deployments, with no prompt, have none).
      d.olderRules = row.published && Boolean(row.systemPrompt) && row.answeringRules < ANSWERING_RULES;
      d.priceTable = priceTableIssue(row.priceTable, row.priceTableConfirmation, row.published);
      const counts = pages.get(d.id) ?? {};
      const total = (counts.queued ?? 0) + (counts.processing ?? 0) + (counts.indexed ?? 0) + (counts.skipped ?? 0) + (counts.failed ?? 0);
      d.stage = deploymentStage(
        {
          status: row.status,
          createdAt: row.createdAt,
          readyAt: row.readyAt,
          firstSeenAt: row.firstSeenAt,
          firstSeenOrigin: row.firstSeenOrigin,
          validation: row.validation,
          preflight: row.preflight,
          questions30: d.usage.questions30,
          signOff: signOffState(
            row.signOff,
            visitorSettingsHash(row),
            renamed.get(t.id)?.[0]?.at,
            contentChanged.get(d.id),
            priceTableChanged(row.signOff, row),
          ).state,
          olderChecks: underOlderChecks(row.signOff),
          stagingDomains: row.stagingDomains,
          answeredOn: origins.get(d.id) ?? [],
          ...(sightings.has(d.id) && { snippetSeen: sightings.get(d.id)! }),
        },
        {
          indexed: counts.indexed ?? 0,
          total,
          syncStatus: d.sync?.lastJobStatus ?? null,
          syncError: null,
          connector: row.contentPath === "sitefinity_connector",
          external: row.contentPath === "manual",
        },
        {
          createdAt: tenant?.createdAt ?? row.createdAt,
          paused: t.status === "paused",
          stoppedForBudget: tenant?.budgetMode === "stop" && t.budget === "over",
        },
      );
    }
  }
  return dash;
}

export interface CostReport {
  month: string;
  // Months with any usage, newest first (at most 12).
  months: string[];
  // test: questions from staging domains or partner staff, and the part of the cost they account
  // for, which the customer price leaves out (costs.ts).
  lines: (MonthLine & { name: string; monthlyBudgetCents: number | null; test: TestTraffic })[];
}

export async function loadCosts(month: string): Promise<CostReport> {
  const next = shiftDay(`${month}-01`, 32).slice(0, 7);
  const monthExpr = sql<string>`to_char(${usageDaily.day}, 'YYYY-MM')`;
  const inMonth = and(gte(usageDaily.day, `${month}-01`), lt(usageDaily.day, `${next}-01`));
  const [months, tenantRows, owners, usage, asked] = await Promise.all([
    db().selectDistinct({ month: monthExpr }).from(usageDaily).orderBy(desc(monthExpr)).limit(12),
    loadTenants(),
    db().select({ id: deployments.id, tenantId: deployments.tenantId }).from(deployments),
    db().select(usageColumns).from(usageDaily).where(inMonth),
    questionsByDay(month).catch(() => []),
  ]);
  const tenantOf = new Map(owners.map((d) => [d.id, d.tenantId]));
  const days = usage.map(toUsageDay);
  const totals = monthTotals(days, tenantOf, month);
  const test = testTrafficByTenant(days, asked, tenantOf);
  return {
    month,
    months: months.map((m) => m.month),
    lines: tenantRows.flatMap((t) => {
      const line = totals.get(t.id);
      return line
        ? [{ ...line, name: t.name, monthlyBudgetCents: t.monthlyBudgetCents, test: test.get(t.id) ?? { questions: 0, costCents: 0 } }]
        : [];
    }),
  };
}

// The fleet as the dashboard and the console's bell see it, loaded once per request: the layout's
// bell and the dashboard page share it (React's cache lasts one server render).
export const fleetSnapshot = cache(async () => {
  const now = new Date();
  const [dash, blocked] = await Promise.all([
    loadDashboard(now),
    // The Agentic RAG account blocked (for budget): every chat is down (lib/account-block.ts).
    accountBlock(db()).catch(() => undefined),
  ]);
  return { now, dash, blocked, attention: attentionItems(dash, blocked && blockedMessage(blocked.state)) };
});

// What the bell lists: the fleet's attention items, or nothing when the database can't say.
export async function attentionNow(): Promise<AttentionItem[]> {
  return (await fleetSnapshot().catch(() => undefined))?.attention ?? [];
}

// Customers and deployments by name, for the console's search. Archived customers are left out.
export interface SearchEntry {
  kind: "customer" | "deployment";
  name: string;
  detail: string;
  href: string;
}

export async function searchIndex(): Promise<SearchEntry[]> {
  const rows = await db()
    .select({ tenantId: tenants.id, tenantName: tenants.name, id: deployments.id, name: deployments.name, siteUrl: deployments.siteUrl })
    .from(tenants)
    .leftJoin(deployments, eq(deployments.tenantId, tenants.id))
    .where(ne(tenants.status, "archived"))
    .orderBy(asc(tenants.name), asc(deployments.name));
  const host = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };
  const seen = new Set<string>();
  const out: SearchEntry[] = [];
  for (const r of rows) {
    if (!seen.has(r.tenantId)) {
      seen.add(r.tenantId);
      out.push({ kind: "customer", name: r.tenantName, detail: "Customer", href: `/customers/${r.tenantId}` });
    }
    if (r.id && r.name) {
      out.push({
        kind: "deployment",
        name: r.name,
        detail: `${r.tenantName} · ${host(r.siteUrl ?? "")}`,
        href: `/customers/${r.tenantId}/deployments/${r.id}`,
      });
    }
  }
  return out;
}

// The latest audit entries across deployments, in History's words (history.ts), newest first.
export interface ActivityEntry {
  id: number;
  at: Date;
  who: string;
  what: string;
  chip: ReturnType<typeof activityChip>;
  deployment: { id: string; name: string; href: string };
  customer: string;
}

export async function recentActivity(limit = 6): Promise<ActivityEntry[]> {
  const rows = await db()
    .select({
      id: auditLog.id,
      action: auditLog.action,
      at: auditLog.at,
      detail: auditLog.detail,
      name: users.name,
      email: users.email,
      deploymentId: deployments.id,
      deploymentName: deployments.name,
      tenantId: tenants.id,
      tenantName: tenants.name,
    })
    .from(auditLog)
    // audit_log.target_id is text (it also holds user and share ids).
    .innerJoin(deployments, eq(auditLog.targetId, sql`${deployments.id}::text`))
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(ne(tenants.status, "archived"))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(limit);
  // Setup mode: the name typed in the same sitting, as History does.
  const unnamed = [...new Set(rows.filter((r) => !(r.name ?? r.email)).map((r) => r.deploymentId))];
  const typed = new Map(await Promise.all(unnamed.map(async (id) => [id, await typedNames(id)] as const)));
  return rows.map((r) => {
    const detail = (r.detail ?? {}) as Record<string, unknown>;
    const sitting = (r.name ?? r.email) ? undefined : typedNear(typed.get(r.deploymentId) ?? [], r.at);
    return {
      id: r.id,
      at: r.at,
      who: historyActor(r.action, detail, r.name ?? r.email, sitting),
      what: historyWhat(r.action, detail),
      chip: activityChip(r.action, detail),
      deployment: { id: r.deploymentId, name: r.deploymentName, href: `/customers/${r.tenantId}/deployments/${r.deploymentId}` },
      customer: r.tenantName,
    };
  });
}
