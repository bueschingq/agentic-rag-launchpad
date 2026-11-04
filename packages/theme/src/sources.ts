// The source links under an answer: at most two, each related to the question or the answer, in
// the visitor's language when there's one in it. Shared by the widget (what visitors see) and the
// console's validation and starter picker, so both show exactly the links visitors get (round 5:
// validation listed up to three unfiltered sources: off-topic, other languages, duplicates).
//
// Round 4: "Can I watch a demo?" cited "What is sFlow?", and the German price answer a Spanish
// page. Agentic RAG often cites a site's repeated chrome: a "Start your free trial · Watch a demo"
// band or a "Contact Support" link on every product page. A passage that several pages share says
// nothing about the page it sits on, so only the page's title and its own passages count. A source
// that shares a word with the question beats one that only shares words with the answer, and one
// far weaker than the best is left out. None may qualify: then there are none. Resource URLs come
// from crawled content, so only http(s) links are ever returned.
// Browser-safe and dependency-free: the widget bundles it.

import { matchWords, relatedWords } from "./relevance.ts";
import { bestScore, detectLanguage, MIN_RERANKER_SCORE } from "./verdict.ts";

// A retrieved resource as Agentic RAG returns it (the stream's retrieval item, or the synchronous
// answer's retrieval_results), as far as source picking reads it.
export interface RetrievedResource {
  title?: string;
  origin?: { url?: string | null } | null;
  fields?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
}

export interface Source {
  title: string;
  href: string;
}

// A cited (or, without citations, retrieved) page as the relevance checks see it: its title, the
// passages the answer drew on, and its main language.
export interface SourceFacts {
  id: string;
  title: string;
  href: string;
  passages: string[];
  language?: string;
}

export const MAX_SOURCES = 2;

export function safeHref(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

type Paragraph = { id: string; text: string; score?: number; type?: string };

function paragraphs(resource: RetrievedResource): Paragraph[] {
  const fields = (resource.fields ?? {}) as Record<
    string,
    { paragraphs?: Record<string, { text?: unknown; score?: unknown; score_type?: unknown }> }
  >;
  return Object.values(fields).flatMap((f) =>
    Object.entries(f?.paragraphs ?? {}).map(([id, p]) => ({
      id,
      text: typeof p?.text === "string" ? p.text : "",
      ...(typeof p?.score === "number" && { score: p.score }),
      ...(p?.score_type !== undefined && { type: String(p.score_type) }),
    })),
  );
}

const languageOf = (resource: RetrievedResource): string | undefined => {
  const language = (resource.metadata as { language?: unknown } | undefined)?.language;
  return typeof language === "string" && language ? language.slice(0, 2).toLowerCase() : undefined;
};

// The pages the answer drew on, in citation order, each with its cited passages; if nothing was
// cited (or citations are off), the retrieved ones, best match first, leaving out reranked ones
// too weak to count, each with its best passage. One per URL. Also what the verdict's off-source
// check reads (answerChecks in @launchpad/theme).
export function citedSources(resources: Record<string, RetrievedResource>, citations: Record<string, unknown>): SourceFacts[] {
  const citedKeys = Object.keys(citations);
  const cited = [...new Set(citedKeys.map((key) => key.split("/")[0] ?? key))];
  const scored = Object.entries(resources).map(([id, resource]) => ({ id, best: bestScore({ [id]: resource }) }));
  const relevant = scored
    .filter(({ best }) => best?.type !== "RERANKER" || best.score >= MIN_RERANKER_SCORE)
    .sort((a, b) => (b.best?.score ?? 0) - (a.best?.score ?? 0));
  const ids = cited.length ? cited : relevant.map((r) => r.id);
  const byHref = new Map<string, SourceFacts>();
  for (const id of ids) {
    const resource = resources[id];
    const href = safeHref(resource?.origin?.url);
    if (!resource || !href) continue;
    const own = paragraphs(resource);
    const passages = cited.length
      ? own.filter((p) => citedKeys.includes(p.id)).map((p) => p.text)
      : own
          .filter((p) => p.text)
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
          .slice(0, 1)
          .map((p) => p.text);
    const seen = byHref.get(href);
    if (seen) seen.passages.push(...passages);
    else {
      const language = languageOf(resource);
      byHref.set(href, { id, title: resource.title?.trim() || new URL(href).pathname, href, passages, ...(language && { language }) });
    }
  }
  return [...byHref.values()];
}

// Words of the chat's own name that are the client's brand ("WhatsUp Gold", "Crayola",
// "Sitefinity assistant"): on every page of the site, so they relate nothing to anything.
const NOT_BRAND = new Set(matchWords("assistant assist helper help chat chatbot bot agent virtual guide team support service"));
export const brandWords = (name: string | undefined): Set<string> => new Set(matchWords(name ?? "").filter((w) => !NOT_BRAND.has(w)));

// Passages repeated across pages: site chrome, not evidence. Two passages are the same when most
// of the shorter one's words are in the other.
const SAME_SHARE = 0.8;
function shared(passage: string[], others: readonly string[][]): boolean {
  if (passage.length < 3) return others.some((o) => o.length === passage.length && passage.every((w) => o.includes(w)));
  return others.some((o) => {
    const [small, big] = passage.length <= o.length ? [passage, o] : [o, passage];
    return small.length > 0 && small.filter((w) => big.includes(w)).length / small.length >= SAME_SHARE;
  });
}

export interface SourceContext {
  question: string;
  answer: string;
  // The widget's language: the visitor's, unless the question says otherwise.
  language?: string;
  // The chat's name, whose brand words don't count.
  brand?: string;
  // Every page retrieved, to tell repeated chrome from a page's own passage.
  resources?: Record<string, RetrievedResource>;
  max?: number;
}

// The source links to show under an answer (see the top of this file). Pure.
export function pickSources(candidates: readonly SourceFacts[], ctx: SourceContext): Source[] {
  const brand = brandWords(ctx.brand);
  // A number in the question matches by chance ("300 Geräte", "300 Ärzte"); in the answer, a
  // figure the page states is evidence.
  const question = matchWords(ctx.question).filter((w) => !brand.has(w) && !/^\d+$/.test(w));
  const answer = matchWords(ctx.answer).filter((w) => !brand.has(w) && !question.includes(w));
  // Each page's passages as words, to find the ones other pages repeat.
  const everywhere = new Map<string, string[][]>();
  const wordsOf = (texts: readonly string[]) => texts.map((text) => matchWords(text));
  for (const [id, resource] of Object.entries(ctx.resources ?? {})) everywhere.set(id, wordsOf(paragraphs(resource).map((p) => p.text)));
  for (const c of candidates) if (!everywhere.has(c.id)) everywhere.set(c.id, wordsOf(c.passages));

  // Words relate as the verdict's off-source check sees them (relatedWords): "cost" and
  // "pricing", "Preise" and "kostet" are one.
  const judged = candidates.map((c, order) => {
    const others = [...everywhere].filter(([id]) => id !== c.id).flatMap(([, ps]) => ps);
    const own = wordsOf(c.passages).filter((words) => !shared(words, others));
    const title = matchWords(c.title);
    const words = [...new Set([...title, ...own.flat()])];
    const asked = relatedWords(question, words);
    return { c, order, asked, rank: asked ? relatedWords(question, title) * 2 + asked : relatedWords(answer, words) };
  });
  // Pages that share a word with the question, if any; else with the answer.
  const tier = judged.some((j) => j.asked) ? judged.filter((j) => j.asked) : judged.filter((j) => j.rank > 0);
  const best = Math.max(0, ...tier.map((j) => j.rank));
  let kept = tier.filter((j) => j.rank * 2 >= best).sort((a, b) => b.rank - a.rank || a.order - b.order);
  // In the visitor's language when there's a page in it.
  const language = detectLanguage(ctx.question) ?? ctx.language;
  if (language && kept.some((j) => j.c.language === language)) kept = kept.filter((j) => !j.c.language || j.c.language === language);
  return kept.slice(0, ctx.max ?? MAX_SOURCES).map(({ c }) => ({ title: c.title, href: c.href }));
}

// The source links under an answer, from the stream's retrieval and citations.
export function sourcesFor(
  resources: Record<string, RetrievedResource>,
  citations: Record<string, unknown>,
  ctx: Omit<SourceContext, "resources">,
): Source[] {
  return pickSources(citedSources(resources, citations), { ...ctx, resources });
}
