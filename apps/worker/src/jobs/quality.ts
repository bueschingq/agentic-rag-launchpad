// Daily REMi averages per deployment: answer relevance (1–5), context relevance, groundedness.
// REMi scores appeared within minutes of each answer in M0.

import { qualityDaily } from "@launchpad/db";
import { noteAccountBlock } from "../../../console/src/lib/account-block.ts";
import { activeDeployments, type JobContext, managerClient } from "../context.ts";
import { addDays, isoDate } from "../dates.ts";

export async function rollupQuality(ctx: JobContext, day: Date): Promise<void> {
  for (const d of await activeDeployments(ctx)) {
    try {
      const kb = await managerClient(ctx, d);
      if (!kb) continue;
      const buckets = await kb.remiScores({ from: day, to: addDays(day, 1), aggregation: "day" });
      const metrics = buckets.find((b) => b.timestamp.startsWith(isoDate(day)))?.metrics ?? [];
      if (metrics.length === 0) continue;
      const avg = (name: string) => metrics.find((m) => m.name === name)?.average ?? null;
      const values = {
        answerRelevance: avg("answer_relevance"),
        contextRelevance: avg("context_relevance"),
        groundedness: avg("groundedness"),
      };
      await ctx.db
        .insert(qualityDaily)
        .values({ deploymentId: d.id, day: isoDate(day), ...values })
        .onConflictDoUpdate({ target: [qualityDaily.deploymentId, qualityDaily.day], set: { ...values, updatedAt: new Date() } });
    } catch (err) {
      ctx.log(`quality rollup failed for deployment ${d.id}: ${err instanceof Error ? err.message : err}`);
      await noteAccountBlock(ctx.db, err, "quality");
    }
  }
}
