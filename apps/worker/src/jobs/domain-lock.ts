// Checks the domain lock again after a deployment's domains change (an edit, or Allow it on a
// refused origin), so nobody has to come back and press "Check the domain lock". A change
// clears the deployment's last check; Agentic RAG takes from 15 s to a few minutes to apply
// it. Every minute for half an hour after the change, this sends the browser's CORS preflight
// from each domain, and records the result once every domain passes, or after 10 minutes
// whatever it says, so a lock that never applies shows as failed rather than pending.

import { auditLog, deployments, type PreflightResult } from "@launchpad/db";
import { zoneApi } from "@launchpad/par-client";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { JobContext } from "../context.ts";

const WATCH_MINUTES = 30;
const GIVE_UP_MINUTES = 10;

// A CORS preflight for /ask from each origin, as the visitor's browser sends it (the console's
// checkPreflight in lib/validation.ts does the same on request).
export async function lockCheck(
  zone: string,
  kbId: string,
  origins: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<PreflightResult> {
  const results = await Promise.all(
    origins.map(async (origin) => {
      try {
        const res = await fetchImpl(`${zoneApi(zone)}/kb/${kbId}/ask`, {
          method: "OPTIONS",
          headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
          signal: AbortSignal.timeout(10_000),
        });
        await res.body?.cancel();
        const allowed = res.headers.get("access-control-allow-origin");
        return { origin, ok: res.ok && (allowed === origin || allowed === "*"), status: res.status };
      } catch {
        return { origin, ok: false, status: 0 };
      }
    }),
  );
  return { at: new Date().toISOString(), origins: results };
}

// Whether to record a check: once it passes, or once the lock has had long enough. Pure.
export function settled(result: PreflightResult, changedAt: Date, now: Date): boolean {
  return result.origins.every((o) => o.ok) || now.getTime() - changedAt.getTime() >= GIVE_UP_MINUTES * 60_000;
}

export async function recheckDomainLocks(ctx: JobContext, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<void> {
  const changedAt = sql<Date>`(select max(${auditLog.at}) from ${auditLog}
    where ${auditLog.targetId} = ${deployments.id}::text and ${auditLog.action} = 'deployment.domains')`.mapWith((v) => new Date(v));
  const due = await ctx.db
    .select({
      id: deployments.id,
      zone: deployments.zone,
      kbId: deployments.kbId,
      domains: deployments.domains,
      validation: deployments.validation,
      readyAt: deployments.readyAt,
      changedAt,
    })
    .from(deployments)
    .where(
      and(
        isNull(deployments.preflight),
        isNotNull(deployments.kbId),
        inArray(deployments.status, ["live", "paused"]),
        sql`cardinality(${deployments.domains}) > 0`,
        sql`${changedAt} > ${new Date(now.getTime() - WATCH_MINUTES * 60_000).toISOString()}::timestamptz`,
      ),
    );
  for (const d of due) {
    const result = await lockCheck(d.zone, d.kbId!, d.domains, fetchImpl);
    if (!settled(result, d.changedAt, now)) continue;
    const ready = !d.readyAt && d.validation?.passed && result.origins.every((o) => o.ok);
    // Only while nobody has changed the domains or checked meanwhile.
    await ctx.db
      .update(deployments)
      .set({ preflight: result, ...(ready && { readyAt: now }) })
      .where(and(eq(deployments.id, d.id), isNull(deployments.preflight)));
    ctx.log(`domain lock for ${d.id}: ${result.origins.every((o) => o.ok) ? "applied" : "still refused after 10 min"}`);
  }
}
