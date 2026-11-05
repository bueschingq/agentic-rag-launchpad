// POST: counts from the widget (chat opened, questions, answered or not, CTA and handoff clicks,
// thumbs, leads) for the client report, and the widget's verdict on each answer, with thumbs on
// the same row (answer_events). No text: see lib/widget-events.ts. text/plain bodies, so the
// widget's sendBeacon needs no preflight; only the deployment's own domains count. Each answer
// keeps how many asks it took and the page's origin, so the worker counts a retried question
// once and the report tells test traffic from a staging domain apart.
//
// Also the question event, posted on its own as each question is asked (question_events): the
// page origin the browser sent, recorded before any answer, so a question whose answer event is
// lost (a tab closed a second after the answer) is still sorted as test traffic or not.

import { answerEvents, questionEvents, widgetEventsDaily } from "@launchpad/db";
import { sql } from "drizzle-orm";
import { recordAccountBlock, recordAccountClear } from "@/lib/account-block.ts";
import { db } from "@/lib/db.ts";
import { clientIp, corsHeaders, findDeployment, isAllowedOrigin, RateLimiter } from "@/lib/public-api.ts";
import {
  accountSignalFromBody,
  answerEventsFromBody,
  countName,
  countsFromBody,
  isTestOrigin,
  questionEventFromBody,
} from "@/lib/widget-events.ts";

type Params = { params: Promise<{ id: string }> };

// A visitor sends a batch every few seconds at most; this leaves room for several tabs.
const limiter = new RateLimiter(30, 60_000);
// One question event per question asked, on a limit of its own so batches never crowd it out.
const questionLimiter = new RateLimiter(30, 60_000);

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const origin = request.headers.get("origin");
  const row = await findDeployment(id);
  if (!row || !isAllowedOrigin(origin, row.deployment.domains)) return new Response(null, { status: 204 });
  const cors = corsHeaders(origin);
  const body = (await request.text()).slice(0, 32_000);

  const asked = questionEventFromBody(body);
  if (asked) {
    if (!questionLimiter.allow(`${id}:${clientIp(request.headers)}`)) return new Response(null, { status: 429, headers: cors });
    // Asked again in the same conversation: one row, with the latest time and origin.
    await db()
      .insert(questionEvents)
      .values({ deploymentId: id, conversationId: asked.conversationId, questionHash: asked.questionHash, origin })
      .onConflictDoUpdate({
        target: [questionEvents.deploymentId, questionEvents.conversationId, questionEvents.questionHash],
        set: { origin, at: new Date() },
      });
    return new Response(null, { status: 204, headers: cors });
  }

  if (!limiter.allow(`${id}:${clientIp(request.headers)}`)) return new Response(null, { status: 429, headers: cors });
  const day = new Date().toISOString().slice(0, 10);
  const test = isTestOrigin(origin, row.deployment.stagingDomains);
  for (const c of countsFromBody(body).values()) {
    await db()
      .insert(widgetEventsDaily)
      .values({ deploymentId: id, day, name: countName(c.name, test), dimension: c.dimension, count: c.count })
      .onConflictDoUpdate({
        target: [widgetEventsDaily.deploymentId, widgetEventsDaily.day, widgetEventsDaily.name, widgetEventsDaily.dimension],
        set: { count: sql`${widgetEventsDaily.count} + ${c.count}` },
      });
  }
  // The same question asked again in a conversation keeps one row, with the latest verdict.
  // Thumbs only show under an answer, so a thumb that arrives first records it as answered.
  // The origin is the page's, as the browser sent it and the domains check above accepted it.
  const key = { deploymentId: id };
  const target = [answerEvents.deploymentId, answerEvents.conversationId, answerEvents.questionHash];
  for (const e of answerEventsFromBody(body)) {
    const row = { ...key, conversationId: e.conversationId, questionHash: e.questionHash };
    if (e.kind === "answer")
      await db()
        .insert(answerEvents)
        .values({ ...row, answered: e.answered, language: e.language, attempts: e.attempts, origin })
        .onConflictDoUpdate({ target, set: { answered: e.answered, language: e.language, attempts: e.attempts, origin, at: new Date() } });
    else
      await db()
        .insert(answerEvents)
        .values({ ...row, answered: true, feedback: e.feedback, origin })
        .onConflictDoUpdate({ target, set: { feedback: e.feedback } });
  }
  // The widget saw the account blocked, or answers working again: recorded once each (lib/account-block.ts).
  const account = accountSignalFromBody(body);
  if (account === "blocked") await recordAccountBlock(db(), "BUDGET", "widget").catch(() => false);
  else if (account === "answering") await recordAccountClear(db(), "widget").catch(() => false);
  return new Response(null, { status: 204, headers: cors });
}

export async function OPTIONS(request: Request, { params }: Params) {
  const { id } = await params;
  const origin = request.headers.get("origin");
  const row = await findDeployment(id);
  if (!row || !isAllowedOrigin(origin, row.deployment.domains)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}
