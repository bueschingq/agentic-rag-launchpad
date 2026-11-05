// Dashboard arithmetic over the worker's daily rollups. Pure functions with no database or
// React, so they run under node:test. Days are UTC "YYYY-MM-DD" strings, as Postgres `date`
// columns come back.

import type { ValidationResult } from "@launchpad/db";
import { isFallbackQuestion, needsCheck, partialContentNote, type RunQuestion } from "./validation-rules.ts";

export interface UsageDay {
  deploymentId: string;
  day: string;
  questions: number;
  queryTokens: number;
  // null when no contract rate was set when the day was rolled up.
  costCents: number | null;
}

export interface QualityDay {
  deploymentId: string;
  day: string;
  answerRelevance: number | null;
  contextRelevance: number | null;
  groundedness: number | null;
}

export interface TenantRow {
  id: string;
  name: string;
  status: string;
  monthlyBudgetCents: number | null;
}

export interface DeploymentRow {
  id: string;
  tenantId: string;
  name: string;
  siteUrl: string;
  status: string;
  kbSlug: string;
}

export interface SyncRow {
  deploymentId: string;
  lastJobStatus: string | null;
  lastSyncedAt: Date | null;
}

const DAY_MS = 86_400_000;

export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
export const shiftDay = (day: string, n: number): string => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
export const monthOf = (day: string): string => day.slice(0, 7);
export const isMonth = (value: unknown): value is string => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

export function daysInMonth(day: string): number {
  const [y, m] = day.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Rollups cover complete UTC days, so "the last N days" ends yesterday.
export function lastDays(today: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => shiftDay(today, i - n));
}

export interface DailyPoint {
  day: string;
  questions: number;
  costCents: number;
}

export interface UsageSummary {
  questions7: number;
  questions30: number;
  questionsPrev30: number;
  // This calendar month so far.
  monthCents: number;
  // Month so far plus the last 7 days' average for each day left, today included.
  projectedCents: number;
  // Days this month with questions but no cost: no contract rate when they were rolled up.
  unpricedDays: number;
  // The last 30 days, oldest first, with empty days filled in.
  daily: DailyPoint[];
}

export function summarizeUsage(rows: UsageDay[], today: string): UsageSummary {
  const byDay = new Map<string, DailyPoint>();
  for (const r of rows) {
    const point = byDay.get(r.day) ?? { day: r.day, questions: 0, costCents: 0 };
    point.questions += r.questions;
    point.costCents += r.costCents ?? 0;
    byDay.set(r.day, point);
  }
  const series = (days: string[]) => days.map((day) => byDay.get(day) ?? { day, questions: 0, costCents: 0 });
  const sum = (points: DailyPoint[], key: "questions" | "costCents") => points.reduce((n, p) => n + p[key], 0);

  const daily = series(lastDays(today, 30));
  const month = monthOf(today);
  const thisMonth = rows.filter((r) => monthOf(r.day) === month && r.day <= today);
  const monthCents = thisMonth.reduce((n, r) => n + (r.costCents ?? 0), 0);
  const pace = sum(series(lastDays(today, 7)), "costCents") / 7;
  const daysLeft = daysInMonth(today) - Number(today.slice(8)) + 1;

  return {
    questions7: sum(series(lastDays(today, 7)), "questions"),
    questions30: sum(daily, "questions"),
    questionsPrev30: sum(series(lastDays(shiftDay(today, -30), 30)), "questions"),
    monthCents,
    projectedCents: Math.round(monthCents + pace * daysLeft),
    unpricedDays: thisMonth.filter((r) => r.costCents === null && r.questions > 0).length,
    daily,
  };
}

export interface QualitySummary {
  // REMi averages over the last 30 days, 1–5, weighted by each day's questions.
  answerRelevance: number | undefined;
  contextRelevance: number | undefined;
  groundedness: number | undefined;
  // Answer relevance over the last 7 days minus the 7 days before.
  trend: number | undefined;
}

export function summarizeQuality(rows: QualityDay[], usage: UsageDay[], today: string): QualitySummary {
  const questions = new Map(usage.map((u) => [`${u.deploymentId}|${u.day}`, u.questions]));
  const weight = (r: QualityDay) => Math.max(questions.get(`${r.deploymentId}|${r.day}`) ?? 1, 1);
  const mean = (days: string[], key: "answerRelevance" | "contextRelevance" | "groundedness") => {
    const inRange = new Set(days);
    let total = 0;
    let weights = 0;
    for (const r of rows) {
      const value = r[key];
      if (value === null || !inRange.has(r.day)) continue;
      total += value * weight(r);
      weights += weight(r);
    }
    return weights ? total / weights : undefined;
  };
  const recent = mean(lastDays(today, 7), "answerRelevance");
  const before = mean(lastDays(shiftDay(today, -7), 7), "answerRelevance");
  const month = lastDays(today, 30);
  return {
    answerRelevance: mean(month, "answerRelevance"),
    contextRelevance: mean(month, "contextRelevance"),
    groundedness: mean(month, "groundedness"),
    trend: recent !== undefined && before !== undefined ? recent - before : undefined,
  };
}

export type BudgetState = "none" | "ok" | "projected" | "near" | "over";

export const NEAR_BUDGET = 0.8;

export function budgetState(usage: Pick<UsageSummary, "monthCents" | "projectedCents">, budgetCents: number | null): BudgetState {
  if (!budgetCents) return "none";
  if (usage.monthCents >= budgetCents) return "over";
  if (usage.monthCents >= budgetCents * NEAR_BUDGET) return "near";
  if (usage.projectedCents >= budgetCents) return "projected";
  return "ok";
}

export interface Alert {
  tone: "warning" | "critical";
  text: string;
  // The panel that explains it and fixes it.
  href?: string;
}

const BUDGET_ALERTS: Partial<Record<BudgetState, Alert>> = {
  over: { tone: "critical", text: "Over budget" },
  near: { tone: "warning", text: "Near budget" },
  projected: { tone: "warning", text: "On track to exceed budget" },
};

// A live site whose content hasn't synced for this long is probably stuck.
const STALE_SYNC_DAYS = 3;
// A week-on-week drop in answer relevance (1–5) worth a look.
const QUALITY_DROP = 0.4;

// What a run leaves for a person, question by question: an answer failing a check, no answer
// (unless a person said the site doesn't cover it), or a flagged answer nobody has checked. The
// worker's alerts and Fleet's needing-attention list both go by it. Pure.
export function openItems(questions: readonly ValidationResult["questions"][number][]): { question: string; what: string }[] {
  return questions.flatMap((q) => {
    const r = q as RunQuestion;
    const what = q.failure
      ? `failed: ${q.failure}`
      : !q.answered && !r.notCovered && !isFallbackQuestion(q.question)
        ? "no answer"
        : needsCheck(q)
          ? q.flags?.includes("price")
            ? "a price to check"
            : "an answer to check"
          : undefined;
    return what ? [{ question: q.question, what }] : [];
  });
}

// A signed-off deployment's latest run, when it no longer passes: what it left open (sign-off
// left nothing open), and whether the console ran it by itself. Not a run on partial content,
// which runs again by itself. Pure.
export function openSinceSignOff(
  signedOff: boolean,
  validation: ValidationResult | null | undefined,
  now = new Date(),
): { open: number; auto: boolean } | undefined {
  if (!signedOff || !validation || validation.passed || partialContentNote(validation, now)) return undefined;
  const open = openItems(validation.questions).length;
  return open ? { open, auto: Boolean((validation as { auto?: unknown }).auto) } : undefined;
}

// Starters the automatic re-run took off the live chat since the deployment's sign-off (B's
// deployment.starters.removed), that nobody has picked again since (deployment.starters, or a
// new sign-off). `entries` are the deployment's audit entries of those three kinds. Pure.
export function startersRemoved(
  entries: readonly { action: string; at: Date; detail: unknown }[],
  signedOffAt: Date | undefined,
): string[] {
  if (!signedOffAt) return [];
  const sorted = [...entries].sort((a, b) => a.at.getTime() - b.at.getTime());
  let removed: string[] = [];
  for (const e of sorted) {
    if (e.action === "deployment.starters.removed" && e.at >= signedOffAt) {
      const question = (e.detail as { question?: unknown } | null)?.question;
      if (typeof question === "string" && question.trim()) removed.push(question.trim());
    } else if (
      (e.action === "deployment.starters" || e.action === "deployment.signoff") &&
      !(e.detail as { auto?: unknown } | null)?.auto
    ) {
      // A person picked starters again, or signed off again.
      removed = [];
    }
  }
  return removed;
}

// What happened to a signed-off deployment since its sign-off that a person hasn't resolved: what
// its latest run left open (openSinceSignOff), and starters the automatic re-run
// took off the live chat (startersRemoved). Fleet lists the customer as needing attention until
// both are gone.
export interface AfterSignOff {
  open?: { open: number; auto: boolean };
  removed: string[];
}

const quoted = (q: string) => `“${q.length > 40 ? `${q.slice(0, 40)}…` : q}”`;

export function afterSignOffAlerts(d: Pick<DeploymentRow, "id" | "tenantId">, after: AfterSignOff | undefined): Alert[] {
  if (!after) return [];
  const at = `/customers/${d.tenantId}/deployments/${d.id}#validate`;
  const alerts: Alert[] = [];
  const n = after.removed.length;
  if (n) {
    const which = n === 1 ? `Starter ${quoted(after.removed[0]!)} removed` : `${n} starters removed`;
    alerts.push({ tone: "critical", text: `${which}: pick again`, href: at });
  }
  if (after.open) {
    // Whoever ran it: the worker re-asking one question marks a person's run as automatic, so the
    // saved run can't say who opened what (the alerts go by the runs' audit entries instead).
    const { open } = after.open;
    alerts.push({ tone: "warning", text: `Since sign-off: ${open} ${open === 1 ? "answer" : "answers"} open`, href: at });
  }
  return alerts;
}

export function deploymentAlerts(
  d: DeploymentRow,
  sync: SyncRow | undefined,
  quality: QualitySummary,
  now: Date,
  after?: AfterSignOff,
): Alert[] {
  const alerts: Alert[] = [...afterSignOffAlerts(d, after)];
  const at = (panel: string) => `/customers/${d.tenantId}/deployments/${d.id}#${panel}`;
  if (d.status === "failed") alerts.push({ tone: "critical", text: "Provisioning failed", href: at("provisioning") });
  if (sync?.lastJobStatus && /fail|error/i.test(sync.lastJobStatus))
    alerts.push({ tone: "critical", text: "Last sync failed", href: at("content") });
  else if (d.status === "live" && sync?.lastSyncedAt) {
    const days = Math.floor((now.getTime() - sync.lastSyncedAt.getTime()) / DAY_MS);
    if (days >= STALE_SYNC_DAYS) alerts.push({ tone: "warning", text: `No sync for ${days} days`, href: at("content") });
  }
  if (quality.trend !== undefined && quality.trend <= -QUALITY_DROP) {
    alerts.push({ tone: "warning", text: `Quality down ${(-quality.trend).toFixed(1)}`, href: `/customers/${d.tenantId}#quality` });
  }
  return alerts;
}

export interface DeploymentView extends DeploymentRow {
  // Where it stands (onboarding.ts); set by the loader, which has the data for it.
  stage?: { key: string; label: string; detail: string; tone: "good" | "neutral" | "warning" | "critical" };
  // Signed off under the review's older checks (review.ts underOlderChecks), and when it was signed
  // off: set by the loader, for Fleet's tile and filter.
  olderChecks?: boolean;
  signedOffAt?: string;
  // A published chat on older answering rules than the console's latest (item 6: held by its
  // re-check, or waiting for it).
  olderRules?: boolean;
  // Its price table needs a person to confirm it (overview.ts priceTableIssue): "changed" after a
  // re-read changed confirmed rows (price-table.ts needsConfirmingAgain), "unconfirmed" on a live
  // chat whose table was never confirmed, "unread" when a pricing page's prices could not be read. Set by the loader.
  priceTable?: "changed" | "unconfirmed" | "unread" | "doubted";
  usage: UsageSummary;
  quality: QualitySummary;
  sync: SyncRow | undefined;
  alerts: Alert[];
}

// The deployments signed off under older checks, oldest sign-off first: Fleet's "Signed off under
// older checks: N" tile and filter, and what "Read the pages again for all, tonight" queues (exec
// review round 5: 9 of 13 deployments flagged, with nothing at fleet level to work through). Pure.
export function olderChecksFirst<D extends Pick<DeploymentView, "olderChecks" | "signedOffAt">>(deployments: readonly D[]): D[] {
  // A sign-off without a readable date counts as the oldest.
  const at = (d: D) => Date.parse(d.signedOffAt ?? "") || 0;
  return deployments.filter((d) => d.olderChecks).sort((a, b) => at(a) - at(b));
}

export interface TenantView extends TenantRow {
  usage: UsageSummary;
  quality: QualitySummary;
  budget: BudgetState;
  // The tenant's budget alert first, then its deployments'.
  alerts: Alert[];
  deployments: DeploymentView[];
}

export interface Dashboard {
  today: string;
  tenants: TenantView[];
  usage: UsageSummary;
  quality: QualitySummary;
}

export interface DashboardInput {
  now: Date;
  tenants: TenantRow[];
  deployments: DeploymentRow[];
  usage: UsageDay[];
  quality: QualityDay[];
  syncs: SyncRow[];
  // Per deployment id: what's unresolved since its sign-off.
  afterSignOff?: ReadonlyMap<string, AfterSignOff>;
}

const latest = (a: SyncRow | undefined, b: SyncRow) => (!a || (b.lastSyncedAt?.getTime() ?? 0) > (a.lastSyncedAt?.getTime() ?? 0) ? b : a);

export function buildDashboard(input: DashboardInput): Dashboard {
  const today = isoDay(input.now);
  const syncs = new Map<string, SyncRow>();
  for (const s of input.syncs) syncs.set(s.deploymentId, latest(syncs.get(s.deploymentId), s));
  const forDeployments = <T extends { deploymentId: string }>(rows: T[], ids: Set<string>) => rows.filter((r) => ids.has(r.deploymentId));

  const tenants = input.tenants.map((t): TenantView => {
    const own = input.deployments.filter((d) => d.tenantId === t.id);
    const ids = new Set(own.map((d) => d.id));
    const usageRows = forDeployments(input.usage, ids);
    const usage = summarizeUsage(usageRows, today);
    const deployments = own.map((d): DeploymentView => {
      const one = new Set([d.id]);
      const dUsage = forDeployments(usageRows, one);
      const quality = summarizeQuality(forDeployments(input.quality, one), dUsage, today);
      const sync = syncs.get(d.id);
      return {
        ...d,
        usage: summarizeUsage(dUsage, today),
        quality,
        sync,
        alerts: deploymentAlerts(d, sync, quality, input.now, input.afterSignOff?.get(d.id)),
      };
    });
    const budget = budgetState(usage, t.monthlyBudgetCents);
    const budgetAlert = BUDGET_ALERTS[budget];
    return {
      ...t,
      usage,
      quality: summarizeQuality(forDeployments(input.quality, ids), usageRows, today),
      budget,
      alerts: [...(budgetAlert ? [{ ...budgetAlert, href: `/customers/${t.id}/edit` }] : []), ...deployments.flatMap((d) => d.alerts)],
      deployments,
    };
  });

  return {
    today,
    tenants,
    usage: summarizeUsage(input.usage, today),
    quality: summarizeQuality(input.quality, input.usage, today),
  };
}

export interface MonthLine {
  tenantId: string;
  questions: number;
  queryTokens: number;
  costCents: number;
  unpricedDays: number;
}

// One calendar month's totals per tenant, for the costs page and its CSV export.
export function monthTotals(rows: UsageDay[], tenantOf: Map<string, string>, month: string): Map<string, MonthLine> {
  const lines = new Map<string, MonthLine>();
  for (const r of rows) {
    const tenantId = tenantOf.get(r.deploymentId);
    if (!tenantId || monthOf(r.day) !== month) continue;
    const line = lines.get(tenantId) ?? { tenantId, questions: 0, queryTokens: 0, costCents: 0, unpricedDays: 0 };
    line.questions += r.questions;
    line.queryTokens += r.queryTokens;
    line.costCents += r.costCents ?? 0;
    if (r.costCents === null && r.questions > 0) line.unpricedDays += 1;
    lines.set(tenantId, line);
  }
  return lines;
}

export const withMarkup = (cents: number, markupPercent: number): number => Math.round(cents * (1 + markupPercent / 100));

// 0 and round steps (1, 2, 2.5 or 5 × 10ⁿ) up to just past `max`.
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  const steps = Math.ceil(max / step - 1e-9);
  return Array.from({ length: steps + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}

// RFC 4180. Text cells that a spreadsheet would run as a formula get a leading apostrophe:
// customer names are typed in by people.
export function toCsv(rows: (string | number)[][]): string {
  const cell = (value: string | number) => {
    let s = String(value);
    if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return `${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}
