// The search configuration every deployment answers with ("launchpad-default"): the partner's
// system prompt plus one language rule and today's date, the console's own user prompt (the
// answering rules, read right after the site's text), and the retrieval settings verified in
// the M0 spike plus page titles. Beside it, one configuration per intent ("launchpad-default-price"
// and so on, round 5): the same, kept to the pages labelled for the intent, with a line for it.
//
// The answering rules are versioned (ANSWERING_RULES), and each deployment records the version its
// chat runs (deployments.answering_rules). A new version reaches a signed-off deployment only after
// the worker re-asks its last validation set and live starters under it and nothing gets worse
// (jobs/rules-rollout.ts); saving the prompt applies the latest at once. The worker refreshes only
// the date every day (jobs/prompt-date.ts), never the rules.

import type { AskConfig } from "@launchpad/par-client";
import {
  datesIn,
  intentConfigName,
  type LanguageSetting,
  languageName,
  NO_CONTEXT_ANSWER,
  NOT_GENERATED,
  type PriceRow,
  ROUTE_INTENTS,
  type RouteIntent,
  rowTerms,
  shownQualifiers,
  withoutGenerated,
  withToday,
} from "@launchpad/theme";
import { namesNoEvent } from "./content-plan.ts";

export const SEARCH_CONFIG = "launchpad-default";

// The latest answering rules: prompt rules, retrieval settings, intent configurations and the
// verdict. 0: everything before round 5 (pushed hourly to every deployment). 1 (round 5): partial
// answers name the page they read, never the whole site (PARTIAL_RULE); intent questions are
// answered from their intent's pages (intent configurations); grounded answers are shown whatever
// their relevance score. Bump it with any change to what composeUserPrompt, searchConfigFor or
// intentSearchConfig produce (test/answering-rules.test.ts fails otherwise).
export const ANSWERING_RULES = 7;
// What each version changes, in the History line and the hold alert.
export const ANSWERING_RULES_CHANGES: Record<number, string> = {
  1: "partial answers name the page they read and never say the whole site lacks something; price, buy, trial, events, support and contact questions are answered from their pages first",
  2: "past events are told as past; pages are named by their title, never as the provided or available text",
  3: "events questions list upcoming events soonest first, by full date with the year (round 6: teamwork.com named 5 Nov ahead of 4 Nov)",
  4: "the events configuration's prompt lists the site's upcoming events, soonest first with full dates, refreshed daily (round 6: teamwork.com still led with 5 Nov under v3)",
  6: "the price configuration's prompt lists the price table's rows, with unit, period and qualifiers, so a price the retrieved paragraphs miss or scramble isn't denied or shifted (round 7: Kemp's Standard, ShareFile's Enterprise, chef's unit, Kemp's German answers)",
  7: "an event dated before today is never offered as the next or upcoming one, even when its page still invites to it, and a number in a name is a version, not a date (round 7: clopaydoor.com's tour of 24-25 October told as next on 2 November, mvtec.com's \"HALCON 26.11\" read as 26 November); dates the reader can't pair with an event stay out of the events list",
  5: 'each event is told in the tense its date gives, and nothing is called upcoming-free while a page dates one today or later (round 7: wartsila\'s "took place on 2–4 December 2026", bynder\'s "We will be at … October 27, 2026")',
};
// The version from which a deployment has the intent configurations saved beside its default one.
export const INTENT_CONFIGS_SINCE = 1;

// The saved search configuration a deployment asks with. The console saves one only when it
// provisions the KB with a prompt; deployments imported from existing KBs have none, and ask
// with the KB's own defaults (asking with a missing one is a 400).
export const searchConfigName = (d: { systemPrompt: string; searchConfig: string }): string | undefined =>
  d.systemPrompt ? d.searchConfig : undefined;

// `today: null` leaves the date out (comparisons, tests). `events`: the events configuration's
// list of upcoming events (eventsParagraph), just before the date.
export function composeSystemPrompt(
  prompt: string,
  language: LanguageSetting,
  today: Date | null = new Date(),
  events?: readonly PromptEvent[],
  prices?: readonly PriceRow[],
): string {
  const rule =
    language === "auto"
      ? "Answer in the language the question is asked in."
      : `Always answer in ${languageName(language)}, whatever language the question is in.`;
  const composed = `${prompt.trim()}\n\n${rule}${events ? `\n\n${eventsParagraph(events)}` : ""}${prices ? `\n\n${pricesParagraph(prices)}` : ""}`;
  return today ? withToday(composed, today) : composed;
}

// ---- the upcoming events, in the events configuration's prompt (answering rules 4) ----
//
// Round 6, recheck 2 (teamwork.com, 1 Nov 2026): under v3, "When is the next webinar?" led with the
// 5 Nov webinar 4 of 4 times, one answer calling the 4 Nov one past. The prompt and its date were
// right, and the 4 Nov page's date reads "Wednesday, November 4th, 2026" in the Knowledge Box. But
// the first paragraph retrieved was the 4 Nov page's "Latest Webinars" sidebar, "live webinars |
// Thursday, November 5th Professional Services in 2027…", with no year; the 5 Nov page's own date
// paragraph wasn't retrieved at all; and 15 of the 20 paragraphs were the site-wide banner "Live
// webinars, 4 & 5 Nov. 2026". The model had to sort and place dates from fragments. With the
// site's upcoming events listed here, soonest first with full dates, the next webinar was named
// first 4 of 4 times. The worker refreshes the list with the date every day (jobs/prompt-date.ts).

// An upcoming event as the prompt lists it, from a synced page's events facts (content.ts
// eventsForPrompt). `name`: the page's heading; `title`: its title (what the Knowledge Box's
// text calls the page); `line`: the page's words around the date.
export interface PromptEvent {
  date: string;
  url: string;
  line: string;
  name?: string;
  title?: string;
  // The page's language: the list keeps room for each (eventsToList).
  lang?: string;
}

export const EVENTS_LIST_START = "Our upcoming events, soonest first";
// Events listed at most, per language: soonest first, so the cap drops the latest.
export const EVENTS_LISTED = 8;
// A line on this many pages or more is a site-wide banner, not an event's own page.
const BANNER_PAGES = 3;

const EVENT_DAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const oneLine = (text: string, max: number) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

// An event's own page: an events address, or a page whose dated line starts with the date
// ("Wednesday, November 4th · 8:00am PST"), as an event page heads its date. Pure.
const EVENT_PATH =
  /\/(?:[^/]*[-_])?(?:webinars?|events?|conferences?|summits?|meetups?|workshops?|seminars?|trainings?|veranstaltungen|evenements|eventos|webinare)(?:[-_/]|$)/i;
const DATE_FIRST =
  /^\s*(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\d{1,2}(?:st|nd|rd|th)?[\s./-]|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d)/i;
// An events index: an address ending in an events folder, which lists many (seeburger.com's
// /de/ressourcen/events, hms-networks.com's /events).
const EVENT_INDEX =
  /\/(?:[^/]*[-_])?(?:webinars?|events?|conferences?|summits?|meetups?|workshops?|seminars?|trainings?|veranstaltungen|evenements|eventos|webinare)\/?$/i;
const eventsIndex = (url: string) => {
  try {
    return EVENT_INDEX.test(new URL(url).pathname);
  } catch {
    return false;
  }
};
const onEventPath = (url: string) => {
  try {
    return EVENT_PATH.test(new URL(url).pathname);
  } catch {
    return EVENT_PATH.test(url);
  }
};
const eventPage = (e: PromptEvent) => onEventPath(e.url) || DATE_FIRST.test(e.line);

// The events to list: soonest first, one per page, except an events index, whose events are each
// listed (round 7: only its first reached the prompt, and the model mixed the rest from fragments;
// an event's own page keeps one, so a sidebar's dates don't pass as its own); for a date an event's own page gives, only such
// pages (not the product pages promoting it); site-wide banners ("Live webinars, 4 & 5 Nov" on
// sixty pages) only for a date nothing else gives; each event once (round 7: on mvtec.com one webinar
// took 5 of 8 places, from its index, its detail page and two sessions); at most EVENTS_LISTED per
// language, so a German visitor's events aren't crowded out by English ones. Pure.
export function eventsToList(events: readonly PromptEvent[]): PromptEvent[] {
  const shape = (line: string) =>
    line
      .toLowerCase()
      .replace(/[^\p{L}]+/gu, " ")
      .trim();
  // A date with nothing naming its event, where the page lists several: which event it belongs to
  // wasn't clear when the page was read, so it isn't stated (round 7: mvtec.com's dates paired with
  // the event before them). An event's own page, with one date, is named by its heading.
  const nameless = new Map<string, number>();
  for (const e of events) if (namesNoEvent(e.line)) nameless.set(e.url, (nameless.get(e.url) ?? 0) + 1);
  const unclear = (e: PromptEvent) => namesNoEvent(e.line) && (eventsIndex(e.url) || (nameless.get(e.url) ?? 0) > 1 || !onEventPath(e.url));
  const pages = new Map<string, Set<string>>();
  for (const e of events) pages.set(shape(e.line), (pages.get(shape(e.line)) ?? new Set()).add(e.url));
  const banner = (e: PromptEvent) => (pages.get(shape(e.line))?.size ?? 0) >= BANNER_PAGES;
  const rank = (e: PromptEvent) => (eventPage(e) ? 0 : banner(e) ? 2 : 1);
  const sorted = events
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && !unclear(e))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : rank(a) - rank(b) || (a.url < b.url ? -1 : 1)));
  const best = new Map<string, number>();
  for (const e of sorted) best.set(e.date, Math.min(best.get(e.date) ?? 2, rank(e)));
  const seen = new Set<string>();
  const bannerDates = new Set<string>();
  const kept: PromptEvent[] = [];
  for (const e of sorted) {
    const key = eventsIndex(e.url) ? `${e.url} ${e.date} ${e.line}` : e.url;
    if (seen.has(key) || rank(e) > (best.get(e.date) ?? 2)) continue;
    if (rank(e) === 2) {
      if (bannerDates.has(e.date)) continue;
      bannerDates.add(e.date);
    }
    seen.add(key);
    if (!kept.some((k) => sameEvent(k, e))) kept.push(e);
  }
  const room = new Map<string, number>();
  return kept.filter((e) => {
    const taken = room.get(e.lang ?? "") ?? 0;
    room.set(e.lang ?? "", taken + 1);
    return taken < EVENTS_LISTED;
  });
}

// The same event told twice: on one day, in one language, mostly in the same words. A line that holds
// only a date says nothing of which event, so two pages' such lines go by their names.
const longWords = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length >= 4);
function sameEvent(a: PromptEvent, b: PromptEvent): boolean {
  if (a.date !== b.date || (a.lang ?? "") !== (b.lang ?? "")) return false;
  if (namesNoEvent(a.line) || namesNoEvent(b.line)) return a.url === b.url || Boolean(a.name && a.name === b.name);
  const [x, y] = [new Set(longWords(a.line)), new Set(longWords(b.line))];
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared >= 2 && shared >= 0.6 * Math.min(x.size, y.size);
}

// The page's own words, the date first: a long line's date is at its end and would be cut off (round
// 7: mvtec.com's German lines, "… · 05. November 2026"), and the model then said no day was given. Pure.
function dateFirst(line: string): string {
  const parts = line.split(" · ");
  const at = parts.findIndex((p, i) => i > 0 && p.length <= 40 && datesIn(p).length > 0);
  return at > 0 ? [parts[at], ...parts.slice(0, at), ...parts.slice(at + 1)].join(" · ") : line;
}

// The pages an event is stated on, as paths, for the chat's check on a reply with no date (the widget's
// route.ts datelessEvent): only addresses. Not a site-wide banner's pages. Pure.
export const EVENT_PAGES_LISTED = 60;
export function eventPagePaths(events: readonly Pick<PromptEvent, "url" | "line">[]): string[] {
  const pages = new Map<string, Set<string>>();
  for (const e of events) pages.set(e.line, (pages.get(e.line) ?? new Set()).add(e.url));
  const paths = events.filter((e) => (pages.get(e.line)?.size ?? 0) < BANNER_PAGES).map((e) => new URL(e.url).pathname.replace(/\/+$/, ""));
  // The chat matches by address, so a start page's empty path would match every page.
  return [...new Set(paths)].filter(Boolean).slice(0, EVENT_PAGES_LISTED);
}

// Whether some dated events were left out of the list because nothing says which event they are.
function eventsLeftOut(events: readonly PromptEvent[]): boolean {
  const nameless = events.filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && namesNoEvent(e.line));
  return nameless.some((e) => eventsIndex(e.url) || !onEventPath(e.url) || nameless.filter((o) => o.url === e.url).length > 1);
}

// The events configuration's paragraph: the upcoming events, soonest first, each with its full
// date (weekday, day, month and year), its name, the page and the page's own words. Pure.
export function eventsParagraph(events: readonly PromptEvent[]): string {
  const listed = eventsToList(events);
  // Some left out as unclear: the list can't be called complete, nor empty.
  const unlisted = eventsLeftOut(events);
  if (!listed.length)
    return unlisted
      ? `${EVENTS_LIST_START}, as our website's pages date them: none can be listed here. Read the events and their dates from the pages you were given, each date with the item it belongs to.`
      : `${EVENTS_LIST_START}, as our website's pages date them: none is dated today or later.`;
  const lines = listed.map((e) => {
    const day = EVENT_DAY.format(new Date(`${e.date}T12:00:00Z`));
    // An events index's heading names the list, not the event: its line does.
    const name = eventsIndex(e.url) ? "" : e.name?.trim() || e.title?.trim() || e.url;
    const page = name && e.title?.trim() && e.title.trim() !== name ? ` (our page "${oneLine(e.title, 120)}")` : "";
    return `- ${day}: ${name ? `${oneLine(name, 160)}${page}, ` : ""}${e.url}. The page says: "${oneLine(dateFirst(e.line), 160)}"`;
  });
  return [
    `${EVENTS_LIST_START}, as our website's pages date them (with the year):`,
    ...lines,
    unlisted
      ? "Name events in this order and with these dates, and never call one listed here over. Our pages date others not listed here, so the first one listed may not be the next: check the pages you were given."
      : "The first one listed is the next. Name events in this order and with these dates, and never call one listed here over.",
  ].join("\n");
}

// A saved system prompt with its events paragraph replaced by `paragraph`; unchanged when it has
// none (one saved before answering rules 4 gets the list only through the rules rollout, after
// its re-check). Pure.
export function withEventsParagraph(system: string, paragraph: string): string {
  const parts = system.split("\n\n");
  const at = parts.findIndex((p) => p.startsWith(EVENTS_LIST_START));
  if (at < 0) return system;
  parts[at] = paragraph;
  return parts.join("\n\n");
}

// ---- the price table, in the price configuration's prompt (answering rules 6) ----
//
// Round 7, recheck, by reading what the asks retrieved (2026-11-02, four read-only asks):
// - Kemp, "How much is the Standard plan?": the paragraph starts "$ 4,500 Popular Enterprise Building
//   on Standard…", the name in the paragraph before and the next plan's name right after the figure:
//   the model denies Standard's price 2 of 3 and, in German, shifts every price by one plan.
// - ShareFile: the /plans paragraph with $42.00 and $35.00 isn't among the 7 retrieved from that page.
// - chef: the stored line is "Enterprise: $ 189"; "per node, per year" is only on Business's line.
// So the rows, which the sync read from the whole page and the proof or a person checked, are listed
// for the price configuration, as the events list is for the events one. About 15 tokens a row, at most
// PRICES_LISTED rows: at most 250 tokens more on a price question, nothing on any other.
export const PRICES_LIST_START = "Our prices, as our pricing page states them";
export const PRICES_LISTED = 16;
export function pricesParagraph(rows: readonly PriceRow[]): string {
  if (!rows.length) return `${PRICES_LIST_START}: none are listed in this list.`;
  const lines = rows.slice(0, PRICES_LISTED).map((r) => {
    const per = rowTerms(r);
    const notes = shownQualifiers(r).join(", ");
    return `- ${r.addOn ? "Add-on: " : ""}${r.plan}: ${r.amount}${per ? ` ${per}` : ""}${notes ? ` (${notes})` : ""}`;
  });
  return [
    `${PRICES_LIST_START}:`,
    ...lines,
    "State these figures exactly, each for its own plan, with its unit and billing. Never say a price, unit or billing listed here isn't stated. " +
      "If a visitor asks about a volume, an extra or a plan not listed here, say so and point to the pricing page: don't work it out.",
  ].join("\n");
}

// A saved system prompt with its prices paragraph replaced; unchanged when it has none. Pure.
export function withPricesParagraph(system: string, paragraph: string): string {
  const parts = system.split("\n\n");
  const at = parts.findIndex((p) => p.startsWith(PRICES_LIST_START));
  if (at < 0) return system;
  parts[at] = paragraph;
  return parts.join("\n\n");
}

// The user prompt: what the model reads with the site's text and the question. Rules that sit
// only in the system prompt lose to the text the model has just read, so these come last.
// Measured 2026-10-30:
// - whatsupgold.com, English and German synced: with the language rule only in the system
//   prompt, 4 of 6 English answers came back in German when German pages ranked first (with a
//   stronger system rule too); with this prompt, 6 of 6 in English, and German in German.
// - telerik.com: "what should I migrate to?" about Silverlight took Xamarin's advice (".NET
//   MAUI", from a paragraph that never names Xamarin) 5 times of 5, also with a product rule;
//   with page titles in the text (`hierarchy`) and this page rule, 0 of 4.
// Agentic RAG's no_context status comes from its own sentence, so the prompt keeps asking for
// it. Never "context" or "documents" in words the model could repeat to visitors.
export const USER_PROMPT_START = "What our website says, page by page";

export function composeUserPrompt(language: LanguageSetting, intent?: RouteIntent): string {
  const lang =
    language === "auto"
      ? "Write your answer in the language of the visitor's question, even when the website text is in another language: translate it."
      : `Write your answer in ${languageName(language)}, whatever language the question or the website text is in.`;
  return [
    `${USER_PROMPT_START} (each page's text starts with its title):\n{context}`,
    "The visitor's question: {question}",
    "Answer from what our website says above. Pages can be about different products or services: answer only from the pages " +
      "about the one the visitor asks about (and general pages), and never present what a page says about one product, such as " +
      `its alternatives, migration path, prices or features, as true of another. ${lang} ${PARTIAL_RULE} ${CASE_RULE} ` +
      `${intent ? `${INTENT_RULES[intent]} ` : ""}` +
      `Only when nothing in the website text helps with the question, reply only, in English and word for word whatever the language: ${NO_CONTEXT_ANSWER}`,
  ].join("\n\n");
}

// Round 5, measured on the release check's sites (2026-10-31): with only "if the website text
// doesn't answer the question, reply only: Not enough data…", the model refused questions the
// pages answer in part. whatsupgold.com's "Was kostet WhatsUp Gold für 300 Geräte?" got the
// sentence 4 times of 4 with /de/preise's "Preis ab $1,229 für 50 Geräte… Angebot anfragen" first
// in the context: the page has no price for 300 devices. So a part of an answer is given, with what
// the page doesn't say and where to ask; the sentence is for when nothing helps.
// Answering rules 1: the same rule gave chef.io "Our website does not list specific subscription
// prices" while /how-to-buy lists $59 and $189: the model sees a few pages, never the whole site.
// So it may say what the page it read doesn't state, naming that page, and never that the website
// as a whole lacks something.
export const PARTIAL_RULE =
  "If the website text answers only part of the question (for example a starting price but not the price for what the visitor " +
  "asks about, or that prices are by quote), give that part, and point to the page or team that can tell them the rest. You may say " +
  "what the page you read doesn't state, naming it (\"Our pricing page doesn't list a price for 300 devices\"). Never say that our " +
  "website, our site or our pages as a whole don't list, state, mention or provide something: you see only part of the website.";

// A line per intent configuration: what a good answer to the intent gives (the answer-quality plan).
export const INTENT_RULES: Record<RouteIntent, string> = {
  price:
    "This is a price question: state each price exactly as the page writes it, with its currency, unit and the plan or product it belongs to, and say which plans are by quote.",
  buy: "This is a question about buying: say where and how to buy, with the page to do it on, and the prices the page states.",
  trial: "This is a question about a trial or demo: say how to start the trial or book the demo, and link the page to do it on.",
  events:
    "This is a question about events: list the upcoming events soonest first, by their full date with the year, so the first one you name is the next; leave out events dated before today, or say they took place. Call an event over only if its full date, with the year, is before today.",
  support: "This is a support question: give the support contact, phone, email, form or page exactly as the page states it.",
  contact: "This is a contact question: give the phone number, email address, form or page exactly as the page states it.",
};
// And the case asked, not a neighbouring one (crayola.com, round 5: "How do I get slime out of
// carpet?" was answered with the steps for slime on asphalt).
export const CASE_RULE =
  "Answer only about the case the visitor asks about: when the website text covers a similar but different product, surface, " +
  "material or version, say what it covers instead of applying it to theirs. " +
  // Answering rules 2 (round 6): teamwork.com's March 19 event, past, was told in the present
  // tense; and "the available text" / "the provided pages" leaked into answers in four languages.
  "An event whose date, with its year, is before today took place: say so, in the past tense. " +
  'Name a page by its title ("Our pricing page lists…"); never write "the text", "the available text", "the provided text", "the provided pages", "the information shown" or "the page excerpt", in any language.';

// A user prompt the console wrote (any version since 2026-10-30), as opposed to one set in the
// Agentic RAG dashboard, which the worker leaves alone.
export const isConsoleUserPrompt = (user: unknown): boolean => typeof user === "string" && user.startsWith(USER_PROMPT_START);

// Retrieval: each matching paragraph with its neighbours, and the page's title before it (the
// `hierarchy` strategy), so the model can tell which product a paragraph is about.
export const PAGE_TITLES = { name: "hierarchy", count: 0 };
export const RAG_STRATEGIES = [{ name: "neighbouring_paragraphs", before: 1, after: 1 }, PAGE_TITLES];

// Paragraphs retrieved per question. 10 was enough on a small first sync, not after the full one
// (round 5, 2026-10-31): on the demo, "How much does Sitefinity cost?" got only the title paragraph
// of /sitefinity-cms/how-to-buy among 10, never its "pricing is tailored to your scope… request a
// quote" text, and the model rightly said it had nothing (0 of 4); with 20, 2 of 2 answered from it.
// Wider neighbours (2 before, 3 after) didn't help. The worker brings it to saved configurations
// (jobs/prompt-date.ts, datedConfig).
export const TOP_K = 20;

// `excludeGenerated`: the deployment has the data augmentation agents on (deployments.augmentation),
// so the configuration keeps their generated text out of retrieval and citation (NOT_GENERATED).
// `events`: the site's upcoming events, listed in the events configuration's prompt (eventsParagraph).
export function searchConfigFor(
  prompt: string,
  language: LanguageSetting,
  today: Date | null = new Date(),
  intent?: RouteIntent,
  excludeGenerated = false,
  events?: readonly PromptEvent[],
  prices?: readonly PriceRow[],
): AskConfig {
  return {
    citations: true,
    top_k: TOP_K,
    rag_strategies: RAG_STRATEGIES,
    prompt: {
      system: composeSystemPrompt(
        prompt,
        language,
        today,
        intent === "events" ? (events ?? []) : undefined,
        intent === "price" ? (prices ?? []) : undefined,
      ),
      user: composeUserPrompt(language, intent),
    },
    ...(excludeGenerated && { filter_expression: { field: NOT_GENERATED } }),
  };
}

// An intent's configuration: the default one with the intent's line, kept to the pages labelled for
// it (filter: content-plan.ts labelFilter, which also takes key pages' resource ids while pages sent
// before labels wait to be read again), and away from generated text with `excludeGenerated`.
export function intentSearchConfig(
  prompt: string,
  language: LanguageSetting,
  intent: RouteIntent,
  filter: { field: Record<string, unknown> },
  today: Date | null = new Date(),
  excludeGenerated = false,
  events?: readonly PromptEvent[],
  prices?: readonly PriceRow[],
): AskConfig {
  return {
    ...searchConfigFor(prompt, language, today, intent, false, events, prices),
    filter_expression: excludingGenerated(filter, excludeGenerated),
  };
}

// Whether a deployment's configurations exclude generated text: while it has the agents on.
export const excludesGenerated = (d: { augmentation?: unknown }): boolean => Boolean(d.augmentation);

// A filter_expression with NOT_GENERATED and-ed in when `exclude`, else as it was. Pure.
export function excludingGenerated(filter: { field: Record<string, unknown> }, exclude: boolean): { field: Record<string, unknown> } {
  return exclude ? { ...filter, field: withoutGenerated(filter.field, true)! } : filter;
}

// A saved configuration with the NOT_GENERATED clause added (`on`) or taken out, everything else as
// saved: turning the agents on or off re-saves the KB's configurations this way, so a held
// rules version or a prompt edited in the dashboard stays as it is. Pure.
export function withGeneratedExclusion(config: AskConfig & { query?: unknown }, on: boolean): AskConfig {
  const { query: _query, filter_expression, ...rest } = config;
  const saved = filter_expression as { field?: Record<string, unknown> } | undefined;
  const isClause = (f: unknown) => JSON.stringify(f) === JSON.stringify(NOT_GENERATED);
  let field = saved?.field;
  if (field && isClause(field)) field = undefined;
  else if (field && Array.isArray(field.and) && Object.keys(field).length === 1) {
    const kept = (field.and as unknown[]).filter((f) => !isClause(f)) as Record<string, unknown>[];
    field = kept.length === 0 ? undefined : kept.length === 1 ? kept[0] : { and: kept };
  }
  field = withoutGenerated(field, on);
  const { field: _field, ...others } = saved ?? {};
  return field
    ? { ...rest, filter_expression: { ...others, field } }
    : Object.keys(others).length
      ? { ...rest, filter_expression: others }
      : rest;
}

// The intent configurations a deployment's chat can route to (public config's intentConfigs, and
// validation): none before INTENT_CONFIGS_SINCE, nor for an imported deployment with no prompt.
export function intentConfigs(d: {
  systemPrompt: string;
  searchConfig: string;
  answeringRules: number;
}): Record<RouteIntent, string> | undefined {
  const base = searchConfigName(d);
  if (!base || d.answeringRules < INTENT_CONFIGS_SINCE) return undefined;
  return Object.fromEntries(ROUTE_INTENTS.map((i) => [i, intentConfigName(base, i)])) as Record<RouteIntent, string>;
}

// Everything that decides an answer under the latest rules, for the version guard's fingerprint.
export function answeringRulesFingerprint(): string {
  return JSON.stringify({
    user: (["en", "auto"] as LanguageSetting[]).map((l) => [composeUserPrompt(l), ...ROUTE_INTENTS.map((i) => composeUserPrompt(l, i))]),
    system: composeSystemPrompt("PROMPT", "en", null),
    events: composeSystemPrompt("PROMPT", "en", null, [
      { date: "2026-11-05", url: "https://x.example/b", line: "Thursday, November 5th", name: "B", title: "Page B" },
      { date: "2026-11-04", url: "https://x.example/a", line: "Wednesday, November 4th", name: "A", title: "Page A" },
    ]),
    eventsNone: eventsParagraph([]),
    prices: pricesParagraph([{ plan: "A", amount: "$1", value: 1, period: "month", url: "https://x.example/p", line: "A $1" }]),
    top_k: TOP_K,
    rag_strategies: RAG_STRATEGIES,
    intents: ROUTE_INTENTS,
  });
}
