// Questions, searches and query-side tokens per deployment per UTC day, priced at the
// partner's contract rate. Processing/storage usage (needs a PAT) is added in M4.
//
// Questions come from the KB's question log, which also feeds the client report: each
// visitor question is kept (masked) with whether it was answered and how it was rated.
// Partner tests (preview, validation, prompt tests, and the Agentic RAG dashboard) are logged
// with client_type "dashboard" and left out of both, so the customer never pays for them.
//
// One visitor question counts once. When a reply has no answer, the widget asks again (of every
// page, without the conversation), and each ask is a row in the log: rows with the same question
// (questionHash) within 2 minutes of the first are attempts at one question. Its verdict is the
// last attempt's, its cost every attempt's (the spend is real), and asked_questions.attempts keeps
// the count for "N retries" in Costs. Where the widget's events show that several visitors asked
// the same words in that time, they stay separate questions.
//
// "Answered" is the widget's verdict where it sent one (answer_events, matched by the hash of
// the question within a few minutes), else the same rule applied to the last attempt's log row.
// Either way the row records which (verdictSource), and the widget's thumbs land on the matched
// question. The page's origin comes from the widget's question event (question_events, sent as
// the question is asked, so it's there even when the answer's batch is lost to a closed tab),
// else from its answer event: the report counts questions from the deployment's staging domains
// as test traffic. A question event also tells visitors apart when their answer events are lost.
//
// The nightly close of yesterday also judges (round 5): a question the shared verdict counts as
// answered whose reply says something is missing or over (negativeClaim) is checked against the
// site by the model judge (the console's judgeAnswer, cached per question and answer), at most
// JUDGE_BUDGET a deployment a night. A reply the judge finds the site doesn't back ("not on the
// site", off topic) is a content gap; one that denies what the site states is unanswered too, but
// listed apart in the console, since writing content won't fix it (the page exists). Later passes
// keep the judge's decision (verdictSource "judge…"), so content gaps stay real.

import { answerEvents, askedQuestions, questionEvents, settings, usageDaily } from "@launchpad/db";
import type { AskLogEntry, KbClient } from "@launchpad/par-client";
import { asksWhen, detectLanguage, isAnswered, logReplyFacts, negativeClaim, questionHash, routeIntent, verdict } from "@launchpad/theme";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { noteAccountBlock } from "../../../console/src/lib/account-block.ts";
import { isJudgeVerdict, judgeOutcome } from "../../../console/src/lib/validation-rules.ts";
import { activeDeployments, type JobContext, managerClient } from "../context.ts";
import { addDays, costCents, isoDate, parseLogDate, yearMonth } from "../dates.ts";

const PAGE = 100;
const LOG_FIELDS = ["id", "date", "question", "answer", "status", "resources_count", "nuclia_tokens", "client_type", "feedback_good"];

// The widget's event lands a few seconds after the log row (it's sent in batches when the
// answer has finished); the margin before allows for clock differences.
const MATCH_BEFORE_MS = 2 * 60_000;
const MATCH_AFTER_MS = 10 * 60_000;
// Attempts at one question: the widget's retry follows the first reply within seconds.
export const RETRY_WINDOW_MS = 2 * 60_000;

// The report judge: the model's verdict on a logged reply, against the site (judgeAnswer in the
// console's lib/judge.ts: "answers", "partly", "not-on-site", "contradicts", "off-topic",
// "talks-about-sources", or "unavailable" when it couldn't be asked).
export type RollupJudge = (q: { deploymentId: string; question: string; answer: string }) => Promise<string | undefined>;

// At most this many judged replies per deployment per night.
export const JUDGE_BUDGET = 200;

// What a judge's verdict makes a question. A hold (judgeOutcome) is a content gap ("judge"), except
// a reply that denies what the site states: unanswered too, but listed apart ("judge-contradicts"),
// since the page exists. Anything else, "unavailable" included, leaves it as the shared verdict
// had it: the judge only makes a result stricter.
export function judgedSource(verdict: string | undefined): string | undefined {
  if (verdict === "contradicts") return "judge-contradicts";
  return isJudgeVerdict(verdict) && judgeOutcome(verdict) === "hold" ? "judge" : undefined;
}

// The judge as the nightly roll-up asks it: the console's judgeAnswer, given the matching key
// pages' facts for an intent question (price, buy, trial, support, contact) or the upcoming dates
// the site states for an events one, since the question log keeps no passages. Loaded when first
// used. It never throws.
export const reportJudge: RollupJudge = async ({ deploymentId, question, answer }) => {
  const [{ judgeAnswer }, { keyFacts, upcomingEvents }] = await Promise.all([
    import("../../../console/src/lib/judge.ts"),
    import("../../../console/src/lib/content.ts"),
  ]);
  const intent = routeIntent(question) ?? (asksWhen(question) ? "events" : undefined);
  const evidence =
    intent === "events" ? { events: await upcomingEvents(deploymentId) } : intent ? { keyFacts: await keyFacts(deploymentId, intent) } : {};
  return (await judgeAnswer({ deploymentId, question, answer, passages: [], ...evidence })).verdict;
};

// `days` UTC days from `day`: today's running totals, yesterday's close, or the month so far
// (recountMonth). The log is read once, with a margin either side, so a retry just past
// midnight joins the question it retried. With a judge (yesterday's close), answered replies that
// claim something is missing are judged, up to JUDGE_BUDGET per deployment.
export async function rollupUsage(ctx: JobContext, day: Date, days = 1, opts: { judge?: RollupJudge } = {}): Promise<void> {
  const end = addDays(day, days);
  const [config] = await ctx.db.select({ rates: settings.contractRates }).from(settings).where(eq(settings.id, 1));
  const rate = config?.rates.nuclia_tokens;

  for (const d of await activeDeployments(ctx)) {
    const budget = { left: opts.judge ? JUDGE_BUDGET : 0 };
    try {
      const kb = await managerClient(ctx, d);
      if (!kb) continue;
      const buckets = await kb.activityMetrics({ from: day, to: end, aggregation: "day" });
      const log = await visitorQuestions(kb, new Date(day.getTime() - RETRY_WINDOW_MS), new Date(end.getTime() + RETRY_WINDOW_MS));
      const since = new Date(day.getTime() - RETRY_WINDOW_MS - MATCH_BEFORE_MS);
      const until = new Date(end.getTime() + RETRY_WINDOW_MS + MATCH_AFTER_MS);
      const events = await ctx.db
        .select({
          id: answerEvents.id,
          conversationId: answerEvents.conversationId,
          questionHash: answerEvents.questionHash,
          at: answerEvents.at,
          answered: answerEvents.answered,
          feedback: answerEvents.feedback,
          attempts: answerEvents.attempts,
          origin: answerEvents.origin,
        })
        .from(answerEvents)
        .where(and(eq(answerEvents.deploymentId, d.id), gte(answerEvents.at, since), lt(answerEvents.at, until)));
      const asked = await ctx.db
        .select({
          id: questionEvents.id,
          conversationId: questionEvents.conversationId,
          questionHash: questionEvents.questionHash,
          at: questionEvents.at,
          origin: questionEvents.origin,
        })
        .from(questionEvents)
        .where(and(eq(questionEvents.deploymentId, d.id), gte(questionEvents.at, since), lt(questionEvents.at, until)));
      const questions = groupAttempts(log, events, asked);
      for (let from = day; from < end; from = addDays(from, 1)) {
        const next = addDays(from, 1);
        const within = (row: AskLogEntry) => {
          const at = parseLogDate(row.date);
          return at >= from && at < next;
        };
        // Each attempt's tokens on the day it was asked; each question on the day of its first.
        const rows = log.filter(within);
        const asked = questions.filter((q) => within(q.rows[0]!));
        // Recounting a past day the log no longer has would wipe what was counted then.
        if (days > 1 && !rows.length) continue;
        const tokens = rows.reduce((sum, row) => sum + (row.nuclia_tokens ?? 0), 0);
        const bucket = buckets.find((b) => b.timestamp.startsWith(isoDate(from)));
        const values = {
          questions: asked.length,
          searches: bucket?.search ?? 0,
          queryTokens: tokens.toFixed(6),
          costCents: costCents(tokens, rate) ?? null,
        };
        await ctx.db
          .insert(usageDaily)
          .values({ deploymentId: d.id, day: isoDate(from), ...values })
          .onConflictDoUpdate({ target: [usageDaily.deploymentId, usageDaily.day], set: { ...values, updatedAt: new Date() } });
        await storeQuestions(ctx, d.id, asked, opts.judge && { judge: opts.judge, budget, log: ctx.log });
      }
    } catch (err) {
      ctx.log(`usage rollup failed for deployment ${d.id}: ${err instanceof Error ? err.message : err}`);
      // The account blocked (for budget): recorded once, for the partner's channel and Fleet.
      await noteAccountBlock(ctx.db, err, "usage");
    }
  }
}

// The judge's part of a roll-up: the reply's last attempt, when the shared verdict counts it as
// answered and it says something is missing or over. Pure.
export function judgeCandidate(
  q: VisitorQuestion,
  row: Pick<NonNullable<ReturnType<typeof toAskedQuestion>>, "answered">,
): string | undefined {
  const question = typeof q.rows[0]?.question === "string" ? q.rows[0].question : "";
  const answer = q.rows.at(-1)?.answer;
  if (!row.answered || typeof answer !== "string" || !answer.trim() || !question.trim()) return undefined;
  return negativeClaim(answer, detectLanguage(question), question) ? answer : undefined;
}

// A stored question as the judge leaves it: unanswered, with the judge as its verdict's source,
// when the verdict holds it (judgedSource). Pure.
export function applyJudgement<R extends { answered: boolean; verdictSource: string }>(row: R, judgement: string | undefined): R {
  const source = judgedSource(judgement);
  return source ? { ...row, answered: false, verdictSource: source } : row;
}

// The rows a roll-up stores for its questions (toAskedQuestion), judged where a judge is given.
export async function questionRows(
  deploymentId: string,
  questions: readonly VisitorQuestion[],
  judging?: { judge: RollupJudge; budget: { left: number }; log: (message: string) => void },
) {
  const out = [];
  for (const q of questions) {
    const shared = toAskedQuestion(q);
    if (shared) out.push({ q, row: await judged(deploymentId, q, { ...shared, verdictSource: shared.verdictSource as string }, judging) });
  }
  return out;
}

// Asks the judge about one stored question, if it's a candidate and the night's budget allows;
// a judge that fails leaves the question as the shared verdict had it.
async function judged<R extends { answered: boolean; verdictSource: string }>(
  deploymentId: string,
  q: VisitorQuestion,
  row: R,
  judging: { judge: RollupJudge; budget: { left: number }; log: (message: string) => void } | undefined,
): Promise<R> {
  if (!judging || judging.budget.left <= 0) return row;
  const answer = judgeCandidate(q, row);
  if (!answer) return row;
  judging.budget.left -= 1;
  const question = String(q.rows[0]!.question).trim();
  const verdict = await judging.judge({ deploymentId, question, answer }).catch((err) => {
    judging.log(`report judge failed for deployment ${deploymentId}: ${err instanceof Error ? err.message : err}`);
    return undefined;
  });
  return applyJudgement(row, verdict);
}

// The month so far, counted again for every deployment: when the counting rules change, so no
// renewal conversation uses figures counted the old way, and nightly for late events and thumbs.
export function recountMonth(ctx: JobContext, today: Date): Promise<void> {
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  return rollupUsage(ctx, first, today.getUTCDate());
}

// One row per question, keyed by its first attempt's log id. A later attempt stored as a
// question of its own (counted before the rule, or before its retry had landed) goes, and a
// question one of its rows was hidden under stays hidden. A question the judge made unanswered
// stays so (its log rows, and so its reply, never change).
async function storeQuestions(
  ctx: JobContext,
  deploymentId: string,
  questions: VisitorQuestion[],
  judging?: { judge: RollupJudge; budget: { left: number }; log: (message: string) => void },
) {
  const ids = questions.flatMap((q) => q.rows.map((r) => String(r.id)));
  if (!ids.length) return;
  const hidden = new Set(
    (
      await ctx.db
        .select({ logId: askedQuestions.logId })
        .from(askedQuestions)
        .where(and(eq(askedQuestions.deploymentId, deploymentId), inArray(askedQuestions.logId, ids), eq(askedQuestions.hidden, true)))
    ).map((r) => r.logId),
  );
  const later: string[] = [];
  // Kept by a judge's verdict from an earlier pass.
  const byJudge = sql`${askedQuestions.verdictSource} like 'judge%'`;
  for (const q of questions) later.push(...q.rows.slice(1).map((r) => String(r.id)));
  for (const { q, row } of await questionRows(deploymentId, questions, judging)) {
    const isHidden = q.rows.some((r) => hidden.has(String(r.id)));
    await ctx.db
      .insert(askedQuestions)
      .values({ deploymentId, ...row, hidden: isHidden })
      .onConflictDoUpdate({
        target: [askedQuestions.deploymentId, askedQuestions.logId],
        set: {
          answered: sql`case when ${byJudge} then ${askedQuestions.answered} else ${row.answered} end`,
          feedback: row.feedback,
          verdictSource: sql`case when ${byJudge} then ${askedQuestions.verdictSource} else ${row.verdictSource} end`,
          attempts: row.attempts,
          origin: row.origin,
          hidden: isHidden,
        },
      });
  }
  if (later.length)
    await ctx.db.delete(askedQuestions).where(and(eq(askedQuestions.deploymentId, deploymentId), inArray(askedQuestions.logId, later)));
}

// The question log for [from, to), without partner tests. The log is kept per calendar month,
// so a range across the 1st reads two, each from within its own month (Agentic RAG refuses a
// date filter outside the month asked for, seen 2026-10-30).
async function visitorQuestions(kb: KbClient, from: Date, to: Date): Promise<AskLogEntry[]> {
  const until = new Date(Math.min(to.getTime(), Date.now()));
  const months = [...new Set([yearMonth(from), yearMonth(new Date(Math.max(until.getTime() - 1, from.getTime())))])];
  const rows: AskLogEntry[] = [];
  for (const month of months) {
    const since = new Date(Math.max(from.getTime(), Date.parse(`${month}-01T00:00:00Z`)));
    let after: number | undefined;
    for (let page = 0; page < 1000; page++) {
      const batch = await kb.askLog({ yearMonth: month, since, limit: PAGE, startingAfter: after, show: LOG_FIELDS });
      for (const row of batch) {
        const at = parseLogDate(row.date);
        if (at >= from && at < to && !isPartnerTest(row)) rows.push(row);
      }
      if (batch.length < PAGE) break;
      after = batch.at(-1)?.id;
    }
  }
  return rows;
}

export const isPartnerTest = (row: Pick<AskLogEntry, "client_type">) => row.client_type === "dashboard";

// The shared rule on what the log offers: its status (no_context, no_retrieval_data), how many
// resources were retrieved, and the question, which says what kind of content answers it (a
// figure, a date, steps) and whether a negative claim is about it. The log has no relevance score
// and no passages, so the score floor and grounding only apply through the widget's own verdict.
export function answeredFromLog(row: Pick<AskLogEntry, "status" | "resources_count" | "answer">, question?: string): boolean {
  return isAnswered(verdict({ ...logReplyFacts(row), ...(question && { question }) }));
}

export interface WidgetVerdict {
  id: string;
  // Missing on events from before question events (the tests' older shape).
  conversationId?: string;
  questionHash: string;
  at: Date;
  answered: boolean;
  feedback: string | null;
  // Asks the widget made (2 when it retried), and the page's origin.
  attempts: number;
  origin: string | null;
}

// The widget's note that a question was asked, and the page origin it was asked on.
export interface QuestionAsked {
  id: string;
  conversationId: string;
  questionHash: string;
  at: Date;
  origin: string | null;
}

// One visitor question: its attempts in the log, oldest first, the widget's verdict on it, and
// its question event.
export interface VisitorQuestion {
  rows: AskLogEntry[];
  widget?: WidgetVerdict;
  asked?: QuestionAsked;
}

type LogRow = Pick<AskLogEntry, "id" | "date" | "question">;

// One visitor's ask of a question as the widget reported it: the question event, the answer
// event, or both (the same conversation and question). Timed by the question event where there
// is one: it's sent as the question goes out, so it sits next to the log row.
interface Visitor {
  key: string;
  questionHash: string;
  at: Date;
  widget?: WidgetVerdict;
  asked?: QuestionAsked;
}

function visitorsOf(events: readonly WidgetVerdict[], asked: readonly QuestionAsked[]): Visitor[] {
  const out = new Map<string, Visitor>();
  for (const a of asked)
    out.set(`${a.conversationId}\u0000${a.questionHash}`, { key: `q:${a.id}`, questionHash: a.questionHash, at: a.at, asked: a });
  for (const e of events) {
    const both = e.conversationId === undefined ? undefined : out.get(`${e.conversationId}\u0000${e.questionHash}`);
    if (both && !both.widget) both.widget = e;
    else out.set(`a:${e.id}`, { key: `a:${e.id}`, questionHash: e.questionHash, at: e.at, widget: e });
  }
  return [...out.values()];
}

// Groups log rows into visitor questions, oldest first. Rows with the same question within 2
// minutes of the first are attempts at one. The widget's events pair with them by hash, within
// the window, nearest first, each visitor once: when more than one pairs with the same rows,
// several visitors asked the same words (a popular starter), and each takes as many rows as its
// answer event says it asked (shared out evenly when only the question event arrived). Without
// events, the rows stay one question. Pure.
export function groupAttempts<R extends LogRow>(
  rows: readonly R[],
  events: readonly WidgetVerdict[],
  asked: readonly QuestionAsked[] = [],
): { rows: R[]; widget?: WidgetVerdict; asked?: QuestionAsked }[] {
  const runs: { hash?: string; rows: R[]; first: number }[] = [];
  const open = new Map<string, (typeof runs)[number]>();
  const at = (r: LogRow) => parseLogDate(r.date).getTime();
  for (const row of [...rows].sort((a, b) => at(a) - at(b))) {
    const hash = typeof row.question === "string" && row.question.trim() ? questionHash(row.question) : undefined;
    const run = hash ? open.get(hash) : undefined;
    if (run && at(row) - run.first <= RETRY_WINDOW_MS) run.rows.push(row);
    else {
      const fresh = { hash, rows: [row], first: at(row) };
      runs.push(fresh);
      if (hash) open.set(hash, fresh);
    }
  }

  const byHash = new Map<string, Visitor[]>();
  for (const v of visitorsOf(events, asked)) byHash.set(v.questionHash, [...(byHash.get(v.questionHash) ?? []), v]);
  const pairs: { run: number; visitor: Visitor; gap: number }[] = [];
  for (const [i, run] of runs.entries()) {
    for (const visitor of (run.hash && byHash.get(run.hash)) || []) {
      const gaps = run.rows
        .map((r) => visitor.at.getTime() - at(r))
        .filter((delta) => delta >= -MATCH_BEFORE_MS && delta <= MATCH_AFTER_MS)
        .map(Math.abs);
      if (gaps.length) pairs.push({ run: i, visitor, gap: Math.min(...gaps) });
    }
  }
  const matched = runs.map((): Visitor[] => []);
  const used = new Set<string>();
  for (const p of pairs.sort((a, b) => a.gap - b.gap)) {
    const taken = matched[p.run]!;
    if (used.has(p.visitor.key) || taken.length >= runs[p.run]!.rows.length) continue;
    taken.push(p.visitor);
    used.add(p.visitor.key);
  }
  const reported = (v: Visitor | undefined) => ({ ...(v?.widget && { widget: v.widget }), ...(v?.asked && { asked: v.asked }) });

  return runs.flatMap((run, i) => {
    const visitors = matched[i]!.sort((a, b) => a.at.getTime() - b.at.getTime());
    if (visitors.length <= 1) return [{ rows: run.rows, ...reported(visitors[0]) }];
    // In time order, each visitor's attempts; every visitor keeps at least one row.
    let next = 0;
    return visitors.map((visitor, v) => {
      const left = visitors.length - v - 1;
      const share = visitor.widget?.attempts ?? Math.round((run.rows.length - next) / (left + 1));
      const take = left ? Math.min(Math.max(share, 1), run.rows.length - next - left) : run.rows.length - next;
      const own = run.rows.slice(next, next + take);
      next += take;
      return { rows: own, ...reported(visitor) };
    });
  });
}

// Visitors type contact details into chats; the report never shows them.
export function maskPersonalData(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/(\+?\d[\d\s().-]{6,}\d)/g, (match) => (match.replace(/\D/g, "").length >= 7 ? "[phone]" : match));
}

const THUMBS: Record<string, "good" | "bad"> = { up: "good", down: "bad" };

export function toAskedQuestion(q: VisitorQuestion) {
  const first = q.rows[0];
  const last = q.rows.at(-1);
  const text = typeof first?.question === "string" ? first.question.trim() : "";
  if (!first || !last || !text) return undefined;
  const rated = q.rows.findLast((r) => typeof r.feedback_good === "boolean");
  const logFeedback = rated?.feedback_good === true ? "good" : rated?.feedback_good === false ? "bad" : null;
  return {
    logId: String(first.id),
    askedAt: parseLogDate(first.date),
    question: maskPersonalData(text).slice(0, 1000),
    // What the visitor saw last: the retry's answer, or the reply that stood.
    answered: q.widget ? q.widget.answered : answeredFromLog(last, text),
    // The widget never rates through Agentic RAG, so its thumbs and the log's don't overlap.
    feedback: (q.widget?.feedback && THUMBS[q.widget.feedback]) || logFeedback,
    verdictSource: q.widget ? ("widget" as const) : ("log" as const),
    attempts: q.rows.length,
    // Where it was asked: the question event's origin, which doesn't depend on the answer's batch.
    origin: q.asked?.origin ?? q.widget?.origin ?? null,
  };
}
