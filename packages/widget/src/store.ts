// The conversation, kept for the tab so it survives the visitor following a link to another
// page of the site. sessionStorage only: no cookies, nothing shared between tabs, and gone
// when the tab closes. Storage can be full or blocked, so every call may quietly do nothing.

import type { Source } from "./sources.ts";

export type Turn = { author: "USER" | "NUCLIA"; text: string };

// A finished reply, enough to show it again: the answer's text (markdown), whether it counted
// as answered, its source links and the visitor's thumbs. toTeam: an answer to check (very short,
// or its pages don't match the question) that tells the visitor to contact the team, so it gets
// the handoff card as a no-answer does. priced: a price reply that contradicted the confirmed
// price table, replaced with its rows (prices.ts), shown with the pricing or quote button.
export interface StoredReply {
  question: string;
  answer: string;
  answered: boolean;
  sources: Source[];
  vote?: "up" | "down";
  toTeam?: boolean;
  priced?: boolean;
  // The pricing page a replaced reply's rows come from, for its link when sources are hidden.
  pricingPage?: { title: string; href: string };
}

export interface Conversation {
  id: string;
  replies: StoredReply[];
  history: Turn[];
  // Floating panel left open: reopen it on the next page.
  open: boolean;
}

const MAX_REPLIES = 20;
const MAX_TEXT = 4000;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const session = (): StorageLike | undefined => {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined; // blocked, e.g. in a sandboxed frame
  }
};

export class ConversationStore {
  readonly #key: string;
  readonly #storage: StorageLike | undefined;

  constructor(deploymentId: string, storage: StorageLike | undefined = session()) {
    this.#key = `arag-chat:${deploymentId}`;
    this.#storage = storage;
  }

  load(): Conversation | undefined {
    try {
      const raw = JSON.parse(this.#storage?.getItem(this.#key) ?? "null") as Partial<Conversation> | null;
      if (!raw || typeof raw.id !== "string" || !Array.isArray(raw.replies) || !Array.isArray(raw.history)) return undefined;
      return { id: raw.id, replies: raw.replies, history: raw.history, open: raw.open === true };
    } catch {
      return undefined;
    }
  }

  save(conversation: Conversation): void {
    const clip = (text: string) => text.slice(0, MAX_TEXT);
    const kept: Conversation = {
      ...conversation,
      replies: conversation.replies
        .slice(-MAX_REPLIES)
        .map((r) => ({ ...r, question: clip(r.question), answer: clip(r.answer), sources: r.sources.slice(0, 3) })),
      history: conversation.history.map((t) => ({ ...t, text: clip(t.text) })),
    };
    try {
      this.#storage?.setItem(this.#key, JSON.stringify(kept));
    } catch {
      // Full or blocked: the conversation just won't follow the visitor.
    }
  }
}
