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

export async function fetchToken(baseUrl: string, deploymentId: string): Promise<PublicTokenResponse> {
  const res = await fetch(`${baseUrl}/api/public/deployments/${encodeURIComponent(deploymentId)}/token`, { method: "POST" });
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  return (await res.json()) as PublicTokenResponse;
}
