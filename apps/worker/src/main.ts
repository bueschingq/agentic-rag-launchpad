// Schedules the rollups with pg-boss (Postgres-backed: no extra infrastructure). Each job
// runs on one worker at a time even if several worker containers are up.

import PgBoss from "pg-boss";
import { createContext } from "./context.ts";
import { addDays, startOfUtcDay } from "./dates.ts";
import { rollupQuality } from "./jobs/quality.ts";
import { rollupUsage } from "./jobs/usage.ts";

const ctx = createContext();
const today = () => startOfUtcDay(new Date());
const yesterday = () => addDays(today(), -1);

const JOBS: { name: string; cron: string; run: () => Promise<void> }[] = [
  // Today's running totals, so the dashboard and budget alerts stay current.
  { name: "rollup-usage", cron: "*/15 * * * *", run: () => rollupUsage(ctx, today()) },
  // Close out yesterday once its last questions have landed in the log.
  { name: "rollup-usage-final", cron: "20 0 * * *", run: () => rollupUsage(ctx, yesterday()) },
  { name: "rollup-quality", cron: "30 0 * * *", run: () => rollupQuality(ctx, yesterday()) },
];

const boss = new PgBoss({ connectionString: process.env.DATABASE_URL, schema: "pgboss" });
boss.on("error", (err) => ctx.log(`pg-boss: ${err.message}`));
await boss.start();

for (const job of JOBS) {
  await boss.createQueue(job.name);
  await boss.schedule(job.name, job.cron, {}, { tz: "UTC" });
  await boss.work(job.name, async () => {
    const started = Date.now();
    await job.run();
    ctx.log(`${job.name} done in ${Date.now() - started} ms`);
  });
}
ctx.log(`scheduled ${JOBS.map((j) => j.name).join(", ")}`);

async function shutdown(signal: string) {
  ctx.log(`${signal}: stopping`);
  await boss.stop({ graceful: true, timeout: 30_000 });
  await ctx.close();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
