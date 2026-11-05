// The dashboard's overview: what needs attention across the fleet (the table, the bell and the
// first figure), the words on the activity feed's chips, and the shapes of its small charts.
// Pure, like metrics.ts: no database or React.

import type { Alert, Dashboard, DeploymentView, TenantView } from "./metrics.ts";

export type AttentionTone = "warning" | "critical";

export interface AttentionIssue {
  tone: AttentionTone;
  text: string;
}

export interface AttentionItem {
  key: string;
  tone: AttentionTone;
  issues: AttentionIssue[];
  // The page that explains it and fixes it.
  href: string;
  customer?: { id: string; name: string };
  deployment?: { id: string; name: string; siteUrl: string };
}

export const OLDER_CHECKS_ISSUE = "Signed off under older checks";
export const OLDER_RULES_ISSUE = "On older answering rules";
export const PRICE_TABLE_ISSUES = {
  unread: "A pricing page was found, but no prices could be read from it.",
  changed: "Price table changed: confirm it again",
  unconfirmed: "Price table to confirm",
  doubted: "Price table has rows to check",
} as const;

// Whether a deployment's price table needs a person (round 6, item 1): its rows changed since they
// were confirmed (A's re-read: price-table.ts needsConfirmingAgain), or a live chat's table was
// never confirmed, so the chat can't check price answers against it. A table with rows the proof or
// a plausibility check doubts shows too, confirmed or not (fix cycle 7c): the row says why. Pure.
export function priceTableIssue(
  table: { rows: readonly { doubt?: string }[]; hash: string; gap?: { kind: string }; unplaced?: readonly unknown[] } | null | undefined,
  confirmation: { hash: string } | null | undefined,
  published: boolean,
): "changed" | "unconfirmed" | "unread" | "doubted" | undefined {
  if (!table?.rows.length) return table?.gap?.kind === "unread" ? "unread" : undefined;
  if (confirmation && confirmation.hash !== table.hash) return "changed";
  if (table.rows.some((r) => r.doubt)) return "doubted";
  if (confirmation) return undefined;
  // Figures the page states and no row has, until a person has looked (and confirmed).
  if (table.unplaced?.length) return "doubted";
  return published ? "unconfirmed" : undefined;
}

const worst = (issues: readonly AttentionIssue[]): AttentionTone => (issues.some((i) => i.tone === "critical") ? "critical" : "warning");

// One deployment's issues, worst first, and where Review takes you: the first alert's panel, else
// the deployment page for a failed stage, else Bring up to date, else Review.
function deploymentItem(t: TenantView, d: DeploymentView): AttentionItem | undefined {
  const base = `/customers/${t.id}/deployments/${d.id}`;
  const issues: (AttentionIssue & { href: string })[] = d.alerts.map((a) => ({ tone: a.tone, text: a.text, href: a.href ?? base }));
  const stage = d.stage;
  // A failed stage, unless an alert already says what failed ("Provisioning failed").
  if ((stage?.tone === "critical" || stage?.key === "failed") && !issues.some((i) => i.tone === "critical")) {
    issues.push({ tone: "critical", text: stage.label, href: base });
  }
  if (d.olderChecks) issues.push({ tone: "warning", text: OLDER_CHECKS_ISSUE, href: `${base}/review/up-to-date` });
  if (d.olderRules) issues.push({ tone: "warning", text: OLDER_RULES_ISSUE, href: `${base}/review` });
  if (d.priceTable)
    issues.push({
      tone: "warning",
      text: PRICE_TABLE_ISSUES[d.priceTable],
      href: d.priceTable === "unread" || d.priceTable === "doubted" ? `${base}#price-table` : `${base}/review`,
    });
  if (!issues.length) return undefined;
  const sorted = [...issues.filter((i) => i.tone === "critical"), ...issues.filter((i) => i.tone !== "critical")];
  return {
    key: d.id,
    tone: worst(sorted),
    issues: sorted.map(({ tone, text }) => ({ tone, text })),
    href: sorted[0]!.href,
    customer: { id: t.id, name: t.name },
    deployment: { id: d.id, name: d.name, siteUrl: d.siteUrl },
  };
}

// Everything Fleet flags, one row per deployment (its alerts, a failed stage, sign-off under older
// checks, older answering rules), a customer's own budget alert as a row of its own, and the Agentic
// RAG account's block above all of them. Critical rows first, then by customer.
export function attentionItems(dash: Pick<Dashboard, "tenants">, blocked?: string): AttentionItem[] {
  const rows: AttentionItem[] = [];
  for (const t of dash.tenants) {
    const own = new Set<Alert>(t.deployments.flatMap((d) => d.alerts));
    const budget = t.alerts.filter((a) => !own.has(a));
    if (budget.length) {
      const issues = budget.map((a) => ({ tone: a.tone, text: a.text }));
      rows.push({
        key: `customer-${t.id}`,
        tone: worst(issues),
        issues,
        href: budget[0]!.href ?? `/customers/${t.id}`,
        customer: { id: t.id, name: t.name },
      });
    }
    for (const d of t.deployments) {
      const item = deploymentItem(t, d);
      if (item) rows.push(item);
    }
  }
  const rank = (i: AttentionItem) => (i.tone === "critical" ? 0 : 1);
  const sorted = rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.i - b.i)
    .map((r) => r.row);
  return blocked
    ? [{ key: "account", tone: "critical", issues: [{ tone: "critical", text: blocked }], href: "/settings#connections" }, ...sorted]
    : sorted;
}

// The chip beside an activity entry: what kind of step it was, and how it went where the entry says.
export function activityChip(action: string, detail: Record<string, unknown>): { label: string; tone: "good" | "neutral" | "warning" } {
  if (action === "deployment.signoff") return { label: "Sign-off", tone: "good" };
  if (action === "deployment.validate") {
    return detail.passed === false
      ? { label: "Validation", tone: "warning" }
      : detail.passed === true
        ? { label: "Validation", tone: "good" }
        : { label: "Validation", tone: "neutral" };
  }
  if (action.startsWith("deployment.validation.")) return { label: "Validation", tone: "neutral" };
  // A repeat hold (the daily re-check, still worse) isn't a second warning: once per version.
  if (action === "deployment.rules.held" && detail.repeat !== true) return { label: "Answering rules", tone: "warning" };
  if (action.startsWith("deployment.rules.")) return { label: "Answering rules", tone: "neutral" };
  if (action.startsWith("content")) return { label: "Content", tone: "neutral" };
  if (action === "deployment.pause") return { label: "Paused", tone: "warning" };
  return { label: "Deployment", tone: "neutral" };
}

// "Welcome back, Dana": a signed-in person's first name; nobody is named in setup mode, or when the
// only name is an email address.
export function greeting(name: string | undefined, setupMode: boolean): string {
  const first = name?.trim().split(/\s+/)[0];
  return !setupMode && first && !first.includes("@") ? `Welcome back, ${first}` : "Welcome back";
}

// Two letters for the account button: "Dana Smith" is "DS", "dana@agency.com" is "D".
export function initials(name: string): string {
  const words = name.includes("@") ? [name] : name.trim().split(/\s+/);
  return words
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

// A line through the values, and the area under it, in a box of width × height (SVG path data).
// The top is the largest value, so a flat series sits on the floor; one value draws a flat line.
export function linePaths(
  values: readonly number[],
  width: number,
  height: number,
  top = Math.max(0, ...values),
): { line: string; area: string } {
  if (!values.length) return { line: "", area: "" };
  const series = values.length === 1 ? [values[0]!, values[0]!] : values;
  const step = width / (series.length - 1);
  const y = (v: number) => (top > 0 ? height - (Math.max(0, v) / top) * height : height);
  const points = series.map((v, i) => `${(i * step).toFixed(2)},${y(v).toFixed(2)}`);
  const line = `M${points.join("L")}`;
  return { line, area: `${line}L${width},${height}L0,${height}Z` };
}

// Running totals: the month's cost day by day.
export function cumulative(values: readonly number[]): number[] {
  let sum = 0;
  return values.map((v) => {
    sum += v;
    return sum;
  });
}

// The dashboard's cost and question figures, labelled for what they count (round 6, item 7): the
// month by name ("Cost in November") once the month has a rolled-up day, else, on the 1st (roll-ups
// end yesterday), the last 30 days, so no tile reads 0 beside an up arrow. The questions' change is
// the last 30 days on the 30 before, so it shows only beside a figure that isn't 0; the projection is
// "at last 7 days' pace". Pure.
export interface HeadlineFigures {
  cost: { label: string; cents: number };
  projection: { label: string; detail: string };
  questions: { label: string; count: number; showChange: boolean };
}

export function headlineFigures(
  usage: { monthCents: number; daily: readonly { day: string; questions: number; costCents: number }[] },
  today: string,
): HeadlineFigures {
  const month = today.slice(0, 7);
  const monthDays = usage.daily.filter((p) => p.day.slice(0, 7) === month && p.day <= today);
  const name = new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const sum = (points: readonly { questions: number; costCents: number }[], key: "questions" | "costCents") =>
    points.reduce((n, p) => n + p[key], 0);
  const started = monthDays.length > 0;
  const questions = started ? sum(monthDays, "questions") : sum(usage.daily, "questions");
  return {
    cost: started
      ? { label: `Cost in ${name}`, cents: usage.monthCents }
      : { label: "Cost, last 30 days", cents: sum(usage.daily, "costCents") },
    projection: {
      label: `Projected for ${name}, at last 7 days' pace`,
      detail: `${started ? `${name} so far` : "Nothing rolled up this month yet"}, plus the last 7 days' pace for each day left`,
    },
    questions: { label: started ? `Questions in ${name}` : "Questions, last 30 days", count: questions, showChange: questions > 0 },
  };
}
