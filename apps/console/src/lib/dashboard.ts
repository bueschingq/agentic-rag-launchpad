// Database reads behind the dashboard pages. The arithmetic lives in metrics.ts.
//
// Each page loads the whole fleet's last 60 days and works in memory. A partner with 200
// sites has about 12,000 usage rows in that window, so this stays cheap well past v1.

import { deployments, qualityDaily, settings, syncSources, tenants, usageDaily } from "@launchpad/db";
import { and, asc, desc, eq, gte, lt, ne, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { buildDashboard, type Dashboard, isoDay, type MonthLine, monthTotals, shiftDay, type UsageDay } from "./metrics.ts";

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
    .select({ id: tenants.id, name: tenants.name, status: tenants.status, monthlyBudgetCents: tenants.monthlyBudgetCents })
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
        status: deployments.status,
        kbSlug: deployments.kbSlug,
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
  return buildDashboard({ now, tenants: tenantRows, deployments: deploymentRows, usage: usage.map(toUsageDay), quality, syncs });
}

export interface CostReport {
  month: string;
  // Months with any usage, newest first (at most 12).
  months: string[];
  lines: (MonthLine & { name: string; monthlyBudgetCents: number | null })[];
}

export async function loadCosts(month: string): Promise<CostReport> {
  const next = shiftDay(`${month}-01`, 32).slice(0, 7);
  const monthExpr = sql<string>`to_char(${usageDaily.day}, 'YYYY-MM')`;
  const inMonth = and(gte(usageDaily.day, `${month}-01`), lt(usageDaily.day, `${next}-01`));
  const [months, tenantRows, owners, usage] = await Promise.all([
    db().selectDistinct({ month: monthExpr }).from(usageDaily).orderBy(desc(monthExpr)).limit(12),
    loadTenants(),
    db().select({ id: deployments.id, tenantId: deployments.tenantId }).from(deployments),
    db().select(usageColumns).from(usageDaily).where(inMonth),
  ]);
  const totals = monthTotals(usage.map(toUsageDay), new Map(owners.map((d) => [d.id, d.tenantId])), month);
  return {
    month,
    months: months.map((m) => m.month),
    lines: tenantRows.flatMap((t) => {
      const line = totals.get(t.id);
      return line ? [{ ...line, name: t.name, monthlyBudgetCents: t.monthlyBudgetCents }] : [];
    }),
  };
}
