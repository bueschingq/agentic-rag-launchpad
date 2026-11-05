// One ephemeral token per chat session (DESIGN.md §4a), fetched from the partner's console
// and refreshed shortly before it expires or when Agentic RAG rejects it.

import type { PublicTokenResponse } from "@launchpad/theme";

const REFRESH_MARGIN_MS = 30_000;

export class TokenSession {
  readonly #fetchToken: () => Promise<PublicTokenResponse>;
  readonly #now: () => number;
  #current: { value: PublicTokenResponse; expires: number } | undefined;
  #pending: Promise<PublicTokenResponse> | undefined;

  constructor(fetchToken: () => Promise<PublicTokenResponse>, now: () => number = Date.now) {
    this.#fetchToken = fetchToken;
    this.#now = now;
  }

  get(): Promise<PublicTokenResponse> {
    if (this.#current && this.#current.expires - REFRESH_MARGIN_MS > this.#now()) return Promise.resolve(this.#current.value);
    // Questions asked while a refresh is in flight share it.
    this.#pending ??= this.#fetchToken()
      .then((value) => {
        this.#current = { value, expires: this.#now() + value.expiresIn * 1000 };
        return value;
      })
      .finally(() => {
        this.#pending = undefined;
      });
    return this.#pending;
  }

  // After a 401/403 from Agentic RAG: the next get() fetches a fresh token.
  invalidate(): void {
    this.#current = undefined;
  }
}

// Whether the chat may answer: Pause (or the customer's budget stop) has to reach chats already
// open, whose token lasts 15 minutes. Before a question, when the last word is over 30 seconds
// old, GET {console}/api/public/deployments/{id}/status → { online }. A failed check doesn't
// stop the chat: only the console saying "offline" does. A chat showing its offline message
// asks sooner (maxAgeMs), so Resume reaches it too.
export class StatusCheck {
  readonly #check: () => Promise<boolean>;
  readonly #now: () => number;
  readonly #maxAgeMs: number;
  #online: boolean;
  #checked: number;

  constructor(online: boolean, check: () => Promise<boolean>, now: () => number = Date.now, maxAgeMs = 30_000) {
    this.#online = online;
    this.#check = check;
    this.#now = now;
    this.#maxAgeMs = maxAgeMs;
    this.#checked = now();
  }

  async online(maxAgeMs = this.#maxAgeMs): Promise<boolean> {
    if (this.#now() - this.#checked <= maxAgeMs) return this.#online;
    this.#online = await this.#check().catch(() => this.#online);
    this.#checked = this.#now();
    return this.#online;
  }
}

export async function fetchOnline(baseUrl: string, deploymentId: string): Promise<boolean> {
  const res = await fetch(`${baseUrl}/api/public/deployments/${encodeURIComponent(deploymentId)}/status`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return true;
  return ((await res.json()) as { online?: unknown }).online !== false;
}

// Agentic RAG turned this page's origin away: the console allows it (it served the config and
// the token), but the KB's domain lock doesn't list it yet, which takes up to a few minutes
// after the domains change. The chat says "Almost ready" rather than "Something went wrong".
export class LockPending extends Error {}

// Whether a failed ask was Agentic RAG refusing the origin. A browser that may not read the
// answer fails the request like a dropped connection; if an opaque request to the same
// address gets through, Agentic RAG is up and it was the origin. A request the page's Content
// Security Policy blocks fails here too, so that stays a failure.
export async function originRefused(askUrl: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    await fetchImpl(askUrl, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

// The chat can't answer for now: the console says it's unavailable (503: paused, over budget, or
// the partner's Agentic RAG account blocked), or Agentic RAG refuses the ask with 402 (the account
// blocked for budget, round 6). The chat shows its offline message rather than "Something went
// wrong". `blocked`: Agentic RAG's refusal, which the console hears about.
export class Unavailable extends Error {
  readonly blocked: boolean;
  constructor(blocked = false) {
    super(blocked ? "Agentic RAG refused the ask (402)" : "Unavailable");
    this.blocked = blocked;
  }
}

export async function fetchToken(baseUrl: string, deploymentId: string): Promise<PublicTokenResponse> {
  const res = await fetch(`${baseUrl}/api/public/deployments/${encodeURIComponent(deploymentId)}/token`, { method: "POST" });
  if (res.status === 503) throw new Unavailable();
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  return (await res.json()) as PublicTokenResponse;
}
