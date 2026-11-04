// A refused ask isn't an answer (fix cycle 7d). During a budget block the automatic re-run read every
// 402 as "no answer": it took starter questions off signed-off live chats and opened answers, and a
// new onboarding's Review said "0 answered". Anything Agentic RAG fails to answer (402, 5xx, a
// timeout, no connection) is a Refusal: a run that meets one stops, changes nothing, and is tried
// again later. The words a person reads are here too, with no raw request and no account id.
// Pure, so client components can read it as well.

export type Refusal =
  // The account is blocked: `state` is what Agentic RAG names ("BUDGET").
  | { kind: "block"; state: string }
  // Its server failed (5xx, or a 200 whose status says error).
  | { kind: "server"; status?: number }
  | { kind: "timeout" }
  // It couldn't be reached.
  | { kind: "unreachable" }
  // Anything else that stopped the ask: a 4xx, or a fault of ours while judging it.
  | { kind: "other"; status?: number };

// Why the account is blocked, in a sentence. Pure.
export const blockSentence = (state: string): string =>
  state === "BUDGET"
    ? "Agentic RAG has stopped answering for this account because of its budget."
    : "Agentic RAG has stopped answering for this account because the account is blocked.";

// Who can do something about it.
export const BLOCK_FIX =
  "Whoever holds the Agentic RAG account can lift it there; everything is checked again by itself once answers work.";

// What a person reads on a run the block stopped. Pure.
export const blockNotice = (state: string): string =>
  `${blockSentence(state)} Answers weren't checked and nothing was changed. ${BLOCK_FIX}`;

// Why sign-off is unavailable during a block. Pure.
export const blockSignOffNote = (state: string): string =>
  `Sign-off isn't available right now. ${blockSentence(state)} Answers can't be checked until it's lifted. ${BLOCK_FIX}`;

// The words for any refusal. Pure.
export function refusalText(r: Refusal): string {
  if (r.kind === "block") return blockNotice(r.state);
  const what =
    r.kind === "timeout"
      ? "Agentic RAG didn't answer in time."
      : r.kind === "server"
        ? "Agentic RAG reported a server error."
        : r.kind === "unreachable"
          ? "Agentic RAG couldn't be reached."
          : `Agentic RAG couldn't take this ask${r.status ? ` (status ${r.status})` : ""}.`;
  return `${what} Answers weren't checked and nothing was changed. It's tried again later.`;
}

// What's thrown out of askPhase (lib/validation.ts) when there is no answer to judge: every path that
// asks gets this rather than an empty answer, so a new path can't read it as "no answer".
export class AskRefused extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(refusalText(refusal));
    this.name = "AskRefused";
    this.refusal = refusal;
  }
}

// The blocking state an error from Agentic RAG names ("BUDGET"), or undefined when it isn't the
// account being blocked. A 402 is a block whatever its wording. Pure.
export function accountBlockState(err: unknown): string | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  const text = [
    err instanceof Error ? err.message : typeof err === "string" ? err : "",
    JSON.stringify((err as { detail?: unknown } | null)?.detail ?? ""),
  ].join(" ");
  const named = /AccountBlockingState\.([A-Z_]+)/.exec(text)?.[1];
  if (named) return named;
  // ParError's message reads "POST host/path → 402: …"; the widget's "/ask returned 402".
  return status === 402 || /(?:→|returned) 402\b/.test(err instanceof Error ? err.message : "") ? "BUDGET" : undefined;
}

// What an error from an ask means. Pure.
export function refusalOf(err: unknown): Refusal {
  if (err instanceof AskRefused) return err.refusal;
  const state = accountBlockState(err);
  if (state) return { kind: "block", state };
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "TimeoutError" || name === "AbortError" || /no answer within/.test(message)) return { kind: "timeout" };
  const given = (err as { status?: unknown } | null)?.status;
  const status = typeof given === "number" ? given : Number(/→ (\d{3})\b/.exec(message)?.[1] ?? Number.NaN);
  if (status >= 500) return { kind: "server", status };
  if (status >= 400) return { kind: "other", status };
  if (/fetch failed|ECONNRE|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket|network/i.test(message)) return { kind: "unreachable" };
  return { kind: "other" };
}

// Whether it's Agentic RAG's own failure, not a question it can't take: never read as anything about
// the question, and a fallback ask doesn't paper over it. Pure.
export const serviceFailure = (r: Refusal): boolean => r.kind !== "other";

// Whether a 200 from /ask carries no answer because the ask failed. Pure.
export const failedReply = (result: { status?: unknown }): boolean => result.status === "error";

// A stored failure as a person reads it: runs saved before this fix hold the raw call
// ("Agentic RAG didn't answer: POST host/api/v1/kb/…/ask → 402: Access denied, as account …").
// Any other failure comes back as it is. Pure.
const RAW_REFUSAL = "Agentic RAG didn't answer";
export const isRefusalFailure = (failure: string | undefined): boolean => Boolean(failure?.includes(RAW_REFUSAL));
export function plainFailure(failure: string): string {
  if (!isRefusalFailure(failure)) return failure;
  return failure
    .split("; ")
    .map((part) =>
      part.includes(RAW_REFUSAL)
        ? `This question wasn't checked. ${refusalText(refusalOf(new Error(part.slice(part.indexOf(RAW_REFUSAL) + RAW_REFUSAL.length))))}`
        : part,
    )
    .join("; ");
}
