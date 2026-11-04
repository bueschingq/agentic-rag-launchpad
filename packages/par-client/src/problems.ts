// Provisioning failures in plain words: what happened, who can fix it, and whether Retry can
// help as things stand. Shared by the console (the deployment page) and the worker (alerts).

export type ProblemKind = "limit" | "key-rights" | "key-invalid" | "unreachable" | "timeout" | "other";

export interface ProvisioningProblem {
  kind: ProblemKind;
  // One sentence, then what to do.
  text: string;
  // Who acts: the partner's admin, Progress, or anyone (a retry).
  who: "admin" | "progress" | "anyone";
}

export function provisioningProblem(detail: string | undefined): ProvisioningProblem {
  const d = detail ?? "";
  if (/\b402\b|maximum number of Knowledge Boxes/i.test(d)) {
    return {
      kind: "limit",
      text: "The Agentic RAG account has no Knowledge Boxes left. Delete one you no longer use in the Agentic RAG dashboard (the console can't delete them yet), or ask Progress to raise the limit, then retry.",
      who: "progress",
    };
  }
  if (/\b403\b/.test(d)) {
    return {
      kind: "key-rights",
      text: "The account key the console uses isn't allowed to manage Knowledge Boxes. An admin needs a NUA key with Knowledge Box management, then retry.",
      who: "admin",
    };
  }
  if (/\b401\b|invalid (token|key)|unauthori[sz]ed/i.test(d)) {
    return {
      kind: "key-invalid",
      text: "Agentic RAG didn't accept the console's account key: it may have been revoked or mistyped. An admin needs to replace it, then retry.",
      who: "admin",
    };
  }
  if (/timed? ?out|timeout|aborted/i.test(d)) {
    return { kind: "timeout", text: "Agentic RAG took too long to answer. Retrying usually works.", who: "anyone" };
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|getaddrinfo|network/i.test(d)) {
    return {
      kind: "unreachable",
      text: "The console couldn't reach Agentic RAG. Check the console's network and the region, then retry.",
      who: "anyone",
    };
  }
  return { kind: "other", text: "Agentic RAG refused a step. See why below; retrying may work if it was temporary.", who: "anyone" };
}

// The alert's cause, for "one alert per cause": the same kind of failure on the same deployment
// is only sent once until it changes or clears.
export const problemCause = (p: ProvisioningProblem) => p.kind;

export const WHO_ACTS: Record<ProvisioningProblem["who"], string> = {
  admin: "Needs an admin",
  progress: "Needs Progress or an account change",
  anyone: "Anyone can retry",
};
