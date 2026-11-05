// Shared pieces of the only routes customer sites can reach: /api/public/deployments/{id}/*.
// The KB's allowed_origins blocks other sites in browsers but not scripted clients (M0),
// so these routes check Origin themselves and rate-limit (see origin.ts).

import { deployments, refusedOrigins, tenants } from "@launchpad/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { isStoppedForBudget, monthSpendCents } from "./budget.ts";
import { db } from "./db.ts";
import { normaliseOrigin } from "./origin.ts";

export { clientIp, corsHeaders, isAllowedOrigin, RateLimiter } from "./origin.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findDeployment(id: string) {
  if (!UUID.test(id)) return undefined;
  const [row] = await db()
    .select({
      deployment: deployments,
      tenantStatus: tenants.status,
      budgetCents: tenants.monthlyBudgetCents,
      budgetMode: tenants.budgetMode,
    })
    .from(deployments)
    .innerJoin(tenants, eq(deployments.tenantId, tenants.id))
    .where(eq(deployments.id, id))
    .limit(1);
  return row;
}

// Serving: provisioned and not paused, the customer active, and not stopped for its budget.
export async function isOnline(row: NonNullable<Awaited<ReturnType<typeof findDeployment>>>): Promise<boolean> {
  if (row.deployment.status !== "live" || row.tenantStatus !== "active") return false;
  if (row.budgetMode !== "stop" || !row.budgetCents) return true;
  return !isStoppedForBudget(row.budgetMode, row.budgetCents, await monthSpendCents(row.deployment.tenantId));
}

// A site that asked for the widget and isn't allowed: hostname and count only, so the partner
// can allow it from the deployment page.
export async function recordRefused(deploymentId: string, origin: string | null): Promise<void> {
  const o = origin && origin !== "null" ? normaliseOrigin(origin) : undefined;
  if (!o) return;
  await db()
    .insert(refusedOrigins)
    .values({ deploymentId, origin: o, count: 1 })
    .onConflictDoUpdate({
      target: [refusedOrigins.deploymentId, refusedOrigins.origin],
      set: { count: sql`${refusedOrigins.count} + 1`, lastSeenAt: new Date() },
    });
}

// The first chat session from an allowed domain makes a deployment Live.
export async function recordFirstSeen(deploymentId: string, origin: string): Promise<void> {
  await db()
    .update(deployments)
    .set({ firstSeenAt: new Date(), firstSeenOrigin: origin })
    .where(and(eq(deployments.id, deploymentId), isNull(deployments.firstSeenAt)));
}

export const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
