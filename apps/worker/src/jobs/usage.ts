// Questions, searches and query-side tokens per deployment per UTC day, priced at the
// partner's contract rate. Processing/storage usage (needs a PAT) is added in M4.

import { settings, usageDaily } from "@launchpad/db";
import type { KbClient } from "@launchpad/par-client";
import { eq } from "drizzle-orm";
import { activeDeployments, type JobContext, managerClient } from "../context.ts";
import { addDays, costCents, isoDate, parseLogDate, yearMonth } from "../dates.ts";

const PAGE = 100;

export async function rollupUsage(ctx: JobContext, day: Date): Promise<void> {
  const next = addDays(day, 1);
  const [config] = await ctx.db.select({ rates: settings.contractRates }).from(settings).where(eq(settings.id, 1));
  const rate = config?.rates.nuclia_tokens;

  for (const d of await activeDeployments(ctx)) {
    try {
      const kb = await managerClient(ctx, d);
      if (!kb) continue;
      const buckets = await kb.activityMetrics({ from: day, to: next, aggregation: "day" });
      const bucket = buckets.find((b) => b.timestamp.startsWith(isoDate(day)));
      const tokens = await queryTokens(kb, day, next);
      const values = {
        questions: bucket?.ask ?? 0,
        searches: bucket?.search ?? 0,
        queryTokens: tokens.toFixed(6),
        costCents: costCents(tokens, rate) ?? null,
      };
      await ctx.db
        .insert(usageDaily)
        .values({ deploymentId: d.id, day: isoDate(day), ...values })
        .onConflictDoUpdate({ target: [usageDaily.deploymentId, usageDaily.day], set: { ...values, updatedAt: new Date() } });
    } catch (err) {
      ctx.log(`usage rollup failed for deployment ${d.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// Sum of nuclia_tokens over the ask log for [from, to).
async function queryTokens(kb: KbClient, from: Date, to: Date): Promise<number> {
  let total = 0;
  let after: number | undefined;
  for (let page = 0; page < 1000; page++) {
    const rows = await kb.askLog({
      yearMonth: yearMonth(from),
      since: from,
      limit: PAGE,
      startingAfter: after,
      show: ["id", "date", "nuclia_tokens"],
    });
    for (const row of rows) {
      const at = parseLogDate(row.date);
      if (at >= from && at < to) total += row.nuclia_tokens ?? 0;
    }
    if (rows.length < PAGE) break;
    after = rows.at(-1)?.id;
  }
  return total;
}
