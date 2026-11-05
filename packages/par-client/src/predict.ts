// Agentic RAG's predict API: one model call with no retrieval, authenticated with the account's
// NUA key (no KB involved). The console's answer judge uses it (lib/judge.ts). Seen 2026-10-31:
// the body is the generated text followed by a status code ("…}0": 0 is success), and some
// deployments of the API stream NDJSON chunks instead ({"chunk":{"type":"text","text":…}}); both
// are read. temperature is accepted.

import { authHeaders } from "./credentials.ts";
import { type FetchLike, send, zoneApi } from "./http.ts";

export interface PredictChatBody {
  // The whole instruction and material: with retrieval off, the model reads only this.
  question: string;
  system?: string;
  user_id: string;
  retrieval?: boolean;
  query_context?: string[] | Record<string, string>;
  generative_model?: string;
  max_tokens?: number;
  [key: string]: unknown;
}

export interface PredictChatResult {
  text: string;
  // The status code the plain-text form ends with: "0" success, "-1" error, "-2" no context.
  status?: string;
  // The model that answered, when the stream says.
  model?: string;
}

// The generated text from /predict/chat: NDJSON chunks, or plain text ending in a status code.
export function predictText(body: string): PredictChatResult {
  let text = "";
  let model: string | undefined;
  let chunks = 0;
  for (const line of body.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const j = JSON.parse(line) as { chunk?: { type?: string; text?: string; model?: string } };
      if (!j.chunk) continue;
      chunks++;
      if (j.chunk.type === "text") text += j.chunk.text ?? "";
      model ??= j.chunk.model;
    } catch {
      // not a chunk line
    }
  }
  if (chunks) return { text, ...(model && { model }) };
  // Plain text: the status code is the last thing, straight after the text.
  const m = body.match(/^([\s\S]*?)(-?[0-9])\s*$/);
  return m && !/[0-9]$/.test(m[1] ?? "") ? { text: m[1] ?? "", status: m[2] } : { text: body };
}

export async function predictChat(opts: {
  zone: string;
  nuaKey: string;
  body: PredictChatBody;
  signal?: AbortSignal;
  fetch?: FetchLike;
}): Promise<PredictChatResult> {
  const res = await send(`${zoneApi(opts.zone)}/predict/chat`, {
    body: { retrieval: false, query_context: [], ...opts.body },
    headers: authHeaders({ kind: "nua", token: opts.nuaKey }),
    signal: opts.signal,
    fetch: opts.fetch,
  });
  return predictText(await res.text());
}
