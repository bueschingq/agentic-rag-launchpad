// Source links under an answer. Resource URLs come from crawled content, so only http(s)
// links ever reach the DOM.

import type { RetrievedResource } from "@launchpad/par-client/ask-stream";

export interface Source {
  title: string;
  href: string;
}

export function safeHref(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

// Cited resources in citation order; if nothing was cited, the retrieved ones. One link per URL.
export function sourcesFor(resources: Record<string, RetrievedResource>, citations: Record<string, unknown>, max = 3): Source[] {
  const cited = [...new Set(Object.keys(citations).map((key) => key.split("/")[0]!))];
  const ids = cited.length ? cited : Object.keys(resources);
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const id of ids) {
    const resource = resources[id];
    const href = safeHref(resource?.origin?.url);
    if (!resource || !href || seen.has(href)) continue;
    seen.add(href);
    out.push({ title: resource.title?.trim() || new URL(href).pathname, href });
    if (out.length === max) break;
  }
  return out;
}
