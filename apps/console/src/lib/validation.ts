// Validation before a deployment is "Ready to embed": questions a visitor would ask, each
// asked of the real chatbot (its saved prompt and search configuration), and a domain-lock
// check from every allowed origin. Four questions are generated from the site's visitor-task
// pages and the partner adds at least two of their own; the list can be edited before the run.
// The widget's starter questions are asked in every run too, and when they're chosen. Every ask
// is a partner test, so it never counts toward the customer's usage.
//
// One judge: an answer counts by the widget's own verdict (verdict() in @launchpad/theme). On
// top of it, an answer that talks about how it works internally, or comes back clearly in
// another language than the question's, fails, and one that states a price or a date, rests
// only on overview pages, or may be in another language, needs a person to check it: each
// figure is shown beside the sentence or table row that states it in the synced pages.
//
// Every way past a problem is recorded with a name and a reason for the review: checking a flag,
// "The site doesn't cover this", and removing a question that failed. A No answer can instead be
// fixed: the pages on the site that may answer it are added to the sync, and the question is
// asked again once they're answerable (the worker's jobs/revalidate.ts, which also runs a run
// again when it asked during the first sync and the sync has finished).
//
// Questions are asked a few at a time (ASK_CONCURRENCY), each in the question's language where
// the KB holds pages in several (retrievalLanguage, as the widget asks), and again across all
// pages when that finds no answer. The run records how much content was answerable, and how
// long it took.

import {
  auditLog,
  type Confirmation,
  contentPages,
  deployments,
  type PreflightResult,
  type PriceReask,
  type PriceTable,
  type PriceTableConfirmation,
  syncSources,
  tenants,
  type ValidationResult,
} from "@launchpad/db";
import { type AskBody, type AskResult, type KbClient, zoneApi } from "@launchpad/par-client";
import {
  askedKind,
  asksWhen,
  citedPassages,
  confirmedTable,
  detectLanguage,
  groundedContent,
  intentConfigName,
  isLanguage,
  type Language,
  type LanguageSetting,
  languageFilter,
  languageName,
  languageOf,
  NOT_GENERATED,
  negativeClaim,
  type RouteIntent,
  retrievalLanguage,
  retrievedPassages,
  routeIntent,
  type WidgetSettings,
} from "@launchpad/theme";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { accountBlock, recordAccountBlock, recordAccountClear } from "./account-block.ts";
import { answeringRulesCurrent, askingClient, intentFilter } from "./answers.ts";
import { AskRefused, failedReply, isRefusalFailure, type Refusal, refusalOf, refusalText, serviceFailure } from "./ask-refusal.ts";
import * as content from "./content.ts";
import { db } from "./db.ts";
import { judgeAnswer as askJudge } from "./judge.ts";
import { isPricingPage, pagePriceRows } from "./price-table.ts";
import {
  excludesGenerated,
  excludingGenerated,
  INTENT_CONFIGS_SINCE,
  intentSearchConfig,
  type PromptEvent,
  searchConfigFor,
  searchConfigName,
} from "./prompt.ts";
import { visitorName } from "./prompt-templates.ts";
import { withSetupName } from "./setup-name.ts";
import {
  ADDED_WAIT_MS,
  ASK_CONCURRENCY,
  answerFigures,
  answerSources,
  applyStarterPick,
  asksPrice,
  asRun,
  type ContentAtRun,
  carriedFromRun,
  carriedOver,
  chosenStarters,
  contentFromCounts,
  type Decision,
  type DraftQuestion,
  datePairingHold,
  dateTenseHold,
  draftProblem,
  evidenceHolds,
  expectedLanguage,
  failingStarters,
  figureKeys,
  GENERATED_QUESTIONS,
  generatedAfterIntents,
  generationNote,
  type Hold,
  halfwayDue,
  type IntentPage,
  type IntentQuestion,
  intentQuestions,
  inventedPriceHold,
  isFallbackQuestion,
  isLegalPage,
  isOverviewPage,
  isUnfinishedStub,
  judgeAnswer,
  languageIntentQuestions,
  locateFigures,
  MAX_QUESTIONS,
  MAX_STARTER_LENGTH,
  MAX_STARTERS,
  needsCheck,
  nothingOpen,
  OWN_QUESTIONS,
  openedSince,
  openHold,
  outstanding,
  pageSettled,
  parseGeneratedQuestions,
  priceQuestionsToAsk,
  priceReask,
  pricingProvenanceHold,
  promptPrices,
  provisionalTable,
  type QuestionIntent,
  questionKey,
  type Removal,
  type RunQuestion,
  recheckDiff,
  recheckDiffAfterSecondAsk,
  removedProblems,
  rerunDue,
  runCounts,
  type SiteFacts,
  STARTER_FAILURE,
  type StarterNeed,
  type StarterPick,
  type StarterRemoval,
  type SyncedPage,
  spreadPages,
  starterNeed,
  starterProblem,
  starterRemoval,
  taskScore,
  trueNoEvents,
  uncitedPriceHold,
  type ValidationRun,
  validationPassed,
  waitingOnPages,
  withIntentQuestions,
  withinQuestionLimit,
  withJudgement,
  withoutStarter,
  worseToAskAgain,
} from "./validation-rules.ts";

export * from "./validation-rules.ts";

// The synced pages to generate from: visitor-task pages first, never legal or conversion pages.
// Page flags that make an answer resting on the page worth a person's check.
const STALE_PAGE_FLAGS = new Set(["stale-commercial", "old", "conversion"]);

// The synced pages to generate from, spread across the site's sections (spreadPages): never legal,
// conversion or other-language pages, nor key pages (their intents are asked separately).
async function generationPages(deploymentId: string, max = 12, opts: { keyPages?: boolean } = {}): Promise<string[]> {
  const pages = await db()
    .select({
      url: contentPages.url,
      title: contentPages.title,
      resourceId: contentPages.resourceId,
      flags: contentPages.flags,
      words: contentPages.words,
      keyIntent: contentPages.keyIntent,
      pageModifiedAt: contentPages.pageModifiedAt,
      publishedAt: contentPages.publishedAt,
      lastModified: contentPages.lastModified,
    })
    .from(contentPages)
    .where(and(eq(contentPages.deploymentId, deploymentId), eq(contentPages.status, "indexed"), isNotNull(contentPages.resourceId)))
    .orderBy(desc(contentPages.words))
    .limit(400);
  const usable = pages.filter(
    (p) => !isLegalPage(p) && !p.flags.some((f) => f === "conversion" || f === "other-language") && (opts.keyPages || !p.keyIntent),
  );
  return spreadPages(
    usable.map((p) => ({
      id: p.resourceId ?? "",
      url: p.url,
      title: p.title,
      words: p.words,
      updated: p.pageModifiedAt ?? p.publishedAt ?? p.lastModified,
    })),
    max,
  ).map((p) => p.id);
}

const languageInstruction = (language: LanguageSetting) =>
  language === "auto" ? "Write them in the website's language." : `Write them in ${languageName(language)}.`;

async function askForQuestions(kb: KbClient, body: { query: string; system: string; resources: string[] }): Promise<string> {
  return kb
    .ask(
      {
        // The instruction goes in the question itself: with only a system prompt, the model answers
        // the question instead of listing questions (seen 2026-10-30).
        query: body.query,
        top_k: 20,
        ...(body.resources.length && { resource_filters: body.resources }),
        prompt: { system: body.system },
      },
      { partnerTest: true },
    )
    .then((r) => {
      if (failedReply(r)) throw new AskRefused({ kind: "server" });
      return r.answer ?? "";
    })
    .catch(async (err: unknown) => {
      // Agentic RAG failing isn't "no questions to suggest".
      if (serviceFailure(refusalOf(err))) throw await refusedAsk(err);
      return "";
    });
}

const QUESTION_RULES =
  "Use only the context, so that each can be answered from it. Never ask about privacy, cookies, terms, legal notices, " +
  "accessibility statements or thank-you pages. Never write 'What can you tell me about' or 'Tell me about', and never " +
  "mention the context, a text or a page. One question per line, each ending with a question mark. No numbering and nothing else.";

// Questions about what visitors come to do, from the site's own pages (four, or fewer when the
// intent questions take their place): one from each page spreadPages picks, asked of that page
// alone, so they spread across the site (round 5). One retry across the site; then fewer, with a
// note saying so. Never a fallback question, nor one asking what a chosen starter or an intent
// question already asks (every run asks the starters too).
export async function generateQuestions(
  kb: KbClient,
  deploymentId: string,
  language: LanguageSetting,
  starters: readonly string[] = [],
  want = GENERATED_QUESTIONS,
): Promise<{ questions: string[]; note?: string }> {
  const pages = await generationPages(deploymentId, want + 2);
  const system =
    "You write test questions for a website's chatbot, as real visitors would type them: short, specific and in their own words, " +
    "about what they came to do: find a product or service, learn how to do something, compare options, check what's included. " +
    `Prices, buying, trials, contact and support are asked separately: leave them out. ${QUESTION_RULES} ${languageInstruction(language)}`;
  const query =
    "List eight short questions a visitor to this website might ask to get something done, each answerable from the context. " +
    "Spread them across topics: what a product or service does, how to do something, what's included, which option fits. " +
    "One per line, each ending with a question mark.";
  const one = "List two short questions a visitor might ask that this page answers. One per line, each ending with a question mark.";
  // One question per page, a few pages at a time, in spreadPages' order.
  const perPage = await inTurns(pages, ASK_CONCURRENCY, (id) => askForQuestions(kb, { query: one, system, resources: [id] }));
  let questions: string[] = [];
  for (const text of perPage) {
    const [q] = parseGeneratedQuestions(text, 1, 150, [...starters, ...questions]);
    if (q && questions.length < want) questions.push(q);
  }
  const parse = (text: string) => parseGeneratedQuestions(text, want, 150, starters);
  if (questions.length < want) {
    // Once more, across the whole site and asking for different ones.
    const again = await askForQuestions(kb, {
      query: `${query} Different from these: ${questions.join(" ")}`,
      system,
      resources: [],
    });
    questions = parse([...questions, ...again.split("\n")].join("\n"));
  }
  if (questions.length >= want) return { questions };
  return { questions, note: generationNote(questions.length) };
}

// Track A's side (lib/content.ts keyPages): the deployment's key pages by intent, with the plan's
// key pages the sync hasn't taken yet (deployments synced before key pages existed have none).
async function sitesKeyPages(deploymentId: string): Promise<IntentPage[]> {
  return content.keyPages(deploymentId, { plan: true }).catch(() => []);
}

// The language the intent questions are asked in (the main language only, this cycle): the
// deployment's, else the first the widget serves, else English.
const mainLanguage = (d: { language: string; widgetSettings: WidgetSettings }): Language =>
  (isLanguage(d.language) ? d.language : undefined) ?? languageOf(d.widgetSettings.languages?.[0]) ?? "en";

// Starter-question suggestions: the few things most visitors come to do, short enough for a chip.
export async function suggestStarters(kb: KbClient, deploymentId: string, language: LanguageSetting): Promise<string[]> {
  // Key pages too (prices, trials and contact are what starters are for), spread across sections.
  const resources = await generationPages(deploymentId, 12, { keyPages: true });
  const text = await askForQuestions(kb, {
    query:
      "List six starter questions for this website's chat, under 60 characters each: the most common things a visitor comes to do " +
      "(prices, a free trial or demo, contacting support or sales, what we offer, where to buy). One per line, each ending with a question mark.",
    system:
      "You write the starter questions a website's chat shows as buttons when it opens: short, plain, in the visitor's words " +
      `(for example "How much does it cost?", "Can I try it free?", "How do I contact support?"). ${QUESTION_RULES} ${languageInstruction(language)}`,
    resources,
  });
  const got = parseGeneratedQuestions(text, 12, MAX_STARTER_LENGTH);
  // In the deployment's default language first (round 7: an English deployment with German pages
  // was offered only German starters, saved as its English ones). Others only to fill up.
  const main = language === "auto" ? undefined : language;
  if (!main) return got.slice(0, 6);
  const own = got.filter((q) => (detectLanguage(q) ?? main) === main);
  if (own.length >= 3) return own.slice(0, 6);
  const again = await askForQuestions(kb, {
    query: `List six starter questions for this website's chat in ${languageName(main)}, under 60 characters each, one per line.`,
    system: `You write a website chat's starter questions in ${languageName(main)} only, whatever language its pages are in. ${QUESTION_RULES}`,
    resources,
  });
  const more = parseGeneratedQuestions(again, 12, MAX_STARTER_LENGTH).filter((q) => (detectLanguage(q) ?? main) === main);
  return [...new Set([...own, ...more])].slice(0, 6);
}

// ---- what the KB holds ----

// The languages of the pages the sync has made answerable, by their <html lang>: what the
// widget and validation can ask in (retrievalLanguage in @launchpad/theme). Empty for content
// that didn't come through the sync (the Sitefinity connector, imported KBs).
export async function contentLanguages(deploymentId: string): Promise<string[]> {
  const rows = await db()
    .selectDistinct({ lang: contentPages.lang })
    .from(contentPages)
    .where(and(eq(contentPages.deploymentId, deploymentId), eq(contentPages.status, "indexed"), isNotNull(contentPages.lang)));
  return [...new Set(rows.map((r) => languageOf(r.lang)).filter((l) => l !== undefined))];
}

// The sync's state: how much is answerable, whether the first sync is still loading pages, how
// many sent pages Agentic RAG is still processing, and when the last sync finished. Undefined for
// content that didn't come through the sync.
export async function syncState(
  deploymentId: string,
): Promise<{ content: ContentAtRun; processing: number; finishedAt: Date | null } | undefined> {
  const [source] = await db()
    .select({ lastSyncedAt: syncSources.lastSyncedAt })
    .from(syncSources)
    .where(and(eq(syncSources.deploymentId, deploymentId), eq(syncSources.kind, "sitemap")));
  if (!source) return undefined;
  // As visitors meet them (Track A's contentCounts): a page being read again still answers from its
  // indexed copy, so a re-read never shows a low "answerable".
  const { counts } = await content.contentCounts(deploymentId);
  const n = (status: keyof typeof counts) => counts[status] ?? 0;
  return {
    // As the content panel counts it: the pages the sync takes, left-out ones not included.
    content: contentFromCounts(
      { indexed: n("indexed"), queued: n("queued"), processing: n("processing"), failed: n("failed") },
      source.lastSyncedAt,
    ),
    processing: n("processing"),
    finishedAt: source.lastSyncedAt,
  };
}

// How much was answerable when a run asked, and whether the first sync was still loading pages.
export async function contentAtRun(deploymentId: string): Promise<ContentAtRun | undefined> {
  return (await syncState(deploymentId))?.content;
}

// ---- running it ----

// A CORS preflight for /ask from the origin, as the visitor's browser will send it. The KB's
// domain lock answers it with a matching Access-Control-Allow-Origin, or refuses it.
export async function checkPreflight(
  zone: string,
  kbId: string,
  origins: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<PreflightResult> {
  const results = await Promise.all(
    origins.map(async (origin) => {
      try {
        const res = await fetchImpl(`${zoneApi(zone)}/kb/${kbId}/ask`, {
          method: "OPTIONS",
          headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
          signal: AbortSignal.timeout(10_000),
        });
        await res.body?.cancel();
        const allowed = res.headers.get("access-control-allow-origin");
        return { origin, ok: res.ok && (allowed === origin || allowed === "*"), status: res.status };
      } catch {
        return { origin, ok: false, status: 0 };
      }
    }),
  );
  return { at: new Date().toISOString(), origins: results };
}

// The deployment, with the name visitors see (whose words never make a source match a question).
type Deployment = typeof deployments.$inferSelect & { kbId: string; brand?: string };

export async function readerClient(deploymentId: string): Promise<{ error: string } | { error?: undefined; d: Deployment; kb: KbClient }> {
  const [row] = await db()
    .select({ d: deployments, name: tenants.name, displayName: tenants.displayName })
    .from(deployments)
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .where(eq(deployments.id, deploymentId));
  const d = row?.d;
  if (!d?.kbId) return { error: "This deployment has no Knowledge Box yet." };
  const kb = await askingClient(d);
  if (!kb) return { error: "This deployment has no key to ask with." };
  const brand = row && visitorName({ name: row.name, displayName: row.displayName });
  return { d: { ...d, kbId: d.kbId, ...(brand && { brand }) }, kb };
}

// The intent questions (price, contact and support, and buy and trial where the site has a key
// page for them), worded from the site's key pages in its main language: first in the list
// prepareQuestions makes, and added to the last run's by Bring up to date (RunOptions.addIntents).
export async function intentsFor(
  deploymentId: string,
  d: { language: string; widgetSettings: WidgetSettings; brand?: string },
): Promise<IntentQuestion[]> {
  const pages = await sitesKeyPages(deploymentId);
  // Events are asked when a synced page states a date still to come (Track A's upcomingEvents).
  const events = (await content.upcomingEvents(deploymentId).catch(() => [])).length > 0;
  const main = mainLanguage(d);
  const intents = intentQuestions(pages, main, d.brand, { events });
  // Room for them on a single-language site: the partner's own, a few generated and the starters.
  const starters = chosenStarters(d.widgetSettings).length;
  const room = MAX_QUESTIONS - OWN_QUESTIONS - generatedAfterIntents(intents.length) - starters;
  // In each further language the widget serves, the generic price and contact questions.
  const others = (d.widgetSettings.languages ?? []).map(languageOf).filter((l): l is Language => Boolean(l) && l !== main);
  // Round 6: the further languages' questions don't count against the cap on the partner's own
  // and generated questions (draftProblem): teamleader.eu got 21 against a cap of 20.
  return [...withinQuestionLimit(intents, Math.max(room, 6)), ...languageIntentQuestions(pages, [...new Set(others)])];
}

// The list to edit before the run: the intent questions (from the site's key pages, in its main
// language and the generic price and contact ones in each other language it serves), then
// questions generated from the site that don't repeat them or the starters.
export async function prepareQuestions(
  deploymentId: string,
): Promise<{ questions: string[]; intents: IntentQuestion[]; note?: string } | { error: string }> {
  const client = await readerClient(deploymentId);
  if (client.error !== undefined) return { error: client.error };
  return orRefused(async () => {
    const intents = await intentsFor(deploymentId, client.d);
    const generated = await generateQuestions(
      client.kb,
      deploymentId,
      client.d.language as LanguageSetting,
      [...chosenStarters(client.d.widgetSettings), ...intents.map((i) => i.question)],
      generatedAfterIntents(intents.length),
    );
    return { ...generated, intents };
  });
}

// Starter suggestions stay the same each time the picker opens: the last ones generated are kept
// in the audit log (one partner-test ask each time), and only "New suggestions" asks again.
const SUGGESTED = "deployment.starters.suggested";

export async function prepareStarters(
  deploymentId: string,
  opts: { fresh?: boolean; actor?: string | null } = {},
): Promise<{ suggestions: string[]; at?: string } | { error: string }> {
  if (!opts.fresh) {
    const [last] = await db()
      .select({ at: auditLog.at, detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.targetId, deploymentId), eq(auditLog.action, SUGGESTED)))
      .orderBy(desc(auditLog.at))
      .limit(1);
    const kept = last?.detail?.suggestions;
    if (last && Array.isArray(kept) && kept.length) {
      return { suggestions: kept.filter((q): q is string => typeof q === "string"), at: last.at.toISOString() };
    }
  }
  const client = await readerClient(deploymentId);
  if (client.error !== undefined) return { error: client.error };
  // The default language: an "auto" deployment's main one (round 7).
  const made = await orRefused(async () => ({
    suggestions: await suggestStarters(client.kb, deploymentId, mainLanguage(client.d) as LanguageSetting),
  }));
  if ("error" in made) return made;
  const { suggestions } = made;
  if (suggestions.length) {
    await db()
      .insert(auditLog)
      .values(
        await withSetupName({
          actorUserId: opts.actor ?? null,
          action: SUGGESTED,
          targetType: "deployment",
          targetId: deploymentId,
          detail: { suggestions },
        }),
      );
  }
  return { suggestions, at: new Date().toISOString() };
}

async function markReady(deploymentId: string, validation: ValidationResult, preflight: PreflightResult | null) {
  if (!validation.passed || !preflight?.origins.every((o) => o.ok)) return;
  await db()
    .update(deployments)
    .set({ readyAt: new Date() })
    .where(and(eq(deployments.id, deploymentId), isNull(deployments.readyAt)));
}

// One ask at most this long; a run never waits on a stuck one.
const ASK_TIMEOUT_MS = 60_000;

// ---- a refused ask (lib/ask-refusal.ts) ----

// An error from an ask as what every path gets: AskRefused, with the block recorded on the first
// refusal, whichever path met it (the alerts job posts it: lib/account-block.ts). This is why no
// alert fired in the block of 2 Nov: askPhase turned the refusal into a failure text, and only the
// rollout's re-check read that text for a block, so the automatic re-run met 402s and recorded nothing.
async function refusedAsk(err: unknown): Promise<AskRefused> {
  if (err instanceof AskRefused) return err;
  const refusal = refusalOf(err);
  // For whoever reads the worker's and console's logs; never for a screen.
  console.error(`ask refused (${refusal.kind}): ${err instanceof Error ? err.message : err}`);
  if (refusal.kind === "block") await recordAccountBlock(db(), refusal.state, "an ask").catch(() => false);
  return new AskRefused(refusal);
}

// What a path that returns { error } says when an ask was refused: the plain words, and what it was.
export interface RefusedResult {
  error: string;
  refused: Refusal;
}
const refusedResult = (err: AskRefused): RefusedResult => ({ error: refusalText(err.refusal), refused: err.refusal });
async function orRefused<T>(work: () => Promise<T>): Promise<T | RefusedResult> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof AskRefused) return refusedResult(err);
    throw err;
  }
}

// `size` at a time, in order; `run` must not throw.
async function inTurns<T, R>(items: readonly T[], size: number, run: (item: T) => Promise<R>, onDone?: (n: number) => void) {
  const out: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i] as T);
      onDone?.(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

/// How a run asks: with the deployment's saved configurations, or (inline) with the latest
// answering rules not yet saved, as the rules rollout re-checks a deployment before switching it
// (jobs/rules-rollout.ts). Caches per run: each intent's label filter, and the site's key-page
// facts and upcoming dates for the evidence check.
export interface AskingClient {
  d: Deployment;
  kb: KbClient;
  inline?: boolean;
  // false: the model judge isn't asked (the rollout's flip check reads only the rules).
  judge?: boolean;
  // false: judgements are neither read from nor written to the cache (read-only checks).
  cache?: boolean;
  filters?: Map<RouteIntent, Promise<{ field: Record<string, unknown> }>>;
  // Per question language (round 6: a French question is checked against /fr/prix).
  sites?: Map<string, Promise<SiteFacts>>;
  // The upcoming events the inline events configuration lists (prompt.ts eventsParagraph).
  promptEvents?: Promise<PromptEvent[]>;
}

const siteFacts = (client: AskingClient, question: string): Promise<SiteFacts> => {
  const lang = detectLanguage(question) ?? (isLanguage(client.d.language) ? client.d.language : "");
  client.sites ??= new Map();
  let site = client.sites.get(lang);
  if (!site) {
    site = Promise.all([
      content.keyFacts(client.d.id, "price", lang || undefined).catch(() => []),
      content.keyFacts(client.d.id, "contact", lang || undefined).catch(() => []),
      content.upcomingEvents(client.d.id).catch(() => []),
    ]).then(([price, contact, events]) => ({ price, contact, events }));
    client.sites.set(lang, site);
  }
  return site;
};

// The pricing page's own plan-to-figure pairings while no table is confirmed: the stored table's
// rows (read by the sync from the pricing pages), else the rows the price key pages' facts give
// (pagePriceRows), without names that may not be plans (provisionalTable).
function pricingFactsOf(d: Deployment, site: SiteFacts): PriceTable | undefined {
  const pages = (site.price ?? []).filter((p) => isPricingPage(p.url, p.title) || p.intent === "price");
  const stored = d.priceTable?.rows ?? [];
  const rows = stored.length ? stored : pages.flatMap((p) => pagePriceRows(p.url, p.facts));
  return provisionalTable(rows, [...pages, ...(d.priceTable?.pages ?? []).map((url) => ({ url }))]);
}

const filterFor = (client: AskingClient, intent: RouteIntent) => {
  client.filters ??= new Map();
  let filter = client.filters.get(intent);
  if (!filter) {
    filter = intentFilter(client.d.id, intent);
    client.filters.set(intent, filter);
  }
  return filter;
};

// A label filter and a language filter together: a filter_expression sent with the question
// replaces the saved configuration's, so a routed ask in one language carries both.
const bothFilters = (a: { field: Record<string, unknown> }, language: Language | undefined) =>
  language ? { field: { and: [a.field, languageFilter(language).filter_expression.field] } } : a;

// One question, asked as the widget asks it: routed first to its intent's pages (price, buy,
// trial, events, support, contact) where the deployment has the intent configurations, then with
// the default configuration; each in the question's language where the KB holds pages in several,
// then across all pages when that finds no answer (some things are only on the other language's
// pages). Returns the answer, and the intent it was routed to when that one answered.
async function askAsVisitor(
  client: AskingClient,
  question: string,
  held: readonly string[],
): Promise<{ result: AskResult; routed?: RouteIntent }> {
  const { d, kb } = client;
  const ask = (body: Partial<AskBody>) =>
    kb.ask(
      { query: question, citations: true, show: ["basic", "origin"], ...body },
      { partnerTest: true, signal: AbortSignal.timeout(ASK_TIMEOUT_MS) },
    );
  const answered = (r: AskResult) => judgeAnswer(question, r).answered;
  const language = retrievalLanguage(question, isLanguage(d.language) ? d.language : undefined, held);
  const saved = searchConfigName(d);
  // While the agents are on, every ask keeps their generated text out, as the widget's do
  // (PublicWidgetConfig.excludeGenerated): an ask's own filter replaces the saved one's.
  const exclude = excludesGenerated(d);
  const base: Partial<AskBody> =
    client.inline && d.systemPrompt
      ? searchConfigFor(d.systemPrompt, d.language as LanguageSetting, new Date(), undefined, exclude)
      : { search_configuration: saved, ...(exclude && { filter_expression: { field: NOT_GENERATED } }) };
  // "When is…" on a site with events, as the widget routes it (route.ts).
  const intent =
    routeIntent(question) ?? (asksWhen(question) && (await content.upcomingEvents(d.id).catch(() => [])).length ? "events" : undefined);
  if (intent && saved && (client.inline || d.answeringRules >= INTENT_CONFIGS_SINCE)) {
    const filter = excludingGenerated(bothFilters(await filterFor(client, intent), language), exclude);
    if (client.inline && intent === "events") client.promptEvents ??= content.eventsForPrompt(d.id).catch(() => []);
    const events = client.inline && intent === "events" ? await client.promptEvents : undefined;
    const body: Partial<AskBody> = client.inline
      ? { ...intentSearchConfig(d.systemPrompt, d.language as LanguageSetting, intent, filter, new Date(), false, events, promptPrices(d)) }
      : { search_configuration: intentConfigName(saved, intent), filter_expression: filter };
    // A routed ask the configuration can't take falls back; Agentic RAG failing doesn't.
    const routed = await ask(body).catch((err: unknown) => {
      if (serviceFailure(refusalOf(err))) throw err;
      return undefined;
    });
    if (routed && answered(routed)) return { result: routed, routed: intent };
  }
  if (!language) return { result: await ask(base) };
  const first = await ask({ ...base, filter_expression: excludingGenerated(languageFilter(language).filter_expression, exclude) });
  return { result: answered(first) ? first : await ask(base) };
}

// The synced pages whose text may state a flagged answer's figures (the digits with any
// separator: "1149" finds "$ 1,149" and "1.149 €"), with the pages the chatbot read, for
// locateFigures to place each figure.
async function pagesStating(deploymentId: string, q: RunQuestion, result: AskResult): Promise<SyncedPage[]> {
  const keys = figureKeys(q.answer, q.flags ?? []);
  const synced = keys.length
    ? await db()
        .select({ url: contentPages.url, title: contentPages.title, text: contentPages.text, lang: contentPages.lang })
        .from(contentPages)
        .where(
          and(
            eq(contentPages.deploymentId, deploymentId),
            eq(contentPages.status, "indexed"),
            sql`${contentPages.text} ~ ${keys.map((k) => k.split("").join("[.,\\s  ]?")).join("|")}`,
          ),
        )
        .limit(80)
    : [];
  // What the chatbot read, for content that didn't come through the sync.
  const resources = (result.retrieval_results?.resources ?? {}) as Record<
    string,
    {
      title?: string;
      origin?: { url?: string | null } | null;
      fields?: Record<string, { paragraphs?: Record<string, { text?: unknown }> }>;
    }
  >;
  const read = Object.values(resources).flatMap((r) => {
    const url = r.origin?.url;
    if (!url || synced.some((p) => p.url === url)) return [];
    const parts = Object.values(r.fields ?? {}).flatMap((f) => Object.values(f?.paragraphs ?? {}).map((p) => p?.text));
    return [{ url, title: r.title ?? null, text: parts.filter((t): t is string => typeof t === "string").join("\n") }];
  });
  return [...synced, ...read];
}

// The pages an answer cites, by address.
const citedUrls = (result: AskResult): string[] => {
  const cited = new Set(Object.keys(result.citations ?? {}).map((k) => k.split("/")[0] ?? k));
  const resources = (result.retrieval_results?.resources ?? {}) as Record<string, { origin?: { url?: string | null } | null }>;
  return [...cited].flatMap((id) => resources[id]?.origin?.url ?? []);
};

// A judged answer with each flagged figure beside the text that states it, and the check link
// pointing at the first figure's page. A price only another product's page states, which the
// answer doesn't cite, is held (uncitedPriceHold).
async function withFigures(
  deploymentId: string,
  q: RunQuestion,
  result: AskResult,
  language?: Language,
  keyPages: readonly string[] = [],
  pricing: SiteFacts["price"] = [],
  noPrices = false,
): Promise<RunQuestion> {
  if (!q.flags?.some((f) => f === "price" || f === "date")) return q;
  const resources = (result.retrieval_results?.resources ?? {}) as Record<string, { origin?: { url?: string | null } | null }>;
  const cited = citedUrls(result);
  const figures = locateFigures(q.answer, q.flags, await pagesStating(deploymentId, q, result), {
    cited,
    retrieved: Object.keys(resources).flatMap((id) => resources[id]?.origin?.url ?? []),
    language,
  });
  const first = figures.find((f) => f.page);
  const stray = uncitedPriceHold(figures, cited, keyPages);
  // A site with no prices: a figure on no synced page is invented, judge on or off.
  const invented = noPrices ? inventedPriceHold(figures) : undefined;
  // A figure given as the pricing page's that no pricing page states (round 7, item 5).
  const provenance = pricingProvenanceHold(
    q.answer,
    figures,
    (pricing ?? []).filter((p) => isPricingPage(p.url, p.title) || p.intent === "price"),
  );
  const added = [stray, provenance, invented].filter((h): h is Hold => Boolean(h));
  return {
    ...q,
    ...(figures.length && { figures }),
    ...(first?.page && { check: { ...first.page, found: true } }),
    ...(added.length && { holds: [...(q.holds ?? []), ...added] }),
  };
}

// An answer asked and judged by the rules (judgeAnswer in validation-rules.ts), waiting for the
// model judge (judgePhase).
interface Asked {
  q: DraftQuestion;
  result?: AskResult;
  judged: RunQuestion;
}

// One question asked and judged as a run judges it: the deployment's language rule, the content
// sync's overview pages, each figure placed in the synced text, and the key pages' evidence.
// Throws AskRefused when there's no answer to judge (lib/ask-refusal.ts), never an empty answer:
// a path that forgets about refusals stops, instead of reading one as "no answer".
async function askPhase(client: AskingClient, q: DraftQuestion, held: readonly string[]): Promise<Asked> {
  const { d } = client;
  try {
    const askedAt = new Date();
    const { result } = await askAsVisitor(client, q.question, held);
    if (failedReply(result)) throw new AskRefused({ kind: "server" });
    // The first answer that works after a block is the all-clear.
    await recordAccountClear(db(), "an ask", askedAt).catch(() => false);
    const urls = answerSources(result).map((s) => s.url);
    const cited = urls.length
      ? await db()
          .select({ url: contentPages.url, flags: contentPages.flags, lang: contentPages.lang })
          .from(contentPages)
          .where(and(eq(contentPages.deploymentId, d.id), inArray(contentPages.url, urls)))
      : [];
    const flagged = new Set(cited.filter((p) => p.flags.includes("overview")).map((p) => p.url));
    // An answer that rests on a page the content rules flag carries the flag, for a person to check.
    const stale = cited.some((p) => p.flags.some((f) => STALE_PAGE_FLAGS.has(f)));
    const expected = expectedLanguage(q.question, d.language);
    const site = await siteFacts(client, q.question);
    const priceTable = confirmedTable(d);
    const judged = judgeAnswer(
      q,
      result,
      (s) => isOverviewPage(s, flagged.has(s.url)),
      expected && { expected, followsVisitor: d.language === "auto" },
      {
        brand: d.brand,
        chatName: d.widgetSettings.nickname,
        pageLanguage: (url) => cited.find((p) => p.url === url)?.lang,
        priceTable,
        // No confirmed table: the pricing page's own pairings (round 7, item 2), and its lines, for a
        // figure the rows lack.
        ...(!priceTable && {
          pricingFacts: pricingFactsOf(d, site),
          pricingLines: (site.price ?? []).flatMap((p) => (p.facts.prices ?? []).map((x) => x.line)),
        }),
      },
    );
    if (stale && judged.answered && !judged.flags?.includes("stale-source")) judged.flags = [...(judged.flags ?? []), "stale-source"];
    const keyPages = (site.price ?? []).map((p) => p.url);
    const noPrices = !d.priceTable?.rows.length && !(site.price ?? []).some((p) => p.facts.prices?.length);
    const figured = await withFigures(d.id, judged, result, expected, keyPages, site.price, noPrices);
    // A full date told in the other tense than the date gives (round 7).
    const tense = dateTenseHold(figured.answer, new Date());
    return { q, result, judged: tense ? { ...figured, holds: [...(figured.holds ?? []), tense] } : figured };
  } catch (err) {
    throw await refusedAsk(err);
  }
}

// The key pages' evidence and the model judge on an asked answer: each can only hold it. The
// evidence check runs on every intent question, every starter, and every answer that partly
// answers or may not answer; the judge on every answer with text (lib/judge.ts, cached per
// question and answer). Never throws.
async function judgePhase(client: AskingClient, a: Asked): Promise<Asked> {
  const { result } = a;
  if (!result) return a;
  const site = await siteFacts(client, a.judged.question);
  const noUpcomingDates = !site.events?.length;
  const judged = trueNoEvents(a.judged, site, new Date());
  const checked = judged.intent || judged.starter || judged.partly || judged.declined;
  const evidence = checked
    ? evidenceHolds(judged.question, judged.answer, site, { intent: judged.intent, cited: citedUrls(result) })
    : { holds: [] as Hold[] };
  const text = judged.answer || judged.hiddenAnswer;
  const resources = result.retrieval_results?.resources ?? {};
  // Each date beside what the page gives it to, judge on or off.
  const paired = text
    ? datePairingHold(
        text,
        [...retrievedPassages(resources, result.augmented_context), ...(site.events ?? []).map((e) => e.line)],
        client.d.brand,
      )
    : undefined;
  if (paired) evidence.holds = [...evidence.holds, paired];
  if (!text || client.judge === false) return { ...a, judged: withJudgement(judged, undefined, evidence) };
  const cited = citedPassages(resources, result.citations ?? {}, result.augmented_context);
  const passages = cited.length ? cited : retrievedPassages(resources, result.augmented_context).slice(0, 12);
  const kind = askedKind(judged.question);
  // The answer's own content of the kind asked, on the pages it cites, with no claim of absence:
  // the judge alone doesn't hold it (withJudgement).
  const content = groundedContent(text, cited, {
    question: judged.question,
    retrieved: retrievedPassages(resources, result.augmented_context),
  });
  const ofKind =
    kind === "contact" ? content.kinds.has("contact") || content.kinds.has("link") : kind ? content.kinds.has(kind) : content.grounded;
  const grounded = cited.length > 0 && ofKind && !negativeClaim(text, undefined, judged.question);
  // The key pages' facts the answer is judged against: the ones it cites, when it cites any (round 6:
  // teamwork.com's answers from /pricing/ were judged against /desk/pricing/'s prices).
  const urls = new Set(citedUrls(result));
  const keyOf = <T extends { url: string }>(pages: readonly T[] | undefined): T[] => {
    const own = (pages ?? []).filter((p) => urls.has(p.url));
    return own.length ? own : (pages ?? []).slice(0, 1);
  };
  const verdict = await askJudge({
    deploymentId: client.d.id,
    question: judged.question,
    answer: text,
    passages,
    ...(client.cache === false && { cache: false }),
    ...(kind === "price" && { keyFacts: keyOf(site.price) }),
    // The table: a plan's monthly and yearly prices aren't a conflict, for the judge either.
    ...(answerFigures(text, ["price"]).length || kind === "price"
      ? { priceTable: confirmedTable(client.d) ?? pricingFactsOf(client.d, site) }
      : {}),
    ...(kind === "contact" && { keyFacts: keyOf(site.contact) }),
    ...(kind === "date" && { events: site.events ?? [] }),
  });
  return { ...a, judged: withJudgement(judged, verdict, evidence, { grounded, noUpcomingDates }) };
}

// A question asked and judged whole: askPhase, then judgePhase.
async function askAndJudge(client: AskingClient, q: DraftQuestion, held: readonly string[]): Promise<Asked> {
  return judgePhase(client, await askPhase(client, q, held));
}

// Questions asked a few at a time (ASK_CONCURRENCY) and each judged as soon as it's asked, the
// judge calls running beside the next asks (JUDGE_CONCURRENCY at most), so a 20-question run
// takes about as long as its asks. In the list's order.
const JUDGE_CONCURRENCY = 6;
export async function askAll(
  client: AskingClient,
  questions: readonly DraftQuestion[],
  held: readonly string[],
  onDone?: (n: number) => void,
  // Asks at once: the picker asks more than a run (its suggestions are short, and nothing else waits).
  concurrency = ASK_CONCURRENCY,
): Promise<Asked[]> {
  const judging: Promise<Asked>[] = new Array(questions.length);
  let running = 0;
  const waiting: (() => void)[] = [];
  const slot = async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= JUDGE_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await work();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
  let done = 0;
  // The first refusal stops the run: no more asks go out, and the caller keeps what it had.
  let refused: AskRefused | undefined;
  await inTurns(
    questions.map((q, i) => ({ q, i })),
    concurrency,
    async ({ q, i }) => {
      if (refused) return;
      try {
        const asked = await askPhase(client, q, held);
        judging[i] = slot(() => judgePhase(client, asked)).then((r) => {
          onDone?.(++done);
          return r;
        });
      } catch (err) {
        refused ??= await refusedAsk(err);
      }
    },
  );
  if (refused) {
    await Promise.allSettled(judging.filter(Boolean));
    throw refused;
  }
  return Promise.all(judging);
}

export interface RunOptions {
  // Fewer good questions could be generated than asked for.
  generationNote?: string;
  // After each answer: how many of how many are in.
  onProgress?: (done: number, total: number) => void;
  // Why each question the last run had a problem with is no longer asked (removedProblems).
  reasons?: { question: string; reason: string }[];
  // Who removed them.
  who?: Confirmation;
  // Started by the worker when the first sync finished.
  auto?: ValidationRun["auto"];
  // With no list given: the last run's list with the intent questions it lacks added
  // (prepareQuestions' intents, withIntentQuestions). Bring up to date's run.
  addIntents?: boolean;
}

export async function runValidation(
  deploymentId: string,
  actor: string | null,
  // The question list. Plain strings (the deployment page's earlier action) count as generated
  // questions. None: the last run's list again (the run after the first sync, Bring up to date).
  draft?: readonly (DraftQuestion | string)[],
  opts: RunOptions = {},
): Promise<{ validation: ValidationRun; preflight: PreflightResult } | { error: string; refused?: Refusal }> {
  const client = await readerClient(deploymentId);
  if (client.error !== undefined) return { error: client.error };
  const { d } = client;
  const last = asRun(d.validation);
  const given = (draft ?? [])
    .map((q): DraftQuestion => (typeof q === "string" ? { question: q, own: false } : q))
    .map(
      (q): DraftQuestion => ({
        question: q.question.trim().slice(0, 300),
        own: q.own && !isFallbackQuestion(q.question),
        ...(q.intent && !q.own && { intent: q.intent }),
        ...(q.intent && !q.own && q.wording && { wording: q.wording }),
      }),
    )
    .filter((q) => q.question);
  const listed: DraftQuestion[] = given.length
    ? given
    : opts.addIntents
      ? withIntentQuestions(last?.questions ?? [], await intentsFor(deploymentId, d))
      : (last?.questions ?? [])
          .filter((q) => !q.starterOnly)
          .map((q) => ({
            question: q.question,
            own: Boolean(q.own),
            ...(q.intent && { intent: q.intent }),
            ...(q.intent && q.wording && { wording: q.wording }),
          }));
  if (!listed.length) return { error: "Generate questions and add your own before running validation." };
  if (given.length) {
    const problem = draftProblem(listed);
    if (problem) return { error: `${problem} before running validation.` };
  }

  // Every question the last run had a problem with and this list leaves out needs a reason.
  const reasons = new Map((opts.reasons ?? []).map((r) => [questionKey(r.question), r.reason.trim().slice(0, 300)]));
  const dropped = given.length ? removedProblems(last, listed) : [];
  const unexplained = dropped.find((r) => !reasons.get(questionKey(r.question)));
  if (unexplained) return { error: `Say why “${unexplained.question}” is no longer asked (${unexplained.was.toLowerCase()}).` };
  if (dropped.length && !opts.who) return { error: "Type your name: removing a question records who removed it." };

  // The widget's starters, in every language it serves: marked where the list has them, and
  // added after it where it doesn't.
  const starters = chosenStarters(d.widgetSettings);
  const starterKeys = new Set(starters.map(questionKey));
  const listedKeys = new Set(listed.map((q) => questionKey(q.question)));
  const asked: DraftQuestion[] = [
    ...listed.map((q) => ({ ...q, starter: starterKeys.has(questionKey(q.question)) })),
    ...starters.filter((q) => !listedKeys.has(questionKey(q))).map((question) => ({ question, own: false, starter: true })),
  ];

  const [held, content] = await Promise.all([contentLanguages(deploymentId), contentAtRun(deploymentId)]);
  const started = Date.now();
  opts.onProgress?.(0, asked.length);
  // A refused ask stops the run here, with nothing saved: the last results and decisions stand.
  const got = await orRefused(() => askAll(client, asked, held, (done) => opts.onProgress?.(done, asked.length)));
  if ("refused" in got) return got;
  const answers = got;
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const results: RunQuestion[] = answers.map(({ q, judged }) => {
    const onlyStarter = q.starter && !listedKeys.has(questionKey(q.question));
    return carriedFromRun(last?.questions ?? [], { ...judged, ...(onlyStarter && { starterOnly: true as const }) });
  });

  const at = new Date().toISOString();
  // Every removal so far, until its question is asked again.
  const askedKeys = new Set(asked.map((q) => questionKey(q.question)));
  const removed: Removal[] = [
    ...(last?.removed ?? []),
    ...dropped.flatMap((r) => (opts.who ? [{ ...opts.who, at, ...r, reason: reasons.get(questionKey(r.question)) ?? "" }] : [])),
  ].filter((r) => !askedKeys.has(questionKey(r.question)));
  // Only when an answer failed on its language: whether saving the prompt would change anything.
  const promptCurrent = results.some((q) => q.failure?.includes("Answered in ")) ? await answeringRulesCurrent(deploymentId) : undefined;
  const validation: ValidationRun = {
    at,
    questions: results,
    passed: validationPassed(results),
    ...(opts.generationNote && { generationNote: opts.generationNote }),
    ...(content && { content }),
    seconds,
    ...(removed.length && { removed }),
    ...(promptCurrent !== undefined && { promptCurrent }),
    ...(opts.auto && { auto: opts.auto }),
  };
  const preflight = await checkPreflight(d.zone, d.kbId, d.domains);

  await db().update(deployments).set({ validation, preflight }).where(eq(deployments.id, deploymentId));
  await markReady(deploymentId, validation, preflight);
  await markHeld(deploymentId);
  const counts = runCounts(results);
  // What this run opened that the last one didn't have open (track C's alerts read it with auto).
  const opened = openedSince(last, results);
  await db()
    .insert(auditLog)
    .values(
      await withSetupName({
        actorUserId: actor,
        action: "deployment.validate",
        targetType: "deployment",
        targetId: deploymentId,
        detail: {
          passed: validation.passed,
          answered: counts.answered,
          asked: results.length,
          own: counts.own,
          starters: results.filter((q) => q.starter).length,
          fallback: counts.fallback,
          failed: counts.failed.length,
          flagged: results.filter((q) => q.flags?.length).length,
          domainsLocked: preflight.origins.every((o) => o.ok),
          seconds,
          ...(dropped.length && { removed: dropped.map((r) => ({ ...r, reason: reasons.get(questionKey(r.question)) })) }),
          ...(opts.auto && { auto: opts.auto }),
          ...(content && { content }),
          undecided: counts.undecided.length,
          ...(counts.noDecision.length && { noDecision: counts.noDecision.map((q) => q.question) }),
          ...(opened.length && { opened }),
          ...(opts.who && !opts.auto && { name: opts.who.name, verified: opts.who.verified }),
        },
      }),
    );
  return { validation, preflight };
}

// heldAt came in with the review's checks 3 (lib/review.ts CHECKS_VERSION, read here as a number so
// the worker needn't import the review); a sign-off under older checks is never stamped (7e).
const HELD_SINCE_CHECKS = 3;

// The sign-off holds (SignOff.heldAt, the onboarding clock's second figure) once a run after the
// first sync leaves nothing open, whoever ran it or resolved what it opened: set once, and kept.
export async function markHeld(deploymentId: string, at = new Date()): Promise<boolean> {
  const [d] = await db()
    .select({ signOff: deployments.signOff, validation: deployments.validation })
    .from(deployments)
    .where(eq(deployments.id, deploymentId));
  if (!d?.signOff || d.signOff.heldAt || !nothingOpen(d.validation)) return false;
  // 7e: the clock times onboardings only. Not a sign-off under older checks, nor one after an
  // upgrade sign-off (Bring up to date audits deployment.signoff with previousChecksVersion).
  if ((d.signOff.checksVersion ?? 0) < HELD_SINCE_CHECKS) return false;
  const [upgrade] = await db()
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetId, deploymentId),
        eq(auditLog.action, "deployment.signoff"),
        sql`${auditLog.detail} ? 'previousChecksVersion'`,
      ),
    )
    .limit(1);
  if (upgrade) return false;
  await db()
    .update(deployments)
    .set({ signOff: sql`jsonb_set(${deployments.signOff}, '{heldAt}', to_jsonb(${at.toISOString()}::text))` })
    .where(and(eq(deployments.id, deploymentId), isNotNull(deployments.signOff), sql`(${deployments.signOff}->>'heldAt') is null`));
  return true;
}

// The saved run with one question changed, judged again as a whole and saved.
async function saveQuestion(
  deploymentId: string,
  index: number,
  question: string,
  change: (q: RunQuestion, run: ValidationRun) => RunQuestion | { error: string },
  // Run-level fields to set with it: auto, when the worker asked it again.
  patch: Partial<ValidationRun> = {},
): Promise<{ validation: ValidationRun; target: RunQuestion; d: typeof deployments.$inferSelect } | { error: string }> {
  const [d] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
  const run = asRun(d?.validation);
  const target = run?.questions[index];
  // The question text guards against changing a newer run's answer by position.
  if (!d || !run || !target || target.question !== question) return { error: "Validation has run again since: check the new answers." };
  const changed = change(target, run);
  if ("error" in changed) return changed;
  const questions = run.questions.map((q, i) => (i === index ? changed : q));
  const validation: ValidationRun = { ...run, ...patch, questions, passed: validationPassed(questions) };
  await db().update(deployments).set({ validation }).where(eq(deployments.id, deploymentId));
  await markReady(deploymentId, validation, d.preflight);
  await markHeld(deploymentId);
  return { validation, target, d };
}

// A person checked a flagged answer against the site: each figure beside the text that states
// it, or, for a figure no synced page states, on the page whose address they give. Recorded on
// the answer and audited.
export async function acknowledgeFlag(
  deploymentId: string,
  index: number,
  question: string,
  who: Confirmation,
  foundAt?: string,
  // For a held answer (round 5): why it's right, for the person who signs off.
  reason?: string,
): Promise<{ validation: ValidationResult } | { error: string }> {
  const address = foundAt?.trim();
  const why = reason?.trim().slice(0, 300);
  const saved = await saveQuestion(deploymentId, index, question, (q) => {
    if (!needsCheck(q)) return { error: q.acknowledged ? "Someone has checked it already." : "That answer has nothing to check." };
    const unstated = (q.figures ?? []).filter((f) => !f.page);
    if (unstated.length && !/^https?:\/\/\S+\.\S+/.test(address ?? "")) {
      return { error: `Paste the address of the page where you found ${unstated.map((f) => f.figure).join(" and ")}.` };
    }
    // A held answer clears only with a named decision and its reason (or by asking again or rewording).
    if (q.holds?.some((h) => h.clear === "decide") && (!why || why.length < 3)) {
      return { error: "Say in a line why this answer is right, for the person who signs off." };
    }
    return {
      ...q,
      acknowledged: { ...who, ...(unstated.length && address && { foundAt: address }), ...(q.holds?.length && why && { reason: why }) },
    };
  });
  if ("error" in saved) return saved;
  await audit(who.by, deploymentId, "deployment.validation.acknowledge", {
    question,
    flags: saved.target.flags,
    ...(saved.target.languageCheck && { languageCheck: saved.target.languageCheck }),
    ...(saved.target.holds?.length && { holds: saved.target.holds.map((h) => h.text), reason: why }),
    ...(address && { foundAt: address }),
    name: who.name,
    verified: who.verified,
  });
  return { validation: saved.validation };
}

// "The site doesn't cover this": a question with no answer passes on the no-answer reply and
// the handoff, with the person's reason. Recorded on the answer, shown on Review and audited.
export async function markNotCovered(
  deploymentId: string,
  index: number,
  question: string,
  reason: string,
  who: Confirmation,
): Promise<{ validation: ValidationResult } | { error: string }> {
  const why = reason.trim().slice(0, 300);
  if (why.length < 3) return { error: "Say in a line why the site doesn't cover it, for the person who signs off." };
  const saved = await saveQuestion(deploymentId, index, question, (q) => {
    // No answer, or a Check this answer (very short, or off-source): round 5.
    if (q.answered && !q.checks?.length && !openHold(q)) return { error: "It has an answer now: nothing to decide." };
    if (q.starter) return { error: "A starter question needs an answer: remove it in Starter questions instead." };
    return { ...q, notCovered: { ...who, reason: why } satisfies Decision };
  });
  if ("error" in saved) return saved;
  await audit(who.by, deploymentId, "deployment.validation.not-covered", { question, reason: why, name: who.name, verified: who.verified });
  return { validation: saved.validation };
}

// ---- fixing a No answer with the site's own pages ----

// Track A's side (lib/content.ts): the sitemap's pages that may answer a question (key pages
// first, matched on one intent word), and pages a person adds to the sync by hand.
export type PageCandidate = content.PageCandidate;

// "Pages on the site that may answer this", from the whole sitemap or crawl, not only the synced
// pages: up to 5, key pages first.
// With track A's note when the page most likely to answer is already in the sync (telerik.com's
// /purchase.aspx and /contact, whatsupgold.com's /de/preise), so the panel says so instead of
// offering only "Already synced" pages.
export async function pageCandidates(
  deploymentId: string,
  question: string,
): Promise<{ pages: PageCandidate[]; note?: string } | { error: string }> {
  try {
    const pages = await content.sitemapCandidates(deploymentId, question, 5);
    const note = content.syncedAnswerNote(pages);
    return { pages, ...(note && { note }) };
  } catch (err) {
    return { error: `Couldn't read the site's pages: ${err instanceof Error ? err.message : err}` };
  }
}

// A page added by hand that trips a date or stale-price rule: asked before it's kept ("This page
// states a price and was published 11 Oct 2016. Keep it anyway?"), with a name and a reason.
export interface KeepAsk {
  url: string;
  rule: string;
  title?: string;
}

// Adds pages to the sync by hand (track A's pinPages), kept anyway with the reason when one is
// given. Pages that need a reason come back in needsReason, not added.
export async function addPagesByHand(
  deploymentId: string,
  urls: readonly string[],
  who: Confirmation,
  keepReason?: string,
): Promise<{ added: string[]; needsReason: KeepAsk[] } | { error: string }> {
  const pages = [...new Set(urls.filter((u) => /^https?:\/\//.test(u)))].slice(0, 5);
  if (!pages.length) return { error: "Tick at least one page to add." };
  const reason = keepReason?.trim().slice(0, 300);
  if (keepReason !== undefined && (!reason || reason.length < 3)) return { error: "Say in a line why the page should be kept anyway." };
  try {
    const result = await content.pinPages(deploymentId, pages, who.by, reason ? { reason, who, urls: pages } : undefined);
    if (!result.added.length && result.refused.length && !result.needsReason.length) {
      return { error: result.refused.map((r) => r.reason).join(" ") };
    }
    return { added: result.added, needsReason: result.needsReason };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// "Add these pages": kept whatever the budget and synced ahead of the queue (track A's pinPages),
// and recorded on the question, which the worker asks again once they're answerable. A page that
// trips a date or stale-price rule isn't added until the person keeps it anyway, with a reason
// (`keep`): until then the pages that need one come back.
export async function addPagesFor(
  deploymentId: string,
  index: number,
  question: string,
  urls: string[],
  who: Confirmation,
  keep?: string,
): Promise<{ validation: ValidationResult; needsReason?: KeepAsk[] } | { error: string; needsReason?: KeepAsk[] }> {
  const [d] = await db().select({ validation: deployments.validation }).from(deployments).where(eq(deployments.id, deploymentId));
  if (asRun(d?.validation)?.questions[index]?.question !== question)
    return { error: "Validation has run again since: check the new answers." };
  const pinned = await addPagesByHand(deploymentId, urls, who, keep);
  if ("error" in pinned) return pinned;
  if (!pinned.added.length) return { error: "Keep it anyway, or untick it.", needsReason: pinned.needsReason };
  const saved = await saveQuestion(deploymentId, index, question, (q) => ({ ...q, added: { ...who, urls: pinned.added } }));
  if ("error" in saved) return saved;
  await audit(who.by, deploymentId, "deployment.validation.add-pages", {
    question,
    urls: pinned.added,
    ...(keep && { kept: keep }),
    name: who.name,
    verified: who.verified,
  });
  return { validation: saved.validation, ...(pinned.needsReason.length && { needsReason: pinned.needsReason }) };
}

// One question asked again and judged in place, keeping the person's decisions that still apply.
// The worker asking it again (once its added pages are answerable) marks the run as automatic.
export async function askAgain(
  deploymentId: string,
  index: number,
  question: string,
  opts: { auto?: ValidationRun["auto"] } = {},
): Promise<{ validation: ValidationRun } | { error: string; refused?: Refusal }> {
  const client = await readerClient(deploymentId);
  if (client.error !== undefined) return { error: client.error };
  const target = asRun(client.d.validation)?.questions[index];
  if (target?.question !== question) return { error: "Validation has run again since: check the new answers." };
  const asked = await orRefused(async () =>
    askAndJudge(
      client,
      { question, own: Boolean(target.own), starter: Boolean(target.starter), ...(target.intent && { intent: target.intent }) },
      await contentLanguages(deploymentId),
    ),
  );
  if ("refused" in asked) return asked;
  const { judged } = asked;
  const at = new Date().toISOString();
  const saved = await saveQuestion(
    deploymentId,
    index,
    question,
    (q) => ({
      ...carriedOver(q, { ...judged, ...(q.starterOnly && { starterOnly: true as const }) }),
      ...(q.added && { added: { ...q.added, askedAgain: at } }),
    }),
    opts.auto ? { auto: opts.auto } : {},
  );
  if ("error" in saved) return saved;
  await audit(null, deploymentId, "deployment.validation.ask-again", {
    question,
    answered: judged.answered,
    ...(opts.auto && { auto: opts.auto }),
  });
  return { validation: saved.validation };
}

// "Run it now" (Review and Validate, while a run waits for half the pages): the last run's
// questions asked again now, by the person.
export async function runAgainNow(deploymentId: string, actor: string | null): Promise<{ passed: boolean } | { error: string }> {
  const result = await runValidation(deploymentId, actor);
  return "error" in result ? result : { passed: result.validation.passed };
}

// ---- starter questions ----

// What the picker showed for each row, so Use these saves the answer the person read and judged,
// not a fresh ask that can come back different (round 7: a row shown as Answered was refused for a
// Check this the new ask raised). Kept in memory for half an hour; a restart just asks again.
const SHOWN_TTL_MS = 30 * 60_000;
const shown = new Map<string, { answer: RunQuestion; at: number }>();
const shownKey = (deploymentId: string, question: string) => `${deploymentId}|${questionKey(question)}`;
function remember(deploymentId: string, answer: RunQuestion): RunQuestion {
  const now = Date.now();
  for (const [k, v] of shown) if (now - v.at > SHOWN_TTL_MS) shown.delete(k);
  shown.set(shownKey(deploymentId, answer.question), { answer, at: now });
  return answer;
}
function shownAnswer(deploymentId: string, question: string): RunQuestion | undefined {
  const got = shown.get(shownKey(deploymentId, question));
  return got && Date.now() - got.at <= SHOWN_TTL_MS ? got.answer : undefined;
}

// One suggestion asked as a starter, for the picker to show its answer and sources before it's
// ticked. Nothing is saved.
export async function askStarter(deploymentId: string, question: string): Promise<{ answer: RunQuestion } | { error: string }> {
  const client = await readerClient(deploymentId);
  if (client.error !== undefined) return { error: client.error };
  const q = question.trim().replace(/\s+/g, " ").slice(0, MAX_STARTER_LENGTH);
  if (!q) return { error: "Type the question first." };
  const asked = await orRefused(async () =>
    askAndJudge(client, { question: q, own: false, starter: true }, await contentLanguages(deploymentId)),
  );
  if ("refused" in asked) return asked;
  return { answer: remember(deploymentId, asked.judged) };
}

// The picker's suggestions asked together, a few at a time and judged as they come in (round 6:
// asked one server action at a time, 19 rows took 40–80 s; the budget is 30 s for 6). Nothing is saved.
export const PICKER_CONCURRENCY = 6;
export async function askStartersBatch(
  deploymentId: string,
  questions: readonly string[],
): Promise<{ answers: { question: string; answer: RunQuestion }[] } | { error: string }> {
  const client = await readerClient(deploymentId);
  if (client.error !== undefined) return { error: client.error };
  const qs = [...new Set(questions.map((q) => q.trim().replace(/\s+/g, " ").slice(0, MAX_STARTER_LENGTH)).filter(Boolean))].slice(0, 30);
  const asked = await orRefused(async () =>
    askAll(
      client,
      qs.map((question) => ({ question, own: false, starter: true })),
      await contentLanguages(deploymentId),
      undefined,
      PICKER_CONCURRENCY,
    ),
  );
  if ("refused" in asked) return asked;
  return { answers: asked.map(({ judged }) => ({ question: judged.question, answer: remember(deploymentId, judged) })) };
}

// The starter-question picker's "Use these": the widget's starters, chosen by a person. Each new
// one is asked first, and a suggestion that gets No answer, is held (may not answer, the judge,
// the key pages' facts) or is Check this can't be saved until a named person decides (round 5):
// I checked it for a Check this, a reason for a held answer; No answer can't be a starter. Then
// they're saved and asked into the latest run; starters no longer chosen leave the run.
export async function saveStarters(
  deploymentId: string,
  chosen: string[],
  who: Confirmation,
  // Check this suggestions the person said "I checked it" to in the picker.
  checked: readonly string[] = [],
  // Held suggestions a person kept, each with why it's right.
  decided: readonly { question: string; reason: string }[] = [],
  // Where a person found a figure no synced page states.
  foundAt: readonly { question: string; url: string }[] = [],
): Promise<
  | { starters: string[]; asked: number }
  | { error: string; blocked?: { question: string; need: StarterNeed; why: string; answer: RunQuestion }[] }
> {
  const starters = [...new Set(chosen.map((q) => q.trim().replace(/\s+/g, " ")).filter(Boolean))];
  if (starters.length > MAX_STARTERS) return { error: `Choose at most ${MAX_STARTERS} starter questions.` };
  if (starters.some((q) => q.length > MAX_STARTER_LENGTH)) return { error: `Keep each question under ${MAX_STARTER_LENGTH} characters.` };
  if (starters.some(isUnfinishedStub)) return { error: "Finish the questions marked …" };
  const problem = starters.map(starterProblem).find(Boolean);
  if (problem) return { error: problem };
  const client = await readerClient(deploymentId);
  if (client.error !== undefined) return { error: client.error };
  const run = asRun(client.d.validation);
  // The new ones asked now, judged as validation judges them, the picker's decisions applied.
  const have = new Set((run?.questions ?? []).filter((q) => q.answered && !openHold(q)).map((q) => questionKey(q.question)));
  const fresh = starters.filter((q) => !have.has(questionKey(q)));
  // The answers the picker showed, as shown; the rest asked now.
  const seen = fresh.flatMap((q) => {
    const a = shownAnswer(deploymentId, q);
    return a ? [{ judged: a }] : [];
  });
  const unseen = fresh.filter((q) => !shownAnswer(deploymentId, q));
  const fresher = await orRefused(async () =>
    askAll(
      client,
      unseen.map((question) => ({ question, own: false, starter: true })),
      await contentLanguages(deploymentId),
    ),
  );
  if ("refused" in fresher) return fresher;
  const answers = [...seen, ...fresher];
  const picked = { checked, decided, foundAt, who };
  const asked = answers.map(({ judged }) => decide(judged, picked));
  // Judged by validation's rules (starterNeed), with the person's decisions: each refusal names the
  // row and what it needs, in the screen's words, with the answer as it came back this time.
  const blocked = answers.flatMap(({ judged }) => {
    const { need, why } = starterNeed(judged, pickFor(judged.question, picked));
    return need === "ok" ? [] : [{ question: judged.question, need, why, answer: judged }];
  });
  if (blocked.length) {
    return {
      error: `Not saved: ${blocked.map((b) => `“${b.question}”: ${b.why}`).join("; ")}.`,
      blocked,
    };
  }
  const [d] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
  if (!d) return { error: "This deployment no longer exists." };
  const { starters: before, ...rest } = d.widgetSettings;
  const widgetSettings = starters.length ? { ...rest, starters } : rest;
  await db()
    .update(deployments)
    .set({ widgetSettings, confirmations: { ...d.confirmations, starters: who } })
    .where(eq(deployments.id, deploymentId));
  await audit(who.by, deploymentId, "deployment.starters", {
    before: before ?? [],
    after: starters,
    name: who.name,
    verified: who.verified,
    picker: true,
    ...(decided.length && { decided }),
  });
  const added = await askStarters(deploymentId, { ...picked, answers: asked });
  return { starters, asked: added };
}

// The picker's decisions as validation-rules' StarterPick, for one question.
interface Picked {
  checked?: readonly string[];
  decided?: readonly { question: string; reason: string }[];
  foundAt?: readonly { question: string; url: string }[];
  who?: Confirmation;
}
function pickFor(question: string, picked: Picked): StarterPick {
  const key = questionKey(question);
  const reason = picked.decided?.find((x) => questionKey(x.question) === key)?.reason;
  const foundAt = picked.foundAt?.find((x) => questionKey(x.question) === key)?.url;
  return {
    checked: (picked.checked ?? []).some((x) => questionKey(x) === key),
    ...(reason && { reason }),
    ...(foundAt && { foundAt }),
  };
}

// A starter's answer with the picker's decisions, recorded as validation records them
// (applyStarterPick): I checked it on anything to check (a price outside the table, a date, a Check
// this), a reason on a hold. It carries into the run.
function decide(q: RunQuestion, picked: Picked): RunQuestion {
  return applyStarterPick(q, pickFor(q.question, picked), picked.who);
}

// The latest run brought in line with the widget's starters: questions marked as starters or
// not, new ones asked and added at the end, ones no longer chosen taken out. Returns how many
// were asked. A deployment that hasn't run validation yet asks them in its first run. Anything
// else that saves starters (the widget configurator) calls it too.
// A starter the person checked or decided in the picker keeps that decision (decide).
export async function askStarters(
  deploymentId: string,
  picked: Picked & {
    // Answers the picker's save asked already.
    answers?: readonly RunQuestion[];
  } = {},
): Promise<number> {
  const client = await readerClient(deploymentId);
  if (client.error !== undefined) return 0;
  const run = asRun(client.d.validation);
  if (!run) return 0;
  const starters = chosenStarters(client.d.widgetSettings);
  const keys = new Set(starters.map(questionKey));
  const given = new Map((picked.answers ?? []).map((q) => [questionKey(q.question), q]));
  const kept = run.questions
    .filter((q) => !q.starterOnly || keys.has(questionKey(q.question)))
    .map(({ starter: _, ...q }): RunQuestion => (keys.has(questionKey(q.question)) ? { ...q, starter: true } : q))
    // A question the save just asked again takes its new answer.
    .map((q) => {
      const now = given.get(questionKey(q.question));
      return now
        ? {
            ...now,
            ...(q.starterOnly && { starterOnly: true as const }),
            ...(q.own && { own: true }),
            ...(q.intent && { intent: q.intent }),
          }
        : q;
    });
  const have = new Set(kept.map((q) => questionKey(q.question)));
  const missing = starters.filter((q) => !have.has(questionKey(q)));
  const toAsk = missing.filter((q) => !given.has(questionKey(q)));
  // Refused: the run stays as it is, and the next run asks the new starters (every run does).
  const got = await orRefused(async () =>
    askAll(
      client,
      toAsk.map((question) => ({ question, own: false, starter: true })),
      await contentLanguages(deploymentId),
    ),
  );
  if ("refused" in got) return 0;
  const answers = got;
  const asked = new Map(answers.map(({ judged }) => [questionKey(judged.question), decide(judged, picked)]));
  const questions = [
    ...kept,
    ...missing.flatMap((q): RunQuestion[] => {
      const a = given.get(questionKey(q)) ?? asked.get(questionKey(q));
      return a ? [{ ...a, starterOnly: true }] : [];
    }),
  ];
  const validation: ValidationRun = { ...run, questions, passed: validationPassed(questions) };
  await db().update(deployments).set({ validation }).where(eq(deployments.id, deploymentId));
  await markReady(deploymentId, validation, client.d.preflight);
  await markHeld(deploymentId);
  return toAsk.length + given.size;
}

// ---- running again by itself (the worker's jobs/revalidate.ts) ----

const sameUrl = (url: string) => url.replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();

// After an automatic run on a signed-off (published) deployment: each live starter that got no
// answer is asked once more, and if it fails again it leaves the live chat (the widget's starters,
// in every language), audited as deployment.starters.removed for track C's alert, and recorded on
// the run for Review. A starter that turns into Check this stays: it's open, and C alerts on it.
// Only a person puts a button back. Returns what it did, for the log.
// Removal is safe by construction: only starterRemoval's "remove", which needs a reply from Agentic
// RAG that says it has no answer. A refused ask throws before getting there (AskRefused: nothing is
// saved, for the caller to stop on), and a reply that's only held stays, as an open answer.
async function removeFailingStarters(deploymentId: string, auto: StarterRemoval["auto"]): Promise<string[]> {
  const client = await readerClient(deploymentId);
  if (client.error !== undefined || !client.d.published || !client.d.signOff) return [];
  const run = asRun(client.d.validation);
  const live = new Set(chosenStarters(client.d.widgetSettings).map(questionKey));
  const failing = failingStarters(run?.questions ?? []).filter((q) => live.has(questionKey(q.question)));
  if (!run || !failing.length) return [];
  const held = await contentLanguages(deploymentId);
  const done: string[] = [];
  let questions = run.questions;
  let settings = client.d.widgetSettings;
  const removed: StarterRemoval[] = [];
  for (const q of failing) {
    const { judged, result } = await askAndJudge(client, { question: q.question, own: false, starter: true }, held);
    const key = questionKey(q.question);
    const decision = result ? starterRemoval(judged, result) : "keep";
    if (decision === "answered") {
      questions = questions.map((x) =>
        questionKey(x.question) === key ? { ...judged, ...(x.starterOnly && { starterOnly: true as const }) } : x,
      );
      done.push(`${deploymentId}: starter "${q.question}" answered when asked again`);
      continue;
    }
    if (decision === "keep") {
      done.push(`${deploymentId}: starter "${q.question}" stays: its reply doesn't say there's no answer`);
      continue;
    }
    const at = new Date().toISOString();
    settings = withoutStarter(settings, q.question);
    removed.push({ question: q.question, at, reason: "no answer", auto });
    // Out of the run: a starter-only question goes; one from the list stays, as a question.
    questions = questions
      .filter((x) => !(x.starterOnly && questionKey(x.question) === key))
      .map((x) => {
        if (questionKey(x.question) !== key) return x;
        const { starter: _s, failure, ...rest } = x;
        const left = failure
          ?.split("; ")
          .filter((f) => f !== STARTER_FAILURE)
          .join("; ");
        return { ...rest, ...(left && { failure: left }) };
      });
    done.push(`${deploymentId}: starter "${q.question}" removed from the chat after the automatic re-run (no answer, twice)`);
  }
  const validation: ValidationRun = {
    ...run,
    questions,
    passed: validationPassed(questions),
    ...(removed.length && { startersRemoved: [...(run.startersRemoved ?? []), ...removed] }),
  };
  await db()
    .update(deployments)
    .set({ validation, ...(removed.length && { widgetSettings: settings }) })
    .where(eq(deployments.id, deploymentId));
  for (const r of removed) {
    await audit(null, deploymentId, "deployment.starters.removed", {
      question: r.question,
      reason: r.reason,
      auto: r.auto,
      name: "the automatic re-run",
    });
  }
  await markHeld(deploymentId);
  return done;
}

// What the worker does each minute (jobs/revalidate.ts), each run marked auto for track C:
// - a run with under half the pages answerable runs again once half are ("half-answerable");
// - a run that asked during the first sync runs again once the sync has finished
//   ("sync-finished");
// - a question waiting on pages added by hand is asked again once they're answerable
//   ("pages-added").
// After each, a live starter with no answer is asked once more and removed if it fails again.
// Returns what it did, for the log.
// A refused ask stops it with nothing changed (a block, the whole of this minute's run; anything else,
// this deployment, with a pause), and the same work is due next time, since nothing moved on.
//
// At most one deployment's whole set is asked each minute: the rest stay due and go in the minutes
// after. Round 7: when a block cleared, 63 questions across 6 deployments went within a minute, and a
// worker restart sent 42 across 2. Each is 10 to 22 asks with the judge beside them, so a queue of six
// takes six minutes, and nothing is skipped. A question waiting on pages added by hand is a single ask
// and doesn't count. Work that failed has its own pause, so it doesn't hold up the next one.
const WHOLE_RUNS_A_MINUTE = 1;
export async function revalidate(now = new Date()): Promise<string[]> {
  // While a block stands, one ask tells whether it's over; if not, nothing else is asked.
  const blocked = await accountBlock(db()).catch(() => undefined);
  if (blocked && !(await probeAccount())) return ["the account is still blocked: nothing asked, nothing changed"];
  const rows = await db()
    .select({ id: deployments.id, validation: deployments.validation })
    .from(deployments)
    .where(
      and(
        isNotNull(deployments.kbId),
        isNotNull(deployments.validation),
        inArray(deployments.status, ["live", "paused"]),
        sql`((${deployments.validation}->'content'->>'partial') = 'true'
          or jsonb_path_exists(${deployments.validation}, '$.questions[*].added ? (!exists(@.askedAgain))'))`,
      ),
    );
  const done: string[] = [];
  let wholeRuns = 0;
  for (const d of rows) {
    const state = await syncState(d.id);
    const auto: ValidationRun["auto"] | undefined = !state
      ? undefined
      : halfwayDue(d.validation, state.content, now)
        ? "half-answerable"
        : rerunDue(d.validation, { partial: state.content.partial, processing: state.processing, finishedAt: state.finishedAt }, now)
          ? "sync-finished"
          : undefined;
    if (auto) {
      const what = auto === "half-answerable" ? "once half the pages were answerable" : "after the first sync";
      const result = await runValidation(d.id, null, undefined, { auto }).catch((err: unknown) => ({
        error: err instanceof Error ? err.message : String(err),
      }));
      if ("error" in result) {
        if ("refused" in result && result.refused?.kind === "block") {
          done.push(`${d.id}: validation ${what} waits: the account is blocked`);
          return done;
        }
        await pauseRetry(d.id, now, result.error);
        done.push(`${d.id}: validation ${what} failed: ${result.error}`);
        if (++wholeRuns >= WHOLE_RUNS_A_MINUTE) return done;
        continue;
      }
      done.push(`${d.id}: validation ran again ${what} (${result.validation.passed ? "passed" : "not passed"})`);
      if (await removalsStopped(d.id, auto, done)) return done;
      if (++wholeRuns >= WHOLE_RUNS_A_MINUTE) return done;
      continue;
    }
    const waiting = waitingOnPages(d.validation);
    if (!waiting.length) continue;
    const urls = [...new Set(waiting.flatMap((w) => w.urls))];
    const pages = await db()
      .select({ url: contentPages.url, status: contentPages.status })
      .from(contentPages)
      .where(eq(contentPages.deploymentId, d.id))
      .then((all) => all.filter((p) => urls.some((u) => sameUrl(u) === sameUrl(p.url))));
    let asked = false;
    for (const w of waiting) {
      const statuses = w.urls.map((u) => pages.find((p) => sameUrl(p.url) === sameUrl(u))?.status);
      if (!statuses.every(pageSettled) && now.getTime() - Date.parse(w.at) < ADDED_WAIT_MS) continue;
      const result = await askAgain(d.id, w.index, w.question, { auto: "pages-added" });
      // Refused: it's still waiting, and is asked again next time. A block stops the whole run.
      if ("refused" in result && result.refused?.kind === "block") {
        done.push(`${d.id}: "${w.question}" waits: the account is blocked`);
        return done;
      }
      asked ||= !("error" in result);
      done.push(
        "error" in result
          ? `${d.id}: couldn't ask "${w.question}" again: ${result.error}`
          : `${d.id}: asked "${w.question}" again with the added pages (${result.validation.questions[w.index]?.answered ? "answered" : "no answer"})`,
      );
    }
    if (asked && (await removalsStopped(d.id, "pages-added", done))) return done;
  }
  // After a sync that changed pages: the live starters and intent questions asked again (round 5).
  // Not signed off, with a refusal stored as a result by a run from before this fix: the run again.
  for (const id of await refusalsNotSignedOff(now)) {
    const result = await runValidation(id, null, undefined, { auto: "sync-finished" });
    if ("error" in result) {
      if ("refused" in result && result.refused?.kind === "block") return done;
      await pauseRetry(id, now, result.error);
    }
    done.push(`${id}: validation ran again over answers a refused ask had left`);
    if (++wholeRuns >= WHOLE_RUNS_A_MINUTE) return done;
  }
  for (const id of await changedSinceRun(now)) {
    try {
      const asked = await reaskAfterSync(id, now);
      done.push(...asked);
      // Nothing to ask (no longer signed off, no reader): it spent nothing.
      if (asked.length && ++wholeRuns >= WHOLE_RUNS_A_MINUTE) return done;
    } catch (err) {
      if (err instanceof AskRefused && err.refusal.kind === "block") {
        done.push(`${id}: asking again after the sync waits: the account is blocked`);
        return done;
      }
      const why = err instanceof Error ? err.message : String(err);
      await pauseRetry(id, now, why).catch(() => {});
      done.push(`${id}: asking again after the sync failed: ${why}`);
      if (++wholeRuns >= WHOLE_RUNS_A_MINUTE) return done;
    }
  }
  return done;
}

// removeFailingStarters from the run's loop: true when a block stopped it, for the run to stop too.
// Any refusal leaves the starters as they are.
async function removalsStopped(deploymentId: string, auto: StarterRemoval["auto"], done: string[]): Promise<boolean> {
  try {
    done.push(...(await removeFailingStarters(deploymentId, auto)));
    return false;
  } catch (err) {
    if (!(err instanceof AskRefused)) throw err;
    done.push(`${deploymentId}: starters not asked again, none removed: ${err.message}`);
    return err.refusal.kind === "block";
  }
}

// A failed try at running again waits a while (autoTried); nothing else in the run moves.
async function pauseRetry(deploymentId: string, now: Date, error: string) {
  const [d] = await db().select({ validation: deployments.validation }).from(deployments).where(eq(deployments.id, deploymentId));
  const run = asRun(d?.validation);
  if (!run) return;
  const validation: ValidationRun = { ...run, autoTried: { at: now.toISOString(), error } };
  await db().update(deployments).set({ validation }).where(eq(deployments.id, deploymentId));
}

// One small ask, while a block is recorded, to tell when it's over: nothing else may ask overnight,
// so the all-clear (and the work waiting on it) would wait for a visitor. A partner test. True when it
// answered, and the all-clear is recorded.
export async function probeAccount(): Promise<boolean> {
  const rows = await db()
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(isNotNull(deployments.kbId), inArray(deployments.status, ["live", "paused"])))
    .limit(5);
  for (const { id } of rows) {
    const client = await readerClient(id);
    if (client.error !== undefined) continue;
    const askedAt = new Date();
    const result = await client.kb
      .ask({ query: "What does this site offer?", show: ["basic"] }, { partnerTest: true, signal: AbortSignal.timeout(ASK_TIMEOUT_MS) })
      .catch(() => undefined);
    if (!result || failedReply(result)) return false;
    await recordAccountClear(db(), "the worker's check", askedAt).catch(() => false);
    return true;
  }
  return false;
}

// ---- after a sync that changed pages, and before new answering rules (round 5, item 6) ----

// Whether a question's last answer is fine for visitors: answered (or decided), nothing open.
const fine = (q: RunQuestion) => !q.failure && (q.answered || Boolean(q.notCovered) || Boolean(q.acknowledged?.reason)) && !needsCheck(q);

// A signed-off deployment's live starters and intent questions asked again after a sync that
// changed pages (nightly, a re-read, or pages added), each answer replaced in the run (decisions
// carried over while they apply), audited as an automatic run ("pages-changed") so track C's
// alerts post one when an intent question flips; then a live starter with no answer is asked
// once more and removed if it fails again (removeFailingStarters). A refused ask throws AskRefused
// with nothing saved, so `rechecked` doesn't move and it's due again.
export async function reaskAfterSync(deploymentId: string, now = new Date()): Promise<string[]> {
  const client = await readerClient(deploymentId);
  if (client.error !== undefined) return [];
  const run = asRun(client.d.validation);
  if (!run || !client.d.published || !client.d.signOff) return [];
  const live = new Set(chosenStarters(client.d.widgetSettings).map(questionKey));
  // Build 8: price questions and live starters (a re-read cost about 12 asks), and any question a run
  // from before this fix stored a refusal on (isRefusalFailure).
  const picked = run.questions.filter((q) => asksPrice(q) || live.has(questionKey(q.question)) || isRefusalFailure(q.failure));
  const answers = await askAll(
    client,
    picked.map((q) => ({
      question: q.question,
      own: Boolean(q.own),
      ...(q.starter && { starter: true }),
      ...(q.intent && { intent: q.intent }),
      ...(q.intent && q.wording && { wording: q.wording }),
    })),
    await contentLanguages(deploymentId),
  );
  const fresh = new Map(answers.map(({ judged }) => [questionKey(judged.question), judged]));
  const questions = run.questions.map((q) => {
    const now = fresh.get(questionKey(q.question));
    return now ? carriedOver(q, { ...now, ...(q.starterOnly && { starterOnly: true as const }) }) : q;
  });
  const validation: ValidationRun = { ...run, questions, passed: validationPassed(questions), rechecked: now.toISOString() };
  await db().update(deployments).set({ validation }).where(eq(deployments.id, deploymentId));
  const opened = openedSince(run, questions);
  await audit(null, deploymentId, "deployment.validate", {
    passed: validation.passed,
    asked: picked.length,
    answered: questions.filter(fine).length,
    auto: "pages-changed",
    ...(opened.length && { opened }),
  });
  await markHeld(deploymentId);
  const flipped = opened.length ? `, ${opened.length} now open` : "";
  return [
    `${deploymentId}: ${picked.length} live starters and intent questions asked again after a sync that changed pages${flipped}`,
    ...(await removeFailingStarters(deploymentId, "pages-changed")),
  ];
}

// A person confirmed the price table: the chat's answers on price change at once, so the run's price
// questions are asked again (at most PRICE_REASKS, the intent's and the live starters' first), each
// answer replaced in the run with decisions carried over, and what visitors now get, a replacement
// included, kept on the confirmation for the card. Only on Confirm. A refused ask leaves the run as it
// was and says so. Never throws.
export async function askPricesAgain(deploymentId: string, now = new Date()): Promise<{ questions: PriceReask[]; note?: string }> {
  const client = await readerClient(deploymentId);
  if (client.error !== undefined) return { questions: [] };
  const run = asRun(client.d.validation);
  if (!run) return { questions: [] };
  const picked = priceQuestionsToAsk(run.questions, chosenStarters(client.d.widgetSettings).map(questionKey));
  if (!picked.length) return { questions: [] };
  const save = async (reasked: NonNullable<PriceTableConfirmation["reasked"]>) => {
    const confirmation = client.d.priceTableConfirmation;
    if (confirmation)
      await db()
        .update(deployments)
        .set({ priceTableConfirmation: { ...confirmation, reasked } })
        .where(eq(deployments.id, deploymentId));
  };
  try {
    const answers = await askAll(
      client,
      picked.map((q) => ({
        question: q.question,
        own: Boolean(q.own),
        ...(q.starter && { starter: true }),
        ...(q.intent && { intent: q.intent }),
        ...(q.intent && q.wording && { wording: q.wording }),
      })),
      await contentLanguages(deploymentId),
    );
    const fresh = new Map(answers.map(({ judged }) => [questionKey(judged.question), judged]));
    const questions = run.questions.map((q) => {
      const got = fresh.get(questionKey(q.question));
      if (got) return carriedOver(q, { ...got, ...(q.starterOnly && { starterOnly: true as const }) });
      // Past the cap: it was checked against the table as it stood, so it no longer says it matches.
      const { tableMatched: _checkedBefore, ...notAsked } = q;
      return notAsked;
    });
    const validation: ValidationRun = { ...run, questions, passed: validationPassed(questions), rechecked: now.toISOString() };
    const asked = questions.filter((q) => picked.some((p) => questionKey(p.question) === questionKey(q.question))).map(priceReask);
    await db().update(deployments).set({ validation }).where(eq(deployments.id, deploymentId));
    await save({ at: now.toISOString(), questions: asked });
    const opened = openedSince(run, questions);
    await audit(null, deploymentId, "deployment.validate", {
      passed: validation.passed,
      asked: picked.length,
      answered: questions.filter(fine).length,
      auto: "price-table",
      ...(opened.length && { opened }),
    });
    return { questions: asked };
  } catch (err) {
    const note = err instanceof AskRefused ? err.message : err instanceof Error ? err.message : String(err);
    await save({ at: now.toISOString(), questions: [], note }).catch(() => {});
    return { questions: [], note };
  }
}

const REASK_PAUSE_MS = 10 * 60_000;

async function refusalsNotSignedOff(now: Date): Promise<string[]> {
  const rows = await db()
    .select({ id: deployments.id, validation: deployments.validation })
    .from(deployments)
    .where(
      and(
        isNotNull(deployments.kbId),
        isNotNull(deployments.validation),
        isNull(deployments.signOff),
        inArray(deployments.status, ["live", "paused"]),
      ),
    );
  return rows.flatMap((r) => {
    const run = asRun(r.validation);
    if (!run?.questions.some((q) => isRefusalFailure(q.failure))) return [];
    return run.autoTried && now.getTime() - Date.parse(run.autoTried.at) < REASK_PAUSE_MS ? [] : [r.id];
  });
}

// Signed-off deployments whose pages changed in a sync that finished since the last run or recheck.
async function changedSinceRun(now: Date): Promise<string[]> {
  const rows = await db()
    .select({ id: deployments.id, validation: deployments.validation, lastSyncedAt: syncSources.lastSyncedAt })
    .from(deployments)
    .innerJoin(syncSources, and(eq(syncSources.deploymentId, deployments.id), eq(syncSources.kind, "sitemap")))
    .where(
      and(
        isNotNull(deployments.kbId),
        isNotNull(deployments.validation),
        isNotNull(deployments.signOff),
        eq(deployments.published, true),
        inArray(deployments.status, ["live", "paused"]),
      ),
    );
  const due: string[] = [];
  for (const r of rows) {
    const run = asRun(r.validation);
    if (!run || run.content?.partial || !r.lastSyncedAt) continue;
    // A try Agentic RAG failed waits a while.
    if (run.autoTried && now.getTime() - Date.parse(run.autoTried.at) < REASK_PAUSE_MS) continue;
    const since = new Date(run.rechecked && run.rechecked > run.at ? run.rechecked : run.at);
    // A refusal a run from before this fix stored as a result is asked again, whatever the sync did.
    if (run.questions.some((q) => isRefusalFailure(q.failure))) {
      due.push(r.id);
      continue;
    }
    // Settled: the sync finished at least 10 minutes ago, after the run.
    if (r.lastSyncedAt <= since || now.getTime() - r.lastSyncedAt.getTime() < 10 * 60_000) continue;
    const [changed] = await db()
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(contentPages)
      .where(
        and(
          eq(contentPages.deploymentId, r.id),
          sql`(${contentPages.indexedAt} > ${since.toISOString()} or (${contentPages.status} in ('removed', 'skipped') and ${contentPages.updatedAt} > ${since.toISOString()}))`,
        ),
      );
    if ((changed?.n ?? 0) > 0) due.push(r.id);
  }
  return due;
}

export interface Recheck {
  total: number;
  unchanged: number;
  better: number;
  // Answers that got worse: was fine, now No answer, held or Check this, or a starter that fails.
  worse: { question: string; before: string; after: string; was: string }[];
}

// A signed-off deployment's last validation set and live starters asked under the latest
// answering rules (not yet saved: asked inline, as partner tests visitors never see), judged as
// validation judges, compared with the last run. Nothing is saved. jobs/rules-rollout.ts switches
// the deployment when nothing got worse.
export async function recheckUnderLatestRules(
  deploymentId: string,
  opts: { cache?: boolean } = {},
): Promise<Recheck | { error: string; retry?: true; refused?: Refusal }> {
  const client = await readerClient(deploymentId);
  if (client.error !== undefined) return { error: client.error };
  const run = asRun(client.d.validation);
  if (!run?.questions.length) return { error: "No validation run to re-check." };
  const drafts = run.questions.map((q) => ({
    question: q.question,
    own: Boolean(q.own),
    ...(q.starter && { starter: true }),
    ...(q.intent && { intent: q.intent }),
    ...(q.intent && q.wording && { wording: q.wording }),
  }));
  const held = await contentLanguages(deploymentId);
  const extra = opts.cache === false ? { cache: false } : {};
  // Like with like (round 6): the same questions asked now under the rules the chat runs and under
  // the latest, side by side, not against the last run's answers, which came from older pages.
  // Agentic RAG refusing (402 budget, 5xx, a timeout): neither apply nor hold; try again later.
  try {
    const [current, latest] = await Promise.all([
      askAll({ ...client, ...extra }, drafts, held),
      askAll({ ...client, inline: true, ...extra }, drafts, held),
    ]);
    const first = recheckDiff(
      run.questions,
      current.map((a) => a.judged),
      latest.map((a) => a.judged),
    );
    if (!first.worse.length) return first;
    // Before calling an answer worse, it's asked once more under the latest rules: worse only when
    // the second ask is worse too (round 6: one empty sample held whatsupgold.com).
    const keys = worseToAskAgain(first);
    const again = await askAll(
      { ...client, inline: true, ...extra },
      drafts.filter((q) => keys.has(questionKey(q.question))),
      held,
    );
    return recheckDiffAfterSecondAsk(
      run.questions,
      current.map((a) => a.judged),
      latest.map((a) => a.judged),
      again.map((a) => a.judged),
    );
  } catch (err) {
    if (!(err instanceof AskRefused)) throw err;
    return { ...refusedResult(err), retry: true };
  }
}

// The domain-lock check alone (after editing domains).
export async function runPreflight(deploymentId: string): Promise<PreflightResult | undefined> {
  const [d] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
  if (!d?.kbId) return undefined;
  const preflight = await checkPreflight(d.zone, d.kbId, d.domains);
  await db().update(deployments).set({ preflight }).where(eq(deployments.id, deploymentId));
  if (d.validation) await markReady(deploymentId, d.validation, preflight);
  return preflight;
}

async function audit(actor: string | null, deploymentId: string, action: string, detail: Record<string, unknown>) {
  await db()
    .insert(auditLog)
    .values(await withSetupName({ actorUserId: actor, action, targetType: "deployment", targetId: deploymentId, detail }));
}
