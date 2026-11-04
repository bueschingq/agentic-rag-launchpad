// Bring up to date overnight (round 6, item 5): fixes in the extractor, the content rules and the
// answering rules reach each live deployment without a click, after its own re-check. It
// generalises the answering rules rollout (round 5, item 6), which retired the hourly push that
// rewrote every deployment's prompt at :07 past the hour with no notice (chef.io's "Our website does
// not list prices").
//
// Every 10 minutes, between 00:00 and 06:00 (the server's time: deployments have no time zone of
// their own), at most PER_RUN deployments that are behind (bringUpToDate):
// - pages read by an older extractor or content rules: read again (Sync now's re-read path,
//   lib/content.ts reextractNow: they stay in the chat meanwhile), audited deployment.uptodate with
//   step "reread". A re-read finishes, or after REREAD_LIMIT_MIN its unfinished pages are listed
//   (step "unfinished") and the job stops waiting for them;
// - then the re-check: not signed off yet, everything is applied (nothing a person signed off can
//   change); signed off, its last validation set and live starters are asked under the latest rules
//   (inline, as partner tests visitors never see) and judged as validation judges
//   (recheckUnderLatestRules, which runs the price table check too). Nothing worse: the answering
//   rules are applied (deployment.rules.applied with the re-check's numbers), and so are the pages
//   today's rules leave out (lib/content.ts applyUpToDate), audited step "applied". Anything worse:
//   it stays as it is, audited deployment.rules.held (when the answering rules were behind) and
//   step "held", with the answers that got worse (the alert in alerts.ts and Fleet's flag); a named person
//   can switch it from Review (applyAnsweringRules) or Bring up to date. An answer is worse only
//   when a second ask under the latest rules is worse too. A hold is re-checked after
//   HOLD_RETRY_HOURS, so one held by a flaky answer moves on by itself (round 6: whatsupgold.com
//   was held for good on one empty answer); a repeat hold is recorded with `repeat`, so the alert
//   stays once per version and Review shows the latest re-check.
// The re-read's new page text is in the chat as each page is read (the Knowledge Box keeps one copy
// of a page): what a hold keeps is the answering rules and the pages today's rules would take out.
// A re-read that changes the price table asks for it to be confirmed again (jobs/content.ts
// refreshPriceTable). Deployments not signed off take new answering rules at any hour.
//
// A run can be forced outside the hours (forceUpToDate: apps/worker/src/jobs/bring-up-to-date-now.ts), for the
// review environment.
//
// Agentic RAG's account block (402 budget) met here is recorded as elsewhere (lib/account-block.ts),
// and a re-check whose asks all answered records the all-clear: overnight, with no visitor traffic,
// the re-check is often the only thing asking (round 6: no block alert and no all-clear reached the
// partner's channel while every re-check met the block from 19:00 to 00:50 UTC).

import { auditLog, contentPages, type Db, deployments, syncSources } from "@launchpad/db";
import { and, desc, eq, gte, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import {
  accountBlock,
  accountBlockState,
  lastAccountEntry,
  noteAccountBlock,
  recordAccountBlock,
  recordAccountClear,
  UNBLOCKED,
} from "../../../console/src/lib/account-block.ts";
import { applyAnsweringRules } from "../../../console/src/lib/answers.ts";
import type { Refusal } from "../../../console/src/lib/ask-refusal.ts";
import { applyUpToDate, reextractNow, upToDatePreview } from "../../../console/src/lib/content.ts";
import { EXTRACTOR_VERSION, REREAD, RULES_VERSION } from "../../../console/src/lib/content-plan.ts";
import { ANSWERING_RULES, ANSWERING_RULES_CHANGES } from "../../../console/src/lib/prompt.ts";
import { type Recheck, recheckUnderLatestRules } from "../../../console/src/lib/validation.ts";
import type { JobContext } from "../context.ts";

// Deployments handled per run: each re-check asks up to about 40 questions.
const PER_RUN = 2;
// A held deployment is re-checked after this long.
export const HOLD_RETRY_HOURS = 24;
// A re-read that hasn't finished in this long lists its unfinished pages and stops waiting.
export const REREAD_LIMIT_MIN = 30;
// The night's hours, in the server's time: [from, to).
export const NIGHT = { from: 0, to: 6 } as const;
// Which call met the block or the all-clear, in its audit entry.
const WHERE = "rules re-check";

// What a re-check says about the Agentic RAG account: blocked (the state Agentic RAG named), or
// answering (every ask answered), or nothing either way. The refusal reaches here as text
// ("Agentic RAG didn't answer: POST …/ask → 402: … 'AccountBlockingState.BUDGET' …"). Pure.
export function recheckAccount(
  recheck: Recheck | { error: string; retry?: true; refused?: Refusal },
): { blocked: string } | { answering: true } | undefined {
  if (!("error" in recheck)) return { answering: true };
  if (recheck.refused?.kind === "block") return { blocked: recheck.refused.state };
  const state = recheck.retry ? accountBlockState(new Error(recheck.error)) : undefined;
  return state ? { blocked: state } : undefined;
}

// Whether now is in the night's hours, in the server's time zone (or the one given). Pure.
export function inNight(now: Date, timeZone?: string): boolean {
  const hour = timeZone
    ? Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(now))
    : now.getHours();
  return hour >= NIGHT.from && hour < NIGHT.to;
}

// The versions a deployment is brought up to: the extractor, the content rules and the answering
// rules, as one key ("6.6.5"), so an entry for older versions doesn't count.
export const TARGET = `${EXTRACTOR_VERSION}.${RULES_VERSION}.${ANSWERING_RULES}`;

export type UpToDateStep =
  | { kind: "reread" }
  | { kind: "wait"; reading: number }
  | { kind: "recheck"; unfinished: string[] }
  | { kind: "none" };

// What to do next for a deployment, from where it stands. Pure.
// - outdated: its pages read by an older extractor or rules (answerable or left out);
// - rulesBehind: on older answering rules;
// - started: when this target's re-read was queued (its "reread" entry), if it was;
// - reading: pages of that re-read still waiting or processing;
// - synced: it has finished a first sync (a first sync reads everything with the current versions).
export function nextStep(input: {
  outdated: number;
  rulesBehind: boolean;
  started?: Date;
  reading: readonly string[];
  synced: boolean;
  // When this target was last applied: pages still outdated after it (they didn't load) wait a day.
  settled?: Date;
  // When the account's last block cleared: a re-read's time limit counts from then, since nothing
  // could be read during the block.
  resumed?: Date;
  now: Date;
}): UpToDateStep {
  if (input.started) {
    const from = input.resumed && input.resumed > input.started ? input.resumed : input.started;
    const minutes = (input.now.getTime() - from.getTime()) / 60_000;
    if (input.reading.length && minutes < REREAD_LIMIT_MIN) return { kind: "wait", reading: input.reading.length };
    return { kind: "recheck", unfinished: [...input.reading] };
  }
  const settledLately = input.settled && input.now.getTime() - input.settled.getTime() < HOLD_RETRY_HOURS * 3_600_000;
  if (settledLately && !input.rulesBehind) return { kind: "none" };
  if (input.outdated > 0 && input.synced && !settledLately) return { kind: "reread" };
  if (input.outdated > 0 || input.rulesBehind) return { kind: "recheck", unfinished: [] };
  return { kind: "none" };
}

// Pages read by an older extractor or older content rules (answerable, left out, or processing), and
// those Fleet queued for tonight ("Read the pages again for all, tonight").
const outdated = and(
  or(lt(contentPages.extractorVersion, EXTRACTOR_VERSION), lt(contentPages.rulesVersion, RULES_VERSION)),
  or(
    inArray(contentPages.status, ["indexed", "skipped", "processing"]),
    and(eq(contentPages.status, "queued"), eq(contentPages.detail, REREAD.nightly)),
  ),
);

// The outer deployment's id, with its table named, in the select's raw subqueries. In a single-table
// select Drizzle writes a column there as a bare "id", which inside the subquery means audit_log's
// own id: `started` and `settled` were always null, so the job never waited for its re-read (round
// 7: re-checks ran a minute after queuing, with most pages still unread).
const DEPLOYMENT_ID = sql.raw(`"deployments"."id"`);

// The deployments behind, most behind first: their pages, or their answering rules. Not one held for
// this target in the last HOLD_RETRY_HOURS, nor one tried in the last hour (round 6: a deployment
// whose apply failed was picked every run, with nothing recorded, and the rollout stalled; and a
// hold was for good, so one flaky answer kept a site on old rules). A re-read under way comes first.
export function behindQuery(database: Db, opts: { night: boolean; only?: readonly string[] }) {
  return database
    .select({
      id: deployments.id,
      signOff: deployments.signOff,
      published: deployments.published,
      from: deployments.answeringRules,
      // This target's re-read under way (none applied or held since), and when it last settled.
      started: sql<string | null>`(select max(a.at)::text from audit_log a where a.target_id = ${DEPLOYMENT_ID}::text
        and a.action = 'deployment.uptodate' and a.detail->>'target' = ${TARGET} and a.detail->>'step' = 'reread'
        and not exists (select 1 from audit_log b where b.target_id = a.target_id and b.action = 'deployment.uptodate'
          and b.detail->>'target' = ${TARGET} and b.detail->>'step' in ('applied', 'held') and b.at >= a.at))`,
      settled: sql<string | null>`(select max(a.at)::text from audit_log a where a.target_id = ${DEPLOYMENT_ID}::text
        and a.action = 'deployment.uptodate' and a.detail->>'target' = ${TARGET} and a.detail->>'step' = 'applied')`,
    })
    .from(deployments)
    .where(
      and(
        isNotNull(deployments.kbId),
        ne(deployments.systemPrompt, ""),
        inArray(deployments.status, ["live", "paused"]),
        opts.only?.length ? inArray(deployments.id, [...opts.only]) : undefined,
        // By day, only deployments not signed off, and only for their answering rules.
        opts.night
          ? or(
              lt(deployments.answeringRules, ANSWERING_RULES),
              sql`exists (select 1 from ${contentPages} where ${contentPages.deploymentId} = ${deployments.id} and ${outdated})`,
              sql`exists (select 1 from ${auditLog} where ${auditLog.targetId} = ${deployments.id}::text and ${auditLog.action} = 'deployment.uptodate'
                and ${auditLog.detail}->>'target' = ${TARGET} and ${auditLog.detail}->>'step' = 'reread'
                and not exists (select 1 from ${auditLog} a2 where a2.target_id = ${deployments.id}::text and a2.action = 'deployment.uptodate'
                  and a2.detail->>'target' = ${TARGET} and a2.detail->>'step' in ('applied', 'held') and a2.at >= ${auditLog.at}))`,
            )
          : and(lt(deployments.answeringRules, ANSWERING_RULES), or(eq(deployments.published, false), sql`${deployments.signOff} is null`)),
        sql`not exists (select 1 from ${auditLog} where ${auditLog.targetId} = ${deployments.id}::text
          and (${auditLog.detail}->>'to')::int = ${ANSWERING_RULES}
          and ((${auditLog.action} = 'deployment.rules.held' and ${auditLog.at} > now() - make_interval(hours => ${HOLD_RETRY_HOURS}))
            or (${auditLog.action} = 'deployment.rules.tried' and ${auditLog.at} > now() - interval '1 hour')))`,
        sql`not exists (select 1 from ${auditLog} where ${auditLog.targetId} = ${deployments.id}::text
          and ${auditLog.action} = 'deployment.uptodate' and ${auditLog.detail}->>'target' = ${TARGET}
          and ((${auditLog.detail}->>'step' = 'held' and ${auditLog.at} > now() - make_interval(hours => ${HOLD_RETRY_HOURS}))
            or (${auditLog.detail}->>'step' = 'tried' and ${auditLog.at} > now() - interval '1 hour')))`,
      ),
    )
    .orderBy(sql`5 desc nulls last`, deployments.answeringRules)
    .limit(PER_RUN * 4);
}
const behind = (ctx: JobContext, opts: { night: boolean; only?: readonly string[] }) => behindQuery(ctx.db, opts);

// The scheduled run: in the night's hours, deployments behind are re-read and re-checked; by day,
// only deployments not signed off take new answering rules.
export async function rolloutRules(ctx: JobContext, now = new Date()): Promise<void> {
  await bringUpToDate(ctx, { now, night: inNight(now) });
}

// A run outside the night's hours (the review environment's apps/worker/src/jobs/bring-up-to-date-now.ts), for every
// deployment behind or only those named.
export async function forceUpToDate(ctx: JobContext, only?: readonly string[], now = new Date()): Promise<string[]> {
  return bringUpToDate(ctx, { now, night: true, ...(only && { only }) });
}

// One run: up to PER_RUN deployments moved on a step. Returns what happened, one line each.
export async function bringUpToDate(ctx: JobContext, opts: { now?: Date; night: boolean; only?: readonly string[] }): Promise<string[]> {
  const now = opts.now ?? new Date();
  const done: string[] = [];
  const say = (line: string) => {
    done.push(line);
    ctx.log(`up to date: ${line}`);
  };
  // While the account is blocked nothing can be read or checked, so nothing starts: no re-read queued,
  // no re-check, nothing applied or held. It carries on after the all-clear (revalidate's check).
  if (await accountBlock(ctx.db).catch(() => undefined)) {
    say("waiting: the account is blocked");
    return done;
  }
  const lastEntry = await lastAccountEntry(ctx.db).catch(() => undefined);
  const resumed = lastEntry?.action === UNBLOCKED ? lastEntry.at : undefined;
  let handled = 0;
  for (const d of await behind(ctx, opts)) {
    if (handled >= PER_RUN) break;
    try {
      const signedOff = Boolean(d.published && d.signOff);
      const rulesBehind = d.from < ANSWERING_RULES;
      if (!opts.night) {
        // By day: not signed off, so nothing a person signed off changes.
        handled += 1;
        await applyRules(ctx, d.id, d.from);
        say(`${d.id} on answering rules v${ANSWERING_RULES} (not signed off)`);
        continue;
      }
      const [source] = await ctx.db
        .select({ lastSyncedAt: syncSources.lastSyncedAt })
        .from(syncSources)
        .where(and(eq(syncSources.deploymentId, d.id), eq(syncSources.kind, "sitemap")));
      const [counts] = await ctx.db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(contentPages)
        .where(and(eq(contentPages.deploymentId, d.id), outdated));
      const started = d.started ? new Date(d.started) : undefined;
      const settled = d.settled ? new Date(d.settled) : undefined;
      const reading = started ? await stillReading(ctx, d.id, started) : [];
      const step = nextStep({
        outdated: counts?.n ?? 0,
        rulesBehind,
        ...(started && { started }),
        ...(settled && { settled }),
        ...(resumed && { resumed }),
        reading,
        synced: Boolean(source?.lastSyncedAt),
        now,
      });
      if (step.kind === "none") continue;
      if (step.kind === "wait") {
        // Not counted against the run: it's the worker's sync that moves it on.
        say(`${d.id} still reading ${step.reading} pages again`);
        continue;
      }
      handled += 1;
      if (step.kind === "reread") {
        const pages = await reextractNow(d.id, null);
        await record(ctx, d.id, "reread", { pages, from: d.from });
        say(`${d.id}: ${pages} pages read by an older extractor or rules are being read again`);
        continue;
      }
      if (step.unfinished.length) {
        await record(ctx, d.id, "unfinished", { pages: step.unfinished.slice(0, 50), count: step.unfinished.length });
        say(
          `${d.id}: ${step.unfinished.length} pages not read again within ${REREAD_LIMIT_MIN} minutes; re-checking without waiting for them`,
        );
      }
      if (!signedOff) {
        if (rulesBehind) await applyRules(ctx, d.id, d.from);
        const leftOut = await applyLeaveOuts(d.id);
        await record(ctx, d.id, "applied", { leftOut, ...(step.unfinished.length && { unfinished: step.unfinished.length }) });
        say(`${d.id} brought up to date (not signed off)${leftOut ? `, ${leftOut} pages left out under today's rules` : ""}`);
        continue;
      }
      const recheck = await recheckUnderLatestRules(d.id);
      const account = recheckAccount(recheck);
      if (account && "blocked" in account) await recordBlock(ctx, account.blocked);
      if (account && "answering" in account) await recordAccountClear(ctx.db, WHERE).catch(() => false);
      if ("error" in recheck && recheck.retry) {
        // Agentic RAG refused (402 budget, 5xx): neither applied nor held; tried again in an hour.
        if (rulesBehind) await tried(ctx, d.id, d.from, recheck.error);
        await record(ctx, d.id, "tried", { error: recheck.error.slice(0, 300) });
        say(`${d.id} re-check not done, tried again later: ${recheck.error}`);
        continue;
      }
      if ("error" in recheck) {
        // Nothing to re-check against: a person applies it (saving the prompt, or Review's switch).
        const none = { total: 0, unchanged: 0, better: 0, worse: [] };
        if (rulesBehind) await hold(ctx, d.id, d.from, none, recheck.error);
        await record(ctx, d.id, "held", { why: recheck.error, total: 0, worse: [] });
        say(`${d.id} held: ${recheck.error}`);
        continue;
      }
      if (!recheck.worse.length) {
        const numbers = { total: recheck.total, unchanged: recheck.unchanged, better: recheck.better };
        if (rulesBehind) await applyAnsweringRules(d.id, { recheck: numbers });
        const leftOut = await applyLeaveOuts(d.id);
        await record(ctx, d.id, "applied", { ...numbers, leftOut, ...(step.unfinished.length && { unfinished: step.unfinished.length }) });
        say(`${d.id} brought up to date after a re-check: ${recheck.total} of ${recheck.total} unchanged or better`);
      } else {
        if (rulesBehind) await hold(ctx, d.id, d.from, recheck);
        await record(ctx, d.id, "held", { total: recheck.total, worse: recheck.worse });
        say(`${d.id} held: ${recheck.worse.length} answers worse after the re-read and under v${ANSWERING_RULES}`);
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      await noteAccountBlock(ctx.db, err, WHERE);
      await tried(ctx, d.id, d.from, why).catch(() => {});
      await record(ctx, d.id, "tried", { error: why.slice(0, 300) }).catch(() => {});
      say(`${d.id} failed: ${why}`);
    }
  }
  return done;
}

// The pages of a re-read started at `since` still to finish: waiting to be read again, or sent and
// not yet processed by Agentic RAG.
async function stillReading(ctx: JobContext, deploymentId: string, since: Date): Promise<string[]> {
  const rows = await ctx.db
    .select({ url: contentPages.url })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.deploymentId, deploymentId),
        or(
          and(eq(contentPages.status, "queued"), inArray(contentPages.detail, [REREAD.nightly, REREAD.now, REREAD.apply])),
          and(eq(contentPages.status, "processing"), gte(contentPages.sentAt, since)),
        ),
      ),
    )
    .orderBy(desc(contentPages.updatedAt))
    .limit(500);
  return rows.map((r) => r.url);
}

// The pages today's rules leave out, taken out (Bring up to date's step 1, by the job). Returns how many.
async function applyLeaveOuts(deploymentId: string): Promise<number> {
  const preview = await upToDatePreview(deploymentId, { reread: false });
  if (!preview.leaveOut.length) return 0;
  return (await applyUpToDate(deploymentId, null)).leftOut;
}

// Answering rules applied to a deployment not signed off; a failure is tried again in an hour.
async function applyRules(ctx: JobContext, deploymentId: string, from: number) {
  const applied = await applyAnsweringRules(deploymentId);
  if ("error" in applied) {
    await noteAccountBlock(ctx.db, new Error(applied.error), WHERE);
    await tried(ctx, deploymentId, from, applied.error);
  }
}

// A step of bringing a deployment up to date, for History, Fleet and the next run.
async function record(ctx: JobContext, deploymentId: string, step: "reread" | "unfinished" | "applied" | "held" | "tried", detail: object) {
  await ctx.db.insert(auditLog).values({
    actorUserId: null,
    action: "deployment.uptodate",
    targetType: "deployment",
    targetId: deploymentId,
    detail: {
      step,
      target: TARGET,
      extractor: EXTRACTOR_VERSION,
      rules: RULES_VERSION,
      answering: ANSWERING_RULES,
      ...detail,
      name: "bring up to date overnight",
    },
  });
}

// The block, recorded once (lib/account-block.ts): the alerts job posts it, and the all-clear later.
async function recordBlock(ctx: JobContext, state: string) {
  await recordAccountBlock(ctx.db, state, WHERE).catch(() => false);
}

// A try that neither applied nor held, so the next runs move on to other deployments for an hour.
async function tried(ctx: JobContext, deploymentId: string, from: number, error: string) {
  await ctx.db.insert(auditLog).values({
    actorUserId: null,
    action: "deployment.rules.tried",
    targetType: "deployment",
    targetId: deploymentId,
    detail: { from, to: ANSWERING_RULES, error: error.slice(0, 300), name: "the answering rules re-check" },
  });
}

// A hold. The first for a version is the alert; a later re-check that holds again (after
// HOLD_RETRY_HOURS) is recorded with `repeat`, for Review's latest state and History, without a
// second alert.
async function hold(ctx: JobContext, deploymentId: string, from: number, recheck: Recheck, why?: string) {
  const [earlier] = await ctx.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetId, deploymentId),
        eq(auditLog.action, "deployment.rules.held"),
        sql`(${auditLog.detail}->>'to')::int = ${ANSWERING_RULES}`,
      ),
    )
    .limit(1);
  await ctx.db.insert(auditLog).values({
    actorUserId: null,
    action: "deployment.rules.held",
    targetType: "deployment",
    targetId: deploymentId,
    detail: {
      from,
      to: ANSWERING_RULES,
      changes: ANSWERING_RULES_CHANGES[ANSWERING_RULES] ?? "",
      total: recheck.total,
      worse: recheck.worse,
      ...(why && { why }),
      ...(earlier && { repeat: true }),
      name: "the answering rules re-check",
    },
  });
}
