// Chat events. Every event is dispatched on the <arag-chat> element as `arag-chat:event` (it
// crosses the shadow root), and goes:
// - to the site's own Google Analytics when the deployment turns that on: gtag if the page
//   has it, else Tag Manager's dataLayer. Nothing here loads a script.
// - to the partner's console in batches (EventBatch), which builds the client report from
//   them. Only counts and flags go there. Each question also goes on its own as it's asked
//   (EventBatch.question), so the console knows which page it came from whatever happens next.
//
// The answer's `answered` is the shared verdict's (verdict.ts in @launchpad/theme): a reply that
// says the site lacks the information and gives nothing concrete ("declined") is false, as in
// validation and the report.
// Question and answer text are never part of an event, because visitors type personal details
// into chats. Each carries the conversation's id, so events can be counted per conversation.

import type { PublicWidgetConfig } from "@launchpad/theme";

export type ChatEvent =
  | "arag_chat_open"
  | "arag_chat_question"
  | "arag_chat_answer"
  | "arag_chat_source_click"
  | "arag_chat_cta_click"
  | "arag_chat_handoff_click"
  | "arag_chat_feedback"
  | "arag_chat_lead_submit";

export type EventParams = Record<string, string | number | boolean>;

export interface AnalyticsWindow {
  gtag?: (...args: unknown[]) => void;
  dataLayer?: unknown[];
}

export function track(
  target: EventTarget,
  config: Pick<PublicWidgetConfig, "deploymentId" | "settings">,
  name: ChatEvent,
  params: EventParams = {},
  win: AnalyticsWindow = globalThis as AnalyticsWindow,
): void {
  const fields = { deployment_id: config.deploymentId, ...params };
  target.dispatchEvent(new CustomEvent("arag-chat:event", { detail: { name, ...fields }, bubbles: true, composed: true }));

  const ga = config.settings.analytics;
  if (!ga?.googleAnalytics) return;
  try {
    if (typeof win.gtag === "function") win.gtag("event", name, { ...fields, ...(ga.measurementId && { send_to: ga.measurementId }) });
    else if (Array.isArray(win.dataLayer)) win.dataLayer.push({ event: name, ...fields });
  } catch {
    // The site's analytics failing must never break the chat.
  }
}

// What the console's events endpoint accepts: these events, with these parameters only.
const CONSOLE_EVENTS = new Set<string>([
  "arag_chat_open",
  "arag_chat_question",
  "arag_chat_answer",
  "arag_chat_cta_click",
  "arag_chat_handoff_click",
  "arag_chat_feedback",
  "arag_chat_lead_submit",
]);
// question_hash (questionHash() of the question, on answers and thumbs) lets the console match
// the widget's verdict to its question log. With the answer, attempts (2 when the widget asked
// again) and origin (the page's) let it count a retried question once and tell test traffic on
// a staging site apart. They go to the console only: never to GA, the dataLayer or the page's
// DOM event.
const CONSOLE_PARAMS = [
  "answered",
  "sources",
  "value",
  "cta_label",
  "contact_type",
  "placement",
  "language",
  "question_hash",
  "attempts",
  "origin",
  // An ask Agentic RAG refused because the partner's account is blocked (402): the console alerts.
  "blocked",
] as const;

export type ConsoleEvent = { name: string; conversation_id: string } & Partial<
  Record<(typeof CONSOLE_PARAMS)[number], string | number | boolean>
>;

export function consoleEvent(name: string, params: EventParams): ConsoleEvent | undefined {
  if (!CONSOLE_EVENTS.has(name) || typeof params.conversation_id !== "string") return undefined;
  const event: ConsoleEvent = { name, conversation_id: params.conversation_id };
  for (const key of CONSOLE_PARAMS) if (params[key] !== undefined) event[key] = params[key];
  return event;
}

export interface BatchTransport {
  // navigator.sendBeacon: survives the page unloading.
  beacon?: (url: string, body: string) => boolean;
  post: (url: string, body: string) => Promise<unknown>;
}

const defaultTransport = (): BatchTransport => ({
  beacon: typeof navigator.sendBeacon === "function" ? (url, body) => navigator.sendBeacon(url, body) : undefined,
  // text/plain is a "simple" request: no CORS preflight, like the beacon.
  post: (url, body) => fetch(url, { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } }),
});

// POST {console}/api/public/deployments/{id}/events, a few seconds after the first event or
// once enough have queued, and with the beacon when the visitor leaves the page.
//
// The question event goes on its own, as the question is asked: {"type":"question",
// "conversationId":…,"questionHash":…}, with keepalive, so the console has the page's origin
// before any answer, even when the tab closes a second after it and the batch is lost. Until that
// post has gone through it's kept, and the beacon takes it on pagehide (the console keeps one row
// per conversation and question, so twice is harmless).
export class EventBatch {
  readonly #url: string;
  readonly #transport: BatchTransport;
  readonly #delayMs: number;
  #queue: ConsoleEvent[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #asked = new Set<string>();

  constructor(url: string, transport: BatchTransport = defaultTransport(), delayMs = 5000) {
    this.#url = url;
    this.#transport = transport;
    this.#delayMs = delayMs;
  }

  add(event: ConsoleEvent) {
    this.#queue.push(event);
    if (this.#queue.length >= 20) this.flush();
    else this.#timer ??= setTimeout(() => this.flush(), this.#delayMs);
  }

  question(conversationId: string, questionHash: string) {
    const body = JSON.stringify({ type: "question", conversationId, questionHash });
    this.#asked.add(body);
    try {
      void this.#transport.post(this.#url, body).then(
        () => this.#asked.delete(body),
        () => {},
      );
    } catch {
      // Kept for the beacon.
    }
  }

  flush(leaving = false) {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    try {
      if (leaving) for (const body of this.#asked) if (this.#transport.beacon?.(this.#url, body)) this.#asked.delete(body);
      if (!this.#queue.length) return;
      const body = JSON.stringify({ events: this.#queue });
      this.#queue = [];
      if (leaving && this.#transport.beacon?.(this.#url, body)) return;
      void this.#transport.post(this.#url, body).catch(() => {});
    } catch {
      // Losing a few counts is better than breaking the page.
    }
  }
}

// A conversation's id: random, and kept with the conversation for the tab's lifetime.
export function newConversationId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
