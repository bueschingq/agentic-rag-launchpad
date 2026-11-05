// The counts the widget reports (POST /api/public/deployments/{id}/events), turned into daily
// rows for the client report, and its verdict on each answer it showed (answer_events), with
// thumbs on the same row. Only known events and one short breakdown per event are kept: never
// question or answer text, only a hash of the question. Pure, so it runs under node:test.
//
// Test traffic: chats on one of the deployment's staging domains, or on this machine
// (isStagingOrigin, the rule "Live on staging" goes by). Their question and answer events carry
// the origin, so the report sorts them at any time; their counts are kept under "test:" names, so
// the client's figures leave them out unless the report includes test traffic.
import { isStagingOrigin } from "./domain-rules.ts";
import { normaliseOrigin } from "./origin.ts";

export interface CountKey {
  name: string;
  dimension: string;
}

const MAX_EVENTS = 50;

// Which parameter breaks each event down in the report.
const DIMENSION: Record<string, (e: Record<string, unknown>) => string> = {
  arag_chat_open: () => "",
  arag_chat_question: (e) => short(e.language),
  arag_chat_answer: (e) => (e.answered === true ? "answered" : "unanswered"),
  arag_chat_cta_click: (e) => short(e.cta_label),
  arag_chat_handoff_click: (e) => short(e.contact_type),
  arag_chat_feedback: (e) => (e.value === "up" || e.value === "down" ? e.value : ""),
  arag_chat_lead_submit: () => "",
};

const short = (value: unknown) => (typeof value === "string" ? value.trim().slice(0, 60) : "");

// The body is text/plain JSON (so sendBeacon needs no CORS preflight): {"events":[…]}.
function eventsOf(body: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const events = (parsed as { events?: unknown })?.events;
  if (!Array.isArray(events)) return [];
  return events.slice(0, MAX_EVENTS).filter((e): e is Record<string, unknown> => !!e && typeof e === "object");
}

export function countsFromBody(body: string): Map<string, CountKey & { count: number }> {
  const counts = new Map<string, CountKey & { count: number }>();
  for (const e of eventsOf(body)) {
    const name = typeof e.name === "string" ? e.name : "";
    const dimensionOf = DIMENSION[name];
    if (!dimensionOf) continue;
    const dimension = dimensionOf(e);
    const key = `${name}\u0000${dimension}`;
    const found = counts.get(key);
    if (found) found.count += 1;
    else counts.set(key, { name, dimension, count: 1 });
  }
  return counts;
}

// One answer the widget showed (its verdict), or a visitor's thumbs on it. Matched to the
// question log by the hash of the question (questionHash in @launchpad/theme).
export type AnswerEvent =
  | {
      kind: "answer";
      conversationId: string;
      questionHash: string;
      answered: boolean;
      language: string | null;
      // Asks it took: 2 when the widget asked again after a reply with no answer.
      attempts: number;
    }
  | { kind: "feedback"; conversationId: string; questionHash: string; feedback: "up" | "down" };

// The widget asks at most twice; anything else is an older widget (1) or noise.
const MAX_ATTEMPTS = 2;

const HASH = /^[0-9a-f]{16}$/;
const CONVERSATION = /^[\w-]{1,64}$/;
const LANGUAGE = /^[a-z]{2}(-[A-Za-z]{2})?$/;

export function answerEventsFromBody(body: string): AnswerEvent[] {
  const out: AnswerEvent[] = [];
  for (const e of eventsOf(body)) {
    const conversationId = typeof e.conversation_id === "string" && CONVERSATION.test(e.conversation_id) ? e.conversation_id : "";
    const questionHash = typeof e.question_hash === "string" && HASH.test(e.question_hash) ? e.question_hash : "";
    if (!conversationId || !questionHash) continue;
    if (e.name === "arag_chat_answer" && typeof e.answered === "boolean") {
      const language = typeof e.language === "string" && LANGUAGE.test(e.language) ? e.language : null;
      const attempts = Number.isInteger(e.attempts) ? Math.min(Math.max(e.attempts as number, 1), MAX_ATTEMPTS) : 1;
      out.push({ kind: "answer", conversationId, questionHash, answered: e.answered, language, attempts });
    } else if (e.name === "arag_chat_feedback" && (e.value === "up" || e.value === "down")) {
      out.push({ kind: "feedback", conversationId, questionHash, feedback: e.value });
    }
  }
  return out;
}

// What a batch says about the Agentic RAG account: an ask refused because the account is blocked
// (the widget's answer event with `blocked`), or an answer that came back, which shows asks work
// again. Undefined when it says neither. lib/account-block.ts records it. Pure.
export function accountSignalFromBody(body: string): "blocked" | "answering" | undefined {
  const events = eventsOf(body).filter((e) => e.name === "arag_chat_answer");
  if (events.some((e) => e.blocked === true)) return "blocked";
  return answerEventsFromBody(body).some((e) => e.kind === "answer") ? "answering" : undefined;
}

// The widget's note that a question was asked, posted on its own as the question goes out (with
// keepalive, and again with the beacon if the page hides first), before any answer: the page
// origin it came from is then on record even when the answer's batch never arrives (a tab closed
// a second after the answer). The body is {"type":"question","conversationId":…,"questionHash":…}.
export interface QuestionEvent {
  conversationId: string;
  questionHash: string;
}

export function questionEventFromBody(body: string): QuestionEvent | undefined {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!e || typeof e !== "object" || e.type !== "question") return undefined;
  const { conversationId, questionHash } = e;
  if (typeof conversationId !== "string" || !CONVERSATION.test(conversationId)) return undefined;
  if (typeof questionHash !== "string" || !HASH.test(questionHash)) return undefined;
  return { conversationId, questionHash };
}

export const TEST_PREFIX = "test:";

// Whether a page origin is test traffic: a staging domain of the deployment (exact scheme, host
// and port) or a loopback address. Unknown (an older widget's event) counts for the client.
export function isTestOrigin(origin: string | null | undefined, stagingDomains: readonly string[]): boolean {
  const o = origin ? normaliseOrigin(origin) : undefined;
  return Boolean(
    o &&
      isStagingOrigin(
        o,
        stagingDomains.map((d) => normaliseOrigin(d) ?? d),
      ),
  );
}

// A daily count's name: as the widget sent it, or under "test:" for test traffic.
export const countName = (name: string, test: boolean) => (test ? `${TEST_PREFIX}${name}` : name);
