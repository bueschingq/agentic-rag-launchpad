// A customer's spend against its monthly budget, and whether that takes its chatbots offline
// (only when the customer is set to "Stop at 100%"; the default is alert only).

import { deployments, tenants, usageDaily } from "@launchpad/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "./db.ts";

export const isStoppedForBudget = (mode: string, budgetCents: number | null, spentCents: number) =>
  mode === "stop" && budgetCents !== null && budgetCents > 0 && spentCents >= budgetCents;

export async function monthSpendCents(tenantId: string, now = new Date()): Promise<number> {
  const first = `${now.toISOString().slice(0, 7)}-01`;
  const [row] = await db()
    .select({ cents: sql<number>`coalesce(sum(${usageDaily.costCents}), 0)`.mapWith(Number) })
    .from(usageDaily)
    .innerJoin(deployments, eq(deployments.id, usageDaily.deploymentId))
    .where(and(eq(deployments.tenantId, tenantId), gte(usageDaily.day, first)));
  return row?.cents ?? 0;
}

export async function budgetState(tenantId: string) {
  const [t] = await db()
    .select({ budget: tenants.monthlyBudgetCents, mode: tenants.budgetMode })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  const spent = await monthSpendCents(tenantId);
  return {
    budgetCents: t?.budget ?? null,
    mode: t?.mode ?? "alert",
    spentCents: spent,
    stopped: isStoppedForBudget(t?.mode ?? "alert", t?.budget ?? null, spent),
  };
}
