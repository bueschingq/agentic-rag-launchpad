// Alerts to the partner (Settings › Alerts: a webhook and/or email), each sent once per
// threshold and period: budgets at 80% and 100% this month (only the higher one when both are
// crossed at once), failed provisioning (once per cause, until it clears), syncs, a first
// sync still waiting after 15 minutes, a usage roll-up that stopped, keys 60, 30 and 7 days
// before they expire, leads that couldn't be delivered, and one per customer whose live chats
// were signed off under older checks. Also a post for each change visitors see on a live chat:
// who changed what, where, and one line when a signed-off chat's answering rules change ("answering
// rules v4 → v5, applied after a re-check", round 6). Also retries undelivered leads, and deletes them once delivered or
// after 7 days.
//
// Validation alerts only for runs the console started by itself (after the first sync, once half
// the pages are answerable), and only for what such a run opened: answers that failed, lost their
// answer or need a check again, compared with the run before it (the `opened` list validation
// writes in the run's audit entry). Never for what a person's run left open: they saw it, and the
// saved run carries it on whatever the worker re-asks later (round 5: a re-ask after added pages
// marked a person's run as automatic, and its three open answers were posted). On a signed-off
// deployment, anything opened posts one alert naming the client; before sign-off, only a run that
// fails on answers that newly failed or lost their answer. Not a run on partial content, which
// runs again once the sync finishes. The same opened items on the same deployment post once an
// hour at most. A starter the automatic run took off the live chat (it failed twice) posts one
// alert per removal, and isn't counted again in the run's.
//
// Every subject leads with the internal customer name, which is what the partner searches for,
// then the deployment: "Crayola (UX review r3) › Main site: validation failed". The job runs every
// minute and looks twice, so an alert reaches the inbox within a minute of its cause.

import {
  alertsSent,
  auditLog,
  credentials,
  deployments,
  leads,
  type ProvisioningStep,
  type SignOff,
  settings,
  syncSources,
  tenants,
  usageDaily,
  users,
  type ValidationResult,
} from "@launchpad/db";
import { deliver, type Message } from "@launchpad/notify";
import { problemCause, provisioningProblem } from "@launchpad/par-client";
import { questionHash } from "@launchpad/theme";
import { and, desc, eq, gte, inArray, isNull, like, lte, max, or, sql } from "drizzle-orm";
import { accountAlert, lastAccountEntry } from "../../../console/src/lib/account-block.ts";
import { plainFailure } from "../../../console/src/lib/ask-refusal.ts";
import { openItems } from "../../../console/src/lib/metrics.ts";
import { questionKey } from "../../../console/src/lib/validation-rules.ts";
import { fieldWords } from "../../../console/src/lib/widget-diff.ts";
import type { JobContext } from "../context.ts";

const LEAD_RETRY_DAYS = 7;
// A first sync with nothing answerable after this long is waiting behind other syncs.
export const SYNC_WAIT_MINUTES = 15;
// Changes older than this aren't posted: the channel hears about changes as they happen.
const CHANGE_WINDOW_MS = 60 * 60_000;
// The second look, after the first.
const SECOND_LOOK_MS = 30_000;
// The review's rules, as stamped on sign-offs: CHECKS_VERSION in the console's lib/review.ts,
// which the worker can't import (it reads the console's sign-in types). A test keeps them equal.
export const CHECKS_VERSION = 3;
const underOlderChecks = (signOff: SignOff | null) => Boolean(signOff) && (signOff?.checksVersion ?? 0) < CHECKS_VERSION;

export interface PendingAlert {
  key: string;
  message: Message;
  // Recorded as sent without sending: a lower threshold overtaken by a higher one.
  silent?: boolean;
  // Kept quiet when an alert already sent matches one of these (SQL LIKE on the key), within `ms`
  // when given: the same failure within the hour, or the same run.
  quietIf?: { like: string; ms?: number }[];
}

// The same open items on a deployment post once in this long.
export const SAME_FAILURE_MS = 60 * 60_000;

// "Crayola (UX review r3) › Main site": the internal customer name, then the deployment.
export const where = (tenantName: string, deployment: string) => `${tenantName} › ${deployment}`;

// A failed provisioning, once per deployment and cause: retries that fail the same way stay
// quiet, and the key is cleared once the deployment recovers. Pure.
export function provisioningAlert(
  d: { id: string; name: string; tenantName: string; provisioningLog: ProvisioningStep[] },
  link: string | undefined,
): PendingAlert {
  const failed = d.provisioningLog.findLast((s) => s.status === "failed");
  const problem = provisioningProblem(failed?.detail);
  const reason: Record<string, string> = {
    limit: "Knowledge Box limit reached",
    "key-rights": "the account key can't manage Knowledge Boxes",
    "key-invalid": "the account key was refused",
    unreachable: "Agentic RAG unreachable",
    timeout: "Agentic RAG timed out",
    other: "a step was refused",
  };
  return {
    key: `provision-failed:${d.id}:${problemCause(problem)}`,
    message: {
      subject: `${where(d.tenantName, d.name)}: provisioning failed (${reason[problem.kind]})`,
      text: problem.text,
      ...(link && { link }),
    },
  };
}

// What a run leaves for a person (the console's rule, which Fleet's needing-attention list uses too).
export { openItems };

// The same open items, whichever run found them: 16 hex digits.
export const openFingerprint = (items: readonly { question: string; what: string }[]) =>
  questionHash(
    items
      .map((i) => `${questionKey(i.question)}|${i.what}`)
      .sort()
      .join("\n"),
  );

// An audit entry on a deployment, as the alerts read them: validation runs (deployment.validate,
// with `auto` when the console started it, and `opened`), the worker's re-asks
// (deployment.validation.ask-again) and starter removals.
export interface AuditEntry {
  id: number;
  action: string;
  at: Date;
  detail: unknown;
}

// What a run opened, as validation records it (openedSince in the console's validation-rules.ts):
// each question with what it now owes, "Failed: …", "No answer" or "A check", and whether that
// check had been done before.
interface Opened {
  question: string;
  was: string;
  reopened?: boolean;
}

function openedOf(detail: unknown): Opened[] {
  const opened = (detail as { opened?: unknown } | null)?.opened;
  return (Array.isArray(opened) ? opened : []).filter(
    (o): o is Opened => typeof o?.question === "string" && o.question.trim() !== "" && typeof o?.was === "string",
  );
}

// An opened item in the alert's words: the price checks by name (from the saved run's flags).
function owes(o: Opened, questions: readonly ValidationResult["questions"][number][]): string {
  if (o.was.startsWith("Failed")) return `failed: ${plainFailure(o.was.replace(/^Failed:\s*/, ""))}`;
  if (o.was === "No answer") return "no answer";
  const price = questions.some((q) => questionKey(q.question) === questionKey(o.question) && q.flags?.includes("price"));
  return `${price ? "a price" : "an answer"} to check${o.reopened ? " again: it was checked before" : ""}`;
}

// One validation run the console started by itself (its audit entry has `auto`), and only what it
// opened compared with the run before it, never what was already open:
// - signed off: anything it opened. "A price check reopened after the sync, with no one told"
//   (Exec, round 4) is the case.
// - not signed off yet: only when the run fails and it opened a failure or a lost answer; new
//   checks waiting for a person are normal onboarding.
// Not a run a person started, nor the worker re-asking one question of a person's run (that's
// deployment.validation.ask-again, which opens nothing). Not a run on partial content: it runs
// again once the sync finishes. Starters the run took off the chat (`removed`) have their own
// alert and are left out here. Names the questions. The same opened items once an hour. Pure.
export function validationAlert(
  d: {
    id: string;
    name: string;
    tenantName: string;
    // When it was signed off, if it is.
    signedOffAt?: Date;
    // The saved run's questions, for which checks are prices.
    questions?: readonly ValidationResult["questions"][number][];
    removed?: readonly string[];
  },
  entry: AuditEntry,
  link: string | undefined,
): PendingAlert | undefined {
  if (entry.action !== "deployment.validate") return undefined;
  const detail = (entry.detail ?? {}) as { auto?: unknown; passed?: unknown; content?: { partial?: unknown } };
  if (!detail.auto || detail.content?.partial === true) return undefined;
  const signedOff = Boolean(d.signedOffAt && d.signedOffAt.getTime() <= entry.at.getTime());
  const removed = new Set((d.removed ?? []).map(questionKey));
  const opened = openedOf(detail).filter(
    (o) => !removed.has(questionKey(o.question)) && (signedOff || (detail.passed === false && o.was !== "A check")),
  );
  if (!opened.length) return undefined;
  const items = opened.map((o) => ({ question: o.question, what: owes(o, d.questions ?? []) }));
  const quote = (q: string) => `“${q.length > 90 ? `${q.slice(0, 90)}…` : q}”`;
  const fields: Record<string, string> = {};
  for (const [i, item] of items.entries()) fields[`${signedOff ? "Opened" : "Failed"} ${i + 1}`] = `${quote(item.question)}: ${item.what}`;
  const fingerprint = openFingerprint(items);
  const n = items.length;
  const answers = `${n} ${n === 1 ? "answer" : "answers"}`;
  return {
    key: `validation-${signedOff ? "open" : "failed"}:${d.id}:${fingerprint}:${entry.id}`,
    message: signedOff
      ? {
          subject: `${where(d.tenantName, d.name)}: the automatic re-run opened ${answers} after sign-off`,
          text: "Visitors may see these answers now. The validation panel has them; the customer stays on Fleet's needing-attention list until they're resolved.",
          fields,
          ...(link && { link }),
        }
      : {
          subject: `${where(d.tenantName, d.name)}: validation failed after the automatic run (${answers} no longer ${n === 1 ? "passes" : "pass"})`,
          text: "The questions are below; the validation panel has the answers.",
          fields,
          ...(link && { link }),
        },
    quietIf: [{ like: `validation-%:${d.id}:${fingerprint}:%`, ms: SAME_FAILURE_MS }],
  };
}

// The validation alerts due from a deployment's recent audit entries: one per automatic run that
// opened something, with the starters it removed left out (removed within a minute of the run or
// after). Pure.
export function validationAlerts(
  d: Omit<Parameters<typeof validationAlert>[0], "removed">,
  entries: readonly AuditEntry[],
  link: string | undefined,
): PendingAlert[] {
  return entries.flatMap((entry) => {
    const removed = entries.flatMap((r) => {
      const question = (r.detail as { question?: unknown } | null)?.question;
      return r.action === STARTER_REMOVED && r.at.getTime() >= entry.at.getTime() - 60_000 && typeof question === "string"
        ? [question]
        : [];
    });
    const alert = validationAlert({ ...d, removed }, entry, link);
    return alert ? [alert] : [];
  });
}

// A starter the automatic re-run took off the live chat after it failed twice (B's
// deployment.starters.removed): one post per removal. Only a person puts a button back. Pure.
export function starterRemovedAlert(
  r: { id: number; detail: unknown; tenantName: string; name: string },
  link: string | undefined,
): PendingAlert | undefined {
  const detail = (r.detail ?? {}) as { question?: unknown; reason?: unknown };
  if (typeof detail.question !== "string" || !detail.question.trim()) return undefined;
  const reason = typeof detail.reason === "string" && detail.reason.trim() ? detail.reason.trim() : "no answer";
  return {
    key: `starter-removed:${r.id}`,
    message: {
      subject: `${where(r.tenantName, r.name)}: starter “${detail.question.trim()}” removed from the chat after the automatic re-run (${reason}). Pick again in Starters.`,
      text: "It was asked twice and failed both times, so its button is gone from the live chat. Picking a starter that answers puts a button back.",
      ...(link && { link }),
    },
  };
}

// The budget alerts due for a customer this month, if any. Pure.
export function budgetAlerts(
  t: { id: string; name: string; budgetCents: number | null; mode: string },
  spentCents: number,
  month: string,
): PendingAlert[] {
  if (!t.budgetCents || t.budgetCents <= 0) return [];
  const share = spentCents / t.budgetCents;
  const out: PendingAlert[] = [];
  const money = (c: number) => (c / 100).toFixed(2);
  if (share >= 0.8) {
    out.push({
      key: `budget-80:${t.id}:${month}`,
      message: { subject: `${t.name} has used 80% of its budget`, text: `${money(spentCents)} of ${money(t.budgetCents)} this month.` },
      // Past 100% already: only the over-budget alert goes out.
      ...(share >= 1 && { silent: true }),
    });
  }
  if (share >= 1) {
    out.push({
      key: `budget-100:${t.id}:${month}`,
      message: {
        subject: `${t.name} is over its budget`,
        text: `${money(spentCents)} of ${money(t.budgetCents)} this month. ${t.mode === "stop" ? "Its chats are offline until next month or a budget change." : "Its chats stay on (alert only)."}`,
      },
    });
  }
  return out;
}

// A deployment's first sync that has had nothing answerable for over 15 minutes: the worker is
// busy with other syncs, or the site loads slowly. Once per run of the sync. Pure.
export function syncWaitAlert(
  s: { deploymentId: string; name: string; tenantName: string; waitingSince: Date; indexed: number; queued: number },
  now: Date,
  link: string | undefined,
): PendingAlert | undefined {
  const minutes = Math.floor((now.getTime() - s.waitingSince.getTime()) / 60_000);
  if (s.indexed > 0 || minutes < SYNC_WAIT_MINUTES) return undefined;
  return {
    key: `sync-waiting:${s.deploymentId}:${s.waitingSince.toISOString()}`,
    message: {
      subject: `${where(s.tenantName, s.name)}: first sync still waiting after ${minutes} min`,
      text: `No page is answerable yet${s.queued ? ` and ${s.queued} ${s.queued === 1 ? "page is" : "pages are"} waiting to load` : ""}. The content panel shows how many pages from other deployments are ahead.`,
      ...(link && { link }),
    },
  };
}

// Keys expiring within 60, 30 or 7 days: one alert at each. Pure.
export function keyAlerts(rows: { deploymentId: string; name: string; tenantName: string; expiresAt: Date }[], now: Date): PendingAlert[] {
  const out: PendingAlert[] = [];
  for (const r of rows) {
    const days = Math.floor((r.expiresAt.getTime() - now.getTime()) / 86_400_000);
    for (const threshold of [7, 30, 60]) {
      if (days <= threshold) {
        out.push({
          key: `keys-${threshold}:${r.deploymentId}:${r.expiresAt.toISOString().slice(0, 10)}`,
          message: {
            subject: `${where(r.tenantName, r.name)}: keys expire in ${Math.max(days, 0)} days`,
            text: `The chat stops working on ${r.expiresAt.toISOString().slice(0, 10)} unless its keys are replaced.`,
          },
        });
        break;
      }
    }
  }
  return out;
}

// Live chats signed off under older checks (lib/review.ts): one alert per customer and checks
// version, linking each deployment's Bring up to date. They keep serving meanwhile. Pure.
export function olderChecksAlerts(
  rows: readonly { tenantId: string; tenantName: string; deploymentId: string; name: string }[],
  version: number,
  link: (tenantId: string, deploymentId: string) => string | undefined,
): PendingAlert[] {
  const byTenant = new Map<string, (typeof rows)[number][]>();
  for (const r of rows) byTenant.set(r.tenantId, [...(byTenant.get(r.tenantId) ?? []), r]);
  return [...byTenant.values()].map((own) => {
    const [first] = own as [(typeof rows)[number]];
    const one = own.length === 1;
    const href = link(first.tenantId, first.deploymentId);
    return {
      key: `older-checks:${first.tenantId}:${version}`,
      message: {
        subject: one
          ? `${where(first.tenantName, first.name)}: signed off under older checks`
          : `${first.tenantName}: ${own.length} deployments signed off under older checks`,
        text: `${one ? "It keeps" : "They keep"} serving. Bring up to date re-extracts the pages, shows what today's rules would leave out and which key pages would join, offers the current prompt and runs validation again with the questions every site gets; then sign off again.`,
        ...(!one && {
          fields: Object.fromEntries(own.map((r) => [r.name, link(r.tenantId, r.deploymentId) ?? "Bring up to date on its review"])),
        }),
        ...(href && { link: href }),
      },
    };
  });
}

// B's audit action for a starter the automatic re-run took off the live chat.
export const STARTER_REMOVED = "deployment.starters.removed";

// The changes that touch what visitors see, or where they see it.
export const VISITOR_CHANGES = [
  "deployment.widget",
  "deployment.prompt",
  "deployment.starters",
  "deployment.domains",
  "deployment.pause",
  "deployment.resume",
  // The price table decides what visitors read on price (build 8).
  "deployment.price-table.confirm",
  "deployment.price-table.edit",
  "deployment.price-table.add",
  "deployment.price-table.delete",
  "deployment.price-table.read",
];

// The answering rules applied to a deployment (the console's applyAnsweringRules): by the
// automatic re-check, or by a person switching after a hold.
export const RULES_APPLIED = "deployment.rules.applied";

// A signed-off chat's answering rules changed, as one line in the channel: "Crayola › Main site:
// answering rules v4 → v5, applied after a re-check". Pure.
export function rulesAlert(
  c: { id: number; detail: unknown; who: string | null; tenantName: string; name: string },
  link: string | undefined,
): PendingAlert | undefined {
  const d = (c.detail ?? {}) as { from?: unknown; to?: unknown; recheck?: { total?: unknown; unchanged?: unknown; better?: unknown } };
  if (typeof d.to !== "number" || d.from === d.to) return undefined;
  const from = typeof d.from === "number" ? `v${d.from} → ` : "";
  const how = d.recheck ? "applied after a re-check" : c.who ? `switched by ${c.who}` : "applied";
  const r = d.recheck;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const counted =
    r && typeof r.total === "number" ? ` ${num(r.unchanged) + num(r.better)} of ${r.total} answers were unchanged or better.` : "";
  return {
    key: `change:${c.id}`,
    message: {
      subject: `${where(c.tenantName, c.name)}: answering rules ${from}v${d.to}, ${how}`,
      text: `Answering rules ${from}v${d.to}, ${how}, on ${where(c.tenantName, c.name)}.${counted} Visitors get answers under the new rules now; Review lists it under changes since sign-off.`,
      ...(link && { link }),
    },
  };
}

// The overnight job's step for a hold (rules-rollout.ts): a deployment stays as it is because the
// re-check found answers worse under the latest rules, or had nothing to re-check against.
export const UP_TO_DATE = "deployment.uptodate";

// A hold, as one post to the channel: the deployment, why, and the worst answers, once per target
// (the key is the target's: the daily re-check that holds again doesn't post again). A person
// decides on Review. Pure.
export function heldAlert(
  c: { detail: unknown; deploymentId: string; tenantName: string; name: string },
  link: string | undefined,
): PendingAlert | undefined {
  const d = (c.detail ?? {}) as { step?: unknown; target?: unknown; total?: unknown; worse?: unknown; why?: unknown };
  if (d.step !== "held" || typeof d.target !== "string") return undefined;
  const worse = Array.isArray(d.worse) ? (d.worse as { question?: unknown }[]) : [];
  const questions = worse.flatMap((w) => (typeof w.question === "string" ? [w.question] : []));
  const said = typeof d.why === "string" && d.why ? d.why : undefined;
  const counted = typeof d.total === "number" && worse.length ? `${worse.length} of ${d.total} answers got worse.` : undefined;
  const asked = questions.length ? `${questions.slice(0, 3).join(" / ")}${questions.length > 3 ? " …" : ""}` : undefined;
  const parts = [`${where(c.tenantName, c.name)} keeps its current answering rules and pages.`, counted, said, asked];
  return {
    key: `up-to-date-held:${c.deploymentId}:${d.target}`,
    message: {
      subject: `${where(c.tenantName, c.name)}: held on the overnight update`,
      text: `${parts.filter(Boolean).join(" ")} It's re-checked daily; a person can decide on Review.`,
      ...(link && { link }),
    },
  };
}

const PRICE_CHANGE = "It changes what visitors read on price: check it on Review and sign off again.";

// A change visitors see on a live chat, as the partner's channel hears it: who changed which
// field, on which customer's deployment. One post per save; a save that changed nothing posts
// nothing. Pure.
export function changeAlert(
  c: { id: number; action: string; detail: unknown; who: string | null; tenantName: string; name: string },
  link: string | undefined,
): PendingAlert | undefined {
  const detail = (c.detail ?? {}) as {
    changed?: unknown;
    before?: unknown;
    after?: unknown;
    plan?: unknown;
    confirmAgain?: unknown;
    changes?: unknown;
  };
  if ("before" in detail && "after" in detail && JSON.stringify(detail.before) === JSON.stringify(detail.after)) return undefined;
  // A re-read that re-opened a confirmed table: nobody to name, and the difference is the news.
  if (c.action === "deployment.price-table.read") {
    if (!detail.confirmAgain) return undefined;
    const named = Array.isArray(detail.changes) ? detail.changes.filter((x): x is string => typeof x === "string") : [];
    return {
      key: `change:${c.id}`,
      message: {
        subject: `${where(c.tenantName, c.name)}: the pricing page changed`,
        text: `The pricing page of ${where(c.tenantName, c.name)} was read again and differs from the confirmed price table${named.length ? `: ${named.slice(0, 4).join("; ")}` : ""}. Until someone confirms it, the chat can't give the table's prices. Check the table and sign off again on Review.`,
        ...(link && { link }),
      },
    };
  }
  const keys = Array.isArray(detail.changed) ? detail.changed.filter((k): k is string => typeof k === "string") : [];
  const what: Record<string, string | undefined> = {
    "deployment.widget": keys.length ? `changed ${fieldWords(keys)}` : undefined,
    "deployment.prompt": "changed how it answers",
    "deployment.starters": "changed the starter questions",
    "deployment.domains": "changed the domains",
    "deployment.pause": "paused the chat",
    "deployment.resume": "resumed the chat",
    "deployment.price-table.confirm": "confirmed the price table",
    "deployment.price-table.edit": `corrected ${typeof detail.plan === "string" ? detail.plan : "a row"} in the price table`,
    "deployment.price-table.add": `added ${typeof detail.plan === "string" ? detail.plan : "a row"} to the price table`,
    "deployment.price-table.delete": `removed ${typeof detail.plan === "string" ? detail.plan : "a row"} from the price table`,
  };
  const did = what[c.action];
  if (!did) return undefined;
  const who = c.who ?? "Someone in setup mode";
  const after: Record<string, string> = {
    "deployment.domains": "Agentic RAG applies new domains within a few minutes.",
    "deployment.pause": "Visitors see the offline message.",
    "deployment.resume": "Visitors can ask again.",
    "deployment.price-table.confirm": PRICE_CHANGE,
    "deployment.price-table.edit": PRICE_CHANGE,
    "deployment.price-table.add": PRICE_CHANGE,
    "deployment.price-table.delete": PRICE_CHANGE,
  };
  return {
    key: `change:${c.id}`,
    message: {
      subject: `${where(c.tenantName, c.name)}: ${who} ${did}`,
      text: `${who} ${did} on ${where(c.tenantName, c.name)}. ${after[c.action] ?? "Visitors see it within a minute; Review lists what has changed since sign-off."}`,
      ...(link && { link }),
    },
  };
}

// The minute's job: two looks, 30 seconds apart. Leads are retried on the first only.
export async function alertPasses(ctx: JobContext, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const started = Date.now();
  await sendAlerts(ctx, new Date(), env);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + SECOND_LOOK_MS - Date.now())));
  await sendAlerts(ctx, new Date(), env, { leads: false });
}

export async function sendAlerts(
  ctx: JobContext,
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env,
  opts: { leads?: boolean } = {},
): Promise<void> {
  const [s] = await ctx.db
    .select({ webhook: settings.alertWebhookUrl, emails: settings.alertEmails })
    .from(settings)
    .where(eq(settings.id, 1));
  const base = (env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  const link = (path: string) => (base ? `${base}${path}` : undefined);
  const due: PendingAlert[] = [];
  const month = now.toISOString().slice(0, 7);

  // The Agentic RAG account blocked (for budget), and cleared again: once each (lib/account-block.ts).
  const account = accountAlert(await lastAccountEntry(ctx.db), now, link("/"));
  if (account) due.push(account);

  // Budgets.
  const spend = await ctx.db
    .select({
      id: tenants.id,
      name: tenants.name,
      budgetCents: tenants.monthlyBudgetCents,
      mode: tenants.budgetMode,
      spent: sql<number>`coalesce(sum(${usageDaily.costCents}), 0)`.mapWith(Number),
    })
    .from(tenants)
    .leftJoin(deployments, eq(deployments.tenantId, tenants.id))
    .leftJoin(usageDaily, and(eq(usageDaily.deploymentId, deployments.id), gte(usageDaily.day, `${month}-01`)))
    .groupBy(tenants.id);
  for (const t of spend) {
    for (const a of budgetAlerts(t, t.spent, month)) due.push({ ...a, message: { ...a.message, link: link(`/customers/${t.id}`) } });
  }

  // Failures: provisioning, sync, validation. And live chats signed off under older checks.
  const ds = await ctx.db
    .select({
      id: deployments.id,
      tenantId: deployments.tenantId,
      tenantName: tenants.name,
      name: deployments.name,
      status: deployments.status,
      published: deployments.published,
      signOff: deployments.signOff,
      validation: deployments.validation,
      provisioningLog: deployments.provisioningLog,
    })
    .from(deployments)
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId));
  // Starters the automatic re-run took off live chats: one post each (within the hour, as changes
  // are), and left out of the run's own alert.
  const removals = await ctx.db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      detail: auditLog.detail,
      deploymentId: deployments.id,
      tenantId: deployments.tenantId,
      tenantName: tenants.name,
      name: deployments.name,
    })
    .from(auditLog)
    .innerJoin(deployments, sql`${deployments.id}::text = ${auditLog.targetId}`)
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .where(
      and(
        eq(auditLog.action, STARTER_REMOVED),
        eq(auditLog.targetType, "deployment"),
        gte(auditLog.at, new Date(now.getTime() - 24 * 3_600_000)),
      ),
    );
  for (const r of removals) {
    if (now.getTime() - r.at.getTime() > CHANGE_WINDOW_MS) continue;
    const a = starterRemovedAlert(r, link(`/customers/${r.tenantId}/deployments/${r.deploymentId}#validate`));
    if (a) due.push(a);
  }
  // Validation runs the console started by itself within the hour: each posts what it opened.
  const autoRuns = await ctx.db
    .select({ id: auditLog.id, action: auditLog.action, at: auditLog.at, detail: auditLog.detail, targetId: auditLog.targetId })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "deployment.validate"),
        eq(auditLog.targetType, "deployment"),
        gte(auditLog.at, new Date(now.getTime() - CHANGE_WINDOW_MS)),
        sql`(${auditLog.detail}->>'auto') is not null`,
      ),
    );
  for (const d of ds) {
    const at = (panel: string) => link(`/customers/${d.tenantId}/deployments/${d.id}#${panel}`);
    if (d.status === "failed") due.push(provisioningAlert(d, at("provisioning")));
    const runs = autoRuns.filter((r) => r.targetId === d.id);
    if (!runs.length) continue;
    const removedHere = removals.filter((r) => r.deploymentId === d.id).map((r) => ({ ...r, action: STARTER_REMOVED }));
    const signedOffAt = d.signOff ? new Date(d.signOff.at) : undefined;
    due.push(
      ...validationAlerts(
        { id: d.id, name: d.name, tenantName: d.tenantName, ...(signedOffAt && { signedOffAt }), questions: d.validation?.questions ?? [] },
        [...runs, ...removedHere],
        at("validate"),
      ),
    );
  }
  const older = ds.filter((d) => d.published && d.status !== "failed" && underOlderChecks(d.signOff));
  due.push(
    ...olderChecksAlerts(
      older.map((d) => ({ tenantId: d.tenantId, tenantName: d.tenantName, deploymentId: d.id, name: d.name })),
      CHECKS_VERSION,
      (tenantId, deploymentId) => link(`/customers/${tenantId}/deployments/${deploymentId}/review/up-to-date`),
    ),
  );
  // Recovered deployments: a later failure, even for the same cause, is news again.
  await ctx.db
    .delete(alertsSent)
    .where(
      and(
        like(alertsSent.key, "provision-failed:%"),
        sql`split_part(${alertsSent.key}, ':', 2) not in (select id::text from ${deployments} where ${deployments.status} = 'failed')`,
      ),
    );
  const failedSyncs = await ctx.db
    .select({
      deploymentId: syncSources.deploymentId,
      error: syncSources.lastError,
      startedAt: syncSources.startedAt,
      name: deployments.name,
      tenantId: deployments.tenantId,
      tenantName: tenants.name,
    })
    .from(syncSources)
    .innerJoin(deployments, eq(deployments.id, syncSources.deploymentId))
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .where(eq(syncSources.lastJobStatus, "failed"));
  for (const f of failedSyncs) {
    due.push({
      key: `sync-failed:${f.deploymentId}:${f.startedAt?.toISOString() ?? ""}`,
      message: {
        subject: `${where(f.tenantName, f.name)}: content sync failed`,
        text: f.error ?? "See the deployment's content panel.",
        link: link(`/customers/${f.tenantId}/deployments/${f.deploymentId}#content`),
      },
    });
  }

  // First syncs with nothing answerable yet, waiting since they started (or were queued).
  const waiting = await ctx.db
    .select({
      deploymentId: syncSources.deploymentId,
      name: deployments.name,
      tenantId: deployments.tenantId,
      tenantName: tenants.name,
      waitingSince: sql<Date>`coalesce(${syncSources.startedAt}, ${syncSources.updatedAt})`.mapWith((v) => new Date(v)),
      indexed:
        sql<number>`(select count(*) from content_pages p where p.deployment_id = ${syncSources.deploymentId} and p.status = 'indexed')`.mapWith(
          Number,
        ),
      queued:
        sql<number>`(select count(*) from content_pages p where p.deployment_id = ${syncSources.deploymentId} and p.status = 'queued')`.mapWith(
          Number,
        ),
    })
    .from(syncSources)
    .innerJoin(deployments, eq(deployments.id, syncSources.deploymentId))
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .where(and(inArray(syncSources.lastJobStatus, ["queued", "running"]), isNull(syncSources.lastSyncedAt)));
  for (const w of waiting) {
    const a = syncWaitAlert(w, now, link(`/customers/${w.tenantId}/deployments/${w.deploymentId}#content`));
    if (a) due.push(a);
  }

  // A usage roll-up that stopped: nothing updated for over a day, while chats are live.
  const [rolled] = await ctx.db.select({ at: max(usageDaily.updatedAt) }).from(usageDaily);
  if (rolled?.at && now.getTime() - rolled.at.getTime() > 26 * 3_600_000) {
    due.push({
      key: `rollup-stalled:${now.toISOString().slice(0, 10)}`,
      message: {
        subject: "Usage figures stopped updating",
        text: `Last updated ${rolled.at.toISOString().slice(0, 16).replace("T", " ")} UTC. Check that the worker can reach Agentic RAG.`,
      },
    });
  }

  // Keys.
  const keys = await ctx.db
    .select({
      deploymentId: credentials.deploymentId,
      name: deployments.name,
      tenantName: tenants.name,
      expiresAt: sql<Date>`min(${credentials.expiresAt})`.mapWith((v) => new Date(v)),
    })
    .from(credentials)
    .innerJoin(deployments, eq(deployments.id, credentials.deploymentId))
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .where(isNull(credentials.revokedAt))
    .groupBy(credentials.deploymentId, deployments.name, tenants.name);
  due.push(...keyAlerts(keys, now));

  // Changes visitors see on live chats, since their sign-off: one post each.
  const changes = await ctx.db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      action: auditLog.action,
      detail: auditLog.detail,
      userName: users.name,
      email: users.email,
      deploymentId: deployments.id,
      tenantId: deployments.tenantId,
      tenantName: tenants.name,
      name: deployments.name,
      signOff: deployments.signOff,
    })
    .from(auditLog)
    .innerJoin(deployments, sql`${deployments.id}::text = ${auditLog.targetId}`)
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(
      and(
        inArray(auditLog.action, [...VISITOR_CHANGES, RULES_APPLIED]),
        eq(auditLog.targetType, "deployment"),
        eq(deployments.published, true),
        gte(auditLog.at, new Date(now.getTime() - CHANGE_WINDOW_MS)),
      ),
    );
  for (const c of changes) {
    if (c.signOff && c.at <= new Date(c.signOff.at)) continue;
    const review = link(`/customers/${c.tenantId}/deployments/${c.deploymentId}/review`);
    // The automatic re-check applied newer rules: nobody to name.
    if (c.action === RULES_APPLIED && (c.detail as { recheck?: unknown } | null)?.recheck) {
      const a = c.signOff ? rulesAlert({ ...c, who: null }, review) : undefined;
      if (a) due.push(a);
      continue;
    }
    // In setup mode there's no user: the name typed with the change, else the last name typed on
    // the deployment, marked as not verified.
    const typed = (c.detail as { name?: unknown } | null)?.name;
    const who =
      c.userName ??
      c.email ??
      (typeof typed === "string" && typed.trim() ? notVerified(typed) : await lastTypedName(ctx, c.deploymentId, c.at, c.signOff));
    // A rules switch names only who it recorded: never a name guessed from the sitting.
    const recorded = c.userName ?? c.email ?? (typeof typed === "string" && typed.trim() ? notVerified(typed) : null);
    const a =
      c.action === RULES_APPLIED
        ? c.signOff
          ? rulesAlert({ ...c, who: recorded }, review)
          : undefined
        : changeAlert({ ...c, who }, review);
    if (a) due.push(a);
  }

  // Holds from the overnight job: once per deployment and target.
  const holds = await ctx.db
    .select({
      detail: auditLog.detail,
      deploymentId: deployments.id,
      tenantId: deployments.tenantId,
      tenantName: tenants.name,
      name: deployments.name,
    })
    .from(auditLog)
    .innerJoin(deployments, sql`${deployments.id}::text = ${auditLog.targetId}`)
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .where(
      and(
        eq(auditLog.action, UP_TO_DATE),
        eq(auditLog.targetType, "deployment"),
        sql`${auditLog.detail}->>'step' = 'held'`,
        gte(auditLog.at, new Date(now.getTime() - CHANGE_WINDOW_MS)),
      ),
    );
  for (const h of holds) {
    const a = heldAlert(h, link(`/customers/${h.tenantId}/deployments/${h.deploymentId}/review`));
    if (a) due.push(a);
  }

  // Leads: retry, give up after 7 days (and say so).
  if (opts.leads !== false) await retryLeads(ctx, now, due, link);

  if (!due.length || (!s?.webhook && !s?.emails?.length)) return;
  const loud = await withoutRepeats(ctx, due, now);
  if (!loud.length) return;
  const fresh = await ctx.db
    .insert(alertsSent)
    .values(loud.map((a) => ({ key: a.key })))
    .onConflictDoNothing()
    .returning({ key: alertsSent.key });
  const toSend = loud.filter((a) => !a.silent && fresh.some((f) => f.key === a.key));
  for (const a of toSend) await deliverAlert(ctx, s, a, env);
  if (toSend.length) ctx.log(`sent ${toSend.length} alert(s)`);
}

// One alert, already recorded in alerts_sent, to the channel: one that reaches nobody is
// forgotten, so it goes out next run instead.
async function deliverAlert(
  ctx: JobContext,
  channel: { webhook: string | null; emails: string[] },
  alert: { key: string; message: Message },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const result = await deliver({ webhookUrl: channel.webhook, emails: channel.emails }, alert.message, {
    extra: { kind: "alert", key: alert.key },
    env,
  });
  if (!result.delivered.length) {
    await ctx.db.delete(alertsSent).where(eq(alertsSent.key, alert.key));
    ctx.log(`alert ${alert.key} not delivered: ${result.errors.join(" · ")}`);
  }
}

// An alert sent at once, once per key, from another job (the content job's retraction alert):
// the same channel (Settings › Alerts) and the same once-per-key record as sendAlerts.
export async function postAlert(ctx: JobContext, alert: { key: string; message: Message }): Promise<void> {
  const [s] = await ctx.db
    .select({ webhook: settings.alertWebhookUrl, emails: settings.alertEmails })
    .from(settings)
    .where(eq(settings.id, 1));
  if (!s?.webhook && !s?.emails?.length) return;
  const fresh = await ctx.db.insert(alertsSent).values({ key: alert.key }).onConflictDoNothing().returning({ key: alertsSent.key });
  if (fresh.length) await deliverAlert(ctx, s, alert);
}

// A name typed in setup mode: anyone could have typed it. Marked once: sign-offs and other
// confirmations store it marked already ("Sam (setup mode, not verified)"), and round 5's alerts
// read "Sam (setup mode, not verified) (not verified) changed how it answers".
export const notVerified = (name: string) => (/not verified/.test(name) ? name.trim() : `${name.trim()} (not verified)`);

// A typed name stands for the person at the keyboard for one sitting (the console's History
// goes by the same two hours, lib/history.ts SITTING_MS).
export const SITTING_MS = 2 * 3_600_000;

// The last name typed on a deployment in the sitting before a change (the audit log's, else the
// sign-off's), for a setup-mode change that recorded none. Never a name from another day: round 5
// credited a reviewer's changes to the round-4 signer. Not the deployment's own name (its create
// entry's) or the automatic re-run's.
async function lastTypedName(ctx: JobContext, deploymentId: string, at: Date, signOff: SignOff | null): Promise<string | null> {
  const since = new Date(at.getTime() - SITTING_MS);
  const [row] = await ctx.db
    .select({ name: sql<string | null>`${auditLog.detail}->>'name'` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetId, deploymentId),
        lte(auditLog.at, at),
        gte(auditLog.at, since),
        isNull(auditLog.actorUserId),
        sql`${auditLog.action} <> 'deployment.create'`,
        sql`${auditLog.detail}->>'auto' is null`,
        sql`coalesce(${auditLog.detail}->>'name', '') <> ''`,
      ),
    )
    .orderBy(desc(auditLog.at))
    .limit(1);
  const signedNow = signOff && !signOff.verified && Date.parse(signOff.at) >= since.getTime() && Date.parse(signOff.at) <= at.getTime();
  const name = row?.name ?? (signedNow ? signOff.name : null);
  return name?.trim() ? notVerified(name) : null;
}

// Alerts with quietIf, decided once: one matching an alert already sent (the same failure within
// the hour, or the same run) is recorded as "quiet:<key>" and never sent, so it stays decided
// when the hour is over; the rest go ahead.
async function withoutRepeats(ctx: JobContext, due: PendingAlert[], now: Date): Promise<PendingAlert[]> {
  const loud: PendingAlert[] = [];
  for (const a of due) {
    if (!a.quietIf?.length) {
      loud.push(a);
      continue;
    }
    const [decided] = await ctx.db
      .select({ key: alertsSent.key })
      .from(alertsSent)
      .where(inArray(alertsSent.key, [a.key, `quiet:${a.key}`]))
      .limit(1);
    if (decided) continue;
    const [repeat] = await ctx.db
      .select({ key: alertsSent.key })
      .from(alertsSent)
      .where(
        or(
          ...a.quietIf.map((q) =>
            q.ms ? and(like(alertsSent.key, q.like), gte(alertsSent.sentAt, new Date(now.getTime() - q.ms))) : like(alertsSent.key, q.like),
          ),
        ),
      )
      .limit(1);
    if (repeat)
      await ctx.db
        .insert(alertsSent)
        .values({ key: `quiet:${a.key}` })
        .onConflictDoNothing();
    else loud.push(a);
  }
  return loud;
}

async function retryLeads(ctx: JobContext, now: Date, due: PendingAlert[], link: (p: string) => string | undefined) {
  const cutoff = new Date(now.getTime() - LEAD_RETRY_DAYS * 86_400_000);
  const pending = await ctx.db
    .select({
      lead: leads,
      name: deployments.name,
      tenantId: deployments.tenantId,
      delivery: deployments.leadDelivery,
      tenantName: tenants.name,
      // The lead itself goes to the client's people: the name visitors see.
      customer: sql<string>`coalesce(${tenants.displayName}, ${tenants.name})`,
    })
    .from(leads)
    .innerJoin(deployments, eq(deployments.id, leads.deploymentId))
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId));
  for (const p of pending) {
    if (p.lead.createdAt < cutoff) {
      await ctx.db.delete(leads).where(eq(leads.id, p.lead.id));
      due.push({
        key: `lead-dropped:${p.lead.id}`,
        message: {
          subject: `${where(p.tenantName, p.name)}: a lead couldn't be delivered`,
          text: `It was deleted after ${LEAD_RETRY_DAYS} days of retries (${p.lead.lastError ?? "no destination"}). Check where leads go on the deployment's Edit page.`,
          link: link(`/customers/${p.tenantId}/deployments/${p.lead.deploymentId}/edit`),
        },
      });
      continue;
    }
    // The payload as the console built it (docs/leads.md); a retry sends the same words.
    const payload = p.lead.payload as {
      customer?: string;
      subject?: string;
      fields?: Record<string, string>;
      pageUrl?: string;
      language?: string;
      transcript?: { author: string; text: string }[];
      consent?: { text?: string; at?: string; privacyUrl?: string };
    };
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(payload.fields ?? {})) fields[k[0]!.toUpperCase() + k.slice(1)] = v;
    if (payload.pageUrl) fields.Page = payload.pageUrl;
    if (payload.consent?.text) {
      fields.Consent = `“${payload.consent.text}”${payload.consent.at ? ` (ticked ${payload.consent.at.slice(0, 16).replace("T", " ")} UTC)` : ""}`;
    }
    if (payload.consent?.privacyUrl) fields["Privacy notice"] = payload.consent.privacyUrl;
    const customer = payload.customer ?? p.customer;
    const result = await deliver(
      p.delivery,
      {
        subject: payload.subject ?? `New lead from the ${customer} website chat`,
        text: `Someone left their details in the chat on ${p.name}.`,
        fields,
      },
      { extra: payload },
    );
    if (result.delivered.length) await ctx.db.delete(leads).where(eq(leads.id, p.lead.id));
    else {
      await ctx.db
        .update(leads)
        .set({ attempts: sql`${leads.attempts} + 1`, lastError: result.errors.join(" · ") || "No delivery set up for leads." })
        .where(eq(leads.id, p.lead.id));
      due.push({
        key: `lead-waiting:${p.lead.deploymentId}:${now.toISOString().slice(0, 10)}`,
        message: {
          subject: `${where(p.tenantName, p.name)}: leads are waiting to be delivered`,
          text: result.errors.join(" · ") || "No webhook or email is set up for this deployment's leads.",
          link: link(`/customers/${p.tenantId}/deployments/${p.lead.deploymentId}/edit`),
        },
      });
    }
  }
}
