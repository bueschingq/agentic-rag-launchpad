// Live answers for the configurator's preview. The KB only accepts browsers on the customer's
// own domains, so the console asks on the preview's behalf, with the deployment's saved search
// configuration and citations (as the widget does), and relays the answer stream unchanged.
// Each question is marked as a partner test, so the usage and report roll-ups leave it out.
//
// The widget decides how to ask, as on the site: of one language's pages first where the KB
// holds several, an intent question with its intent's configuration and of its pages, then once
// more with the deployment's own configuration, of every page and without the conversation. What
// it sends is passed on rebuilt from its parts alone: the language, one of this deployment's
// intent configurations (never another name), and the intent's key pages by resource id.

import { KbClient } from "@launchpad/par-client";
import { intentConfigName, isLanguage, type Language, languageFilter, NOT_GENERATED, ROUTE_INTENTS } from "@launchpad/theme";
import { labelFilter } from "@/lib/content-plan.ts";
import { searchConfigName } from "@/lib/prompt.ts";
import { loadWidgetPage, previewKey } from "@/lib/widget.ts";

type Term = { prop?: unknown; language?: unknown; id?: unknown; and?: unknown; or?: unknown };
const RESOURCE_ID = /^[0-9a-f]{32}$/;

// The language and resource ids in the widget's filter: { field: language }, { field: intent's
// pages }, or { field: { and: [language, intent's pages] } } (packages/widget/src/route.ts).
function filterParts(field: Term | undefined): { language?: Language; resources: string[] } {
  const terms = (Array.isArray(field?.and) ? field.and : field ? [field] : []) as Term[];
  const flat = terms.flatMap((t) => (Array.isArray(t?.or) ? (t.or as Term[]) : [t]));
  const language = flat.find((t) => t?.prop === "language" && isLanguage(t.language))?.language as Language | undefined;
  const resources = flat.flatMap((t) => (t?.prop === "resource" && typeof t.id === "string" && RESOURCE_ID.test(t.id) ? [t.id] : []));
  return { ...(language && { language }), resources };
}

type Params = { params: Promise<{ id: string; deploymentId: string }> };

const MAX_QUESTION = 2000;
const MAX_HISTORY = 20;

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request, { params }: Params) {
  const { id, deploymentId } = await params;
  const page = await loadWidgetPage(id, deploymentId);
  const kbId = page?.deployment.kbId;
  if (!page || !kbId) return json({ error: "Not found" }, 404);

  const body = (await request.json().catch(() => undefined)) as
    | { query?: unknown; chat_history?: unknown; search_configuration?: unknown; filter_expression?: { field?: Term } }
    | undefined;
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query || query.length > MAX_QUESTION) return json({ error: "Ask a question of up to 2,000 characters." }, 400);
  const history = (Array.isArray(body?.chat_history) ? body.chat_history : [])
    .slice(-MAX_HISTORY)
    .flatMap((turn: { author?: unknown; text?: unknown }) =>
      (turn?.author === "USER" || turn?.author === "NUCLIA") && typeof turn.text === "string"
        ? [{ author: turn.author as "USER" | "NUCLIA", text: turn.text.slice(0, 8000) }]
        : [],
    );

  const { language, resources } = filterParts(body?.filter_expression?.field);
  const base = searchConfigName(page.deployment);
  const intent = base ? ROUTE_INTENTS.find((i) => intentConfigName(base, i) === body?.search_configuration) : undefined;
  // And, while the agents are on, never their generated text (the saved configurations keep it out
  // too, but this filter replaces theirs).
  const fields = [
    ...(language ? [languageFilter(language).filter_expression.field] : []),
    ...(intent ? [labelFilter(intent, resources).field] : []),
    ...(page.deployment.augmentation ? [NOT_GENERATED] : []),
  ];

  const key = await previewKey(deploymentId);
  if (!key) return json({ error: "This deployment has no key to ask with." }, 503);
  const kb = new KbClient({ zone: page.deployment.zone, kbId, credential: { kind: "key", token: key } });
  try {
    const stream = await kb.askRaw(
      {
        query,
        search_configuration: intent && base ? intentConfigName(base, intent) : base,
        chat_history: history,
        citations: true,
        show: ["basic", "origin"],
        ...(fields.length && { filter_expression: { field: fields.length === 1 ? fields[0] : { and: fields } } }),
      },
      { signal: request.signal, partnerTest: true },
    );
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(`preview ask failed for deployment ${deploymentId}:`, err instanceof Error ? err.message : err);
    return json({ error: "Agentic RAG didn't answer." }, 502);
  }
}
