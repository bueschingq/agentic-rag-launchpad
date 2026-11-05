// Loads a deployment's config from the partner's console. When that fails, the widget renders
// nothing on the client's page, so it says why in one console.error that names the cause:
// the console refusing this page's origin, the page's Content Security Policy blocking the
// request, or the console being unreachable.

import type { PublicWidgetConfig } from "@launchpad/theme";

export type ConfigFailure =
  | { cause: "origin"; origin: string }
  | { cause: "not-found" }
  // Either of the two above: the console refused without saying which.
  | { cause: "refused"; origin: string }
  | { cause: "csp"; directive: string }
  | { cause: "unreachable" }
  | { cause: "status"; status: number };

export function explain(failure: ConfigFailure, base: string, deployment: string): string {
  const intro = `[arag-chat] The chat for deployment ${deployment} isn't showing:`;
  switch (failure.cause) {
    case "origin":
      return `${intro} the console at ${base} doesn't allow this page's origin, ${failure.origin}. Add it to the deployment's allowed domains in the console (www and non-www are different domains).`;
    case "not-found":
      return `${intro} the console at ${base} has no live deployment with that id. Check the snippet's data-deployment.`;
    case "refused":
      return `${intro} the console at ${base} refused the request. Most likely this page's origin, ${failure.origin}, isn't one of the deployment's allowed domains (www and non-www are different domains); otherwise check the snippet's data-deployment.`;
    case "csp":
      // Answers stream from Agentic RAG's region, which only the config names: the install
      // guide lists both, so one change to the directive covers them.
      return `${intro} this page's Content Security Policy blocked the request to ${base}. Add ${base} to its ${failure.directive} directive${
        failure.directive === "connect-src"
          ? ", with the Agentic RAG address the install guide's CSP entries list, which answers stream from"
          : ""
      }.`;
    case "unreachable":
      return `${intro} the console at ${base} couldn't be reached. Check the snippet's address and that the console is online.`;
    case "status":
      return `${intro} the console at ${base} answered ${failure.status}.`;
  }
}

export interface LoadDeps {
  fetch: typeof fetch;
  // Where Content Security Policy violations are reported (the page's document).
  events?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  origin: string;
}

// Until a person signs the chat off in the console, its config is { published: false }: the
// widget shows nothing, and says so once.
export const UNPUBLISHED = "[arag-chat] This chat isn't published yet: it shows once it's signed off in the console.";

export async function loadConfig(
  base: string,
  deployment: string,
  deps: LoadDeps = { fetch: globalThis.fetch.bind(globalThis), events: document, origin: location.origin },
): Promise<{ config: PublicWidgetConfig } | { failure: ConfigFailure } | { unpublished: true }> {
  const url = `${base}/api/public/deployments/${encodeURIComponent(deployment)}/config`;
  let blocked: string | undefined;
  const onViolation = (e: Event) => {
    const v = e as SecurityPolicyViolationEvent;
    if (v.blockedURI?.startsWith(base)) blocked = v.effectiveDirective || "connect-src";
  };
  deps.events?.addEventListener("securitypolicyviolation", onViolation);
  try {
    const res = await deps.fetch(url);
    if (res.ok) {
      const body = (await res.json()) as PublicWidgetConfig | { published: false };
      return "published" in body && body.published === false ? { unpublished: true } : { config: body as PublicWidgetConfig };
    }
    // Readable only when the console sends CORS headers with its refusals.
    if (res.status === 403) return { failure: { cause: "origin", origin: deps.origin } };
    if (res.status === 404) return { failure: { cause: "not-found" } };
    return { failure: { cause: "status", status: res.status } };
  } catch {
    // The violation event can trail the failed fetch by a task.
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (blocked) return { failure: { cause: "csp", directive: blocked } };
    // A refusal without CORS headers looks like a network error from here. If an opaque
    // request gets through, the console is up and turned this origin away.
    try {
      await deps.fetch(url, { mode: "no-cors", cache: "no-store" });
      return { failure: { cause: "refused", origin: deps.origin } };
    } catch {
      return { failure: blocked ? { cause: "csp", directive: blocked } : { cause: "unreachable" } };
    }
  } finally {
    deps.events?.removeEventListener("securitypolicyviolation", onViolation);
  }
}
