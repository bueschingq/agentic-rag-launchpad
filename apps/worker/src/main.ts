// Schedules content sync and the rollups with pg-boss (Postgres-backed: no extra infrastructure). Each job
// runs on one worker at a time even if several worker containers are up.

import PgBoss from "pg-boss";
import { createContext } from "./context.ts";
import { addDays, startOfUtcDay } from "./dates.ts";
import { alertPasses } from "./jobs/alerts.ts";
import { reprocessForAgents } from "./jobs/augment.ts";
import { syncContent } from "./jobs/content.ts";
import { recheckDomainLocks } from "./jobs/domain-lock.ts";
import { refreshPromptDates } from "./jobs/prompt-date.ts";
import { rollupQuality } from "./jobs/quality.ts";
import { revalidateAfterSync } from "./jobs/revalidate.ts";
import { rolloutRules } from "./jobs/rules-rollout.ts";
import { recountMonth, reportJudge, rollupUsage } from "./jobs/usage.ts";
import { snifferClient } from "./sniffer.ts";

const ctx = createContext();
const today = () => startOfUtcDay(new Date());
const yesterday = () => addDays(today(), -1);

const sniffer = snifferClient();
if (!sniffer) ctx.log("content sync is off: set SNIFFER_URL and SNIFFER_TOKEN");

const JOBS: { name: string; cron: string; run: () => Promise<void> }[] = [
  // Each run does a slice of every sync in progress (see jobs/content.ts).
  ...(sniffer ? [{ name: "content-sync", cron: "* * * * *", run: () => syncContent(ctx, sniffer) }] : []),
  // Today's running totals, so the dashboard and budget alerts stay current.
  { name: "rollup-usage", cron: "*/15 * * * *", run: () => rollupUsage(ctx, today()) },
  // Close out yesterday once its last questions have landed in the log, judging the answers that
  // say something is missing (at most 200 a deployment), so the report's content gaps are real.
  { name: "rollup-usage-final", cron: "20 0 * * *", run: () => rollupUsage(ctx, yesterday(), 1, { judge: reportJudge }) },
  { name: "rollup-quality", cron: "30 0 * * *", run: () => rollupQuality(ctx, yesterday()) },
  // The month so far, counted again (one question per visitor question); also once at start, below.
  { name: "rollup-usage-month", cron: "40 0 * * *", run: () => recountMonth(ctx, today()) },
  // Alerts to the partner, and retries for leads that couldn't be delivered: every minute,
  // looking twice, so an alert reaches the inbox within a minute.
  { name: "alerts", cron: "* * * * *", run: () => alertPasses(ctx) },
  // The domain lock, checked again until it applies after the domains change.
  { name: "domain-lock", cron: "* * * * *", run: () => recheckDomainLocks(ctx) },
  // Today's date in every saved prompt, once a day and never the rules (round 5: the hourly push is retired).
  { name: "prompt-date", cron: "5 0 * * *", run: () => refreshPromptDates(ctx, new Date()) },
  // New answering rules, per deployment, after its own re-check (jobs/rules-rollout.ts).
  { name: "rules-rollout", cron: "*/10 * * * *", run: () => rolloutRules(ctx) },
  // Validation again once the first sync finishes, and questions again once added pages are in.
  { name: "revalidate", cron: "* * * * *", run: () => revalidateAfterSync(ctx) },
  // Pages processed again, a batch a minute, after Agentic RAG agents are turned on for a deployment.
  { name: "augment", cron: "* * * * *", run: () => reprocessForAgents(ctx) },
];

// Cron jobs start within 10 s of their minute (pg-boss checks every 30 s by default).
const boss = new PgBoss({ connectionString: process.env.DATABASE_URL, schema: "pgboss", cronMonitorIntervalSeconds: 10 });
boss.on("error", (err) => ctx.log(`pg-boss: ${err.message}`));
await boss.start();

// The old nightly batch's schedule, kept by pg-boss until it's taken off: Bring up to date overnight
// (jobs/rules-rollout.ts) reads pages again now.
await boss.unschedule("content-reread").catch(() => {});

// A test environment can leave out jobs that spend Agentic RAG tokens (WORKER_SKIP_JOBS=a,b); pg-boss
// keeps a schedule until it's taken off.
const skipped = new Set((process.env.WORKER_SKIP_JOBS ?? "").split(",").map((name) => name.trim()));
for (const job of JOBS) {
  if (skipped.has(job.name)) {
    await boss.unschedule(job.name).catch(() => {});
    ctx.log(`${job.name} skipped (WORKER_SKIP_JOBS)`);
    continue;
  }
  await boss.createQueue(job.name);
  await boss.schedule(job.name, job.cron, {}, { tz: "UTC" });
  await boss.work(job.name, async () => {
    const started = Date.now();
    await job.run();
    ctx.log(`${job.name} done in ${Date.now() - started} ms`);
  });
}
ctx.log(`scheduled ${JOBS.map((j) => j.name).join(", ")}`);
// The month's figures by the current counting rules now, rather than tonight; once across workers.
await boss.send("rollup-usage-month", {}, { singletonKey: "start", singletonSeconds: 600 });

async function shutdown(signal: string) {
  ctx.log(`${signal}: stopping`);
  await boss.stop({ graceful: true, timeout: 30_000 });
  await ctx.close();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
