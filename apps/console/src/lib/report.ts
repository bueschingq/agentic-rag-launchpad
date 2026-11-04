// The monthly client report: what visitors asked, what went unanswered (the content gaps), what
// they rated not helpful, what they clicked, and answer quality, per customer. Built from the
// worker's question log copy (partner tests left out, contact details masked) and the widget's
// counts. A question the widget asked again counts once, with the answer the visitor saw last;
// the retries show only in Costs. "Answered" is the widget's own verdict where it sent one, else
// the same rule applied to the question log (verdictSource); questions from before that rule say
// so. The partner can hide a question that isn't a content gap; hidden questions are left out of
// the lists, in the console and on shared links alike. Cost appears only when the partner asks
// for it, never on a shared link.
//
// Test traffic, questions from one of a deployment's staging domains (or flagged partnerTest),
// is a line of its own, "Test traffic: 12 questions, not counted", and stays out of every figure
// unless the report is asked to include it (withTest), here and on shared links alike. Where it
// was asked comes from the widget's question event, so a closed tab doesn't make a test question
// the client's.
//
// A reply that says the site lacks the information and gives nothing concrete ("we don't have
// steps for that, please contact us") is no answer (the shared verdict's "may-not-answer"): it
// counts as unanswered and is listed under Content gaps. The month that rule ships, the report says
// so in one line, so a lower answered share at renewal doesn't catch the partner out.
//
// The worker's nightly roll-up also has the model judge the replies the shared verdict counts as
// answered but that say something is missing or over (round 5). One the judge holds (the site
// doesn't back it, it answers something else, or it talks about its sources) is a content gap
// (verdictSource "judge"). One that denies what the site states ("Our website does not
// list prices" beside a pricing page) is unanswered too, but no content gap: the page exists, so
// it's listed apart, in the console only ("judge-contradicts").

import { askedQuestions, auditLog, deployments, qualityDaily, tenants, usageDaily, widgetEventsDaily } from "@launchpad/db";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { withSetupName } from "./setup-name.ts";
import { isTestOrigin, TEST_PREFIX } from "./widget-events.ts";

export interface GroupedQuestion {
  question: string;
  count: number;
  answered: number;
}

// "What are your hours?" and "what are your hours" are one question: identical wordings,
// ignoring case and punctuation.
export const questionKey = (q: string) =>
  q
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

export function groupQuestions(rows: readonly { question: string; answered: boolean }[]): GroupedQuestion[] {
  const groups = new Map<string, GroupedQuestion>();
  for (const r of rows) {
    const key = questionKey(r.question);
    if (!key) continue;
    const g = groups.get(key);
    if (g) {
      g.count += 1;
      if (r.answered) g.answered += 1;
    } else groups.set(key, { question: r.question.trim(), count: 1, answered: r.answered ? 1 : 0 });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.question.localeCompare(b.question));
}

export const monthBounds = (month: string) => {
  const start = `${month}-01`;
  const d = new Date(`${start}T00:00:00Z`);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return { start, next };
};

// Which rule decided "answered" for the month's questions: all by the shared rule, some by the
// earlier one (questions before the change, which aren't recounted), or all by the earlier one.
export function ruleOf(rows: readonly { verdictSource: string | null; askedAt: Date }[]): {
  earlier: "none" | "some" | "all";
  since?: Date;
} {
  const current = rows.filter((r) => r.verdictSource !== null);
  if (current.length === rows.length) return { earlier: "none" };
  if (!current.length) return { earlier: "all" };
  return { earlier: "some", since: new Date(Math.min(...current.map((r) => r.askedAt.getTime()))) };
}

// The worker's verdict source for a reply the judge found denying what the site states (apps/
// worker/src/jobs/usage.ts judgedSource).
export const MISSED = "judge-contradicts";

// The day replies that say "contact us" without answering started counting as gaps: the release
// day of the shared verdict's "declined" outcome. Set at release.
export const DECLINED_COUNTED_FROM = "2026-10-31";

// "From 2 November 2026, replies that said "contact us" without answering count as gaps": only on
// the report for the month that holds `from`. Pure.
export function gapsRuleNote(month: string, from: string = DECLINED_COUNTED_FROM): string | undefined {
  if (from.slice(0, 7) !== month) return undefined;
  const day = new Date(`${from.slice(0, 10)}T00:00:00Z`).toLocaleString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return `From ${day}, replies that said “contact us” without answering count as gaps.`;
}

// Whether a question was test traffic: asked from a staging domain of its deployment, or by
// partner staff. Pure.
export function isTestQuestion(q: { partnerTest: boolean; origin: string | null }, stagingDomains: readonly string[]): boolean {
  return q.partnerTest || isTestOrigin(q.origin, stagingDomains);
}

export async function loadReport(tenantId: string, month: string, opts: { withTest?: boolean } = {}) {
  const withTest = opts.withTest === true;
  // visibleName: the name the client's own people see, on the report's title and the shared link.
  // Never the internal name: a customer added before "Name visitors see" was required is "The client".
  const [row] = await db()
    .select({ id: tenants.id, name: tenants.name, displayName: tenants.displayName })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!row) return undefined;
  const tenant = { id: row.id, name: row.name, visibleName: row.displayName?.trim() || "The client" };
  const ds = await db()
    .select({ id: deployments.id, name: deployments.name, siteUrl: deployments.siteUrl, stagingDomains: deployments.stagingDomains })
    .from(deployments)
    .where(eq(deployments.tenantId, tenantId));
  const ids = ds.map((d) => d.id);
  const staging = new Map(ds.map((d) => [d.id, d.stagingDomains]));
  const { start, next } = monthBounds(month);
  const prev = monthBounds(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7));
  if (!ids.length) return { tenant, deployments: ds, month, empty: true as const };

  const inMonth = (col: typeof askedQuestions.askedAt) =>
    and(gte(col, new Date(`${start}T00:00:00Z`)), lt(col, new Date(`${next}T00:00:00Z`)));
  const [asked, logged, quality, prevQuality, usage] = await Promise.all([
    db()
      .select({
        deploymentId: askedQuestions.deploymentId,
        question: askedQuestions.question,
        answered: askedQuestions.answered,
        feedback: askedQuestions.feedback,
        verdictSource: askedQuestions.verdictSource,
        hidden: askedQuestions.hidden,
        askedAt: askedQuestions.askedAt,
        partnerTest: askedQuestions.partnerTest,
        origin: askedQuestions.origin,
      })
      .from(askedQuestions)
      .where(and(inArray(askedQuestions.deploymentId, ids), inMonth(askedQuestions.askedAt))),
    db()
      .select({
        name: widgetEventsDaily.name,
        dimension: widgetEventsDaily.dimension,
        count: sql<number>`sum(${widgetEventsDaily.count})`.mapWith(Number),
      })
      .from(widgetEventsDaily)
      .where(and(inArray(widgetEventsDaily.deploymentId, ids), gte(widgetEventsDaily.day, start), lt(widgetEventsDaily.day, next)))
      .groupBy(widgetEventsDaily.name, widgetEventsDaily.dimension),
    db()
      .select({ relevance: sql<number | null>`avg(${qualityDaily.answerRelevance})`.mapWith((v) => (v === null ? null : Number(v))) })
      .from(qualityDaily)
      .where(and(inArray(qualityDaily.deploymentId, ids), gte(qualityDaily.day, start), lt(qualityDaily.day, next))),
    db()
      .select({ relevance: sql<number | null>`avg(${qualityDaily.answerRelevance})`.mapWith((v) => (v === null ? null : Number(v))) })
      .from(qualityDaily)
      .where(and(inArray(qualityDaily.deploymentId, ids), gte(qualityDaily.day, prev.start), lt(qualityDaily.day, prev.next))),
    db()
      .select({
        questions: sql<number>`coalesce(sum(${usageDaily.questions}), 0)`.mapWith(Number),
        costCents: sql<number>`coalesce(sum(${usageDaily.costCents}), 0)`.mapWith(Number),
        // The worker's last roll-up: the question log is read every 15 minutes.
        updatedAt: sql<Date | null>`max(${usageDaily.updatedAt})`.mapWith((v) => (v ? new Date(v) : null)),
      })
      .from(usageDaily)
      .where(and(inArray(usageDaily.deploymentId, ids), gte(usageDaily.day, start), lt(usageDaily.day, next))),
  ]);

  const test = new Set(asked.filter((q) => isTestQuestion(q, staging.get(q.deploymentId) ?? [])));
  const questions = withTest ? asked : asked.filter((q) => !test.has(q));
  // The widget's counts from staging domains are kept under "test:" names (lib/widget-events.ts).
  const events = logged.flatMap((e) => {
    const fromTest = e.name.startsWith(TEST_PREFIX);
    return fromTest && !withTest ? [] : [{ ...e, name: fromTest ? e.name.slice(TEST_PREFIX.length) : e.name }];
  });
  const count = (name: string, dimension?: string) =>
    events.filter((e) => e.name === name && (dimension === undefined || e.dimension === dimension)).reduce((n, e) => n + e.count, 0);
  const breakdown = (name: string) => {
    const byLabel = new Map<string, number>();
    for (const e of events) if (e.name === name && e.dimension) byLabel.set(e.dimension, (byLabel.get(e.dimension) ?? 0) + e.count);
    return [...byLabel].map(([label, n]) => ({ label, count: n })).sort((a, b) => b.count - a.count);
  };

  // A question the partner marked "Not a content gap" stays out of every list, with all its wordings.
  const hiddenKeys = new Set(questions.filter((q) => q.hidden).map((q) => questionKey(q.question)));
  const listed = questions.filter((q) => !hiddenKeys.has(questionKey(q.question)));
  const answered = questions.filter((q) => q.answered).length;
  // The widget's thumbs are its event counts; a matched question carries them too (verdictSource
  // "widget"), so only the log's own ratings are added.
  const logRated = (value: string) => questions.filter((q) => q.feedback === value && q.verdictSource !== "widget").length;
  const thumbsUp = count("arag_chat_feedback", "up") + logRated("good");
  const thumbsDown = count("arag_chat_feedback", "down") + logRated("bad");
  const figuresTo = usage[0]?.updatedAt ?? null;
  return {
    tenant,
    deployments: ds,
    month,
    empty: false as const,
    // The question log copy, else (before the worker's first pass) the usage roll-up.
    questions: asked.length ? questions.length : usage[0]?.questions || 0,
    // Questions with their text and outcome; fewer than the total until the worker's next pass.
    logged: questions.length,
    answered,
    unanswered: questions.length - answered,
    top: groupQuestions(listed).slice(0, 20),
    gaps: groupQuestions(listed.filter((q) => !q.answered && q.verdictSource !== MISSED)).slice(0, 10),
    // For the console only: replies the judge found denying what the site states.
    missed: groupQuestions(listed.filter((q) => !q.answered && q.verdictSource === MISSED)).slice(0, 10),
    notHelpful: groupQuestions(listed.filter((q) => q.feedback === "bad")).slice(0, 10),
    // For the console only: what the partner hid, to show it again.
    hidden: groupQuestions(questions.filter((q) => hiddenKeys.has(questionKey(q.question)))),
    rule: ruleOf(questions),
    // The month "contact us" replies started counting as gaps: one line saying so.
    gapsNote: gapsRuleNote(month),
    // Only while the month is still running: a finished month's figures are complete.
    figuresTo: figuresTo && figuresTo < new Date(`${next}T00:00:00Z`) ? figuresTo : null,
    thumbs: { up: thumbsUp, down: thumbsDown },
    opens: count("arag_chat_open"),
    ctas: breakdown("arag_chat_cta_click"),
    handoffs: breakdown("arag_chat_handoff_click"),
    leads: count("arag_chat_lead_submit"),
    // Questions from staging domains: left out of every figure above unless included.
    test: { questions: test.size, included: withTest },
    languages: breakdown("arag_chat_question"),
    quality: { now: quality[0]?.relevance ?? null, before: prevQuality[0]?.relevance ?? null },
    costCents: usage[0]?.costCents ?? 0,
  };
}

// "Not a content gap": hides every wording of a question in the month from the report's lists
// (and the shared link), or shows it again. Audited.
export async function setQuestionHidden(tenantId: string, month: string, question: string, hidden: boolean, actor: string | null) {
  const key = questionKey(question);
  const ids = (await db().select({ id: deployments.id }).from(deployments).where(eq(deployments.tenantId, tenantId))).map((d) => d.id);
  if (!key || !ids.length) return 0;
  const { start, next } = monthBounds(month);
  const rows = await db()
    .select({ deploymentId: askedQuestions.deploymentId, logId: askedQuestions.logId, question: askedQuestions.question })
    .from(askedQuestions)
    .where(
      and(
        inArray(askedQuestions.deploymentId, ids),
        gte(askedQuestions.askedAt, new Date(`${start}T00:00:00Z`)),
        lt(askedQuestions.askedAt, new Date(`${next}T00:00:00Z`)),
      ),
    );
  const matching = rows.filter((r) => questionKey(r.question) === key);
  for (const r of matching)
    await db()
      .update(askedQuestions)
      .set({ hidden })
      .where(and(eq(askedQuestions.deploymentId, r.deploymentId), eq(askedQuestions.logId, r.logId)));
  await db()
    .insert(auditLog)
    .values(
      await withSetupName({
        actorUserId: actor,
        action: hidden ? "report.hide_question" : "report.show_question",
        targetType: "tenant",
        targetId: tenantId,
        detail: { month, question, rows: matching.length },
      }),
    );
  return matching.length;
}

// Visitor questions the widget asked again, per customer, for "N retries" in Costs (where the
// spend is): never in the client report. Test traffic included, as in the cost.
export async function retriesByTenant(month: string): Promise<Map<string, number>> {
  const { start, next } = monthBounds(month);
  const rows = await db()
    .select({
      tenantId: deployments.tenantId,
      retries: sql<number>`coalesce(sum(${askedQuestions.attempts} - 1), 0)`.mapWith(Number),
    })
    .from(askedQuestions)
    .innerJoin(deployments, eq(deployments.id, askedQuestions.deploymentId))
    .where(and(gte(askedQuestions.askedAt, new Date(`${start}T00:00:00Z`)), lt(askedQuestions.askedAt, new Date(`${next}T00:00:00Z`))))
    .groupBy(deployments.tenantId);
  return new Map(rows.map((r) => [r.tenantId, r.retries]));
}

// How a visitor's contact clicks and forms count, one way everywhere: a form sent is a lead; a click
// on its button only opened it (round 7: "1 contact form" above "Contact form: 2"). Pure.
type ReportCounts = {
  opens: number;
  questions: number;
  answered: number;
  logged: number;
  leads: number;
  ctas: readonly { label: string; count: number }[];
  handoffs: readonly { label: string; count: number }[];
  languages: readonly { label: string; count: number }[];
};
const sum = (rows: readonly { count: number }[]) => rows.reduce((n, r) => n + r.count, 0);
export const contactClicks = (r: Pick<ReportCounts, "handoffs">): number => sum(r.handoffs.filter((h) => h.label !== "form"));

// The month from chat to lead: each count is one of the report's own. Questions a chat asks are many
// to one, so these are steps to read, not a conversion rate. Pure.
export function reportFunnel(r: ReportCounts): { label: string; count: number }[] {
  return [
    { label: "Chats opened", count: r.opens },
    { label: "Questions asked", count: r.questions },
    { label: "Answered from the site", count: r.answered },
    { label: "Buttons and contacts clicked", count: sum(r.ctas) + contactClicks(r) },
    { label: "Leads sent", count: r.leads },
  ];
}

// The languages list, adding up to the questions: the widget counts a question's language as it's
// asked, so questions from before it did, or read only from the log, have none. Pure.
export function languageCounts(r: Pick<ReportCounts, "languages" | "questions">): { label: string; count: number }[] {
  const missing = r.questions - sum(r.languages);
  return missing > 0 ? [...r.languages, { label: "Not recorded", count: missing }] : [...r.languages];
}

// The report as a spreadsheet: every figure and list it shows, never the cost. toCsv makes it text. Pure.
export function reportRows(
  r: ReportCounts & {
    month: string;
    unanswered: number;
    thumbs: { up: number; down: number };
    test: { questions: number; included: boolean };
    top: readonly GroupedQuestion[];
    gaps: readonly GroupedQuestion[];
    notHelpful: readonly GroupedQuestion[];
  },
): (string | number)[][] {
  const list = (section: string, rows: readonly { label: string; count: number }[]) => rows.map((x) => [section, x.label, x.count, ""]);
  const questions = (section: string, rows: readonly GroupedQuestion[]) =>
    rows.map((q) => [section, q.question, q.count, q.count - q.answered]);
  return [
    ["Section", "Item", "Count", "Unanswered"],
    ["Month", r.month, "", ""],
    ...list("Funnel", reportFunnel(r)),
    ["Questions", "With no answer on the site", r.unanswered, ""],
    ["Ratings", "Helpful", r.thumbs.up, ""],
    ["Ratings", "Not helpful", r.thumbs.down, ""],
    [r.test.included ? "Test traffic (included)" : "Test traffic (not counted)", "Questions", r.test.questions, ""],
    ...list("Language", languageCounts(r)),
    ...list("Button clicked", r.ctas),
    ...list(
      "Contact used",
      r.handoffs.map((h) => ({ label: h.label === "form" ? "Contact form opened" : h.label, count: h.count })),
    ),
    ...questions("Asked most", r.top),
    ...questions("Content gap", r.gaps),
    ...questions("Rated not helpful", r.notHelpful),
  ];
}

// Answer relevance (REMi, 1–5) in words a client reads.
export function qualityWords(now: number | null, before: number | null): string {
  if (now === null) return "Not enough rated answers this month to say.";
  const level = now >= 4.2 ? "very good" : now >= 3.5 ? "good" : now >= 2.8 ? "fair" : "weak";
  const trend =
    before === null
      ? ""
      : now - before >= 0.2
        ? ", better than the month before"
        : before - now >= 0.2
          ? ", down on the month before"
          : ", about the same as the month before";
  return `Answers were ${level} (${now.toFixed(1)} out of 5 on Progress's relevance check)${trend}.`;
}
