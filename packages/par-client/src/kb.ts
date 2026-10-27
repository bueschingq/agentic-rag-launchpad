// Knowledge Box–scoped calls, authenticated with one of that KB's service-account keys or an
// ephemeral token. Which role each call needs (all verified in M0 unless noted):
//   writer   createResource, getResource
//   manager  saveSearchConfig, activityMetrics, askLog, remiScores (NUA keys get 403 on analytics)
//   reader   ask, askStream, find, mintEphemeralToken; ephemeral tokens minted from it can ask/find, not write

import type { Aggregation } from "./account.ts";
import { type AskStreamItem, readAskStream } from "./ask-stream.ts";
import type { Credential } from "./credentials.ts";
import { apiDateTime, type FetchLike, requestJson, send, zoneApi } from "./http.ts";

export interface ResourceInput {
  slug?: string;
  title: string;
  // Shown as the citation link. Sitefinity's connector fills this as the "Original file path".
  originUrl?: string;
  text?: { body: string; format?: "PLAIN" | "MARKDOWN" | "HTML" | "RST" };
  link?: { uri: string; cssSelector?: string };
}

// /ask body in the API's own (snake_case) shape; anything not listed passes through.
export interface AskBody {
  query: string;
  search_configuration?: string;
  citations?: boolean | "default" | "llm_footnotes";
  top_k?: number;
  prompt?: string | { system?: string; user?: string };
  rag_strategies?: Record<string, unknown>[];
  chat_history?: { author: "USER" | "NUCLIA"; text: string }[];
  generative_model?: string;
  max_tokens?: number;
  show?: string[];
  audit_metadata?: Record<string, string>;
  [key: string]: unknown;
}

// A saved ask configuration: the same fields as AskBody, minus the question.
export type AskConfig = Omit<AskBody, "query" | "search_configuration">;

export interface AskResult {
  answer: string;
  status?: string;
  citations?: Record<string, [number, number][]>;
  retrieval_results?: { resources?: Record<string, unknown> };
  [key: string]: unknown;
}

export interface ActivityBucket {
  timestamp: string;
  search: number;
  chat: number;
  ask: number;
}

// One row of the ask activity log. `nuclia_tokens` is the per-question consumption that
// query-side cost is computed from.
export interface AskLogEntry {
  id: number;
  date: string;
  question?: string;
  answer?: string;
  model?: string;
  nuclia_tokens?: number;
  total_duration?: number;
  status?: number;
  feedback_good?: boolean | null;
  [key: string]: unknown;
}

export interface RemiBucket {
  timestamp: string;
  metrics: { name: "answer_relevance" | "context_relevance" | "groundedness" | string; min: number; max: number; average: number }[];
}

export class KbClient {
  readonly zone: string;
  readonly kbId: string;
  readonly #credential: Credential;
  readonly #fetch: FetchLike | undefined;

  constructor(opts: { zone: string; kbId: string; credential: Credential; fetch?: FetchLike }) {
    this.zone = opts.zone;
    this.kbId = opts.kbId;
    this.#credential = opts.credential;
    this.#fetch = opts.fetch;
  }

  get baseUrl(): string {
    return `${zoneApi(this.zone)}/kb/${this.kbId}`;
  }

  // ---- content (writer) ----

  createResource(input: ResourceInput): Promise<{ uuid: string }> {
    return requestJson<{ uuid: string }>(`${this.baseUrl}/resources`, {
      ...this.#opts(),
      body: {
        slug: input.slug,
        title: input.title,
        origin: input.originUrl ? { url: input.originUrl } : undefined,
        texts: input.text ? { body: { body: input.text.body, format: input.text.format ?? "PLAIN" } } : undefined,
        links: input.link ? { link: { uri: input.link.uri, css_selector: input.link.cssSelector } } : undefined,
      },
    });
  }

  getResource(rid: string, show: string[] = ["basic"]): Promise<{ id: string; title?: string; metadata?: { status?: string } }> {
    return requestJson(`${this.baseUrl}/resource/${rid}`, { ...this.#opts(), query: { show } });
  }

  // ---- configuration (manager) ----

  async saveSearchConfig(name: string, config: AskConfig): Promise<void> {
    await send(`${this.baseUrl}/search_configurations/${encodeURIComponent(name)}`, {
      ...this.#opts(),
      body: { kind: "ask", config: { query: "", ...config } },
    });
  }

  listSearchConfigs(): Promise<Record<string, { kind: string; config: AskConfig }>> {
    return requestJson(`${this.baseUrl}/search_configurations`, this.#opts());
  }

  // ---- answers (reader key or ephemeral token) ----

  ask(body: AskBody, opts: { signal?: AbortSignal } = {}): Promise<AskResult> {
    return requestJson<AskResult>(`${this.baseUrl}/ask`, {
      ...this.#opts(),
      body,
      headers: { "X-Synchronous": "true" },
      signal: opts.signal,
    });
  }

  async *askStream(body: AskBody, opts: { signal?: AbortSignal } = {}): AsyncGenerator<AskStreamItem> {
    const res = await send(`${this.baseUrl}/ask`, { ...this.#opts(), body, signal: opts.signal });
    if (!res.body) throw new Error("/ask returned no body to stream.");
    yield* readAskStream(res.body);
  }

  // A browser token scoped like the key that mints it. Use the reader key. Sent as ?eph-token=.
  async mintEphemeralToken(ttlSeconds: number): Promise<{ token: string; expiresAt: Date }> {
    if (this.#credential.kind !== "key") throw new Error("Ephemeral tokens are minted with a KB service-account key.");
    const res = await requestJson<{ token: string }>(`${zoneApi(this.zone)}/ephemeral_token`, {
      ...this.#opts(),
      body: { ttl: ttlSeconds },
    });
    return { token: res.token, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
  }

  // ---- analytics (manager) ----

  activityMetrics(q: { from: Date; to?: Date; aggregation?: Aggregation }): Promise<ActivityBucket[]> {
    return requestJson<ActivityBucket[]>(`${this.baseUrl}/activity/metrics`, {
      ...this.#opts(),
      query: { from: apiDateTime(q.from), to: q.to && apiDateTime(q.to), aggregation: q.aggregation ?? "day" },
    });
  }

  // NDJSON, one entry per question, oldest first within a page. `yearMonth` is "YYYY-MM";
  // page with `startingAfter` = the last id seen. Paging and the date filter follow the API
  // reference but were not exercised in M0.
  async askLog(q: { yearMonth: string; since?: Date; limit?: number; startingAfter?: number; show?: string[] | "all" }): Promise<AskLogEntry[]> {
    const res = await send(`${this.baseUrl}/activity/ask/query`, {
      ...this.#opts(),
      body: {
        year_month: q.yearMonth,
        show: q.show ?? ["id", "date", "question", "nuclia_tokens", "model", "total_duration", "status", "feedback_good"],
        filters: q.since ? { date: { ge: q.since.toISOString() } } : {},
        pagination: { limit: q.limit ?? 100, ...(q.startingAfter !== undefined && { starting_after: q.startingAfter }) },
      },
    });
    const text = await res.text();
    return text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as AskLogEntry);
  }

  remiScores(q: { from: Date; to?: Date; aggregation?: Aggregation }): Promise<RemiBucket[]> {
    return requestJson<RemiBucket[]>(`${this.baseUrl}/remi/scores`, {
      ...this.#opts(),
      query: { from: apiDateTime(q.from), to: q.to && apiDateTime(q.to), aggregation: q.aggregation ?? "day" },
    });
  }

  #opts() {
    return { credential: this.#credential, fetch: this.#fetch };
  }
}
