// Parses the NDJSON stream from POST /kb/{kb}/ask. Browser-safe: the widget imports this
// module directly, so it must not import anything Node-specific.
//
// Each line is {"item": {"type": …, …}}. Types seen in M0: answer, retrieval, status,
// augmented_context, citations, metadata, consumption.

export interface RetrievedResource {
  id: string;
  title?: string;
  origin?: { url?: string | null } | null;
  [key: string]: unknown;
}

export type AskStreamItem =
  | { type: "answer"; text: string }
  | { type: "citations"; citations: Record<string, [number, number][]> }
  | { type: "retrieval"; resources: Record<string, RetrievedResource>; raw: unknown }
  | { type: "status"; status: string; code?: string; details?: string | null }
  | { type: "metadata"; tokens?: Record<string, number>; timings?: Record<string, number> }
  | { type: "consumption"; raw: unknown }
  | { type: "error"; error: string }
  | { type: "other"; itemType: string; raw: unknown };

export async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield parseLine(line);
        newline = buffer.indexOf("\n");
      }
    }
    finished = true;
    const rest = buffer.trim();
    if (rest) yield parseLine(rest);
  } finally {
    // The consumer stopped early (closed panel, new question): stop downloading.
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new SyntaxError(`Malformed NDJSON line from /ask: ${line.slice(0, 120)}`);
  }
}

export function toStreamItem(raw: unknown): AskStreamItem {
  const item = ((raw as { item?: unknown })?.item ?? raw) as Record<string, unknown>;
  const type = typeof item?.type === "string" ? item.type : "";
  switch (type) {
    case "answer":
      return { type, text: typeof item.text === "string" ? item.text : "" };
    case "citations":
      return { type, citations: (item.citations ?? {}) as Record<string, [number, number][]> };
    case "retrieval": {
      const results = (item.results ?? {}) as { resources?: Record<string, RetrievedResource> };
      return { type, resources: results.resources ?? {}, raw: item.results };
    }
    case "status":
      return {
        type,
        status: String(item.status ?? ""),
        ...(item.code !== undefined && { code: String(item.code) }),
        details: (item.details as string | null | undefined) ?? null,
      };
    case "metadata":
      return {
        type,
        ...(item.tokens !== undefined && { tokens: item.tokens as Record<string, number> }),
        ...(item.timings !== undefined && { timings: item.timings as Record<string, number> }),
      };
    case "consumption":
      return { type, raw: item };
    case "error":
      return { type, error: String(item.error ?? "Unknown error") };
    default:
      return { type: "other", itemType: type, raw: item };
  }
}

export async function* readAskStream(body: ReadableStream<Uint8Array>): AsyncGenerator<AskStreamItem> {
  for await (const raw of readNdjson(body)) yield toStreamItem(raw);
}

export interface AskSummary {
  answer: string;
  citations: Record<string, [number, number][]>;
  resources: Record<string, RetrievedResource>;
  status?: string;
  error?: string;
}

export async function collectAsk(items: AsyncIterable<AskStreamItem>): Promise<AskSummary> {
  const summary: AskSummary = { answer: "", citations: {}, resources: {} };
  for await (const item of items) {
    if (item.type === "answer") summary.answer += item.text;
    else if (item.type === "citations") summary.citations = item.citations;
    else if (item.type === "retrieval") summary.resources = item.resources;
    else if (item.type === "status") summary.status = item.status;
    else if (item.type === "error") summary.error = item.error;
  }
  return summary;
}
