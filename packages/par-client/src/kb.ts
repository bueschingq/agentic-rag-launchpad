// Knowledge Box–scoped calls, authenticated with one of that KB's service-account keys or an
// ephemeral token. Which role each call needs (all verified in M0 unless noted):
//   writer   createResource, putTextResource, deleteResourceBySlug, getResource
//   manager  saveSearchConfig, activityMetrics, askLog, remiScores (NUA keys get 403 on analytics)
//   reader   ask, askStream, find, mintEphemeralToken; ephemeral tokens minted from it can ask/find, not write

import type { Aggregation } from "./account.ts";
import { type AskStreamItem, readAskStream } from "./ask-stream.ts";
import type { Credential } from "./credentials.ts";
import { ParError } from "./errors.ts";
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
  resources_count?: number;
  client_type?: string;
  [key: string]: unknown;
}

export interface RemiBucket {
  timestamp: string;
  metrics: { name: "answer_relevance" | "context_relevance" | "groundedness" | string; min: number; max: number; average: number }[];
}

export interface AskOptions {
  signal?: AbortSignal;
  // A question asked by partner staff (preview, validation, prompt tests), not a visitor. The
  // question log records it with client_type "dashboard" (verified 2026-10-30), so usage,
  // cost and reports can leave it out.
  partnerTest?: boolean;
}

const clientHeader = (opts: AskOptions): Record<string, string> => (opts.partnerTest ? { "X-NDB-CLIENT": "dashboard" } : {});

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

  // A synced page: created under its slug, or, when the slug exists (409), its title, origin and
  // text replaced, which reprocesses it. Returns the resource id when it was created.
  // labels: the page's classifications (usermetadata.classifications), which /ask's
  // filter_expression filters on ({ field: { prop: "label", labelset, label } }); always sent, so
  // a page that loses a label loses it in the Knowledge Box too. metadata: extra.metadata, kept
  // with the resource and never indexed as text. Should Agentic RAG refuse the labels or the
  // metadata (400 or 422), the page is sent once more without them (labelled: false), so a
  // sync never stops over its labels.
  async putTextResource(input: {
    slug: string;
    title: string;
    originUrl: string;
    body: string;
    format?: "PLAIN" | "MARKDOWN" | "HTML";
    labels?: readonly { labelset: string; label: string }[];
    metadata?: Record<string, unknown>;
  }): Promise<{ uuid?: string; created: boolean; labelled: boolean }> {
    const text = { body: input.body, format: input.format ?? "MARKDOWN" };
    const labelled = {
      usermetadata: { classifications: (input.labels ?? []).map((l) => ({ labelset: l.labelset, label: l.label })) },
      ...(input.metadata && { extra: { metadata: input.metadata } }),
    };
    const put = async (more: Record<string, unknown>): Promise<{ uuid?: string; created: boolean }> => {
      try {
        const { uuid } = await requestJson<{ uuid: string }>(`${this.baseUrl}/resources`, {
          ...this.#opts(),
          body: { slug: input.slug, title: input.title, origin: { url: input.originUrl }, texts: { body: text }, ...more },
        });
        return { uuid, created: true };
      } catch (err) {
        if (!(err instanceof ParError && err.status === 409)) throw err;
      }
      const res = await send(`${this.baseUrl}/slug/${encodeURIComponent(input.slug)}`, {
        ...this.#opts(),
        method: "PATCH",
        body: { title: input.title, origin: { url: input.originUrl }, texts: { body: text }, ...more },
      });
      await res.body?.cancel();
      return { created: false };
    };
    try {
      return { ...(await put(labelled)), labelled: true };
    } catch (err) {
      if (!(err instanceof ParError && (err.status === 400 || err.status === 422))) throw err;
      return { ...(await put({})), labelled: false };
    }
  }

  // A page that left the site. Gone already counts as done.
  async deleteResourceBySlug(slug: string): Promise<void> {
    try {
      const res = await send(`${this.baseUrl}/slug/${encodeURIComponent(slug)}`, { ...this.#opts(), method: "DELETE" });
      await res.body?.cancel();
    } catch (err) {
      if (!(err instanceof ParError && err.status === 404)) throw err;
    }
  }

  // How much the KB holds, whatever put it there (sync, Sitefinity's connector, the dashboard).
  counters(): Promise<{ resources: number; paragraphs: number; fields: number; sentences: number }> {
    return requestJson(`${this.baseUrl}/counters`, this.#opts());
  }

  // Processing status lives in metadata.status: PENDING, PROCESSED or ERROR.
  getResourceBySlug(slug: string): Promise<{ id: string; title?: string; metadata?: { status?: string } }> {
    return requestJson(`${this.baseUrl}/slug/${encodeURIComponent(slug)}`, { ...this.#opts(), query: { show: ["basic"] } });
  }

  getResource(rid: string, show: string[] = ["basic"]): Promise<{ id: string; title?: string; metadata?: { status?: string } }> {
    return requestJson(`${this.baseUrl}/resource/${rid}`, { ...this.#opts(), query: { show } });
  }

  // ---- configuration (manager) ----

  // Creates the configuration, or replaces it: POST answers 409 once it exists, and PATCH
  // then overwrites it (verified 2026-10-29).
  async saveSearchConfig(name: string, config: AskConfig): Promise<void> {
    const url = `${this.baseUrl}/search_configurations/${encodeURIComponent(name)}`;
    const body = { kind: "ask", config: { query: "", ...config } };
    try {
      await send(url, { ...this.#opts(), body });
    } catch (err) {
      if (!(err instanceof ParError && err.status === 409)) throw err;
      await send(url, { ...this.#opts(), method: "PATCH", body });
    }
  }

  listSearchConfigs(): Promise<Record<string, { kind: string; config: AskConfig }>> {
    return requestJson(`${this.baseUrl}/search_configurations`, this.#opts());
  }

  // ---- answers (reader key or ephemeral token) ----

  ask(body: AskBody, opts: AskOptions = {}): Promise<AskResult> {
    return requestJson<AskResult>(`${this.baseUrl}/ask`, {
      ...this.#opts(),
      body,
      headers: { "X-Synchronous": "true", ...clientHeader(opts) },
      signal: opts.signal,
    });
  }

  async *askStream(body: AskBody, opts: AskOptions = {}): AsyncGenerator<AskStreamItem> {
    yield* readAskStream(await this.askRaw(body, opts));
  }

  // The NDJSON answer stream as bytes, for relaying unchanged (the console's widget preview).
  async askRaw(body: AskBody, opts: AskOptions = {}): Promise<ReadableStream<Uint8Array>> {
    const res = await send(`${this.baseUrl}/ask`, { ...this.#opts(), body, headers: clientHeader(opts), signal: opts.signal });
    if (!res.body) throw new Error("/ask returned no body to stream.");
    return res.body;
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
  // page with `startingAfter` = the last id seen. The date filter must fall inside `yearMonth`
  // (422 otherwise) and takes a zone-less timestamp: a trailing "Z" is a 500.
  async askLog(q: {
    yearMonth: string;
    since?: Date;
    limit?: number;
    startingAfter?: number;
    show?: string[] | "all";
  }): Promise<AskLogEntry[]> {
    const res = await send(`${this.baseUrl}/activity/ask/query`, {
      ...this.#opts(),
      body: {
        year_month: q.yearMonth,
        show: q.show ?? ["id", "date", "question", "nuclia_tokens", "model", "total_duration", "status", "feedback_good"],
        filters: q.since ? { date: { ge: apiDateTime(q.since) } } : {},
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
