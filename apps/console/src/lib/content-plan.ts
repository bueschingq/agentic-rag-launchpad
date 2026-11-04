// The content plan shown on New deployment, and the order every sync takes pages in. Both work
// from the sitemaps' entries alone (the sniffer's /plan: each url's lastmod, priority and
// hreflang), so the plan shows within seconds of entering the site address, and the worker
// ranks pages with this same code: the plan's numbers are the sync's.
//
// Pure (today is passed in), so it runs under node:test, in the console and in the worker.

import type { ContentPlanSummary, PageFacts } from "@launchpad/db";
import { isLanguage, languageName } from "@launchpad/theme";

export interface PlanEntry {
  url: string;
  // YYYY-MM-DD.
  lastmod?: string;
  priority?: number;
  // From the url's own hreflang link, lower case; alternates is how many languages its links offer.
  lang?: string;
  alternates?: number;
}

// Suggested exclusions: ticked when the plan opens, each can be unticked.
export const PLAN_RULES = ["conversion", "duplicate", "archive", "year", "versions", "old"] as const;
export type PlanRule = (typeof PLAN_RULES)[number];
export const isPlanRule = (value: unknown): value is PlanRule => PLAN_RULES.includes(value as PlanRule);

// Flags a synced page can carry on the content list.
export const PAGE_FLAGS = ["conversion", "old", "other-language", "overview", "short-text", "stale-commercial", "yearless-date"] as const;
export type PageFlag = (typeof PAGE_FLAGS)[number];
export const FLAG_LABELS: Record<PageFlag, string> = {
  conversion: "Likely conversion page",
  old: "Older than 2 years",
  "other-language": "Other language",
  overview: "Overview page",
  "short-text": "Text much shorter than the page",
  "stale-commercial": "States a price or offer, published over 12 months ago",
  "yearless-date": "A date without a year we couldn't place",
};

// What read each synced page: the sniffer's extractor (apps/sniffer/src/content.ts, which says
// which version read a page) and these content rules. A page read by older ones isn't
// "unchanged" on a re-sync, and is read again once, in a nightly batch capped so first syncs
// never wait (apps/worker/src/jobs/content.ts). Bump RULES_VERSION when the flags, the reasons a
// page is left out, the key pages or the text sent for a page change: test/rules-version.test.ts
// fails until it's bumped (it compares the rules' output with a record kept per version).
// 1: pages' own dates, bulk-stamped sitemap dates, stale prices and offers.
// 2: key pages first, with their intent line in the text sent; key, FAQ, help and support pages
//    never left out by age alone; pages added by hand answer to the date and stale-price rules
//    unless a person keeps them with a reason.
// 3: error pages left out ("Your token is invalid", 404 text on a 200 page); a key page loading
//    finds unusable gives way to the next of its intent, and is never left out as an overview;
//    an intent word last in a short address counts, numbered and retired copies don't; a key page
//    titled for its prices is a price page; the buying line names prices and quotes; a canonical
//    that differs only by http or https is the page itself.
// 4: the home page and the site's top-level pages are never left out by age alone (chef.io's "/"
//    was, by a CMS date nobody updated); a key page's intent line leaves the text sent (it's the
//    page's labels and metadata now: answers quoted it back); a date without a year that can't
//    be placed is flagged.
// 5: help, how-to and tips articles are never left out by age alone, like FAQ pages (swiffer.com's
//    "tips-and-articles/…/how-to-clean-tiles-and-grout", published 2023); a stale price goes by
//    the later of a page's published and updated dates unless it's an article (a pricing page
//    updated this week isn't stale); e-books, templates and downloads are never key pages, nor
//    an intent word's product ("offerte-programma", quote software, isn't a pricing page).
// 6: /plans and /plans/* are pricing pages (sharefile.com); a support word last in an address
//    names a support page only after a word saying whose support it is (/technical-support, not
//    /regulatory-compliance-support, a feature page); the events section's own pages
//    (/events/<event>) are taken right after the key pages; key pages that don't load are
//    replaced before the first sync takes them.
// 7: a help article with an intent word in its title isn't that intent's page (/help/49-episode-order);
//    a contact or buying word last needs a word saying whose (/sales-contact, not /directory-contacts);
//    /it-support is a service, not support; support by what it is, a level deeper too
//    (/marine/services/technical-support, /service-desk); customer stories are never key pages; key
//    pages only in the deployment's languages; one quote form while a page states prices; the
//    events section's index and pages under a section (/media/events); no age rule takes out a page
//    announcing a future event (round 7).
// The extractor is the sniffer's (apps/sniffer/src/content.ts, its own version SNIFFER_EXTRACTOR)
// and what the sync does to its text before sending it:
// 1: the sniffer's main-content Markdown, the page's own dates.
// 2: short lines a site repeats across its sections (footer, header and call-to-action bands
//    such as telerik.com's "Contact Support") are dropped, except on the key pages they're about.
// 3: dates written without a year get their year in the text sent ("Thursday, November 5" →
//    "Thursday, November 5, 2026": placeDates), and each page carries its page-type labels and
//    what it states (prices, contacts, links, events: statedFacts).
// 4: figures split across spans are joined ("9 .99" → "9.99", a "&" placeholder before a figure
//    takes the page's currency: joinFigures); the sniffer reads a <data value> figure (its own
//    version 2); a phone number glued to an email address is split; a date written with its
//    year is an event only on a line about an event (not a subsidy deadline).
// 5: a "&" between two numbers stays ("Live webinars, 4 & 5 Nov" was sent as "4 $5 Nov"), and a
//    price alone on its line under a plan's heading carries the heading's name and its unit
//    ("Enterprise: $ 189"; chef.io's "$ 189" was cut into the Enterprise Plus paragraph): joinFigures.
// 6: a plan's second price just under its first takes the same name (a monthly/annual toggle:
//    sharefile.com's "Premium: $ 28.59", then "$ 26.00"); a footnote mark after a figure
//    ("$ 1,229 *") still leaves it alone; a "starting from" line joins the figure under it; a
//    plan's heading may be up to 8 lines above its price (whatsupgold.com's cards); a figure
//    written with its plan's name takes its unit from the next line too. The price table is read
//    from these lines (lib/price-table.ts).
// 7: the sniffer keeps a form's text, a heading's button text, a card wrapped in a link or list item
//    as blocks, a toggle's data-yearly figures and a reloading toggle's other view (its own version
//    3); a price with a short unit or its billing ("$19 /mo", "$25 / month, billed annually") is
//    named from its heading, past a card's feature list; "When billed annually" joins it; a
//    heading up to 6 lines above names a figure; a feature line or badge above a figure never does;
//    "Enterprise 1 $199" holds one figure, not "1 $" (round 7: transistor.fm, buzzsprout.com,
//    alfredapp.com).
// 8: the sniffer operates a page's client-side toggles (its own version 4). Round 7's second check:
//    a page's dates are read in day-first ranges ("17-19 November 2026", "5. bis 7. November"),
//    with "4 & 5 Nov" two dates, and in numbers ("05.11.2026", "2026-11-05"); a date on an events
//    page is an event's whatever its line says, and a line that holds only a date is stored with
//    the lines that name it ("SEEBURGER Integration Summit 2026 · Neckarsulm · 26. November 2026").
//    A page's language is what its text says when that's clear, not only its <html lang>.
// Content rules 8: a page whose text states a date still to come is never left out by age, whatever
// its line says (the age rule read only lines naming an event, so "We are exhibiting at NATO EDGE,
// November 17 - 19 2026" and SEEBURGER's date-only lines didn't count).
// 10 (fix cycle 7e): a date-only line takes its name from the side of it the list names its events on
// (datedListLayout), and stays unnamed when that isn't clear; a short place and date take the heading
// right above them. Content rules 9: with a language ticked beside the unmarked pages, a page whose
// address names no language stays, whatever it reads as (servedLanguages).
export const EXTRACTOR_VERSION = 10;
export const SNIFFER_EXTRACTOR = 5;
export const RULES_VERSION = 9;

// Why a page is waiting, when it's waiting to be read again rather than for a sync. The worker
// orders the queue by them (a nightly re-read goes after first syncs and re-syncs) and, on a
// re-read, never takes an answerable page out by itself: it says why it would, and Bring up to
// date applies it (lib/content.ts applyUpToDate), except when the re-read is that Apply.
export const REREAD = {
  nightly: "Waiting to be read again: the extractor or content rules are newer than when it was synced.",
  now: "Waiting to be read again now: the extractor or content rules are newer than when it was synced.",
  apply: "Waiting to be read again now, under the current rules.",
} as const;
// How a page the site rate-limited waits (round 6: hms-networks.com answered 429 to 60 of 88 pages,
// each a final "failed"): the sync tries it again on later runs, more slowly, up to
// RATE_LIMIT_TRIES times; then it's failed with that reason, and the next sync tries again. A
// page already in the chat keeps answering from its copy meanwhile.
export const RATE_LIMITED = "The site rate-limited the sync";
export const RATE_LIMIT_TRIES = 4;
export function rateLimitedDetail(status: number, tries: number): string {
  return tries >= RATE_LIMIT_TRIES
    ? `${RATE_LIMITED} (${status}) on ${tries} tries; the next sync tries it again.`
    : `${RATE_LIMITED} (${status}); trying it again more slowly (try ${tries} of ${RATE_LIMIT_TRIES}).`;
}
// How many times a page has been rate-limited, from its reason (0: it hasn't been).
export const rateLimitTries = (detail: string | null | undefined): number => {
  if (!detail?.startsWith(RATE_LIMITED)) return 0;
  return Number(/\(try (\d+) of/.exec(detail)?.[1] ?? /on (\d+) tries/.exec(detail)?.[1] ?? 1);
};
// Content's header while pages wait on a rate limit, in place of "failed".
export const rateLimitedNote = (pages: number, waiting: boolean): string =>
  `${RATE_LIMITED} (429) on ${pages.toLocaleString("en")} ${pages === 1 ? "page" : "pages"}; ${waiting ? "retrying more slowly" : "the next sync tries them again, more slowly"}.`;

// Fleet's line for the same, across deployments.
export const fleetRateLimitedNote = (pages: number, deployments: number): string =>
  `${deployments === 1 ? "1 deployment's site" : `${deployments.toLocaleString("en")} deployments' sites`} rate-limited the sync (429) on ${pages.toLocaleString("en")} ${pages === 1 ? "page" : "pages"}; they're tried again, more slowly.`;

// How a re-read records what the current rules would change on an answerable page.
export const WOULD_LEAVE_OUT = "Would now be left out: ";
// Why a page a person left out is out: Leave out on Content, or its path added to Leave out.
export const LEFT_OUT_BY_YOU = "Left out by you: its address is in the content settings' Leave out.";
// How a page added by hand that trips a date or stale-price rule waits for a person to keep it.
export const KEEP_ASKED = "Added by hand, but not synced until someone keeps it: ";
// The same, said of a page that's in the chat now (a re-read found today's rules would take it
// out): never "not synced" for a page visitors' answers can cite.
export const KEEP_ASKED_LIVE = "Added by hand and in the chat now, but today's rules take it out unless someone keeps it: ";

// A page's reason as Content, Review and Bring up to date show it: a page in the chat (answerable,
// or being read again from its indexed copy) is never called "not synced".
export function shownDetail(detail: string | null | undefined, inChat: boolean): string | undefined {
  if (!detail) return undefined;
  return inChat && detail.includes(KEEP_ASKED) ? detail.replace(KEEP_ASKED, KEEP_ASKED_LIVE) : detail;
}

// Pages a person added by hand (validation's Add these pages, the Content page's Always
// include): kept whatever the budget and the plan's rules, up to this many, and synced first.
export const MAX_PINNED = 25;

// The content settings' address is a sitemap file to read directly (it ends in .xml, .xml.gz or
// .gz: hms-networks.com's robots.txt lists /sitemap/sitemap.gz), rather than a page to find
// sitemaps from or crawl. Both are kept in sync_sources.sitemapUrl.
export const isSitemapAddress = (url: string | null | undefined) => {
  if (!url) return false;
  try {
    return /\.(xml|gz)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

const DAY_MS = 86_400_000;

// A date more than a day after today isn't a page's: a placeholder, or a number in the address
// that isn't a year (kemptechnologies.com's white paper on 2048-bit keys read as 31 Dec 2048;
// crayola.com's "…-2026" coloring pages as 31 Dec 2026 in October). Every date the plan and the
// content rules go by (a sitemap's lastmod, a page's own date, a date in the address) counts as
// unknown then. The day's slack covers time zones.
export const knownDate = (date: Date | null | undefined, today: Date): Date | undefined =>
  date && date.getTime() - today.getTime() <= DAY_MS ? date : undefined;
export const knownDay = (day: string | null | undefined, today: Date): string | undefined =>
  day && knownDate(new Date(`${day}T00:00:00Z`), today) ? day : undefined;

export const ARCHIVE_DAYS = 365;
export const OLD_DAYS = 730;
// A price, offer or version in an article is out of date this long after it's published.
export const COMMERCIAL_DAYS = 365;
// Sections whose pages date: last year's campaigns and events are the stale answers. An event's
// own pages (/devreach/us/speakers) date like the event.
const ARCHIVE_SECTIONS = new Set([
  "campaigns",
  "campaign",
  "events",
  "event",
  "webinars",
  "webinar",
  "press",
  "press-releases",
  "pressreleases",
  "news",
  "newsroom",
  "archive",
  "archives",
  "speakers",
  "agenda",
  "sessions",
  "venue",
  "sponsors",
]);
// Articles: dated by when they were published, since a site-wide edit (a new template, a fixed
// link) moves every post's modified date without changing what it says.
const ARTICLE_SECTIONS = new Set([
  "blog",
  "blogs",
  "news",
  "newsroom",
  "press",
  "press-releases",
  "pressreleases",
  "webinars",
  "webinar",
  "whitepapers",
  "whitepaper",
  "white-papers",
  "events",
  "event",
  "campaigns",
  "campaign",
]);
// A sitemap date shared by at least this many of a folder's pages, and this share of its dated
// ones, is the day the sitemap was regenerated, not when they changed (telerik.com dates 156 of
// its 286 webinars 29 Jun 2026; kemptechnologies.com 761 of 781 partner pages 21 Mar 2022).
const STAMP_PAGES = 10;
const STAMP_SHARE = 0.25;
// Release notes and changelogs: their pages name a version (/release-notes/sitefinity-cms-10-2-6653).
// progress.com dates every one of them in its sitemap with the day it was regenerated, so the
// dates can't tell an old version's notes from the current one's.
const RELEASE_SECTION = /^(release-?notes?|releasenotes|change-?logs?|whats-?new|what-s-new|releases?|release-history|version-history)$/i;
// A version in the last segment: major.minor ("10-2-6653", "v14.4", "15_1") or a major and a
// five-digit build ("9-16100"). Not a year ("r3-2024").
const VERSION = /(?:^|[^0-9])(\d{1,2})[-._](\d{1,2}|\d{5,6})(?:[-._]\d+)*(?![0-9])/;
// Applied only where a product has at least this many versions listed.
const MIN_VERSIONS = 3;
// A page named for a version and little else: "13-3-lts", "whats-new-in-14-4", "15-1-release".
const VERSION_PAGE = /^(?:whats-?new-in-|what-s-new-in-|v)?(\d{1,2})[-._]\d{1,2}(?:-(?:lts|release|whats-?new|upgrade))?$/;

// A path segment that is the whole of a thank-you, confirmation or success page, in the
// languages Sitefinity sites commonly use ("grazie" is progress.com's Italian thank-you page).
const CONVERSION =
  /^(thank-?you|thanks|confirmation|confirmed|success|grazie|danke|gracias|merci|obrigado|bedankt)(-(page|[a-z]|\d+))?(\.(aspx|html?))?$/i;
// A print view is the last segment (/x/print): crayola.com's /free-coloring-pages/print/… are
// its coloring pages, not print views.
const PRINT = /^print(\.(aspx|html?))?$/i;
const conversion = (segments: readonly string[]) => segments.some((s) => CONVERSION.test(s)) || PRINT.test(segments.at(-1) ?? "");
const CONVERSION_TITLE = /^\s*(thank you|thanks|thank-you|confirmation)\b/i;
// The last segment of a listing page: a blog's or a section's index, tags, categories, archives.
const OVERVIEW_SEGMENT =
  /^(blogs?|blog-listing|news|newsroom|events|webinars|resources|articles|press-releases|tags?|categor(y|ies)|archives?|listing|index|all|sitemap|search|search-results)$/i;
const OVERVIEW_TITLE = /\b(listing|index|archives?)\b|^\s*(tag|tags|category|categories)\b|\b(tag|category):/i;

// ISO 639-1 codes a path segment can name ("/de/", "/es-mx/"), and the country codes sites use
// in their place ("/jp/" for Japanese on whatsupgold.com, "/tw/" for Traditional Chinese).
const LANGUAGE_CODES = new Set(
  "en es fr de nl pt it ja zh ko ru pl cs sk sv da nb fi tr ar he el hu ro bg hr sl sr uk th vi id hi et lv lt ca".split(" "),
);
const PATH_ALIASES: Record<string, string> = { jp: "ja", cn: "zh-cn", tw: "zh-tw", kr: "ko", cz: "cs", br: "pt-br" };

// ---- small helpers ----

// Ad-click and campaign parameters: progress.com's canonical tags can carry Google Ads' (gad_*,
// gbraid), and a link with them credits a campaign the visitor never clicked.
const TRACKING_PARAM =
  /^(utm_[a-z_]+|gclid|gclsrc|gbraid|wbraid|dclid|gad_[a-z_]+|fbclid|msclkid|yclid|twclid|ttclid|li_fat_id|mc_cid|mc_eid|_hsenc|_hsmi|_gl|srsltid)$/i;

// The address without ad-click and campaign parameters.
export function withoutTracking(url: string): string {
  const u = new URL(url);
  const kept = [...u.searchParams].filter(([name]) => !TRACKING_PARAM.test(name));
  if (kept.length === [...u.searchParams].length) return url;
  u.search = new URLSearchParams(kept).toString();
  return u.href;
}

// The same page whatever its spelling: lower-case host, no fragment, no trailing slash, no
// tracking parameters (as the worker's normalizeUrl).
// parsed: the address already parsed, which saves parsing it again when it has no query.
export function pageKey(url: string, parsed?: URL): string {
  const u = parsed && !parsed.search ? parsed : new URL(withoutTracking(url));
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
  return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
}

const segmentsOf = (path: string) =>
  path
    .split("/")
    .filter(Boolean)
    .map((s) => {
      if (!s.includes("%")) return s.toLowerCase();
      try {
        return decodeURIComponent(s).toLowerCase();
      } catch {
        return s.toLowerCase();
      }
    });

export function groupBy<T>(items: Iterable<T>, keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

// Plain code-unit order: dates and paths, not words, so no locale rules (and much faster).
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const primaryLanguage = (tag: string) => tag.split("-")[0]!.toLowerCase();

// The languages a sync keeps, for the check once a page is loaded: the plan's (the unmarked
// group stands for the deployment's own). Without a plan's (deployments from before the plan),
// the deployment's own language, or any when it follows each visitor's.
//
// Pages nothing marks are the site's default language, whatever that is. With a language chosen
// beside them, the site's marked pages are the choice and the unmarked ones its default, so the
// result holds UNMARKED too: an address that names no language stays, whatever its page reads as
// (round 7: "each visitor's language" with German ticked dropped mvtec.com's 40 English pages,
// /contact among them, as another language). Unticking the unmarked group is how to leave them out.
export const UNMARKED = "und";
export function servedLanguages(languages: readonly string[], deploymentLanguage: string): string[] {
  const own = deploymentLanguage === "auto" ? [] : [deploymentLanguage];
  if (!languages.length) return own;
  const marked = languages.filter((l) => l !== UNMARKED).map(primaryLanguage);
  return [...new Set([...marked, ...own, ...(marked.length && languages.includes(UNMARKED) ? [UNMARKED] : [])])];
}

// "/blog" matches /blog and everything under it; "*" matches anything, so "/*/careers" or
// "*.aspx" work too. Case-insensitive. The same rules as the sniffer's pathMatches.
const compiled = new Map<string, RegExp>();
export function pathMatches(url: string, patterns: readonly string[], pathname = new URL(url).pathname): boolean {
  const path = pathname.toLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) return false;
    if (!pattern.includes("*")) {
      const prefix = pattern.replace(/\/+$/, "");
      return path === prefix || path.startsWith(`${prefix}/`);
    }
    let re = compiled.get(pattern);
    if (!re) {
      re = new RegExp(
        `^${pattern
          .split("*")
          .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      );
      compiled.set(pattern, re);
    }
    return re.test(path);
  });
}

export function withinRules(url: string, include: readonly string[], exclude: readonly string[], path?: string): boolean {
  if (include.some((p) => p.trim()) && !pathMatches(url, include, path)) return false;
  return !pathMatches(url, exclude, path);
}

// The language a path names in its first two segments: "/de/…", "/sitefinity-cms/it/…".
export const pathLanguage = (url: string): string | undefined => segmentLanguage(segmentsOf(new URL(url).pathname));

function segmentLanguage(segments: readonly string[]): string | undefined {
  for (const segment of segments.slice(0, 2)) {
    const s = segment.replace("_", "-");
    if (PATH_ALIASES[s]) return PATH_ALIASES[s];
    // A region ("es-mx") or script ("zh-hant"), not any word: "/it-pros" isn't Italian.
    const m = /^([a-z]{2})(-([a-z]{2}|hans|hant))?$/.exec(s);
    if (m && LANGUAGE_CODES.has(m[1]!)) return s;
  }
  return undefined;
}

// hreflang when the sitemap offers a real set of translations; the path when the only link is
// the url itself and the path says otherwise (progress.com marks its /sitefinity-cms/it/ pages
// "en"); "und" when neither says.
export function entryLanguage(entry: Pick<PlanEntry, "url" | "lang" | "alternates">, segments?: readonly string[]): string {
  const path = segmentLanguage(segments ?? segmentsOf(new URL(entry.url).pathname));
  if (entry.lang && (!path || primaryLanguage(path) === primaryLanguage(entry.lang) || (entry.alternates ?? 1) > 1)) return entry.lang;
  return path ?? entry.lang ?? "und";
}

// "zh-tw" as people write it: "zh-TW".
export const displayTag = (tag: string) => tag.replace(/-([a-z]{2})$/, (_, region: string) => `-${region.toUpperCase()}`);

export function languageLabel(tag: string): string {
  if (tag === "und") return "Not marked";
  const primary = primaryLanguage(tag);
  if (isLanguage(primary) && tag === primary) return languageName(primary);
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

// A date in the address, for pages with no lastmod or a bulk-stamped one: /2025/04/25/ or
// /2025/04/ (blog and news posts), else a quarter ("2025-q2", "22q4", "q3-2024"), a month
// ("july-2014") or a year ("devreach-2022", "/2015") in the path. A quarter, month or year
// stands for its last day, so the age rules never call a page older than it can be; with
// several, the latest that isn't after today (knownDay) counts.
export function urlDate(url: string, today: Date, path = new URL(url).pathname): string | undefined {
  const m = /\/((?:19|20)\d{2})\/(0[1-9]|1[0-2])(?:\/(0[1-9]|[12]\d|3[01]))?(?:\/|$)/.exec(path);
  if (m) return knownDay(`${m[1]}-${m[2]}-${m[3] ?? "01"}`, today);
  // Most addresses hold no year: say so before the slower look.
  if (!/(19|20)\d\d|\dq[1-4]/i.test(path)) return undefined;
  const p = path.toLowerCase();
  const found: string[] = [];
  const quarter = (year: number, q: number) => found.push(lastDay(year, q * 3));
  for (const q of p.matchAll(/(?:^|[^0-9a-z])((?:19|20)\d{2})[-_ ]?q([1-4])(?![0-9a-z])/g)) quarter(Number(q[1]), Number(q[2]));
  for (const q of p.matchAll(/(?:^|[^0-9a-z])q([1-4])[-_ ]?((?:19|20)\d{2})(?![0-9])/g)) quarter(Number(q[2]), Number(q[1]));
  for (const q of p.matchAll(/(?:^|[^0-9a-z])(\d{2})q([1-4])(?![0-9a-z])/g)) quarter(2000 + Number(q[1]), Number(q[2]));
  for (const mm of p.matchAll(/(?:^|[^a-z])(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-_ ]((?:19|20)\d{2})(?![0-9])/g)) {
    found.push(lastDay(Number(mm[2]), MONTHS.indexOf(mm[1]!) + 1));
  }
  if (!found.length) {
    for (const y of p.matchAll(/(?:^|[^0-9])((?:19|20)\d{2})(?=[^0-9]|$)/g)) {
      const year = Number(y[1]);
      if (year >= 1990) found.push(`${year}-12-31`);
    }
  }
  return found
    .filter((day) => knownDay(day, today))
    .sort()
    .at(-1);
}

const ageDays = (day: string | undefined, today: Date) => (day ? (today.getTime() - Date.parse(`${day}T00:00:00Z`)) / DAY_MS : undefined);

export const isConversionUrl = (url: string) => conversion(segmentsOf(new URL(url).pathname));

export function isOverviewUrl(url: string, u = new URL(url), segments = segmentsOf(u.pathname)): boolean {
  const last = segments.at(-1);
  if (last && OVERVIEW_SEGMENT.test(last)) return true;
  // /page/2, /tag/x, /category/y, ?page=3
  if (
    segments.some(
      (s, i) => (s === "page" && /^\d+$/.test(segments[i + 1] ?? "")) || (/^(tags?|categor(y|ies))$/.test(s) && i < segments.length - 1),
    )
  )
    return true;
  return /^\d+$/.test(u.searchParams.get("page") ?? "");
}

// The years "before last year": on 30 October 2026 that's 2024 and earlier.
const oldYear = (path: string, today: Date) => {
  const lastYear = today.getUTCFullYear() - 1;
  return [...path.matchAll(/(?:^|[^0-9])((?:19|20)\d{2})(?=[^0-9]|$)/g)].some((m) => {
    const year = Number(m[1]);
    return year >= 1990 && year < lastYear;
  });
};
// The earliest such year, for saying why.
const oldYearIn = (path: string, today: Date): number | undefined => {
  const lastYear = today.getUTCFullYear() - 1;
  const years = [...path.matchAll(/(?:^|[^0-9])((?:19|20)\d{2})(?=[^0-9]|$)/g)]
    .map((m) => Number(m[1]))
    .filter((y) => y >= 1990 && y < lastYear);
  return years.length ? Math.min(...years) : undefined;
};

// ---- key pages ----

// The questions every commercial site gets (price, buy, contact, support, trial or demo) and its
// FAQ: the pages that answer them are taken before the sections take turns, never left out by
// age alone, and sent with a line naming their intent, so "How do I contact sales?" finds a
// /contact page that never says "sales".
export const KEY_INTENTS = ["price", "contact", "support", "buy", "trial", "faq"] as const;
export type KeyIntent = (typeof KEY_INTENTS)[number];
export const isKeyIntent = (value: unknown): value is KeyIntent => KEY_INTENTS.includes(value as KeyIntent);

// Key pages, and key, FAQ, help and support pages never left out by age alone, change what a
// live chat answers from. So a published deployment keeps the selection from before them until
// a person brings it up to date: it takes them once it's signed off under checks 3 or later
// (CHECKS_VERSION in lib/review.ts, read here as a number so the worker needn't import the
// review), or once Bring up to date's Add switched it (lib/content.ts addKeyPages, audited
// content.key-pages). A deployment not yet published takes them from its first sync.
export const KEY_PAGES_CHECKS = 3;
export const takesKeyPages = (d: { published: boolean; signOff?: { checksVersion?: number } | null }): boolean =>
  !d.published || (d.signOff?.checksVersion ?? 0) >= KEY_PAGES_CHECKS;

// At most an eighth of the budget, and 25 (an eighth of the default 200).
export const MAX_KEY_PAGES = 25;
export const keyPageLimit = (budget: number) => Math.min(MAX_KEY_PAGES, Math.max(1, Math.ceil(budget / 8)));
// Per intent and language, so one intent's folder (crayola.com's 195 FAQs, telerik.com's 40
// /support pages) can't fill the key pages.
const KEY_PER_INTENT = 4;

// The words an address starts with, in the languages the widget serves (no accents).
const INTENT_WORDS: Record<KeyIntent, string> = {
  price:
    "price prices pricing plans quote quotes rates preise preis preisliste angebot precios precio tarifas cotizacion presupuesto prix tarif tarifs tarification devis prijzen prijs tarieven offerte precos preco orcamento prezzi prezzo listino tariffe preventivo",
  buy: "buy purchase purchasing shop store order kaufen bestellen comprar compra tienda acheter commander boutique kopen winkel loja acquista acquistare negozio",
  contact:
    "contact contacts contactus kontakt kontaktieren contacto contactenos contactanos contacter contactez contatti contattaci contatto contato conosco",
  support:
    "support help helpdesk hilfe kundenservice kundendienst soporte ayuda assistance aide ondersteuning hulp klantenservice suporte ajuda assistenza supporto aiuto",
  trial: "trial trials try demo demos testversion prueba demostracion essai essais proefversie teste prova",
  faq: "faq faqs preguntas perguntas domande veelgestelde haufige haeufige fragen",
};
const INTENT_BY_WORD = new Map(
  KEY_INTENTS.flatMap((intent) => INTENT_WORDS[intent].split(" ").map((word) => [word, intent] as [string, KeyIntent])),
);
// Words before the intent in an address: /request-a-quote, /start-free-trial, /how-to-buy,
// /nous-contacter, /solicitar-presupuesto.
const INTENT_FILLER = new Set(
  "free request requesting get book schedule start how where to a an the our your my online live solicitar solicita solicite pide pedir una un uno de del jetzt kostenlos kostenlose gratis demander demande obtenir nous une richiedi richiesta di neem vraag een fale um".split(
    " ",
  ),
);
// Phrases, whole or as a segment's last two words: what the page is, not a word in a product's
// slug (/marine/services/technical-support, /customer-service, /service-desk).
const INTENT_PHRASES: Record<string, KeyIntent> = {
  "get in touch": "contact",
  "reach us": "contact",
  "customer service": "support",
  "customer care": "support",
  "service desk": "support",
  "help center": "support",
  "help centre": "support",
};
const PAGE_EXTENSION = /\.(aspx?|html?|php|jsp|cfm)$/;

// The intent a path segment names: it starts with an intent word (after words like "request a"),
// in at most three words, so /purchase-order-app-for-sap-netweaver isn't a buying page.
function intentSegment(segment: string): { intent: KeyIntent; extra: number } | undefined {
  const words = segment
    .replace(PAGE_EXTENSION, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[-_.+\s]+/)
    .filter(Boolean);
  const phrase = INTENT_PHRASES[words.join(" ")] ?? INTENT_PHRASES[words.slice(-2).join(" ")];
  if (phrase && (words.length <= 2 || words.slice(0, -2).every((w) => SUPPORT_QUALIFIERS.has(w) || INTENT_FILLER.has(w))))
    return { intent: phrase, extra: words.length > 2 ? 1 : 0 };
  // A numbered, lettered or retired copy: /es/contacto-2, /contact-m, /demo-interactiva-old.
  if (words.length > 1 && VARIANT_WORD.test(words.at(-1)!)) return undefined;
  // A help article's number first (/help/130-directory-contacts, /help/49-episode-order): an
  // article whose title holds an intent word, not that intent's page (round 7: buzzsprout.com).
  if (words.length > 1 && /^\d+$/.test(words[0]!)) return undefined;
  let start = 0;
  while (start < words.length && INTENT_FILLER.has(words[start]!)) start += 1;
  const rest = words.slice(start);
  if (!rest.length || rest.length > 3) return undefined;
  // An intent word naming a product: "offerte-programma" (quote software), "invoice-template".
  if (rest.some((w) => PRODUCT_WORD.has(w))) return undefined;
  // First or last: /pricing-and-licensing, /interactive-demo, /request-an-ai-search-demo. A
  // support word last names a support page only after a word saying whose support it is
  // (/technical-support, /customer-support): /regulatory-compliance-support is a feature page
  // (round 6: sharefile.com's /product-feature/regulatory-compliance-support was its support page).
  // A contact or buying word last names that page only after a word saying whose it is
  // (/sales-contact, /online-shop): /directory-contacts is a list of contacts, /episode-order a
  // help topic (round 7).
  const first = INTENT_BY_WORD.get(rest[0]!);
  const last = rest.length > 1 ? INTENT_BY_WORD.get(rest.at(-1)!) : undefined;
  const qualifiers =
    last === "support" ? SUPPORT_QUALIFIERS : last === "contact" ? CONTACT_QUALIFIERS : last === "buy" ? BUY_QUALIFIERS : undefined;
  const intent = first ?? (qualifiers && !rest.slice(0, -1).every((w) => qualifiers.has(w) || CONJUNCTIONS.has(w)) ? undefined : last);
  return intent ? { intent, extra: rest.filter((w) => !CONJUNCTIONS.has(w)).length - 1 } : undefined;
}
// Words that say whose support a page is, before a support word. Not "it": /it-support is an IT
// firm's service (round 7: planetmagpie.com's /it-support pages were its "support" key pages).
const SUPPORT_QUALIFIERS = new Set(
  "technical tech customer customers client clients product products premium online live global partner partners enterprise standard 24x7 247 contact technischer technische kunden tecnico tecnica soporte".split(
    " ",
  ),
);
// Words that say whose contact or shop a page is, before a contact or buying word.
const CONTACT_QUALIFIERS = new Set("sales media press general business customer customers partner partners team us our main".split(" "));
const BUY_QUALIFIERS = new Set("online web direct now".split(" "));
// Words that make an intent word the name of a product or a resource, not the intent's page.
const PRODUCT_WORD = new Set(
  "programma software logiciel programme programm app apps tool tools maker generator template templates sjabloon modele vorlage plantilla modelo ebook".split(
    " ",
  ),
);
// The last word of a copy of a page.
const VARIANT_WORD = /^(\d+|[a-z]|old|new|copy|test|backup|draft|staging|tmp|v\d+)$/;
const CONJUNCTIONS = new Set("and und y et e en".split(" "));

// A page in a blog, news, press, webinar, whitepaper, event or campaign folder, or a forum thread
// (telerik.com's /forums/trial-edition): never a key page, so a 2016 post about prices can't
// become one.
const NOT_KEY_SECTIONS = new Set([
  ...ARTICLE_SECTIONS,
  "forums",
  "forum",
  "threads",
  "thread",
  "discussions",
  "discussion",
  // An e-book or template about quotes isn't the pricing page (teamleader.eu's /fr/ebooks/devis).
  "ebooks",
  "ebook",
  "e-books",
  "e-book",
  "templates",
  "template",
  "downloads",
  "download",
  "glossary",
  "glossaries",
  "dictionary",
  "wiki",
  // A customer story isn't a buying page (round 7: mews.com's /en/customers/boutique-hotel-orangerie).
  "customers",
  "customer-stories",
  "case-studies",
  "case-study",
  "success-stories",
  "testimonials",
  "references",
  "referenzen",
  "kunden",
  "kundenstimmen",
  "clientes",
  "casos-de-exito",
  "temoignages",
  "klanten",
  "showcase",
]);
// Also a glossary's entries, and anything under a folder named for a year or a campaign
// (teamwork.com's /2026-strategic-shifts/value-beyond-price/ and /glossary/value-based-pricing/
// aren't its pricing pages).
const inArticleFolder = (segments: readonly string[]) =>
  segments.some((s, i) => NOT_KEY_SECTIONS.has(s) || (i < segments.length - 1 && /(^|[^0-9])(19|20)\d{2}([^0-9]|$)/.test(s)));

// The intent an address names one or two levels deep, after any language folder (and after
// Only these paths' single prefix: skip): the deeper of the two when both do
// (/purchase/support-plans is about support), with how many named one, the deciding segment's
// other words, and the depth below the prefix.
function addressIntent(
  segments: readonly string[],
  skip = 0,
): { intent: KeyIntent; named: number; extra: number; depth: number } | undefined {
  if (inArticleFolder(segments)) return undefined;
  const at = skip + (segments[skip] && segmentLanguage([segments[skip]!]) ? 1 : 0);
  const found = segments
    .slice(at, at + 2)
    .map(intentSegment)
    .filter((i): i is { intent: KeyIntent; extra: number } => Boolean(i));
  // A support page by what it is, a level deeper under a division's services
  // (/marine/services/technical-support: round 7, wartsila.com's plan found no support page).
  if (!found.length && segments.length === at + 3) {
    const deeper = intentSegment(segments[at + 2]!);
    if (deeper?.intent === "support" && /[-_]/.test(segments[at + 2]!)) found.push(deeper);
  }
  const last = found.at(-1);
  return last ? { intent: last.intent, named: found.length, extra: last.extra, depth: segments.length - at } : undefined;
}

// The intent of a page's address (price, contact, support, buy, trial, faq), or undefined.
export const intentOf = (url: string): KeyIntent | undefined => addressIntent(segmentsOf(new URL(url).pathname))?.intent;

// A support key page by what it says, not only its address: a members' welfare or charity fund is
// support of another kind (imeche.org's /support-network, a benevolent fund, was the site's support
// key page, so "How do I contact support?" gave the fund's number). Pure.
const WELFARE_WORDS =
  /\b(?:welfare|benevolent|hardship|bereavement|charit(?:y|able)|wellbeing|well-being|mental health|financial (?:help|hardship|assistance|support)|donat(?:e|ion|ions)|members? in need|veterans?|carers?)\b/gi;
const PRODUCT_HELP =
  /\b(?:technical support|customer (?:service|support)|support (?:team|ticket|portal|request|centre|center)|help ?desk|service desk|knowledge base|troubleshoot\w*|documentation|warranty|open a ticket|submit a ticket|contact support)\b/i;
export const welfarePage = (text: string): boolean => (text.match(WELFARE_WORDS)?.length ?? 0) >= 2 && !PRODUCT_HELP.test(text);

// A key page's intent once it has loaded: its title's (keyIntentFor), and none for a support page whose
// own text says it's something else. Pure.
export const keyIntentOfPage = (
  intent: KeyIntent | null | undefined,
  title: string | null | undefined,
  text: string | null | undefined,
): KeyIntent | null => {
  const kind = keyIntentFor(intent, title);
  return kind === "support" && welfarePage(`${title ?? ""}\n${text ?? ""}`) ? null : kind;
};

// A key page whose title names its prices is a price page whatever its address says: the demo's
// /sitefinity-cms/how-to-buy is "Sitefinity Pricing and Licensing Information". Not a contact or
// support page that mentions them.
const PRICING_TITLE = /\b(pricing|prices|price list|preise|preisliste|precios|tarifs|tarification|prezzi|listino|prijzen|precos|preços)\b/i;
export const keyIntentFor = (intent: KeyIntent | null | undefined, title: string | null | undefined): KeyIntent | null =>
  !intent ? null : intent !== "contact" && intent !== "support" && PRICING_TITLE.test(title ?? "") ? "price" : intent;

// A pricing page by what it is (round 6: sharefile.com's /plans wasn't one): an address naming
// prices or plans (/pricing, /plans, /plans/*, /de/preise) or buying (/buy, /how-to-buy,
// /purchase), or a title naming its prices or plans ("Plans & Pricing", "Pricing and Licensing").
// Not a quote form (/quote-request), an FAQ (/pricing/subscription-model-faq), a page about
// support or contact, nor anything in a blog, news or glossary folder. The price table is read
// from these pages (lib/price-table.ts). Pure.
const PLANS_TITLE =
  /\b(plans?|pakete|planes|forfaits|abonnements?|subscriptions?)\b.{0,20}\b(pricing|prices?|preise|precios|prix|tarifs?)\b|\b(pricing|prices?|preise|precios|prix|tarifs?)\b.{0,20}\b(plans?|pakete|planes|forfaits)\b/i;
export function isPricingPage(url: string, title?: string | null): boolean {
  let segments: string[];
  try {
    segments = segmentsOf(new URL(url).pathname);
  } catch {
    return false;
  }
  if (inArticleFolder(segments)) return false;
  const last = segments.at(-1) ?? "";
  if (/(^|[-_])faqs?($|[-_])/i.test(last) || /\bfaqs?\b|frequently asked/i.test(title ?? "")) return false;
  const intent = addressIntent(segments)?.intent;
  if (intent === "support" || intent === "contact" || intent === "trial") return false;
  const titled = PRICING_TITLE.test(title ?? "") || PLANS_TITLE.test(title ?? "");
  // A quote form states no prices, unless its title says it does.
  if (QUOTE_ADDRESS.test(last) && !titled) return false;
  return intent === "price" || intent === "buy" || titled;
}

// Key, FAQ, help and support pages: never left out by age alone (the stale-price rule still
// applies). FAQ, help and support count at any depth (/products/x/faq).
// Help, how-to and tips sections and articles: evergreen like FAQ pages (swiffer.com's
// /en-us/tips-and-articles/our-cleaning-tips/how-to-clean-tiles-and-grout).
const HELP_SEGMENT =
  /^(tips?|tips-and-[a-z-]+|[a-z-]+-tips|how-?tos?|how-to-[a-z0-9-]+|guides?|help-?cent(er|re)|knowledge-?base|kb|tutorials?|consejos|conseils|tipps|ratgeber|astuces)$/;
const evergreen = (segments: readonly string[]) =>
  !inArticleFolder(segments) &&
  (Boolean(addressIntent(segments)) ||
    segments.some((s) => {
      const intent = intentSegment(s);
      return intent?.intent === "faq" || intent?.intent === "support" || HELP_SEGMENT.test(s);
    }));
export const isEvergreenUrl = (url: string) => evergreen(segmentsOf(new URL(url).pathname));

// The home page and the site's top-level pages ("/", "/de", "/products", "/de/produkte", below
// Only these paths' single prefix too): never left out by age alone, like key pages. A CMS date
// nobody updates says nothing about them (chef.io's "/": published 2020, sitemap 2026). Not an
// article folder's index, and, once loaded, not an article (a post at the site's root still ages).
const topLevel = (segments: readonly string[], skip = 0) => {
  const at = skip + (segments[skip] && segmentLanguage([segments[skip]!]) ? 1 : 0);
  return segments.length - at <= 1 && !inArticleFolder(segments);
};
export const isTopLevelUrl = (url: string) => topLevel(segmentsOf(new URL(url).pathname));

// The words a question uses for each intent, for the fix panel's one-word match ("How do I
// contact sales?" is a contact question; "How much does it cost?" a price one).
// Not every address word: "store" and "order" mean other things in a question.
// By language, so a German price question prefers /de/preise.
const QUESTION_WORDS: Record<KeyIntent, Record<string, string>> = {
  price: {
    en: "price pricing quote cost expensive fee license licensing licence subscription rates",
    de: "preis preise kosten kostet angebot",
    es: "precio precios cuesta presupuesto",
    fr: "prix tarif tarifs coute devis",
    nl: "prijs prijzen kost offerte",
    pt: "preco precos custa orcamento",
    it: "prezzo prezzi costa preventivo",
  },
  buy: {
    en: "buy buying purchase purchasing shop reseller distributor retailer",
    de: "kaufen",
    es: "comprar compra",
    fr: "acheter",
    nl: "kopen",
    it: "acquistare acquista",
  },
  contact: {
    en: "contact contacting sale sales talk call phone email reach speak touch",
    de: "kontakt kontaktieren vertrieb",
    es: "contacto contactar ventas",
    fr: "contacter ventes",
    nl: "verkoop",
    pt: "contato vendas",
    it: "contatto contattare vendite",
  },
  support: {
    en: "support help helpdesk ticket troubleshoot troubleshooting",
    de: "hilfe",
    es: "soporte ayuda",
    fr: "assistance aide",
    nl: "ondersteuning hulp",
    pt: "suporte ajuda",
    it: "assistenza supporto aiuto",
  },
  trial: {
    en: "trial try demo evaluation evaluate",
    de: "testversion",
    es: "prueba demostracion",
    fr: "essai",
    nl: "proefversie",
    pt: "teste",
    it: "prova",
  },
  faq: { en: "faq faqs" },
};
// Which page intents answer a question's intent: a price question can be answered from a buying
// page (telerik.com's /purchase.aspx is its price list), a contact question from a support one.
const ANSWERED_BY: Record<KeyIntent, readonly KeyIntent[]> = {
  price: ["price", "buy"],
  buy: ["buy", "price"],
  contact: ["contact", "support"],
  support: ["support", "contact"],
  trial: ["trial"],
  faq: ["faq"],
};
const stemmed = (word: string) =>
  word.endsWith("ies") && word.length > 4
    ? `${word.slice(0, -3)}y`
    : word.endsWith("s") && !word.endsWith("ss") && word.length > 3
      ? word.slice(0, -1)
      : word;
const QUESTION_INTENT = new Map<string, KeyIntent[]>();
// A word's language, when only one language uses it.
const QUESTION_LANGUAGE = new Map<string, string | null>();
for (const intent of KEY_INTENTS) {
  for (const [lang, list] of Object.entries(QUESTION_WORDS[intent])) {
    for (const word of list.split(" ")) {
      for (const w of new Set([word, stemmed(word)])) {
        QUESTION_INTENT.set(w, [...new Set([...(QUESTION_INTENT.get(w) ?? []), intent])]);
        QUESTION_LANGUAGE.set(w, QUESTION_LANGUAGE.has(w) && QUESTION_LANGUAGE.get(w) !== lang ? null : lang);
      }
    }
  }
}
const questionWords = (question: string) =>
  question
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

// The intents a question asks about, by its words.
export function questionIntents(question: string): KeyIntent[] {
  const found = new Set<KeyIntent>();
  for (const w of questionWords(question)) {
    for (const intent of QUESTION_INTENT.get(w) ?? QUESTION_INTENT.get(stemmed(w)) ?? []) found.add(intent);
  }
  return KEY_INTENTS.filter((i) => found.has(i));
}

// The language a question's intent words are in ("Was kostet…": de), when they say.
export function questionLanguage(question: string): string | undefined {
  const counts = new Map<string, number>();
  for (const w of questionWords(question)) {
    const lang = QUESTION_LANGUAGE.get(w) ?? QUESTION_LANGUAGE.get(stemmed(w));
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1]);
  return best[0] && best[0][1] > (best[1]?.[1] ?? 0) ? best[0][0] : undefined;
}

// The page intents that answer any of a question's intents.
export const answeringIntents = (intents: readonly KeyIntent[]): Set<KeyIntent> => new Set(intents.flatMap((i) => ANSWERED_BY[i]));

// The line a key page's text gets when it's sent, in the page's language, so retrieval finds the
// page for the intent's questions. Visitors only see it if an answer quotes it.
const INTENT_LINES: Record<string, Record<KeyIntent, string>> = {
  en: {
    price: "About this page: prices, plans, quotes and what it costs.",
    buy: "About this page: how and where to buy, prices, quotes and what it costs.",
    contact: "About this page: how to contact us, including sales and support.",
    support: "About this page: support and help, and how to contact support.",
    trial: "About this page: a free trial or a demo.",
    faq: "About this page: frequently asked questions.",
  },
  de: {
    price: "Über diese Seite: Preise, Pakete, Angebote und was es kostet.",
    buy: "Über diese Seite: wie und wo man kauft, Preise, Angebote und was es kostet.",
    contact: "Über diese Seite: wie Sie uns kontaktieren, auch Vertrieb und Support.",
    support: "Über diese Seite: Support und Hilfe, und wie Sie den Support kontaktieren.",
    trial: "Über diese Seite: eine kostenlose Testversion oder eine Demo.",
    faq: "Über diese Seite: häufig gestellte Fragen.",
  },
  es: {
    price: "Sobre esta página: precios, planes, presupuestos y cuánto cuesta.",
    buy: "Sobre esta página: cómo y dónde comprar, precios, presupuestos y cuánto cuesta.",
    contact: "Sobre esta página: cómo contactarnos, también ventas y soporte.",
    support: "Sobre esta página: soporte y ayuda, y cómo contactar con soporte.",
    trial: "Sobre esta página: una prueba gratuita o una demostración.",
    faq: "Sobre esta página: preguntas frecuentes.",
  },
  fr: {
    price: "À propos de cette page : prix, offres, devis et ce que cela coûte.",
    buy: "À propos de cette page : comment et où acheter, prix, devis et ce que cela coûte.",
    contact: "À propos de cette page : comment nous contacter, y compris les ventes et le support.",
    support: "À propos de cette page : support et aide, et comment contacter le support.",
    trial: "À propos de cette page : un essai gratuit ou une démo.",
    faq: "À propos de cette page : questions fréquentes.",
  },
  nl: {
    price: "Over deze pagina: prijzen, pakketten, offertes en wat het kost.",
    buy: "Over deze pagina: hoe en waar te kopen, prijzen, offertes en wat het kost.",
    contact: "Over deze pagina: hoe u contact met ons opneemt, ook verkoop en support.",
    support: "Over deze pagina: support en hulp, en hoe u contact opneemt met support.",
    trial: "Over deze pagina: een gratis proefversie of een demo.",
    faq: "Over deze pagina: veelgestelde vragen.",
  },
  pt: {
    price: "Sobre esta página: preços, planos, orçamentos e quanto custa.",
    buy: "Sobre esta página: como e onde comprar, preços, orçamentos e quanto custa.",
    contact: "Sobre esta página: como entrar em contato, incluindo vendas e suporte.",
    support: "Sobre esta página: suporte e ajuda, e como contatar o suporte.",
    trial: "Sobre esta página: um teste grátis ou uma demonstração.",
    faq: "Sobre esta página: perguntas frequentes.",
  },
  it: {
    price: "Informazioni su questa pagina: prezzi, piani, preventivi e quanto costa.",
    buy: "Informazioni su questa pagina: come e dove acquistare, prezzi, preventivi e quanto costa.",
    contact: "Informazioni su questa pagina: come contattarci, anche vendite e assistenza.",
    support: "Informazioni su questa pagina: assistenza e supporto, e come contattare l'assistenza.",
    trial: "Informazioni su questa pagina: una prova gratuita o una demo.",
    faq: "Informazioni su questa pagina: domande frequenti.",
  },
};
export const intentLine = (intent: KeyIntent, lang: string | undefined): string =>
  (INTENT_LINES[primaryLanguage(lang ?? "en")] ?? INTENT_LINES.en!)[intent];

// ---- chrome: short lines a site repeats on page after page ----

// A line as chrome is compared: no list or quote marker, link text without its address, no
// emphasis, lower case.
const chromeUnit = (line: string) =>
  line
    .replace(/^\s*(?:[-*+>]|\d+\.)\s+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
const INTENT_LINE_SET = new Set(Object.values(INTENT_LINES).flatMap((lines) => Object.values(lines).map((l) => l.toLowerCase())));
// Short words with no figure: a heading, a code fence, a price or a count is never chrome.
const chromeCandidate = (line: string, unit: string) =>
  Boolean(unit) &&
  !/^\s*(#|```)/.test(line) &&
  /\p{L}/u.test(unit) &&
  !/\d/.test(unit) &&
  unit.length <= 80 &&
  unit.split(" ").length <= 8 &&
  !INTENT_LINE_SET.has(unit);
// The part of the site a page is in: its first folder after a language folder.
const siteSection = (url: string) => {
  const segments = segmentsOf(new URL(url).pathname);
  return (segments[0] && segmentLanguage([segments[0]]) ? segments[1] : segments[0]) ?? "";
};
// Each line of a text with whether it's inside a code block.
function* textLines(text: string): Generator<{ line: string; code: boolean }> {
  let code = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      code = !code;
      yield { line, code: true };
      continue;
    }
    yield { line, code };
  }
}

// The lines a site repeats as chrome: short, without a figure, on at least 5 of the pages (and a
// twentieth of them), in at least 3 of the site's sections. telerik.com's footer "Contact Support"
// is on 39 of its 201 pages across its product folders; crayola.com's stain-tip steps repeat only
// within /stain-tips, so they stay. Needs 8 pages to judge.
export function chromeLines(pages: readonly { url: string; text: string }[]): Set<string> {
  if (pages.length < 8) return new Set();
  const seen = new Map<string, { pages: number; sections: Set<string> }>();
  for (const page of pages) {
    const units = new Set<string>();
    for (const { line, code } of textLines(page.text)) {
      if (code) continue;
      const unit = chromeUnit(line);
      if (chromeCandidate(line, unit)) units.add(unit);
    }
    const section = siteSection(page.url);
    for (const unit of units) {
      const s = seen.get(unit) ?? { pages: 0, sections: new Set<string>() };
      s.pages += 1;
      s.sections.add(section);
      seen.set(unit, s);
    }
  }
  const least = Math.max(5, Math.ceil(pages.length / 20));
  return new Set([...seen].filter(([, s]) => s.pages >= least && s.sections.size >= 3).map(([unit]) => unit));
}

// A price ("$ 849", "1.229 €") or a line that is a figure ("### 25,000+").
const FIGURE_LINE = (line: string) => PRICE.test(line) || /^[\s#>*-]*\d[\d.,\s]*[%+]?\s*$/.test(line);

// A page's text without the site's chrome lines, except those about the page's own key intent
// ("Contact Support" stays on /contact and the support pages), and those next to a figure: a
// price band's "per developer, per year" or "Preis ab" belongs to its price. A pricing or buying
// key page keeps every line: its price table names the products the site's menus repeat
// (telerik.com's /purchase.aspx lists "Kendo UI for Angular").
export function dropChrome(markdown: string, chrome: ReadonlySet<string>, intent?: KeyIntent | null): string {
  if (!chrome.size || intent === "price" || intent === "buy") return markdown;
  const lines = [...textLines(markdown)];
  const nearFigure = (i: number) => {
    for (const step of [-1, 1]) {
      let j = i + step;
      while (lines[j] && !lines[j]!.line.trim()) j += step;
      if (lines[j] && FIGURE_LINE(lines[j]!.line)) return true;
    }
    return false;
  };
  const kept: string[] = [];
  for (const [i, { line, code }] of lines.entries()) {
    const unit = code || /^\s*#/.test(line) ? "" : chromeUnit(line);
    const own = intent && answeringIntents(questionIntents(unit)).has(intent);
    if (unit && chrome.has(unit) && !own && !nearFigure(i)) continue;
    kept.push(line);
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// "support plans" for /purchase/support-plans: how the plan names a key page.
export function pageLabel(path: string): string {
  const last = path.split("/").filter(Boolean).at(-1);
  if (!last) return "home page";
  let word = last;
  try {
    word = decodeURIComponent(last);
  } catch {
    // As written.
  }
  return (
    word
      .replace(PAGE_EXTENSION, "")
      .replace(/[-_+]+/g, " ")
      .trim()
      .toLowerCase() || "home page"
  );
}

// ---- the plan ----

export interface PlanChoices {
  // Selected language groups ("en", "zh-tw", "und" for pages nothing marks); undefined: the
  // defaults for the served languages.
  languages?: readonly string[];
  rules: readonly PlanRule[];
  include: readonly string[];
  exclude: readonly string[];
  budget: number;
}

export interface PlanInput extends PlanChoices {
  entries: readonly PlanEntry[];
  // The languages the deployment answers in (primary tags); every supported one for "auto".
  served: readonly string[];
  today: Date;
  // What earlier syncs found by loading pages, by pageKey: their flags demote overview pages.
  known?: ReadonlyMap<string, readonly string[]>;
  // false: the selection from before key pages (takesKeyPages), for live deployments signed off
  // under older checks: no key pages, and key, FAQ, help and support pages age like the rest.
  keyPages?: boolean;
  // Pages loading found unusable (too little text, an error page, not found, left out), by
  // pageKey: a key page among them gives its place to the next candidate for its intent.
  unusable?: ReadonlySet<string>;
}

export interface RankedPage {
  entry: PlanEntry;
  key: string;
  lang: string;
  section: string;
  depth: number;
  // The date the plan goes by: the sitemap's lastmod, unless it's bulk-stamped, else a date in
  // the address. The page's own date replaces it once the page is loaded.
  date?: string;
  // The lastmod is the day most of its folder shares (see STAMP_PAGES): not the page's date.
  stamped: boolean;
  // The folder its sitemap date is compared within ("/de/resources").
  folder: string;
  // A blog post, news item, webinar, whitepaper, event or campaign page, by its address.
  article: boolean;
  overview: boolean;
  matches: PlanRule[];
  order: number;
  // The intent its address names (intentOf), and whether the plan takes it as a key page.
  intent?: KeyIntent;
  keyPage: boolean;
  // A key page loading found unusable (PlanInput.unusable), replaced by the next candidate: kept
  // with its intent so Content can say which key pages couldn't be used, and why.
  keyUnusable?: boolean;
}

// The key pages the plan takes, those it couldn't and why, and the intents no address names.
export interface PlanKeyPages {
  limit: number;
  taken: { path: string; intent: KeyIntent; label: string }[];
  notTaken: { path: string; intent: KeyIntent; why: string }[];
  // Of price, contact and support: none of the sitemaps' addresses names it.
  none: KeyIntent[];
  // The events section's own pages, taken after the key pages (pickEventPages).
  events?: { path: string; label: string }[];
}

export interface PlanLanguage {
  tag: string;
  label: string;
  pages: number;
  supported: boolean;
  selected: boolean;
}

export interface PlanSection {
  path: string;
  pages: number;
  newest?: string;
  oldest?: string;
  // Not updated in 2 years, and within the budget.
  old: number;
  taken: number;
  // The pages the budget takes from it, best first (paths), and the date the plan gave each.
  takes: { path: string; date?: string }[];
}

// A sitemap date most of a folder shares: the plan treats it as unknown.
export interface PlanStamp {
  section: string;
  day: string;
  pages: number;
}

export interface PlanSuggestion {
  rule: PlanRule;
  label: string;
  pages: number;
  ticked: boolean;
  // The sections with most matching pages, and sections it leaves out whole (/devreach-2022).
  bySection: { path: string; pages: number }[];
  wholeSections: string[];
}

export interface ContentPlan {
  // Every page in the sitemaps: the one count the scan and the Content panel also show.
  total: number;
  // Pages with a lastmod (not after today): 0 means the sitemap has no dates.
  dated: number;
  // Within Only these paths and Leave out, and the label that number carries.
  inScope: number;
  scope?: string;
  languages: PlanLanguage[];
  // In scope and in a selected language.
  inLanguages: number;
  sections: PlanSection[];
  suggestions: PlanSuggestion[];
  // What's left after the ticked suggestions: the pages the budget takes from, best first.
  eligible: number;
  taken: number;
  oldestTaken?: string;
  newestTaken?: string;
  undatedTaken: number;
  // Folders whose sitemap dates are bulk-stamped, most pages first: those dates count as unknown.
  stamped: PlanStamp[];
  keyPages: PlanKeyPages;
}

// The defaults: pages nothing marks (the site's main pages), plus for each served language its
// largest group, unless the unmarked pages outnumber it (they stand in for it then).
export function defaultLanguages(counts: ReadonlyMap<string, number>, served: readonly string[]): string[] {
  const selected = counts.has("und") ? ["und"] : [];
  const unmarked = counts.get("und") ?? 0;
  for (const language of new Set(served.map(primaryLanguage))) {
    const best = [...counts].filter(([tag]) => tag !== "und" && primaryLanguage(tag) === language).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= unmarked) selected.push(best[0]);
  }
  return selected;
}

// A plan that takes no pages in the language the chat answers in says so (round 7: mvtec.com set to
// German or to the visitor's language took 0 of its 387 /de/ pages, and nothing said). `answers`: the
// deployment's language setting, "" while it follows the customer's. Pure.
export function languageGapNote(
  answers: string,
  languages: readonly Pick<PlanLanguage, "tag" | "label" | "pages" | "supported">[],
  selected: readonly string[],
): string | undefined {
  if (!answers || !languages.length || !selected.length) return undefined;
  const taken = new Set(selected.map(primaryLanguage));
  const names = (list: readonly Pick<PlanLanguage, "label" | "pages">[]) => list.map((l) => `${l.label} (${l.pages} pages)`).join(", ");
  if (answers === "auto") {
    const left = languages.filter((l) => l.tag !== "und" && l.supported && !taken.has(primaryLanguage(l.tag)));
    return left.length
      ? `This chat answers in each visitor's language, but the plan doesn't take these: ${names(left)}. Visitors asking in them get answers from the pages taken, translated. Tick them to answer from the site's own words.`
      : undefined;
  }
  const own = primaryLanguage(answers);
  if (taken.has(own)) return undefined;
  const here = languages.filter((l) => primaryLanguage(l.tag) === own);
  return here.length
    ? `This chat answers in ${here[0]!.label}, but the plan takes none of the site's ${names(here)}. Tick it to answer from the site's own words.`
    : undefined;
}

// Whether the answers' language is among the languages the chat has pages in, once it has any, for
// Review (the language can change after the plan). Pure.
export function answersLanguageNote(answers: string, held: readonly string[]): string | undefined {
  if (!held.length || answers === "auto" || !answers) return undefined;
  const own = primaryLanguage(answers);
  return held.some((l) => primaryLanguage(l) === own)
    ? undefined
    : `This chat answers in ${languageLabel(own)}, but none of its pages are in that language: answers are translated from ${held.map((l) => languageLabel(primaryLanguage(l))).join(", ")} pages.`;
}

// Folders become sections: the first path segment (after Only these paths' single prefix and a
// language prefix), and the second where a big section is mostly sub-folders (/blog/<topic>).
function sectionsFor(items: { segments: string[] }[], base: string[]): string[] {
  // A language prefix ("/de", "/es-mx") stays part of the section's name.
  const prefixOf = (segments: string[]) =>
    segments[base.length] && segmentLanguage([segments[base.length]!]) ? base.length + 1 : base.length;
  const prefixes = items.map((item) => prefixOf(item.segments));
  // A first-level name is a folder when some page sits under it.
  const folders = new Set<string>();
  items.forEach((item, i) => {
    const at = prefixes[i]!;
    if (item.segments.length > at + 1) folders.add(item.segments.slice(0, at + 1).join("/"));
  });
  const first = items.map((item, i) => {
    const at = prefixes[i]!;
    const head = item.segments.slice(0, at + 1).join("/");
    return folders.has(head) ? head : item.segments.slice(0, at).join("/");
  });
  // Split a big folder by its sub-folders when they hold most of it and aren't too many.
  const result = [...first];
  for (const [key, members] of groupBy(first.keys(), (i) => first[i]!)) {
    if (members.length < 40 || !folders.has(key)) continue;
    const depth = key.split("/").length;
    const deeper = members.filter((i) => items[i]!.segments.length > depth + 1);
    const sub = groupBy(deeper, (i) => items[i]!.segments.slice(0, depth + 1).join("/"));
    const inSub = [...sub.values()].reduce((n, m) => n + m.length, 0);
    if (sub.size >= 2 && sub.size <= 25 && inSub >= members.length / 2) {
      for (const [name, subMembers] of sub) for (const i of subMembers) result[i] = name;
    }
  }
  return result.map((key) => `/${key}`);
}

// The folder a page's sitemap date is compared within: its first folder after a language
// prefix ("/de/resources"), or the top-level pages of its language ("/de").
function stampFolder(segments: readonly string[]): string {
  const at = segments[0] && segmentLanguage([segments[0]]) ? 1 : 0;
  return `/${segments.slice(0, segments.length > at + 1 ? at + 1 : at).join("/")}`;
}

// The (folder, day) pairs whose lastmod is bulk-stamped: STAMP_PAGES or more of the folder's
// pages, and STAMP_SHARE or more of its dated ones, share the day.
export function stampedDays(items: readonly { lastmod?: string; segments: readonly string[]; folder?: string }[]): Set<string> {
  const byFolder = groupBy(
    items.filter((i) => i.lastmod),
    (i) => i.folder ?? stampFolder(i.segments),
  );
  const stamped = new Set<string>();
  for (const [folder, members] of byFolder) {
    if (members.length < STAMP_PAGES) continue;
    for (const [day, same] of groupBy(members, (m) => m.lastmod!)) {
      if (same.length >= STAMP_PAGES && same.length >= members.length * STAMP_SHARE) stamped.add(`${folder} ${day}`);
    }
  }
  return stamped;
}

export const isArticleUrl = (url: string) => segmentsOf(new URL(url).pathname).some((s) => ARTICLE_SECTIONS.has(s));

function classify(input: PlanInput): { all: RankedPage[]; inScope: RankedPage[]; scope?: string; named: Map<RankedPage, KeyFacts> } {
  const plain = input.include.filter((p) => p.trim());
  const base = plain.length === 1 && !plain[0]!.includes("*") ? segmentsOf(plain[0]!) : [];
  const parsed = input.entries.map((entry, order) => {
    const u = new URL(entry.url);
    const segments = segmentsOf(u.pathname);
    // A lastmod after today is unknown, like a bulk-stamped one.
    const lastmod = knownDay(entry.lastmod, input.today);
    // Below Only these paths' single prefix, key pages are read as from the site's root: the
    // demo's /sitefinity-cms/how-to-buy is one level deep.
    const skip = base.length && base.every((b, i) => segments[i] === b) ? base.length : 0;
    return { entry, order, u, segments, skip, folder: stampFolder(segments), key: pageKey(entry.url, u), lastmod };
  });
  const keys = new Set(parsed.map((p) => p.key));
  const sections = sectionsFor(parsed, base);
  const stamps = stampedDays(parsed);
  // Release notes: the newest major version of each product (the last segment's text before its
  // version) in each section. Notes for earlier majors match "versions".
  const versioned = parsed.map(({ segments }, i) => {
    const last = segments.at(-1) ?? "";
    const m = segments.slice(0, -1).some((s) => RELEASE_SECTION.test(s)) ? VERSION.exec(last) : null;
    return m ? { product: `${sections[i]}|${last.slice(0, m.index).replace(/[-_v. ]+$/i, "")}`, major: Number(m[1]) } : undefined;
  });
  const majors = new Map<string, number[]>();
  for (const v of versioned) if (v) majors.set(v.product, [...(majors.get(v.product) ?? []), v.major]);
  const newestMajor = new Map(
    [...majors].filter(([, list]) => new Set(list).size >= MIN_VERSIONS).map(([product, list]) => [product, Math.max(...list)]),
  );
  // A page named for a version of the product its folder is named for (progress.com's
  // /sitefinity-cms/13-3-lts) is an earlier version's page too, once that product's release
  // notes list a newer major.
  const newestByName = new Map<string, number>();
  for (const [product, major] of newestMajor) {
    const name = product.slice(product.indexOf("|") + 1);
    if (name) newestByName.set(name, Math.max(major, newestByName.get(name) ?? 0));
  }
  const versionPage = (segments: readonly string[]): boolean => {
    const m = segments.length >= 2 ? VERSION_PAGE.exec(segments.at(-1)!) : null;
    return Boolean(m && Number(m[1]) < (newestByName.get(segments[0]!) ?? 0));
  };
  // How many of a key page's first two levels name an intent (/purchase/support-plans before
  // /support/wpf among support pages), its other words, and its depth below the prefix.
  const named = new Map<RankedPage, KeyFacts>();
  const all = parsed.map(({ entry, order, u, segments, skip, folder, key, lastmod }, i): RankedPage => {
    const stamped = Boolean(lastmod && stamps.has(`${folder} ${lastmod}`));
    const date = (stamped ? undefined : lastmod) ?? urlDate(entry.url, input.today, u.pathname);
    const age = ageDays(date, input.today);
    const addressed = addressIntent(segments, skip);
    const matches: PlanRule[] = [];
    if (conversion(segments)) matches.push("conversion");
    // An A/B or regional variant: /contact-m next to /contact.
    const path = u.pathname.replace(/\/+$/, "");
    const last = path.slice(path.lastIndexOf("/") + 1);
    const base = /-[a-z]$/i.test(last) ? last.slice(0, -2) : "";
    if (/[a-z]/i.test(base) && keys.has(pageKey(`${u.origin}${path.slice(0, path.lastIndexOf("/") + 1)}${base}${u.search}`)))
      matches.push("duplicate");
    // An events index's date says when its page was made, not what it lists: only its text can say,
    // once it's loaded (announcesUpcoming; round 7: janes.com's and seeburger.com's indexes).
    const eventsIndex = EVENT_FOLDERS.has(segments.at(-1) ?? "");
    if (age !== undefined && age > ARCHIVE_DAYS && segments.some((s) => ARCHIVE_SECTIONS.has(s)) && !eventsIndex) matches.push("archive");
    if (oldYear(u.pathname, input.today)) matches.push("year");
    const version = versioned[i];
    if ((version && version.major < (newestMajor.get(version.product) ?? 0)) || versionPage(segments)) matches.push("versions");
    // Key, FAQ, help and support pages, the home page and top-level pages aren't left out by age
    // alone.
    if (
      age !== undefined &&
      age > OLD_DAYS &&
      !eventsIndex &&
      !(input.keyPages !== false && (addressed || evergreen(segments) || topLevel(segments, skip)))
    )
      matches.push("old");
    const page: RankedPage = {
      entry,
      key,
      lang: entryLanguage(entry, segments),
      section: sections[i]!,
      folder,
      depth: segments.length,
      ...(date && { date }),
      stamped,
      article: segments.some((s) => ARTICLE_SECTIONS.has(s)),
      overview: isOverviewUrl(entry.url, u, segments) || Boolean(input.known?.get(key)?.includes("overview")),
      matches,
      order,
      ...(addressed && { intent: addressed.intent }),
      keyPage: false,
    };
    if (addressed) named.set(page, { named: addressed.named, extra: addressed.extra, depth: addressed.depth });
    return page;
  });
  const inScope = all.filter((c, i) => withinRules(c.entry.url, input.include, input.exclude, parsed[i]!.u.pathname));
  const scope = plain.length ? (base.length ? `under /${base.join("/")}` : "within Only these paths") : undefined;
  return { all, inScope, ...(scope && { scope }), named };
}

// What sorts a key page among its intent's: its depth below the prefix, how many of its two
// levels name an intent, and the other words in the one that decides.
interface KeyFacts {
  named: number;
  extra: number;
  depth: number;
}

// A page that can be a key page: it names an intent, and isn't a thank-you page, an A/B variant
// or a listing by its address (a page loading found mostly links is still one: crayola.com's
// /support hubs).
const keyCandidate = (c: RankedPage) =>
  Boolean(c.intent) && !c.matches.some((r) => r === "conversion" || r === "duplicate") && !isOverviewUrl(c.entry.url);

// The key pages, best first: per language and intent, shallowest first, then the pages whose
// two levels both name an intent, then the plainest address, then the newest, then the shortest;
// the languages and intents take turns, KEY_PER_INTENT at most each, up to limit. A page loading
// found unusable gives its place to the next of its intent (unused lists those replaced, and
// those with no candidate left to take their place).
function pickKeyPages(
  candidates: readonly RankedPage[],
  limit: number,
  langRank: (c: RankedPage) => number,
  languageSize: ReadonlyMap<string, number>,
  named: ReadonlyMap<RankedPage, KeyFacts>,
  unusable: ReadonlySet<string> = new Set(),
): { picked: RankedPage[]; unused: RankedPage[] } {
  const fact = (c: RankedPage) => named.get(c) ?? { named: 0, extra: 0, depth: c.depth };
  const pathLength = (c: RankedPage) => c.entry.url.length;
  const buckets = [...groupBy(candidates, (c) => `${c.lang}|${c.intent}`).values()]
    .map((members) => {
      // A quote form after the pages that state prices, and only one of them while there is such a
      // page (round 7: planetmagpie.com's pricing key pages were three 0-word quote forms).
      const quote = (c: RankedPage) =>
        c.intent === "price" &&
        QUOTE_ADDRESS.test(
          c.entry.url
            .replace(/[?#].*$/, "")
            .split("/")
            .filter(Boolean)
            .at(-1) ?? "",
        )
          ? 1
          : 0;
      const sorted = members.sort(
        (a, b) =>
          quote(a) - quote(b) ||
          fact(a).depth - fact(b).depth ||
          fact(b).named - fact(a).named ||
          fact(a).extra - fact(b).extra ||
          compare(b.date ?? "", a.date ?? "") ||
          pathLength(a) - pathLength(b) ||
          a.order - b.order,
      );
      // A contact page with more words in its address (/de/kontakt-log-management: another
      // product's form) only when the language has no plain one to use.
      const plain = sorted[0]!.intent === "contact" && sorted.some((c) => fact(c).extra <= 1 && !unusable.has(c.key));
      const slots: { page: RankedPage; replaces: RankedPage[] }[] = [];
      let skipped: RankedPage[] = [];
      const priced = sorted.some((c) => !quote(c) && !unusable.has(c.key));
      let quotes = 0;
      for (const c of plain ? sorted.filter((m) => fact(m).extra <= 1) : sorted) {
        if (slots.length >= KEY_PER_INTENT) break;
        if (quote(c) && priced && quotes++ >= 1) continue;
        if (unusable.has(c.key)) skipped.push(c);
        else {
          slots.push({ page: c, replaces: skipped });
          skipped = [];
        }
      }
      return { first: sorted[0]!, slots, tail: skipped };
    })
    .sort(
      (a, b) =>
        langRank(a.first) - langRank(b.first) ||
        (languageSize.get(b.first.lang) ?? 0) - (languageSize.get(a.first.lang) ?? 0) ||
        compare(a.first.lang, b.first.lang) ||
        KEY_INTENTS.indexOf(a.first.intent!) - KEY_INTENTS.indexOf(b.first.intent!),
    );
  const picked: RankedPage[] = [];
  const unused: RankedPage[] = [];
  for (let round = 0; round < KEY_PER_INTENT && picked.length < limit; round++) {
    for (const bucket of buckets) {
      if (picked.length >= limit) break;
      const slot = bucket.slots[round];
      if (slot) {
        picked.push(slot.page);
        unused.push(...slot.replaces);
      }
      // Unusable ones with nothing left to take their place.
      if (round === bucket.slots.length && bucket.tail.length) unused.push(...bucket.tail);
    }
  }
  return { picked, unused };
}

// The folders a site lists its events in, by language.
const EVENT_FOLDERS = new Set([
  "events",
  "event",
  "veranstaltungen",
  "eventos",
  "evenements",
  "événements",
  "evenementen",
  "eventi",
  "messen",
  "trade-shows",
  "tradeshows",
]);

// The events section's own pages (/events/automation-summit-2026, /de/veranstaltungen/x): one
// level below an events folder, not dated over a year ago nor naming an earlier year, newest first
// (undated after), up to KEY_PER_INTENT per language and `room` in all. Taken right after the key
// pages: "Are there any upcoming events?" is answered from them (round 6: hms-networks.com lists
// 126 events under /events; none was synced, and the answer came from the shareholders page).
function pickEventPages(candidates: readonly RankedPage[], room: number, today: Date): RankedPage[] {
  if (room <= 0) return [];
  // The events folder may sit under a section (/media/events, /marine/events,
  // /de/ressourcen/events: round 7, wartsila.com and mews.com had none taken); its index lists
  // the dates, so it comes first, then its pages.
  const index = new Set<RankedPage>();
  const events = candidates.filter((c) => {
    const segments = segmentsOf(new URL(c.entry.url).pathname);
    const at = segments[0] && segmentLanguage([segments[0]]) ? 1 : 0;
    const folder = segments.findIndex((s, i) => i >= at && i <= at + 2 && EVENT_FOLDERS.has(s));
    if (folder < 0 || segments.length > folder + 2) return false;
    if (c.matches.includes("conversion") || c.matches.includes("duplicate")) return false;
    if (segments.length === folder + 1) {
      index.add(c);
      return true;
    }
    if (c.overview) return false;
    const age = ageDays(c.date, today);
    return (age === undefined || age <= ARCHIVE_DAYS) && !oldYear(new URL(c.entry.url).pathname, today);
  });
  const picked: RankedPage[] = [];
  for (const members of groupBy(events, (c) => c.lang).values()) {
    const sorted = [...members].sort(
      (a, b) => Number(index.has(b)) - Number(index.has(a)) || compare(b.date ?? "", a.date ?? "") || a.order - b.order,
    );
    picked.push(...sorted.slice(0, KEY_PER_INTENT));
  }
  return picked.slice(0, room);
}

// A suggested exclusion in a few words, for the key pages it keeps out.
const RULE_SHORT: Record<PlanRule, string> = {
  conversion: "conversion pages",
  duplicate: "duplicates",
  archive: "archive pages",
  year: "an earlier year in the address",
  versions: "earlier versions",
  old: "not updated in 2 years",
};

// Folders whose pages are tied to a time (webinars, events, whitepapers): without a date of their
// own, they can't be told fresh from stale before they load, so they come after the site's
// specific pages, though still ahead of listings.
const TIME_BOUND_SECTIONS = new Set([...ARCHIVE_SECTIONS, "whitepapers", "whitepaper", "white-papers", "ebooks", "ebook", "on-demand"]);
const undatedTimeBound = (c: RankedPage) => !c.date && segmentsOf(new URL(c.entry.url).pathname).some((s) => TIME_BOUND_SECTIONS.has(s));

// How many undated pages of one folder are spread by hand (the rest follow in scrambled order):
// enough for any page budget, and quick on telerik.com's 150,000 pages.
const SPREAD_POOL = 400;

// A stable scramble of a word (FNV-1a), so undated pages starting with different words are taken
// across the alphabet rather than from its start.
const scramble = (word: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 0x01000193);
  return h >>> 0;
};

// The pages a sync takes, best first, after the languages and ticked suggestions:
// 0. key pages (pickKeyPages): addresses naming price, buy, contact, support, trial or FAQ, one
//    or two levels deep (deeper ones after), never from article folders, up to an eighth of the
//    budget and 25;
// 1. a served language (or pages nothing marks) before another language the partner chose;
// 2. undated pages in time-bound folders (webinars, events, whitepapers) after the other specific
//    pages, and overview pages (listings, tags, archives) after every specific page: demoted, not
//    dropped;
// 3. in turn from each section, larger sections taking more turns, so a small budget covers the
//    site rather than its biggest folder;
// 4. within a section, shallowest first, and within each depth the newest date, then (for pages
//    without one) the sitemap's priority, then spread across the section by the first and
//    last words of the address, then sitemap order. Undated sections are often listed
//    alphabetically: crayola.com's /stain-tips would otherwise give a run of "Acrylic Paint
//    on…", or fifteen pages "on appliances".
export function rankPages(input: PlanInput): {
  ranked: RankedPage[];
  inScope: RankedPage[];
  selected: Set<string>;
  scope?: string;
  keyPages: PlanKeyPages;
} {
  const { all, inScope, scope, named } = classify(input);
  const counts = new Map<string, number>();
  for (const c of inScope) counts.set(c.lang, (counts.get(c.lang) ?? 0) + 1);
  const selected = new Set(input.languages ?? defaultLanguages(counts, input.served));
  const served = new Set(input.served.map(primaryLanguage));
  const ticked = new Set(input.rules);
  // No language selected means every language (as sync_sources.languages).
  const languageChosen = (c: RankedPage) => selected.size === 0 || selected.has(c.lang);
  const inLanguage = inScope.filter((c) => languageChosen(c) && !c.matches.some((r) => ticked.has(r)));

  // Unmarked pages are taken as the site's own language; a known other language comes after.
  const langRank = (c: RankedPage) => (c.lang === "und" || served.has(primaryLanguage(c.lang)) ? 0 : 1);

  // Key pages first. The ones the partner's choices kept out are named with the reason: the
  // pick without Only these paths, Leave out and the ticked suggestions, against the real one.
  // None in the selection from before key pages.
  const limit = input.keyPages === false ? 0 : keyPageLimit(input.budget);
  // Key pages only in the deployment's languages (round 7: bynder.com's 30 key pages in German,
  // French, Dutch… were taken and then all left out as another language). An unmarked page under
  // a two-letter folder that isn't one of them (/dk/book-demo, /se/boka-demo) gives way to the
  // intent's other pages.
  const keyLanguage = (pages: readonly RankedPage[]) => {
    const own = pages.filter((c) => !served.size || langRank(c) === 0);
    const foreign = (c: RankedPage) => {
      const first = segmentsOf(new URL(c.entry.url).pathname)[0] ?? "";
      return c.lang === "und" && served.size > 0 && /^[a-z]{2}$/i.test(first) && !served.has(first.toLowerCase());
    };
    const plainIntents = new Set(own.filter((c) => !foreign(c)).map((c) => c.intent));
    return own.filter((c) => !foreign(c) || !plainIntents.has(c.intent));
  };
  const pick = limit
    ? pickKeyPages(keyLanguage(inLanguage.filter(keyCandidate)), limit, langRank, counts, named, input.unusable)
    : undefined;
  const intentKeys = pick?.picked ?? [];
  for (const c of intentKeys) c.keyPage = true;
  for (const c of pick?.unused ?? []) c.keyUnusable = true;
  // Then the events section's own pages, within the key pages' limit.
  const events = limit
    ? pickEventPages(
        keyLanguage(inLanguage.filter((c) => !c.keyPage && !c.keyUnusable)),
        // At least two, even when the intents' pages fill the limit: "Any upcoming events?"
        // needs the events list (round 7: wartsila.com's /media/events wasn't taken).
        Math.max(limit - intentKeys.length, Math.min(2, limit)),
        input.today,
      )
    : [];
  for (const c of events) c.keyPage = true;
  const keys = [...intentKeys, ...events];
  const scoped = new Set(inScope);
  const notTaken = (
    limit ? pickKeyPages(keyLanguage(all.filter((c) => languageChosen(c) && keyCandidate(c))), limit, langRank, counts, named).picked : []
  )
    .filter((c) => !c.keyPage)
    .map((c) => {
      const path = new URL(c.entry.url).pathname;
      const rule = c.matches.find((r) => ticked.has(r));
      const why = !scoped.has(c)
        ? input.include.some((p) => p.trim()) && !pathMatches(c.entry.url, input.include)
          ? "outside Only these paths"
          : "left out by you in Leave out"
        : rule
          ? `left out by a suggested exclusion: ${RULE_SHORT[rule]}`
          : "more key pages than the plan takes";
      return { path, intent: c.intent!, why };
    });
  // A buying page answers price questions too (telerik.com's /purchase.aspx is its price list).
  const addressed = new Set(all.flatMap((c) => (c.intent ? [c.intent] : [])));
  const looked: Record<"price" | "contact" | "support", KeyIntent[]> = {
    price: ["price", "buy"],
    contact: ["contact"],
    support: ["support"],
  };
  const keyPages: PlanKeyPages = {
    limit,
    taken: intentKeys.map((c) => {
      const path = new URL(c.entry.url).pathname;
      return { path, intent: c.intent!, label: pageLabel(path) };
    }),
    notTaken,
    none: (["price", "contact", "support"] as const).filter((i) => !looked[i].some((x) => addressed.has(x))),
    ...(events.length && {
      events: events.map((c) => {
        const path = new URL(c.entry.url).pathname;
        return { path, label: pageLabel(path) };
      }),
    }),
  };
  // The other pages go in the order they'd have without key pages (each section still counts its
  // key pages for its turns), so taking key pages changes as little as it can: they come in place
  // of the pages at the end of the budget.
  const rest = inLanguage;
  // The page's turn among those in its section starting with the same word, or ending with the
  // same one, whichever is later: crayola.com's stain tips vary by both ("marker-on-appliances",
  // "marker-on-carpet"), and either alone gives a run of one kind.
  const spread = new Map<RankedPage, number>();
  const slugWords = (c: RankedPage) => {
    const path = c.entry.url.replace(/[?#].*$/, "").replace(/\/+$/, "");
    return path
      .slice(path.lastIndexOf("/") + 1)
      .toLowerCase()
      .split(/[-_.\s%]+/)
      .filter(Boolean);
  };
  // Undated pages of a folder and depth, in the order they should be taken: each next one the page
  // whose first and last words have been used least so far (the first SPREAD_POOL candidates, in a
  // scrambled order; the rest after them). Words most of the folder's addresses share ("stain",
  // "tip" in "…-stain-tip") tell nothing apart, so they're set aside first.
  for (const members of groupBy(
    rest.filter((c) => !c.date),
    (c) => `${c.section}|${c.depth}`,
  ).values()) {
    const words = members.map(slugWords);
    const seen = new Map<string, number>();
    for (const list of words) for (const w of new Set(list)) seen.set(w, (seen.get(w) ?? 0) + 1);
    const common = (w: string) => members.length >= 4 && (seen.get(w) ?? 0) > members.length / 2;
    const pool = members
      .map((c, i) => {
        const telling = words[i]!.filter((w) => !common(w));
        const list = telling.length ? telling : words[i]!;
        const first = list[0] ?? "";
        return { c, first, last: list.at(-1) ?? "", key: scramble(first) };
      })
      .sort((a, b) => a.key - b.key || a.c.order - b.c.order);
    const firsts = new Map<string, number>();
    const lasts = new Map<string, number>();
    const left = pool.slice(0, SPREAD_POOL);
    let position = 0;
    while (left.length) {
      let best = 0;
      let bestCost = Number.POSITIVE_INFINITY;
      for (let i = 0; i < left.length; i++) {
        const p = left[i]!;
        const cost = (firsts.get(p.first) ?? 0) + (lasts.get(p.last) ?? 0);
        if (cost < bestCost) {
          best = i;
          bestCost = cost;
          if (cost === 0) break;
        }
      }
      const [p] = left.splice(best, 1);
      firsts.set(p!.first, (firsts.get(p!.first) ?? 0) + 1);
      lasts.set(p!.last, (lasts.get(p!.last) ?? 0) + 1);
      spread.set(p!.c, position++);
    }
    for (const p of pool.slice(SPREAD_POOL)) spread.set(p.c, position++);
  }
  const within = (a: RankedPage, b: RankedPage) =>
    a.depth - b.depth ||
    compare(b.date ?? "", a.date ?? "") ||
    (b.entry.priority ?? 0.5) - (a.entry.priority ?? 0.5) ||
    (a.date ? 0 : spread.get(a)! - spread.get(b)!) ||
    a.order - b.order;
  const sectionSize = new Map<string, number>();
  for (const c of rest) sectionSize.set(c.section, (sectionSize.get(c.section) ?? 0) + 1);
  const turn = new Map<RankedPage, number>();
  // Worked out once per page: the sort below compares each page many times.
  const tiers = new Map(rest.map((c) => [c, c.overview ? 2 : undatedTimeBound(c) ? 1 : 0]));
  const tier = (c: RankedPage) => tiers.get(c)!;
  for (const members of groupBy(rest, (c) => `${langRank(c)}|${tier(c)}|${c.section}`).values()) {
    const weight = Math.sqrt(sectionSize.get(members[0]!.section) ?? 1);
    for (const [i, c] of members.sort(within).entries()) turn.set(c, i / weight);
  }
  const ranked = [
    ...keys,
    ...rest
      .filter((c) => !c.keyPage)
      .sort((a, b) => langRank(a) - langRank(b) || tier(a) - tier(b) || turn.get(a)! - turn.get(b)! || within(a, b)),
  ];
  return { ranked, inScope, selected, ...(scope && { scope }), keyPages };
}

export function planContent(input: PlanInput, labels: Partial<Record<PlanRule, string>> = {}): ContentPlan {
  const { ranked, inScope, selected, scope, keyPages } = rankPages(input);
  const counts = new Map<string, number>();
  for (const c of inScope) counts.set(c.lang, (counts.get(c.lang) ?? 0) + 1);
  const languages = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([tag, pages]) => ({
      tag,
      label: languageLabel(tag),
      pages,
      supported: tag === "und" || isLanguage(primaryLanguage(tag)),
      selected: selected.has(tag),
    }));
  const inLanguages = inScope.filter((c) => selected.size === 0 || selected.has(c.lang));

  const taken = ranked.slice(0, Math.max(0, input.budget));
  const takenSet = new Set(taken);
  const sections = new Map<string, PlanSection>();
  for (const c of inLanguages) {
    const s = sections.get(c.section) ?? { path: c.section, pages: 0, old: 0, taken: 0, takes: [] };
    s.pages += 1;
    if (c.date && (!s.newest || c.date > s.newest)) s.newest = c.date;
    if (c.date && (!s.oldest || c.date < s.oldest)) s.oldest = c.date;
    if (c.matches.includes("old")) s.old += 1;
    if (takenSet.has(c)) s.taken += 1;
    sections.set(c.section, s);
  }
  for (const c of taken) sections.get(c.section)?.takes.push({ path: new URL(c.entry.url).pathname, ...(c.date && { date: c.date }) });
  const stamps = new Map<string, PlanStamp>();
  for (const c of inLanguages) {
    if (!c.stamped) continue;
    const stamp = stamps.get(`${c.folder} ${c.entry.lastmod}`) ?? { section: c.folder, day: c.entry.lastmod!, pages: 0 };
    stamp.pages += 1;
    stamps.set(`${c.folder} ${c.entry.lastmod}`, stamp);
  }
  const ticked = new Set(input.rules);
  const suggestions = PLAN_RULES.map((rule): PlanSuggestion => {
    const matching = inLanguages.filter((c) => c.matches.includes(rule));
    const bySection = new Map<string, number>();
    for (const c of matching) bySection.set(c.section, (bySection.get(c.section) ?? 0) + 1);
    return {
      rule,
      label: labels[rule] ?? ruleLabel(rule, input.today),
      pages: matching.length,
      ticked: ticked.has(rule),
      bySection: [...bySection]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([path, pages]) => ({ path, pages })),
      wholeSections: [...bySection]
        .filter(([path, pages]) => path !== "/" && pages > 1 && pages === sections.get(path)?.pages)
        .map(([path]) => path)
        .sort(compare)
        .slice(0, 12),
    };
  });
  const dates = taken.flatMap((c) => (c.date ? [c.date] : [])).sort();
  return {
    total: input.entries.length,
    dated: input.entries.filter((e) => knownDay(e.lastmod, input.today)).length,
    inScope: inScope.length,
    ...(scope && { scope }),
    languages,
    inLanguages: inLanguages.length,
    sections: [...sections.values()].sort((a, b) => b.pages - a.pages || compare(a.path, b.path)),
    suggestions,
    eligible: ranked.length,
    taken: taken.length,
    ...(dates[0] && { oldestTaken: dates[0], newestTaken: dates.at(-1)! }),
    undatedTaken: taken.length - dates.length,
    stamped: [...stamps.values()].sort((a, b) => b.pages - a.pages || compare(a.section, b.section)),
    keyPages,
  };
}

const INTENT_NAMES: Record<KeyIntent, string> = {
  price: "pricing",
  contact: "contact",
  support: "support",
  buy: "buying",
  trial: "trial or demo",
  faq: "FAQ",
};
export const intentName = (intent: KeyIntent) => INTENT_NAMES[intent];

// A crawled site has no ranking to cap its key pages: at most KEY_PER_INTENT of each intent per
// language, the shallowest and shortest addresses; the others are ordinary pages (round 7:
// alfredapp.com's 87 "support" key pages out of 181). Pure.
export function capKeyIntents<T extends { url: string; intent: KeyIntent | null }>(listed: readonly T[]): T[] {
  const depth = (url: string) => segmentsOf(new URL(url).pathname).length;
  const groups = groupBy(
    listed.filter((l) => l.intent),
    (l) => `${pathLanguage(l.url) ?? ""}|${l.intent}`,
  );
  const keep = new Set<T>();
  for (const members of groups.values()) {
    const best = [...members].sort((a, b) => depth(a.url) - depth(b.url) || a.url.length - b.url.length);
    for (const m of best.slice(0, KEY_PER_INTENT)) keep.add(m);
  }
  return listed.map((l) => (l.intent && !keep.has(l) ? { ...l, intent: null } : l));
}

// The plan's Key pages line: "Key pages: 9 taken (pricing, contact, support plans, request a
// quote…)", then any it couldn't take and why, and what no address names.
export function keyPagesNote(keys: PlanKeyPages, shown = 6): { taken: string; notTaken?: string; none?: string } {
  const labels = [...new Set(keys.taken.map((k) => k.label))];
  const list = labels.length > shown ? `${labels.slice(0, shown).join(", ")}…` : labels.join(", ");
  const events = keys.events?.length
    ? ` Then ${keys.events.length === 1 ? "1 page" : `${keys.events.length} pages`} from the events section (${keys.events
        .slice(0, 3)
        .map((e) => e.path)
        .join(", ")}${keys.events.length > 3 ? "…" : ""}), for questions about upcoming events.`
    : "";
  const taken = keys.taken.length
    ? `Key pages: ${keys.taken.length} taken (${list}), ahead of the sections, and never left out by age alone.${events}`
    : `Key pages: none taken. No address in the plan names pricing, buying, contact, support, a trial or an FAQ.${events}`;
  const notTaken = keys.notTaken.length
    ? `Not taken: ${keys.notTaken
        .slice(0, shown)
        .map((k) => `${k.path} (${k.why})`)
        .join(", ")}${keys.notTaken.length > shown ? `, and ${keys.notTaken.length - shown} more` : ""}.`
    : undefined;
  const none = keys.none.length
    ? `No ${keys.none
        .map(intentName)
        .join(", ")
        .replace(
          /, ([^,]*)$/,
          " or $1",
        )} page in the sitemaps: questions about ${keys.none.length === 1 ? "it" : "them"} may need a page added by hand once the sync runs.`
    : undefined;
  return { taken, ...(notTaken && { notTaken }), ...(none && { none }) };
}

// Which ranked pages a sync takes: down the ranking until the budget is full. Pages an earlier
// sync left out (duplicates, conversion pages…) stay listed with their reason but don't use up
// the budget, so the pages that replaced them stay too. Pages a person added by hand (pinned,
// by key) are taken first by the sync, whatever the budget, up to MAX_PINNED. The worker lists
// pages with it; Bring up to date previews what a re-sync would add and drop.
// A duplicate whose canonical isn't in the ranking still uses its place: the canonical is synced
// in its stead (whatsupgold.com's https pages pointing at their http copies made 201 of 200).
export function selectPages(
  ranked: readonly RankedPage[],
  existing: ReadonlyMap<string, { status: string; detail?: string | null }>,
  budget: number,
  pinned: ReadonlySet<string> = new Set(),
): RankedPage[] {
  const selected: RankedPage[] = [];
  const rankedKeys = new Set(ranked.map((p) => p.key));
  let counted = 0;
  for (const page of ranked) {
    if (pinned.has(page.key)) continue;
    if (counted >= budget) break;
    selected.push(page);
    const row = existing.get(page.key);
    const target = row?.status === "skipped" ? duplicateTarget(row.detail) : undefined;
    if (row?.status !== "skipped" || (target && !rankedKeys.has(safeKey(target)))) counted += 1;
  }
  return selected;
}

// What loading found unusable, for key pages (PlanInput.unusable): failed, or left out (too little
// text, an error page, a duplicate, another language, a stale price). Not a page waiting for a
// person to keep it, nor one an older rule left out as an overview: key pages aren't any more, so
// it's sent when it's read again.
export const unusableForKeys = (r: { status: string; detail?: string | null }) =>
  r.status === "failed" ||
  (r.status === "skipped" && !r.detail?.startsWith(KEEP_ASKED) && !r.detail?.startsWith("An overview page, mostly links"));

// The page a skipped duplicate points at, from the reason it was left out.
export const duplicateTarget = (detail: string | null | undefined) =>
  /^Duplicate of (\S+), which is synced instead\.$/.exec(detail ?? "")?.[1];
const safeKey = (url: string) => {
  try {
    return pageKey(url);
  } catch {
    return url;
  }
};

// A dated line that's a news item's publication stamp, not something happening on that date: words,
// a separator, then the date at the end, with no word for an event (imeche.org's /events lists "IMechE
// Design Challenge 2027 Device Rules and Guidelines available · 02 Nov 2026" among its news, which
// read as the next event). Pure.
const STAMP_AT_END = /\s[·•|]\s*\d{1,2}\s+\p{L}{3,9}\.?\s+\d{4}\s*$|\s[·•|]\s*\p{L}{3,9}\.?\s+\d{1,2},?\s+\d{4}\s*$/u;
const EVENT_WORD =
  /\b(?:event|conference|webinar|seminar|workshop|summit|forum|expo|exhibition|meetup|meet-up|course|training|tour|congress|symposium|fair|messe|konferenz|tagung|kongress|veranstaltung|schulung|conferencia|seminario|taller|feria|conférence|séminaire|salon|congrès|evenement|beurs|cursus)\b/i;
export const publicationStamp = (line: string): boolean => STAMP_AT_END.test(line) && !EVENT_WORD.test(line);

// An error page served as a normal page: a short page whose title or heading says it's an error
// (the demo's /try-now/sandbox/invalid-token, "Your Token is Invalid"). Its reason, or undefined.
const ERROR_HEADING =
  /\b(404|not found|page (?:does not|doesn't) exist|no longer (?:exists|available)|not currently available|we(?:'|’)re sorry|page you (?:are|were|'re) looking for|(?:token|link|session) (?:is |has )?(?:invalid|expired|been revoked)|invalid (?:token|link|request)|expired (?:token|link)|access denied|forbidden|unauthori[sz]ed|something went wrong|an error (?:has )?occurred|seite nicht gefunden|pagina no encontrada|página no encontrada|page introuvable|pagina non trovata|pagina niet gevonden|página não encontrada)\b/i;
const ERROR_TEXT =
  /\b(404|page not found|(?:token|link) (?:is |has )?(?:invalid|expired)|access denied|(?:page|content) you (?:are|were|'re) looking for (?:is|was|could|can)[^.]{0,40}|not currently available)\b/i;
export function errorPage(page: { title?: string; markdown: string; words: number }): string | undefined {
  if (page.words > 150) return undefined;
  const headings = [...page.markdown.matchAll(/^#{1,3}\s+(.+)$/gm)].slice(0, 2).map((m) => m[1]!.trim());
  const said =
    [page.title ?? "", ...headings].find((line) => ERROR_HEADING.test(line)) ??
    (ERROR_TEXT.test(page.markdown.slice(0, 200)) ? page.markdown.slice(0, 200).match(ERROR_TEXT)![0] : undefined);
  return said ? `An error page ("${said.slice(0, 60)}"), with nothing to answer from.` : undefined;
}

// "412 pages in /webinars share the sitemap date 29 Jun 2026": the plan's note for each folder
// whose sitemap dates it treats as unknown.
export function stampNote(stamp: PlanStamp): string {
  const n = stamp.pages.toLocaleString("en");
  return `${n} ${stamp.pages === 1 ? "page" : "pages"} in ${stamp.section} share the sitemap date ${formatPlanDay(stamp.day)}`;
}

// How the plan found the site's pages, for the sitemap discovery the sniffer reports
// (apps/sniffer/src/pages.ts SitemapDiscovery). Undefined when robots.txt's own sitemaps gave
// them: nothing to explain.
export interface SitemapDiscovery {
  how: "given" | "robots" | "fallback";
  why?: "none-listed" | "elsewhere" | "no-pages";
  elsewhere: string[];
  used: string[];
  givenEmpty?: string;
}

const shortUrl = (url: string) => url.replace(/^https?:\/\//, "");

// What to say when there's no price table: no pricing page, prices by quote, or a pricing page whose
// prices couldn't be read (round 7: the card said "no pricing page was found" of alfredapp.com's
// /shop/). Pure.
export function noPriceTableNote(
  table: { rows: readonly unknown[]; gap?: { kind: "unread" | "quote"; url: string } } | null | undefined,
  // false: no page has been read yet, so nothing is known about a pricing page. "reading": the first
  // sync is running, and the table is built when it ends (round 7: "no pricing page was found" for
  // 9 minutes, with /pricing already indexed).
  read: boolean | "reading" = true,
): string {
  if (read === "reading" && !table?.gap) return "The price table is still being read: the site's first sync hasn't finished.";
  if (table?.gap?.kind === "unread")
    return `A pricing page was found (${new URL(table.gap.url).pathname}), but no prices could be read from it. Check the page, and that price answers match it.`;
  if (table?.gap?.kind === "quote") return `No price table: ${new URL(table.gap.url).pathname} says the site's prices are by quote.`;
  return read ? "No price table: no pricing page was found." : "No price table yet: no page has been read.";
}

// "1 gzipped sitemap file", "16 sitemap files (3 gzipped)". Pure.
export function sitemapFilesNote(files: number, gzipped = 0): string {
  const noun = files === 1 ? "file" : "files";
  if (!gzipped) return `${files} sitemap ${noun}`;
  return gzipped === files ? `${files} gzipped sitemap ${noun}` : `${files} sitemap ${noun} (${gzipped} gzipped)`;
}

export function discoveryNote(discovery: SitemapDiscovery | undefined): string | undefined {
  if (!discovery) return undefined;
  const used = discovery.used.map(shortUrl).join(", ");
  const given = discovery.givenEmpty
    ? `The sitemap address given (${shortUrl(discovery.givenEmpty)}) lists none of this site's pages. `
    : "";
  if (discovery.how === "given") return `Read from the sitemap address given: ${used}.`;
  if (!discovery.used.length) return given || undefined;
  if (discovery.how === "robots") return given ? `${given}The plan used the sitemaps robots.txt lists: ${used}.` : undefined;
  const hosts = [...new Set(discovery.elsewhere.map((url) => new URL(url).hostname))];
  if (discovery.why === "elsewhere")
    return `${given}robots.txt points to ${hosts.join(" and ")}'s ${discovery.elsewhere.length === 1 ? "sitemap" : "sitemaps"}, so the plan used ${used} instead.`;
  if (discovery.why === "no-pages")
    return `${given}The sitemaps robots.txt lists name none of this site's pages, so the plan used ${used} instead.`;
  return `${given}robots.txt names no sitemap; the plan used ${used}.`;
}

// The language a sitemap file's address names: a folder ("/fr-be/sitemap.xml") or a part of its
// name ("sitemap-de.xml", "sitemap_fr_be.xml"). Undefined for a file that names none, which is
// usually the site's main language.
export function sitemapFileLanguage(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const segments = segmentsOf(u.pathname);
  const folder = segmentLanguage(segments.slice(0, -1));
  if (folder) return folder;
  const name = (segments.at(-1) ?? "").replace(/\.(xml(\.gz)?|gz)$/i, "");
  for (const m of name.matchAll(/(?:^|[-_.])([a-z]{2})(?:[-_]([a-z]{2}))?(?=$|[-_.])/gi)) {
    const tag = `${m[1]!.toLowerCase()}${m[2] ? `-${m[2].toLowerCase()}` : ""}`;
    const found = segmentLanguage([tag]);
    if (found) return found;
  }
  return undefined;
}

// What the plan says when the sitemap read is incomplete: the files that couldn't be read even
// when tried again, and those not reached in time, with the languages their addresses name, so
// the partner knows the counts and languages may be short (round 6: teamleader.eu's plan read 67
// of its 120 files and showed no English, German, Italian or Belgian French). The first sync
// reads the site again: an incomplete read isn't kept.
export function incompleteNote(read: {
  failed?: readonly { url: string; status?: number }[];
  unread?: readonly string[];
}): string | undefined {
  const failed = read.failed ?? [];
  const unread = read.unread ?? [];
  if (!failed.length && !unread.length) return undefined;
  const files = [...failed.map((f) => f.url), ...unread];
  const tags = [...new Set(files.map(sitemapFileLanguage))];
  const named = tags.filter((t): t is string => Boolean(t)).map(languageLabel);
  const languages = named.length
    ? ` Languages that may be incomplete: ${named.join(", ")}${tags.includes(undefined) ? ", and pages in files that name no language" : ""}.`
    : "";
  const statuses = [...new Set(failed.map((f) => f.status).filter((s): s is number => Boolean(s)))];
  const parts = [
    failed.length &&
      `${failed.length} sitemap ${failed.length === 1 ? "file" : "files"} couldn't be read, even when tried again${statuses.length ? ` (the site answered ${statuses.join(", ")})` : ""}`,
    unread.length && `${unread.length} ${unread.length === 1 ? "wasn't" : "weren't"} reached in time`,
  ].filter(Boolean);
  const shown = files
    .slice(0, 4)
    .map((url) => url.replace(/^https?:\/\/[^/]+/, ""))
    .join(", ");
  return `The sitemap read is incomplete: ${parts.join(", and ")} (${shown}${files.length > 4 ? `, and ${files.length - 4} more` : ""}). The page count above is short.${languages} The first sync reads them again; check the languages on Content once it has.`;
}

// What the plan says when robots.txt, a sitemap or the start page came back as a bot-protection
// page (the sniffer's blocked.ts): said before a Knowledge Box is spent, with what to ask for.
export function blockedNote(blocked: { url: string; status?: number; by: string }): string {
  let where = blocked.url;
  try {
    where = new URL(blocked.url).pathname;
  } catch {
    // As given.
  }
  const by =
    blocked.by === "bot protection" ? "bot protection" : blocked.by === "a cookie wall" ? "a cookie wall" : `${blocked.by} bot protection`;
  return `The site blocked our reader (${by}): ${where === "/" ? "the start page" : where} answered with a challenge or block page${blocked.status ? ` (${blocked.status})` : ""}. Ask the client's web team to allow the crawler (its user agent starts "LaunchpadSniffer"), then enter the address again. Creating the deployment now would sync nothing.`;
}

// What the plan says when the site rate-limited the sitemap read but every file came in.
export const rateLimitNote = (files: number) =>
  `The site rate-limited the sitemap read (429) on ${files.toLocaleString("en")} ${files === 1 ? "file" : "files"}; it was read more slowly and every file came in. The sync loads pages the same way.`;

// What the first sync does when no sitemap lists a page.
export const crawlNote = (address: string, budget: number) =>
  `No usable sitemap: the first sync follows links from ${address}, up to ${budget.toLocaleString("en")} pages, 3 clicks deep.`;

export function ruleLabel(rule: PlanRule, today: Date): string {
  const year = today.getUTCFullYear() - 2;
  return {
    conversion: "Conversion pages: thank-you, confirmation, success and print pages",
    duplicate: "Duplicates: A/B and regional variants of another page, and pages whose canonical URL points elsewhere",
    archive: "Archive pages: campaigns, events, webinars, press and news not updated in 12 months",
    year: `Pages with ${year} or an earlier year in the address, such as /devreach-${year - 2}`,
    versions: "Release notes for earlier versions: pages naming a version before the newest one listed, such as 14.4 when 15.x is current",
    old: "Pages not updated in 2 years",
  }[rule];
}

// What New deployment stores with the sync source: the plan as the partner accepted it. The
// ticked suggestions are also the rules every later sync applies (planRules).
export function planSummary(plan: ContentPlan, at: Date): ContentPlanSummary {
  return {
    at: at.toISOString(),
    total: plan.total,
    excluded: plan.suggestions.filter((s) => s.ticked).map((s) => ({ rule: s.rule, pages: s.pages })),
    ...(plan.oldestTaken && { oldestTaken: plan.oldestTaken }),
  };
}

export const planRules = (plan: ContentPlanSummary | null | undefined): PlanRule[] =>
  (plan?.excluded ?? []).map((r) => r.rule).filter(isPlanRule);

// The Content panel's and list's count: the sitemaps' total (the scan's and the plan's number),
// then the sync's, saying what it's filtered to.
export function countLine(sync: {
  total?: number;
  found: number | null;
  budget: number;
  include: readonly string[];
  exclude: readonly string[];
  languages: readonly string[];
  rules: readonly PlanRule[];
  discovery: string | null;
  // Pages added by hand, kept whatever the budget ("200 + 2 added by hand").
  pinned?: number;
}): string {
  const n = (value: number) => value.toLocaleString("en");
  const byHand = sync.pinned ? `, plus ${n(sync.pinned)} added by hand` : "";
  if (sync.found === null) return `The budget takes ${n(sync.budget)} pages${byHand}.`;
  if (sync.discovery === "crawl")
    return `The site has no sitemap: the crawl found ${n(sync.found)} pages, and the budget takes ${n(sync.budget)}${byHand}.`;
  const filters: string[] = [];
  const plain = sync.include.filter((p) => p.trim());
  if (plain.length === 1 && !plain[0]!.includes("*")) filters.push(`under ${plain[0]!.replace(/\/+$/, "")}`);
  else if (plain.length) filters.push("within Only these paths");
  const languages = sync.languages.filter((l) => l !== "und");
  if (languages.length) filters.push(`in ${languages.map(languageLabel).join(", ")}`);
  if (sync.rules.length)
    filters.push(`without the ${sync.rules.length === 1 ? "suggested exclusion" : `${sync.rules.length} suggested exclusions`}`);
  if (sync.exclude.length) filters.push("outside Leave out");
  const within = filters.length ? ` ${filters.join(", ")}` : "";
  const total = sync.total ? `The sitemaps list ${n(sync.total)} pages; ${n(sync.found)} are` : `The sitemap lists ${n(sync.found)} pages`;
  return `${total}${within}. The budget takes ${n(Math.min(sync.budget, sync.found))}${byHand}.`;
}

// ---- what loading a page adds ----

export interface RenderedFacts {
  url: string;
  title?: string;
  lang?: string;
  // The best date known without the page's own (the sitemap's, unless bulk-stamped, else the
  // address's), and the page's own published and modified dates.
  lastModified?: Date;
  published?: Date;
  modified?: Date;
  // A JSON-LD Article, BlogPosting or NewsArticle; with the address (isArticleUrl), an article.
  articleType?: string;
  linkShare?: number;
  rootChars?: number;
  textChars?: number;
  // The extracted text, read for prices, offers and versions.
  text?: string;
}

export const isArticle = (page: Pick<RenderedFacts, "url" | "articleType">) => Boolean(page.articleType) || isArticleUrl(page.url);

// The date the age rules go by: an article's publication (its modified date moves with every
// site-wide edit), any other page's last change; the sitemap's or the address's when the page
// states none.
export function pageDate(page: RenderedFacts): { date: Date; kind: "published" | "modified" } | undefined {
  const own = isArticle(page) ? (page.published ?? page.modified) : (page.modified ?? page.published);
  if (own) return { date: own, kind: own === page.published ? "published" : "modified" };
  return page.lastModified ? { date: page.lastModified, kind: "modified" } : undefined;
}

// What a page's text states that goes out of date: a price, a discount or offer, or a product
// version. Figures with a currency ("$7,995", "1.299 €", "USD 99"), "20% off", "discount" in
// the languages the widget serves, "version 13.3", "v14.4", "13.3 LTS", "R3 2024", "2025 Q2".
const PRICE = /[$€£¥]\s?\d|\d[\d.,]*\s?(€|eur\b|usd\b|gbp\b|chf\b)|\b(usd|eur|gbp|chf)\s?\d/i;
const DISCOUNT =
  /\b\d{1,2}\s?% (off|discount)\b|\bsave (up to )?\d{1,2}\s?%|\b(discount|coupon|promo code|special offer|limited[- ]time offer|rabatt|descuento|remise|sconto|desconto|korting)\b/i;
const PRODUCT_VERSION =
  /\b(version|versión|versione|versão|v)\s?\d{1,3}(\.\d{1,4})+\b|\b\d{1,3}\.\d{1,4} lts\b|\br[1-4][\s-]20\d{2}\b|\b20\d{2}[\s-]q[1-4]\b/i;
export function commercialContent(text: string): "a price" | "a discount or offer" | "a version" | undefined {
  if (PRICE.test(text)) return "a price";
  if (DISCOUNT.test(text)) return "a discount or offer";
  if (PRODUCT_VERSION.test(text)) return "a version";
  return undefined;
}

const ageOf = (date: Date, today: Date) => (today.getTime() - date.getTime()) / DAY_MS;
const dayOf = (date: Date) => formatPlanDay(date.toISOString().slice(0, 10));

// A loaded page's language: a language prefix in its address (/it/, /de-de/) wins over what the
// page declares, as in the plan: progress.com's /sitefinity-cms/it/ pages say lang="en".
export const pageLanguage = (page: Pick<RenderedFacts, "url" | "lang">): string | undefined => pathLanguage(page.url) ?? page.lang;

// The flags a synced page carries. served: the primary languages the sync keeps (empty: any).
// keyPages: false for a deployment on the selection from before key pages (takesKeyPages): key,
// FAQ, help and support pages age like the rest there.
export function pageFlags(page: RenderedFacts, opts: { served: readonly string[]; today: Date; keyPages?: boolean }): PageFlag[] {
  const flags: PageFlag[] = [];
  if (isConversionUrl(page.url) || CONVERSION_TITLE.test(page.title ?? "")) flags.push("conversion");
  const dated = pageDate(page);
  // Key, FAQ, help and support pages, the home page and top-level pages that aren't articles
  // aren't old by age alone.
  const ageless = isEvergreenUrl(page.url) || (isTopLevelUrl(page.url) && !page.articleType);
  if (dated && ageOf(dated.date, opts.today) > OLD_DAYS && !(opts.keyPages !== false && ageless) && !announcesUpcoming(page, opts.today))
    flags.push("old");
  const lang = pageLanguage(page);
  if (
    opts.served.length &&
    lang &&
    !opts.served.includes(primaryLanguage(lang)) &&
    !(opts.served.includes(UNMARKED) && !pathLanguage(page.url))
  )
    flags.push("other-language");
  // Mostly link text, or a title that says it lists things.
  if (isOverviewUrl(page.url) || OVERVIEW_TITLE.test(page.title ?? "") || ((page.linkShare ?? 0) > 0.5 && (page.textChars ?? 0) >= 100))
    flags.push("overview");
  if ((page.rootChars ?? 0) >= 400 && (page.textChars ?? 0) < (page.rootChars ?? 0) / 2) flags.push("short-text");
  // An article's price is written when it's published (a site-wide edit moves its modified date);
  // any other page's (a pricing page) is as fresh as its last update.
  const priced = commercialDate(page);
  if (priced && ageOf(priced, opts.today) > COMMERCIAL_DAYS && page.text && commercialContent(page.text)) flags.push("stale-commercial");
  // A date written without a year that no year near the page's own date fits (placeDates).
  if (page.text && placeDates(page.text, dateAnchor(page, opts.today), pageLanguage(page)).unplaced.length) flags.push("yearless-date");
  return flags;
}

// "Check this: states a price, published 2016": what a stale-commercial flag says where the
// page stays in (anywhere but an article, so a /pricing page isn't dropped).
export function commercialNote(page: Pick<RenderedFacts, "url" | "articleType" | "published" | "modified" | "text">): string | undefined {
  const what = page.text ? commercialContent(page.text) : undefined;
  const at = commercialDate(page);
  if (!what || !at) return undefined;
  return `Check this: states ${what}, ${at === page.published ? "published" : "updated"} ${at.getUTCFullYear()}`;
}

// The date a page's prices and offers are as fresh as: an article's publication, any other page's
// later of published and updated (round 6: teamleader.eu's pricing pages, published 2023 and
// updated 28 Oct 2026, were called stale).
export function commercialDate(page: Pick<RenderedFacts, "url" | "articleType" | "published" | "modified">): Date | undefined {
  if (isArticle(page)) return page.published;
  const dates = [page.published, page.modified].filter((d): d is Date => Boolean(d));
  return dates.sort((a, b) => b.getTime() - a.getTime())[0];
}

// Whether a page states an event's date on or after today (a date with its year on a line about an
// event, or one placed from a date written without its year): then no age rule takes it out. Pure.
//
// Any date, on any line, in any supported language: the text decides, not the line's words nor the
// page's <html lang> (round 7: "We are exhibiting at NATO EDGE, November 17 - 19 2026" on janes.com,
// and seeburger.com's "26. November 2026 - 27. November 2026" on a line of its own, were dropped as
// "older than 2 years"). A month and year counts too ("in November 2026").
export function announcesUpcoming(
  page: Pick<RenderedFacts, "url" | "lang" | "text" | "published" | "modified" | "lastModified">,
  today: Date,
): boolean {
  if (!page.text || !/\d/.test(page.text)) return false;
  const from = today.toISOString().slice(0, 10);
  const anchor = dateAnchor(page, today);
  const own = pageLanguage(page);
  for (const lang of new Set([own ?? "en", ...Object.keys(MONTH_NAMES)])) {
    if (placeDates(page.text, anchor, lang).dates.some((d) => d.date >= from)) return true;
    const words = dateWords(lang);
    for (const m of page.text.matchAll(words.monthYear)) {
      const month = words.month.get(bare(m[1]!));
      if (month !== undefined && isoDay(Number(m[2]), month, 28) >= from) return true;
    }
  }
  return false;
}

// Why the content rules leave a loaded page out, in words a partner can act on, or undefined.
// rules: the plan's ticked suggestions (the date rules go by the page's own date here, which
// the plan couldn't know). Other languages, and articles that state a price, offer or version
// and were published over 12 months ago, are always left out.
export function ruleLeaveOut(page: RenderedFacts, flags: readonly PageFlag[], rules: readonly PlanRule[], today: Date): string | undefined {
  if (flags.includes("other-language"))
    return `In another language (${languageLabel(pageLanguage(page) ?? "und")}) than the ones this deployment syncs.`;
  if (flags.includes("conversion") && rules.includes("conversion"))
    return "A thank-you or confirmation page: the plan leaves conversion pages out.";
  // A page announcing a date still to come is never left out by age (round 7: bynder.com's OnDAM
  // Paris 2026 page, published in 2025, was left out as an event page over 12 months old).
  const dated = pageDate(page);
  const stale = flags.includes("stale-commercial") && isArticle(page) && page.published;
  if (!stale && !dated) return undefined;
  if (announcesUpcoming(page, today)) return undefined;
  if (stale) {
    return `States ${commercialContent(page.text ?? "")}, published ${dayOf(page.published!)}: an article over 12 months old, so its prices, offers and versions may have changed.`;
  }
  if (!dated) return undefined;
  const said = `${dated.kind === "published" ? "Published" : "Last updated"} ${dayOf(dated.date)}`;
  if (rules.includes("old") && flags.includes("old")) return `${said}: older than 2 years, which the plan leaves out.`;
  const archive = segmentsOf(new URL(page.url).pathname).some((s) => ARCHIVE_SECTIONS.has(s));
  if (rules.includes("archive") && archive && ageOf(dated.date, today) > ARCHIVE_DAYS)
    return `${said}: a campaign, event, webinar or news page over 12 months old, which the plan leaves out.`;
  return undefined;
}

// A date or stale-price rule a page added by hand trips: it's added only once a person keeps it,
// with a name and a reason (pinPages), and Review shows it. The other rules (another language, a
// thank-you page, the budget) give way to a person's choice, as before.
export interface KeepRule {
  kind: "stale-price" | "date";
  // Asked before the page is kept: "This page states a price and was published 11 Oct 2016."
  ask: string;
}

export function keepRule(page: RenderedFacts, flags: readonly PageFlag[], rules: readonly PlanRule[], today: Date): KeepRule | undefined {
  const upcoming = announcesUpcoming(page, today);
  if (!upcoming && flags.includes("stale-commercial") && isArticle(page) && page.published) {
    return {
      kind: "stale-price",
      ask: `This page states ${commercialContent(page.text ?? "")} and was published ${dayOf(page.published)}.`,
    };
  }
  const dated = upcoming ? undefined : pageDate(page);
  if (dated) {
    const said = `${dated.kind === "published" ? "was published" : "was last updated"} ${dayOf(dated.date)}`;
    if (rules.includes("old") && flags.includes("old")) return { kind: "date", ask: `This page ${said}, over 2 years ago.` };
    const archive = segmentsOf(new URL(page.url).pathname).some((s) => ARCHIVE_SECTIONS.has(s));
    if (rules.includes("archive") && archive && ageOf(dated.date, today) > ARCHIVE_DAYS)
      return { kind: "date", ask: `This campaign, event, webinar or news page ${said}, over 12 months ago.` };
  }
  const year = rules.includes("year") ? oldYearIn(new URL(page.url).pathname, today) : undefined;
  if (year) return { kind: "date", ask: `This page's address names ${year}, an earlier year.` };
  return undefined;
}

// What a page added by hand says while it waits for a person to keep it.
export const keepAsked = (rule: KeepRule) => `${KEEP_ASKED}${rule.ask} Keep it anyway on Content, with a reason, to sync it.`;

// The kind of rule a kept page tripped, from the words it was kept with.
export const keptKind = (rule: string): KeepRule["kind"] =>
  /\bstates (a price|a discount or offer|a version)\b/.test(rule) ? "stale-price" : "date";

// Review's line for pages kept by hand: "1 page kept by hand despite a stale price".
export function keptSummary(kept: readonly { rule: string }[]): string | undefined {
  if (!kept.length) return undefined;
  const kinds = new Set(kept.map((k) => keptKind(k.rule)));
  const why = kinds.size === 2 ? "a stale price or its date" : kinds.has("stale-price") ? "a stale price" : "its date";
  return `${kept.length} ${kept.length === 1 ? "page" : "pages"} kept by hand despite ${why}`;
}

// ---- a page as the sniffer read it ----

// The sniffer's /pages result, as far as the content rules read it (apps/worker/src/sniffer.ts
// SitePage has the rest).
export interface LoadedPage {
  url: string;
  title: string;
  lang?: string;
  markdown: string;
  linkShare?: number;
  rootChars?: number;
  textChars?: number;
  datePublished?: string;
  dateModified?: string;
  articleType?: string;
  published?: string;
}

export const dateFrom = (raw: string | undefined) => {
  const t = raw ? Date.parse(raw) : Number.NaN;
  return Number.isNaN(t) ? undefined : new Date(t);
};

// The language a page's text is written in, when that's clear: its share of each language's most
// common words, with one language well ahead of the rest. Undefined on a short text, a list of names
// or a mix. A page's navigation may be in another language: it's a small part of the words. Pure.
const COMMON_WORDS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries({
    en: "the and of to in is for with that on you your are this our from can it as be we have or by an will not at",
    de: "der die und das ist für mit den von zu ein eine auf im sie wir nicht sich dem des auch werden oder bei wie sind einer",
    fr: "le la les et des de du un une est pour dans que qui vous nous sur avec au aux par plus ce votre sont pas ou",
    es: "el la los las y de del en un una es para con que por su se al lo como más sus nuestro nuestra usted todo le",
    it: "il la le gli di e che per un una in con del della è sono dei delle non si al più come nel alla da",
    nl: "de het een en van in is op voor met dat te zijn aan bij je ons om niet ook als door worden uw onze",
    pt: "o a os as e de do da em um uma para com que por no na dos das se ao mais como é seu sua você",
  }).map(([lang, words]) => [lang, new Set(words.split(" "))]),
);
const MIN_WORDS_FOR_LANGUAGE = 60;
export function textLanguage(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const words = text
    .toLowerCase()
    .replace(/https?:\S+/g, " ")
    .split(/[^\p{L}]+/u)
    .filter(Boolean)
    .slice(0, 4000);
  if (words.length < MIN_WORDS_FOR_LANGUAGE) return undefined;
  const shares = Object.entries(COMMON_WORDS)
    .map(([lang, common]) => ({ lang, share: words.filter((w) => common.has(w)).length / words.length }))
    .sort((a, b) => b.share - a.share);
  const [top, next] = shares as [(typeof shares)[number], (typeof shares)[number]];
  return top.share >= 0.15 && top.share >= next.share * 1.6 ? top.lang : undefined;
}

// What the content rules know about a loaded page: its own dates and type, and the date the
// plan gave it (the sitemap's, unless bulk-stamped, else the address's) when it states none.
// A date after today is unknown (knownDate), so it's neither ruled on nor stored.
export function loadedFacts(page: LoadedPage, planDate?: Date | null, today = new Date()): RenderedFacts {
  const published = knownDate(dateFrom(page.datePublished), today);
  const modified = knownDate(dateFrom(page.dateModified) ?? (page.datePublished ? undefined : dateFrom(page.published)), today);
  const lastModified = knownDate(planDate, today);
  // The page's own text when it's clear, over what the page declares (round 7: a Spanish page at
  // /eg/paperport/fn/es/… under <html lang="en"> was synced into an English deployment, and its
  // "129 €" offered as support for a dollar price). The declared language is kept when it's a
  // regional form of the same one.
  const declared = page.lang?.toLowerCase();
  const said = textLanguage(page.markdown);
  const lang = said && (!declared || primaryLanguage(declared) !== said) ? said : declared;
  return {
    url: page.url,
    title: page.title,
    ...(lang && { lang }),
    ...(lastModified && { lastModified }),
    ...(published && { published }),
    ...(modified && { modified }),
    ...(page.articleType && { articleType: page.articleType }),
    ...(page.linkShare !== undefined && { linkShare: page.linkShare }),
    ...(page.rootChars !== undefined && { rootChars: page.rootChars }),
    ...(page.textChars !== undefined && { textChars: page.textChars }),
    text: page.markdown,
  };
}

// ---- page-type labels: what retrieval routes an intent's questions to ----

// Every resource the sync sends carries its page type as labels (usermetadata.classifications,
// labelset launchpad_page): the intent its key page answers, and "events" for a page that states
// a date still to come. A search configuration per intent filters on them (labelFilter). The
// intent line that used to lead a key page's text ("About this page: …") is the resource's
// metadata now (pageMetadata), where no answer can quote it.
export const PAGE_LABELSET = "launchpad_page";
export const PAGE_LABELS = ["price", "buy", "contact", "support", "trial", "faq", "events"] as const;
export type PageLabel = (typeof PAGE_LABELS)[number];

// A page's labels: its key intent, and "events" when it states a date on or after today.
export function pageLabels(intent: KeyIntent | null | undefined, events: PageFacts["events"], today: Date): PageLabel[] {
  const day = today.toISOString().slice(0, 10);
  const labels: PageLabel[] = intent ? [intent] : [];
  if ((events ?? []).some((e) => e.date && e.date >= day)) labels.push("events");
  return labels;
}

// The labels whose pages answer an intent's questions: a price question is answered from a buying
// page too, a contact question from a support one (ANSWERED_BY).
export const labelsFor = (intent: KeyIntent | "events"): PageLabel[] => (intent === "events" ? ["events"] : [...ANSWERED_BY[intent]]);

// Agentic RAG's filter on those labels, for /ask or a saved ask configuration (filter_expression;
// tried on a review Knowledge Box on 2026-10-31: accepted, a label keeps out every resource
// without it, and resource ids combine with labels in one "or"). resources: key pages' resource
// ids to take as well, while pages sent before labels existed wait to be read again.
export function labelFilter(intent: KeyIntent | "events", resources: readonly string[] = []): { field: Record<string, unknown> } {
  const terms: Record<string, unknown>[] = [
    ...labelsFor(intent).map((label) => ({ prop: "label", labelset: PAGE_LABELSET, label })),
    ...resources.map((id) => ({ prop: "resource", id })),
  ];
  return { field: terms.length === 1 ? terms[0]! : { or: terms } };
}

// What a key page's resource carries as metadata: its intent, and the intent's line in the page's
// language (intentLine), for routing and the Content page, never in the text an answer quotes.
export const pageMetadata = (intent: KeyIntent | null | undefined, lang: string | undefined): Record<string, unknown> | undefined =>
  intent ? { launchpad: { intent, about: intentLine(intent, lang) } } : undefined;

// ---- dates written without a year ----

// Month and day names in the languages dates are read in (English always, and the page's own),
// with their short forms; matching also takes them without accents. Days are Sunday first, as
// Date.getUTCDay counts them.
const MONTH_NAMES: Record<string, string[][]> = {
  en: [
    ["january", "jan"],
    ["february", "feb"],
    ["march", "mar"],
    ["april", "apr"],
    ["may"],
    ["june", "jun"],
    ["july", "jul"],
    ["august", "aug"],
    ["september", "sept", "sep"],
    ["october", "oct"],
    ["november", "nov"],
    ["december", "dec"],
  ],
  de: [
    ["januar", "jänner", "jan"],
    ["februar", "feb"],
    ["märz", "mär"],
    ["april", "apr"],
    ["mai"],
    ["juni", "jun"],
    ["juli", "jul"],
    ["august", "aug"],
    ["september", "sept", "sep"],
    ["oktober", "okt"],
    ["november", "nov"],
    ["dezember", "dez"],
  ],
  fr: [
    ["janvier", "janv"],
    ["février", "févr", "fév"],
    ["mars"],
    ["avril", "avr"],
    ["mai"],
    ["juin"],
    ["juillet", "juil"],
    ["août"],
    ["septembre", "sept"],
    ["octobre", "oct"],
    ["novembre", "nov"],
    ["décembre", "déc"],
  ],
  es: [
    ["enero", "ene"],
    ["febrero", "feb"],
    ["marzo", "mar"],
    ["abril", "abr"],
    ["mayo"],
    ["junio", "jun"],
    ["julio", "jul"],
    ["agosto", "ago"],
    ["septiembre", "setiembre", "sept", "sep"],
    ["octubre", "oct"],
    ["noviembre", "nov"],
    ["diciembre", "dic"],
  ],
};
const DAY_NAMES: Record<string, string[][]> = {
  en: [
    ["sunday", "sun"],
    ["monday", "mon"],
    ["tuesday", "tues", "tue"],
    ["wednesday", "wed"],
    ["thursday", "thurs", "thur", "thu"],
    ["friday", "fri"],
    ["saturday", "sat"],
  ],
  de: [
    ["sonntag", "so"],
    ["montag", "mo"],
    ["dienstag", "di"],
    ["mittwoch", "mi"],
    ["donnerstag", "do"],
    ["freitag", "fr"],
    ["samstag", "sonnabend", "sa"],
  ],
  fr: [
    ["dimanche", "dim"],
    ["lundi", "lun"],
    ["mardi", "mar"],
    ["mercredi", "mer"],
    ["jeudi", "jeu"],
    ["vendredi", "ven"],
    ["samedi", "sam"],
  ],
  es: [
    ["domingo", "dom"],
    ["lunes", "lun"],
    ["martes", "mar"],
    ["miércoles", "mié"],
    ["jueves", "jue"],
    ["viernes", "vie"],
    ["sábado", "sáb"],
  ],
};
const DAY_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const bare = (word: string) => word.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

interface DateWords {
  month: Map<string, number>;
  day: Map<string, number>;
  // "Thursday, November 5", "Nov. 5th"; and "5 November", "Donnerstag, 5. November", "jeudi 5
  // novembre", "jueves, 5 de noviembre", "1er novembre", "the 5th of November".
  monthFirst: RegExp;
  dayFirst: RegExp;
  // "November 2026", "Nov. 2026", "noviembre de 2026".
  monthYear: RegExp;
}
const dateWordsByLanguage = new Map<string, DateWords>();
function dateWords(lang: string | undefined): DateWords {
  const primary = primaryLanguage(lang ?? "en");
  const langs = [...new Set(["en", ...(MONTH_NAMES[primary] ? [primary] : [])])];
  const key = langs.join(",");
  const known = dateWordsByLanguage.get(key);
  if (known) return known;
  const index = (tables: string[][][]) => {
    const map = new Map<string, number>();
    for (const table of tables) {
      for (const [i, names] of table.entries()) for (const n of names) map.set(bare(n), i);
    }
    return map;
  };
  const alternation = (tables: string[][][]) =>
    [...new Set(tables.flat(2).flatMap((n) => [n, bare(n)]))]
      .sort((a, b) => b.length - a.length)
      .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
  const months = alternation(langs.map((l) => MONTH_NAMES[l]!));
  const days = alternation(langs.map((l) => DAY_NAMES[l]!));
  const weekday = `(?:(${days})(\\.,?|,)?\\s+(?:the\\s+|le\\s+|el\\s+|den\\s+)?)?`;
  const words: DateWords = {
    month: index(langs.map((l) => MONTH_NAMES[l]!)),
    day: index(langs.map((l) => DAY_NAMES[l]!)),
    monthFirst: new RegExp(`(?<![\\p{L}\\d])${weekday}(${months})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\p{L}\\d]|[:.,]\\d)`, "giu"),
    dayFirst: new RegExp(
      // Not after a hyphen, except a day range's ("17-19 November").
      `(?<![\\p{L}\\d.,/])(?<!(?<!\\d)-)${weekday}(\\d{1,2})(?:(?:er|st|nd|rd|th|º)?\\s+(?:de\\s+|of\\s+)?|\\.\\s*)(${months})(?![\\p{L}])\\.?`,
      "giu",
    ),
    monthYear: new RegExp(`(?<![\\p{L}\\d])(${months})\\.?,?\\s+(?:de\\s+|of\\s+)?((?:19|20)\\d{2})(?!\\d)`, "giu"),
  };
  dateWordsByLanguage.set(key, words);
  return words;
}

// A year straight after a date ("November 5, 2026", "5. November 2026", "5 de noviembre de
// 2026"), or after the end of a range that starts with it ("November 5–7, 2026").
const YEAR_AFTER = /^\s*(?:,|\bde\b|\bdel\b)?\s*(?:19|20)\d{2}(?!\d)/iu;
const RANGE_WORD = String.raw`[-–—]|\b(?:bis|to|through|until|till|hasta|al|au|à|a)\b`;
const RANGE_YEAR = new RegExp(
  String.raw`^\s*(?:${RANGE_WORD}|&|\b(?:and|und|et|y)\b)\s*(?:\p{L}+\.?\s+)?\d{1,2}(?:st|nd|rd|th|\.)?\s*(?:\p{L}+\.?\s*)?,?\s*(?:19|20)\d{2}(?!\d)`,
  "iu",
);
// The start of a day range, or a first day, just before a date that names the month: "17-19
// November", "5. bis 7. November", "del 5 al 7 de noviembre", "du 5 au 7 novembre", "4 & 5 Nov".
const DAY_BEFORE = new RegExp(
  String.raw`(?<![\d.,:/])(\d{1,2})(?:st|nd|rd|th|er|º|\.)?\s*(${RANGE_WORD}|&|\b(?:and|und|et|y)\b)\s*$`,
  "iu",
);
// Between a range's two dates ("26. November 2026 - 27. November 2026", "Nov 30 - Dec 2").
const BETWEEN_RANGE = new RegExp(String.raw`^\s*,?\s*(?:(?:19|20)\d{2})?\s*(?:${RANGE_WORD})\s*$`, "iu");
// Dates in numbers, with their year: 05.11.2026 (day first), 2026-11-05, and 11/05/2026 (month first
// in English, else day first).
const DOTTED_DATE = /(?<![\d.])(\d{1,2})\.(\d{1,2})\.((?:19|20)\d{2})(?!\d)/g;
const ISO_DATE = /(?<![\d-])((?:19|20)\d{2})-(\d{2})-(\d{2})(?![\d-])/g;
const SLASH_DATE = /(?<![\d/])(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})(?!\d)/g;

// The date a yearless date is placed from: the page's most recent date, whether it's the
// published, the updated or the sitemap's (the plan's, which is the sitemap's unless it's
// bulk-stamped); the day the page is read when it states none.
export interface DateAnchor {
  date: Date;
  from: "published" | "updated" | "sitemap" | "read";
}
const ANCHOR_WORDS: Record<DateAnchor["from"], string> = {
  published: "the page's published date",
  updated: "the page's updated date",
  sitemap: "the sitemap date",
  read: "the day it was read",
};
export function dateAnchor(page: Pick<RenderedFacts, "published" | "modified" | "lastModified">, today: Date): DateAnchor {
  const dates: DateAnchor[] = [
    ...(page.published ? [{ date: page.published, from: "published" as const }] : []),
    ...(page.modified ? [{ date: page.modified, from: "updated" as const }] : []),
    ...(page.lastModified ? [{ date: page.lastModified, from: "sitemap" as const }] : []),
  ];
  return dates.sort((a, b) => b.date.getTime() - a.date.getTime())[0] ?? { date: today, from: "read" };
}

// The year a date without one falls in: its next occurrence on or after the anchor. With a day
// name, the year must agree with it: the next occurrence, else one up to 90 days before the anchor
// (a page updated just after its event), else the year after; otherwise none fits. Pure.
export function placeYear(month: number, day: number, weekday: number | undefined, anchor: Date): number | undefined {
  const from = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  const on = (year: number) => {
    const d = new Date(Date.UTC(year, month, day));
    return d.getUTCMonth() === month ? d : undefined;
  };
  // The next occurrence (29 February: the next leap year).
  let next = anchor.getUTCFullYear();
  while (next < anchor.getUTCFullYear() + 8 && !((on(next)?.getTime() ?? 0) >= from)) next += 1;
  if (!on(next)) return undefined;
  if (weekday === undefined) return next;
  const fits = (year: number) => on(year)?.getUTCDay() === weekday;
  if (fits(next)) return next;
  const before = on(next - 1);
  if (before && before.getTime() < from && from - before.getTime() <= 90 * DAY_MS && fits(next - 1)) return next - 1;
  return fits(next + 1) ? next + 1 : undefined;
}

// A date the page states, as read: ISO day, the line it's on as written (short), and how it was
// read. Dates written without a year are placed (written: false); readAs says from what.
export interface ReadDate {
  date: string;
  line: string;
  readAs: string;
  yearless: boolean;
  // The last day of a range whose first day is the date before this one on the line.
  rangeEnd?: boolean;
}
export interface PlacedDates {
  // The text with each placed date's year written in ("Thursday, November 5, 2026").
  text: string;
  dates: ReadDate[];
  // Dates without a year that no year near the anchor fits, as written.
  unplaced: { raw: string; line: string; readAs: string }[];
}

const longDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
// keepNumber: a line that starts with a date's day ("05. November 2026"), not a list's number.
const shortLine = (line: string, keepNumber = false) => {
  const clean = line
    .replace(keepNumber ? /^\s*(?:#{1,6}|[-*+>])\s+/ : /^\s*(?:#{1,6}|[-*+>]|\d+\.)\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*\|\s*|\s*\|\s*$/g, "")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 160 ? `${clean.slice(0, 157)}…` : clean;
};
// A dated line, for one date on it: on a line too long to keep whole, the sentence with that date, so
// a long line's dates each show their own words (round 7: northwesternenergy.com's "webinar on
// Thursday, November 5, 2026 … news release … Wednesday, November 4, 2026" was cut after the 5th, and
// stored for the 4th too: "4 November 2026, as written" beside words saying November 5). Pure.
const dateLine = (line: string, start: number, end: number) => {
  const whole = shortLine(line, true);
  if (!whole.endsWith("…")) return whole;
  const before = line.slice(0, start);
  const stop = [...before.matchAll(/[.!?]\s+(?=\p{Lu})/gu)].filter((m) => !/\b\p{L}{1,4}$/u.test(before.slice(0, m.index))).at(-1);
  const from = Math.max(stop ? stop.index + stop[0].length : 0, end - 150);
  return shortLine(line.slice(from), true);
};
const isoDay = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
// How far after the page's own date a date without a year or day name is placed (placeDates).
const LOOSE_DAYS = 90;

// Every date a text states, in en, de, fr and es formats with or without a day name, and the text
// with the year written into each date that had none: placed as its next occurrence on or after
// the page's most recent date, agreeing with the day name when there is one (placeYear). A date
// no year fits stays as written, and is listed as unplaced (the page's "yearless-date" flag). A
// date with no day name that would land over LOOSE_DAYS after the page's date stays as written
// too, unflagged: more likely a past reference than an upcoming one. Pure.
export function placeDates(text: string, anchor: DateAnchor, lang?: string): PlacedDates {
  const words = dateWords(lang);
  const dates: ReadDate[] = [];
  const unplaced: PlacedDates["unplaced"] = [];
  const out: string[] = [];
  let changed = false;
  for (const line of text.split("\n")) {
    // Most lines name no month: a quick look first.
    if (!/\d/.test(line)) {
      out.push(line);
      continue;
    }
    const numeric = (y: number, m: number, d: number, at: number) => {
      if (m < 0 || m > 11 || d < 1 || new Date(Date.UTC(y, m, d)).getUTCMonth() !== m) return;
      const iso = isoDay(y, m, d);
      dates.push({ date: iso, line: dateLine(line, at, at + 10), readAs: `${longDay(iso)}, as written`, yearless: false });
    };
    for (const m of line.matchAll(DOTTED_DATE)) numeric(Number(m[3]), Number(m[2]) - 1, Number(m[1]), m.index);
    for (const m of line.matchAll(ISO_DATE)) numeric(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m.index);
    for (const m of line.matchAll(SLASH_DATE)) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      const monthFirst = primaryLanguage(lang ?? "en") === "en" ? a <= 12 : b > 12;
      numeric(Number(m[3]), (monthFirst ? a : b) - 1, monthFirst ? b : a, m.index);
    }
    const found: { start: number; end: number; month: number; day: number; weekday?: number; monthFirst: boolean; de: boolean }[] = [];
    for (const [re, monthFirst] of [
      [words.monthFirst, true],
      [words.dayFirst, false],
    ] as const) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        const [all, dayWord, punct] = m;
        const monthWord = monthFirst ? m[3]! : m[4]!;
        const day = Number(monthFirst ? m[4] : m[3]);
        const month = words.month.get(bare(monthWord));
        // A day no year has ("31 November") isn't a date.
        if (month === undefined || day < 1 || new Date(Date.UTC(2024, month, day)).getUTCMonth() !== month) continue;
        let start = m.index!;
        let end = start + all.length;
        // A sentence's full stop isn't part of a month written in full.
        if (all.endsWith(".") && !monthFirst && monthWord.length > 4) end -= 1;
        let weekday = dayWord ? words.day.get(bare(dayWord)) : undefined;
        // A short day name needs its full stop or comma ("Do., 5. November", "Thu, Nov 5"): "so"
        // or "do" before a date is a word, not a day. The date then starts after it.
        if (dayWord && bare(dayWord).length <= 4 && !(bare(dayWord).length <= 2 ? punct?.startsWith(".") : punct)) {
          start += monthFirst ? all.toLowerCase().indexOf(monthWord.toLowerCase(), dayWord.length) : all.search(/\d/);
          weekday = undefined;
        }
        found.push({ start, end, month, day, ...(weekday !== undefined && { weekday }), monthFirst, de: /\bde\s/i.test(all) });
      }
    }
    // The first, longest reading of each stretch of the line.
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept = found.filter((f, i) => !found.slice(0, i).some((g) => f.start < g.end && g.start < f.end));
    let rebuilt = "";
    let at = 0;
    let lastEnd = -1;
    for (const f of kept) {
      const raw = line.slice(f.start, f.end);
      const rest = line.slice(f.end);
      const year =
        YEAR_AFTER.exec(rest)?.[0].match(/(19|20)\d{2}/)?.[0] ?? RANGE_YEAR.exec(rest)?.[0].match(/(19|20)\d{2}(?!.*(19|20)\d{2})/)?.[0];
      // This date closes a range opened by the date before it, or names a month for a day before it.
      const closes = lastEnd >= 0 && BETWEEN_RANGE.test(line.slice(lastEnd, f.start));
      lastEnd = f.end;
      const lead = f.monthFirst ? undefined : DAY_BEFORE.exec(line.slice(0, f.start));
      const firstDay = lead && Number(lead[1]) < f.day && Number(lead[1]) >= 1 ? Number(lead[1]) : undefined;
      const inRange = firstDay !== undefined && !/^(?:&|and|und|et|y)$/i.test(lead![2]!);
      if (year) {
        const d = new Date(Date.UTC(Number(year), f.month, f.day));
        if (d.getUTCMonth() === f.month) {
          if (firstDay !== undefined) {
            const iso = isoDay(Number(year), f.month, firstDay);
            dates.push({ date: iso, line: dateLine(line, f.start, f.end), readAs: `${longDay(iso)}, as written`, yearless: false });
          }
          dates.push({
            date: isoDay(Number(year), f.month, f.day),
            line: dateLine(line, f.start, f.end),
            readAs: `${longDay(isoDay(Number(year), f.month, f.day))}, as written`,
            yearless: false,
            ...((closes || inRange) && { rangeEnd: true }),
          });
        }
        continue;
      }
      const placed = placeYear(f.month, f.day, f.weekday, anchor.date);
      if (placed === undefined) {
        const anchorDay = longDay(anchor.date.toISOString().slice(0, 10));
        const dayMonth = longDay(isoDay(2024, f.month, f.day)).replace(/ 2024$/, "");
        unplaced.push({
          raw,
          line: dateLine(line, f.start, f.end),
          readAs:
            f.weekday === undefined
              ? `Couldn't place "${raw}": ${dayMonth} doesn't come within 8 years of ${anchorDay} (${ANCHOR_WORDS[anchor.from]}).`
              : `Couldn't place "${raw}": no year near ${anchorDay} (${ANCHOR_WORDS[anchor.from]}) puts ${dayMonth} on a ${DAY_EN[f.weekday]}.`,
        });
        continue;
      }
      const iso = isoDay(placed, f.month, f.day);
      // Without a day name to confirm it, a date far past the page's own ("Released on March 3"
      // on a page updated in October) is more likely last time's than next time's: it stays as
      // written, neither placed nor flagged.
      if (f.weekday === undefined && Date.parse(`${iso}T00:00:00Z`) - anchor.date.getTime() > LOOSE_DAYS * DAY_MS) continue;
      if (firstDay !== undefined) {
        const first = isoDay(placed, f.month, firstDay);
        dates.push({
          date: first,
          line: dateLine(line, f.start, f.end),
          readAs: `${longDay(first)}, from ${ANCHOR_WORDS[anchor.from]}`,
          yearless: true,
        });
      }
      dates.push({
        date: iso,
        line: dateLine(line, f.start, f.end),
        readAs: `${longDay(iso)}, from ${ANCHOR_WORDS[anchor.from]}`,
        yearless: true,
        ...((closes || inRange) && { rangeEnd: true }),
      });
      rebuilt += `${line.slice(at, f.end)}${f.monthFirst ? `, ${placed}` : f.de ? ` de ${placed}` : ` ${placed}`}`;
      at = f.end;
      changed = true;
    }
    out.push(at ? `${rebuilt}${line.slice(at)}` : line);
  }
  return { text: changed ? out.join("\n") : text, dates, unplaced };
}

// ---- what a page states: prices, contacts, links and events (content_pages.facts) ----

// A figure with a currency, in local formats: "$ 59", "$1,229", "2.205 US-Dollar", "2 205 $",
// "USD 2,205", "49,99 €".
const AMOUNT = String.raw`\d{1,3}(?:[.,   ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const FIGURE = new RegExp(
  String.raw`(?:US\$|[$€£¥]|\b(?:USD|EUR|GBP|CHF)\b)\s?(?:${AMOUNT})(?!\s?%|\d)|(?<![\d.,])(?:${AMOUNT})\s?(?:[$€£¥]|(?:USD|EUR|GBP|CHF|US-Dollars?|Dollars?|Euros?)(?![\p{L}]))(?!\s?\d)`,
  "giu",
);
// The figures on a line, as written, with where each starts (lib/price-table-model.ts's proof). Pure.
export const figuresOnLine = (line: string): { raw: string; at: number }[] =>
  [...line.matchAll(FIGURE)].map((m) => ({ raw: m[0], at: m.index! }));
// The same, for asking whether a line holds one (no lastIndex to keep).
const HAS_FIGURE = new RegExp(FIGURE.source, "iu");
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi;
// Words that make a dated line an event's (a webinar, a session, register…), in the widget's
// languages: a date written with its year on any other line (a subsidy's deadline) isn't one.
const EVENT_LINE =
  /\b(webinars?|events?|conferences?|summits?|sessions?|workshops?|seminars?|meetups?|trainings?|live|register|registration|join us|keynote|roadshow|expo|veranstaltung(en)?|anmeld|termin|eventos?|seminario|taller|inscri|événements?|evenement(en)?|conférence|atelier|séminaire|bijeenkomst|webinaire|congres|kongress|messe|feria|salon)/i;
const PHONE = /(?<![\w$€£.,/])(?:\+\s?\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{1,4}(?:[\s.-]\d{2,8}){1,4}(?![\w.,/]?\d)/g;
const PHONE_WORD =
  /\b(phone|tel|telephone|call|fax|toll[- ]free|hotline|telefon|teléfono|telefono|téléphone|tél|llame|llámenos|appelez|anrufen|rufen|ligue|numéro|número|nummer)\b/i;
const NANP = /^\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}$|^1[\s.-]8\d{2}[\s.-]\d{3}[\s.-]\d{4}$/;
const FORM_WORDS = /\b(form|formular|formulario|formulaire|modulo|fill (?:in|out)|send us a message)\b/i;
const QUOTE_ADDRESS = /quote|angebot|devis|presupuesto|cotizaci|preventivo|offerte|orcamento/i;

// A badge a pricing card shows by its plan's name or price: never a plan's name.
const BADGE_LINE =
  /^(?:most popular|popular|best value|great value|best seller|bestseller|recommended|new|featured|our pick|current plan|save \d+\s*%|am beliebtesten|beliebt|empfohlen|más popular|recomendado|le plus populaire|recommandé)$/i;

// The line a figure is on, as a partner reads it: with its unit when that's the next line ("$ 59"
// then "per node, per year"), and the heading or name it sits under ("Business: $ 59 per node,
// per year").
function figureLine(lines: readonly string[], i: number, figure: string): string {
  const near = (from: number, step: number, max: number) => {
    const out: number[] = [];
    for (let j = from + step; j >= 0 && j < lines.length && out.length < max; j += step) if (lines[j]!.trim()) out.push(j);
    return out;
  };
  let line = shortLine(lines[i]!);
  // A long paragraph, or a line or table row with several figures: the sentence or cell that
  // states this one.
  if (line.length > 100 || (line.match(FIGURE)?.length ?? 0) > 1) {
    const piece = line.split(/(?<=[.!?])\s+|\s·\s/).find((part) => part.replace(/\s+/g, " ").includes(figure));
    if (piece) line = piece.trim();
  }
  // A figure alone on its line, or written with its plan's name ("Advanced: $ 16.50", labelFigures),
  // takes its unit from the next line.
  const named = /^([^:]{1,60}):\s+/.exec(line);
  const bareFigure = (named ? line.slice(named[0].length) : line).replace(FIGURE, "").replace(/[^\p{L}]/gu, "").length < 3;
  if (bareFigure) {
    const [next] = near(i, 1, 1);
    const unit = next === undefined ? "" : shortLine(lines[next]!);
    // After a figure written with its plan's name, only a line that reads as its unit ("Per
    // user/month", "for 50 devices"), not the next sentence.
    const unitLike = !named || /^(?:\/|(?:[Pp]er|[Pp]ro|par|por|each|billed|a|an|for|[Mm]inimum|min)\b|\p{Ll})/u.test(unit);
    if (unit && unitLike && !HAS_FIGURE.test(unit) && unit.split(" ").length <= 8 && !/^\s*#/.test(lines[next!]!)) line = `${line} ${unit}`;
  }
  // The heading up to 6 lines above (an add-ons heading over several add-ons' lines: extractor 7);
  // else, for a figure alone, the short line just above, unless that's a list item (a feature
  // line: "Dynamic show notes") or a badge ("Recommended", "Most popular": transistor.fm).
  const above = near(i, -1, 6);
  const heading = above.find((j) => /^\s*#{1,6}\s/.test(lines[j]!));
  const name =
    heading !== undefined
      ? shortLine(lines[heading]!)
      : bareFigure &&
          above[0] !== undefined &&
          !/^\s*(?:[-*+]|\d+\.)\s/.test(lines[above[0]]!) &&
          !BADGE_LINE.test(shortLine(lines[above[0]]!)) &&
          /^[\p{L}][\p{L}\s&+'-]{0,40}$/u.test(shortLine(lines[above[0]]!))
        ? shortLine(lines[above[0]]!)
        : undefined;
  const said = name && !HAS_FIGURE.test(name) && !line.toLowerCase().includes(name.toLowerCase()) ? `${name}: ${line}` : line;
  return said.length > 160 ? `${said.slice(0, 157)}…` : said;
}

// The links a key page offers for the questions it answers: itself, and same-site links whose
// address names a trial, a demo, a quote, buying or contact.
function intentLinks(page: { url: string; title?: string; links?: readonly string[] }, intent: KeyIntent): NonNullable<PageFacts["links"]> {
  const kind = (url: string, i: KeyIntent) => (QUOTE_ADDRESS.test(new URL(url).pathname) ? "quote" : i);
  const linkable = new Set<KeyIntent>(["trial", "price", "buy", "contact"]);
  const out: NonNullable<PageFacts["links"]> = [];
  const seen = new Set<string>();
  const add = (url: string, i: KeyIntent, label?: string) => {
    const key = pageKey(url);
    if (seen.has(key) || out.length >= 8) return;
    seen.add(key);
    out.push({ intent: kind(url, i), url, ...(label && { label }) });
  };
  if (linkable.has(intent)) add(page.url, intent, page.title);
  for (const link of page.links ?? []) {
    try {
      const i = intentOf(link);
      if (i && linkable.has(i)) add(link, i, pageLabel(new URL(link).pathname));
    } catch {
      // Not an address.
    }
  }
  return out;
}

// What a page states that answers are checked against (content_pages.facts, refreshed on every
// read): each price figure with its line, phone numbers, email addresses and a contact page's
// form address, a key page's trial, demo, quote, buying and contact links, and its dates, each
// with how it was read (events: dates without a year, placed, and dates on or after today; a date
// no year fits has date "" and readAs saying why). Pure.
export function statedFacts(
  page: { url: string; title?: string; text: string; links?: readonly string[]; words?: number; lang?: string },
  intent: KeyIntent | null | undefined,
  dates: PlacedDates,
  today: Date,
): PageFacts {
  const lines = page.text.split("\n");
  const prices: NonNullable<PageFacts["prices"]> = [];
  const contacts: NonNullable<PageFacts["contacts"]> = [];
  let code = false;
  for (const [i, raw] of lines.entries()) {
    if (/^\s*```/.test(raw)) code = !code;
    if (code || !raw.trim()) continue;
    for (const m of raw.matchAll(FIGURE)) {
      const figure = m[0].replace(/\s+/g, " ").trim();
      const line = figureLine(lines, i, figure);
      if (prices.length < 20 && !prices.some((p) => p.figure === figure && p.line === line)) prices.push({ figure, line });
    }
    for (const m of raw.matchAll(EMAIL)) {
      // A phone number glued to the address by the page's layout ("+353 21 2128700sales@…").
      const value = m[0].replace(/^\d{4,}(?=[a-z])/i, "");
      if (contacts.length < 10 && !contacts.some((c) => c.value === value)) contacts.push({ kind: "email", value, line: shortLine(raw) });
    }
    for (const m of raw.matchAll(PHONE)) {
      const value = m[0].trim();
      const digits = value.replace(/\D/g, "").length;
      if (digits < 7 || digits > 15 || /^(19|20)\d{2}[-./ ]\d{1,2}[-./ ]\d{1,2}$/.test(value)) continue;
      if (!(value.startsWith("+") || NANP.test(value) || PHONE_WORD.test(raw))) continue;
      if (contacts.length < 10 && !contacts.some((c) => c.value === value)) contacts.push({ kind: "phone", value, line: shortLine(raw) });
    }
  }
  if (intent === "contact" && ((page.words ?? 80) < 80 || FORM_WORDS.test(page.text) || !contacts.length)) {
    contacts.push({ kind: "form", value: page.url, line: page.title ?? pageLabel(new URL(page.url).pathname) });
  }
  const links = intent ? intentLinks(page, intent) : [];
  const yesterday = new Date(today.getTime() - DAY_MS).toISOString().slice(0, 10);
  const events: NonNullable<PageFacts["events"]> = [];
  const eventsPage = isEventsPage(page.url, page.title);
  let before: PlacedDates["dates"][number] | undefined;
  const layout = datedListLayout(lines, page.lang);
  let at = -1;
  for (const d of dates.dates) {
    const opener = before;
    // Where this date's line is: the same words can open two items of a list.
    if (!(d.rangeEnd && opener?.line === d.line)) {
      const next = lines.findIndex((l, i) => i > at && shortLine(l, true) === d.line);
      if (next >= 0) at = next;
    }
    before = d;
    // A range is listed once, by its first day, unless that has passed and its last hasn't.
    if (d.rangeEnd && opener && opener.date >= yesterday) continue;
    // A date written with its year is an event's on a line about one (not a deadline), or anywhere
    // on an events page (round 7: seeburger.com's German index gave no dates to the prompt's list,
    // so the model mixed them: its lines hold only the date).
    const event = d.yearless || (d.date >= yesterday && (eventsPage || EVENT_LINE.test(d.line)));
    if (!event || events.length >= 20) continue;
    const line = namedDateLine(lines, d.line, page.lang, layout, at);
    if (!events.some((e) => e.date === d.date && e.line === line)) events.push({ date: d.date, line, readAs: d.readAs });
  }
  for (const u of dates.unplaced.slice(0, 5)) events.push({ date: "", line: u.line, readAs: u.readAs });
  return {
    ...(prices.length && { prices }),
    ...(contacts.length && { contacts }),
    ...(links.length && { links }),
    ...(events.length && { events }),
  };
}

// Whether a page is an events page: its address has an events folder, or its title is about events.
export function isEventsPage(url: string, title?: string | null): boolean {
  return segmentsOf(new URL(url).pathname).some((s) => EVENT_FOLDERS.has(s)) || EVENT_LINE.test(title ?? "");
}

// A dated line as the prompt's events list reads it. A line holding only a date says nothing about
// which event: it takes the lines that name it (up to 3 above it, or a heading right below when the
// page puts the date first), and a time on the next line. Each event keeps its own date and hours,
// so the model has no need to work out which goes with which (seeburger.com: "14:00–17:00" given
// to the wrong event, and the 27th to the Summit). Pure.
const TIME_LINE = /^\W*\d{1,2}[:.h]\d{2}\b[^\p{L}]*(?:\b\p{L}{1,5}\b[^\p{L}]*)*(?:\(.{0,30}\))?$/u;
// A line that holds only a date, in the page's language or English: it says nothing of which event
// (prompt.ts leaves such a line out of an events index's list). Pure.
export function namesNoEvent(line: string, lang?: string): boolean {
  const langs = lang ? [lang] : Object.keys(MONTH_NAMES);
  return line
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .every((w) => w.length <= 3 || langs.some((l) => dateWords(l).month.has(bare(w)) || dateWords(l).day.has(bare(w))));
}

// Which side of its date a plain list (no headings) names each event on. Date-only lines alone can't
// say, and taking the wrong side gives every event the date of the one beside it (round 7: mvtec.com
// heads each item with its date, so "HALCON 26.11 Webinar" took the 24 November of the trade show
// after it). The side an item's name is on holds the same kind of line next to every date; the other
// side holds whatever the item before ended on, a sentence for one and a label for the next. When
// both sides are even, the end of the list decides: the whole item left before the first date, or
// after the last. Neither: "unclear", and the date stays unnamed. "single": one date, or headings
// right beside most dates, which name them. "headed": headings between the dates, above them, so
// a heading right below a date is the next section's (hms-networks.com's course list). Pure.
export type DatedListLayout = "above" | "below" | "unclear" | "single" | "headed";
const SENTENCE_LINE = /[.!?…]["”»)]?$/u;
function datedListLayout(lines: readonly string[], lang: string | undefined): DatedListLayout {
  const filled = lines.flatMap((text, at) => (text.trim() ? [{ text: text.trim(), at }] : []));
  const heading = (t: string) => /^#{1,6}\s/.test(t);
  const isDate = (t: string) =>
    !heading(t) &&
    /\d/.test(t) &&
    namesNoEvent(shortLine(t, true), lang) &&
    placeDates(t, { date: new Date(0), from: "read" }, lang).dates.length > 0;
  const stops = filled.flatMap((l, i) => (isDate(l.text) ? [i] : []));
  if (stops.length < 2) return "single";
  const most = (count: number) => count * 2 >= stops.length;
  if (most(stops.filter((i) => heading(filled[i - 1]?.text ?? "") || heading(filled[i + 1]?.text ?? "")).length)) return "single";
  if (stops.slice(1).filter((stop, n) => filled.slice(stops[n]! + 1, stop).some((l) => heading(l.text))).length >= 2) return "headed";
  const isTime = (t: string) => TIME_LINE.test(shortLine(t));
  const nextTo = (i: number, step: number) => {
    let j = i + step;
    while (j >= 0 && j < filled.length && isTime(filled[j]!.text)) j += step;
    return filled[j]?.text;
  };
  const kinds = (step: number) =>
    stops.map((i) => {
      const t = nextTo(i, step);
      return t === undefined || heading(t) ? undefined : SENTENCE_LINE.test(t) ? "sentence" : "label";
    });
  const even = (list: readonly (string | undefined)[]) => list.every((k) => k && k === list[0]);
  const [aboveEven, belowEven] = [even(kinds(-1)), even(kinds(1))];
  const untilHeading = (from: number, step: number) => {
    let count = 0;
    for (let j = from; j >= 0 && j < filled.length && !heading(filled[j]!.text); j += step) if (!isTime(filled[j]!.text)) count++;
    return count;
  };
  const lead = untilHeading(stops[0]! - 1, -1);
  const tail = untilHeading(stops.at(-1)! + 1, 1);
  if (aboveEven && !belowEven) return lead ? "above" : "unclear";
  if (belowEven && !aboveEven) return tail >= 2 ? "below" : "unclear";
  if (!aboveEven && !belowEven) return "unclear";
  const smallest = Math.min(...stops.slice(1).map((stop, i) => filled.slice(stops[i]! + 1, stop).filter((l) => !isTime(l.text)).length));
  if (lead >= smallest && tail < smallest) return "above";
  if (tail >= smallest && lead < smallest) return "below";
  return "unclear";
}

function namedDateLine(lines: readonly string[], line: string, lang: string | undefined, layout: DatedListLayout, known: number): string {
  const at = known >= 0 && shortLine(lines[known] ?? "", true) === line ? known : lines.findIndex((l) => shortLine(l, true) === line);
  if (!namesNoEvent(line, lang ?? "en")) {
    // A short place and date right under an event's heading ("### Crane Safety 2026", "Manchester, 11
    // November 2026"): the heading is its name.
    for (let i = at - 1; at >= 0 && i >= 0; i--) {
      if (!lines[i]!.trim()) continue;
      const short = line.split(/\s+/).length <= 6;
      return short && /^\s*#{1,6}\s/.test(lines[i]!) ? `${shortLine(lines[i]!)} · ${line}` : line;
    }
    return line;
  }
  if (at < 0 || layout === "unclear") return line;
  if (layout === "below") {
    const parts: string[] = [];
    for (let i = at + 1; i < lines.length && parts.length < 3; i++) {
      if (!lines[i]!.trim()) continue;
      if (/^\s*#{1,6}\s/.test(lines[i]!) || placeDates(lines[i]!, { date: new Date(0), from: "read" }, lang).dates.length) break;
      parts.push(shortLine(lines[i]!));
      // Up to the sentence that describes it.
      if (SENTENCE_LINE.test(lines[i]!.trim())) break;
    }
    return [...parts, line].join(" · ");
  }
  const near = (from: number, step: number) => {
    for (let i = from; i >= 0 && i < lines.length; i += step) if (lines[i]!.trim()) return i;
    return -1;
  };
  const level = (i: number) => (i >= 0 ? (/^\s*(#{1,6})\s/.exec(lines[i]!)?.[1]?.length ?? 0) : 0);
  const isHeading = (i: number) => level(i) > 0;
  const above = near(at - 1, -1);
  const below = near(at + 1, 1);
  const parts: string[] = [];
  // A heading right below, deeper than any right above, or the one above already follows another
  // date (hms-networks.com's cards): the page puts the date first.
  const dated = (i: number) => i >= 0 && placeDates(lines[i]!, { date: new Date(0), from: "read" }, lang).dates.length > 0;
  const aboveTaken = isHeading(above) && level(below) === level(above) && dated(near(above - 1, -1));
  if (layout !== "headed" && isHeading(below) && (!isHeading(above) || level(below) > level(above) || aboveTaken))
    parts.push(shortLine(lines[below]!));
  else {
    let i = above;
    while (i >= 0 && parts.length < 3) {
      const text = shortLine(lines[i]!);
      // Another date, or its hours, is the event before: stop there.
      if (TIME_LINE.test(text)) break;
      if (placeDates(lines[i]!, { date: new Date(0), from: "read" }, lang).dates.length) break;
      if (lines[i]!.trimStart().startsWith(">")) break;
      parts.unshift(text);
      if (isHeading(i)) break;
      i = near(i - 1, -1);
    }
  }
  const time = below >= 0 && TIME_LINE.test(shortLine(lines[below]!)) ? ` ${shortLine(lines[below]!)}` : "";
  return [...parts, `${line}${time}`].join(" · ");
}

const CURRENCIES: [RegExp, string][] = [
  [/US\$|\$|US-Dollars?|Dollars?|\bUSD\b/i, "USD"],
  [/€|\bEUR\b|Euros?/i, "EUR"],
  [/£|\bGBP\b/i, "GBP"],
  [/¥|\bJPY\b/i, "JPY"],
  [/\bCHF\b/i, "CHF"],
];
export const currencyOf = (figure: string) => CURRENCIES.find(([re]) => re.test(figure))?.[1];

type Unplaced = { figure: string; url: string; line: string };
// The figures the note names that a row now has: a figure is in a row by its value and currency,
// however it's written ("$12", "$ 12"). Pure.
export function stillUnplaced(rows: readonly { value: number; currency?: string }[], unplaced: Unplaced[] | undefined): Unplaced[] {
  return (unplaced ?? []).filter((f) => {
    const value = Number(figureValue(f.figure));
    const currency = currencyOf(f.figure);
    return !rows.some((r) => r.value === value && (!currency || !r.currency || r.currency === currency));
  });
}

// A figure's amount, whatever its local format, to compare figures by: "1 250 €" and "1.250 €"
// are 1250, "37,5 €" and "37,50 €" are 37.5, "$9.99" is 9.99, "2.205 US-Dollar" is 2205. A
// separator followed by exactly 3 digits groups thousands; one followed by 1 or 2 digits at the
// end marks the decimals. Undefined when it holds no digits. Pure.
export function figureValue(figure: string): string | undefined {
  const kept = figure.replace(/[^\d.,\s  ]/g, "").trim();
  if (!/\d/.test(kept)) return undefined;
  // Spaces between digit groups are thousands; any other space ends the figure.
  const compact = kept.replace(/(\d)[\s  ]+(?=\d{3}(?!\d))/g, "$1").split(/[\s  ]/)[0]!;
  const m = /^(.*?)[.,](\d{1,2})$/.exec(compact);
  const whole = (m ? m[1]! : compact).replace(/[.,]/g, "");
  const cents = m ? m[2]!.padEnd(2, "0") : undefined;
  const n = String(Number(whole || "0"));
  return cents && cents !== "00" ? `${n}.${cents.replace(/0$/, "")}` : n;
}
// Two figures for the same amount, in any local format.
export const sameFigure = (a: string, b: string): boolean => {
  const x = figureValue(a);
  return x !== undefined && x === figureValue(b);
};

// Figures a page's markup splits into spans, joined: "9 .99" → "9.99", and a "&" placeholder
// before a figure (teamwork.com's comparison table: "& 9.99") takes the currency the page writes
// most; never a "&" between two numbers (extractor 5: teamwork.com's banner "Live webinars, 4 & 5
// Nov" was sent as "4 $5 Nov"). A price alone on its line under a plan's heading is written with
// the heading's name (labelFigures). Pure.
export function joinFigures(markdown: string): string {
  let text = markdown.replace(/(\d)[  ]+([.,]\d{1,2})(?![\d.,])/g, "$1$2");
  if (/(^|[\s|(])&[  ]?\d/m.test(text)) {
    const counts = new Map<string, number>();
    for (const m of text.matchAll(/[$€£¥]/g)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
    const symbol = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (symbol)
      text = text.replace(/(^|[\s|(])&[  ]?(?=\d)/gm, (whole: string, before: string, at: number, all: string) =>
        // "4 & 5 Nov", "1&2": a "&" joining two numbers is a word, not a currency placeholder.
        /\d[  ]*$/.test(all.slice(0, at + before.length)) ? whole : `${before}${symbol}`,
      );
  }
  return labelFigures(text);
}

// A price alone on its line ("$ 189"), within a few lines under a heading ("##### Enterprise") and
// the first figure there, written with the heading's name, and its unit when that's the next line:
// "Enterprise: $ 189", "Business: $ 59 per node, per year" (extractor 5). The Knowledge Box cuts the
// text into paragraphs by length, not by heading: chef.io's "$ 189" opened the paragraph that goes
// on with "Enterprise Plus", away from its own heading, and answers said the Enterprise price wasn't
// stated, or gave it to Enterprise Plus. Pure.
// A footnote mark after the figure ("$ 1,229 *", whatsupgold.com) still leaves it alone (extractor 6).
// A short unit, and the billing a toggle shows it for, may follow it on its line ("$19 /mo",
// "$190 per year", "$25 / month, billed annually": extractor 7).
const PRICE_TAIL = String.raw`(?:[ \t]*(?:\/|per\b)[ \t]*\p{L}+)?(?:,?[ \t]*(?:when )?billed[ \t]+\p{L}+)?`;
const PRICE_ALONE = new RegExp(
  String.raw`^[ \t]*(?:US\$|[$€£¥])[  ]?(?:${AMOUNT})[ \t]*[*†+]{0,2}${PRICE_TAIL}[ \t]*$|^[ \t]*(?:${AMOUNT})[  ]?[$€£¥][ \t]*[*†+]{0,2}${PRICE_TAIL}[ \t]*$`,
  "u",
);
// "When billed annually" under a card's price is its unit line too (buzzsprout.com).
const UNIT_LINE = /^(?:\/|(?:per|pro|par|por|each|billed|a|an|[Ww]hen billed|[Ii]f billed)\b|\p{Ll})/u;
// A line that says the figure below is a starting price ("starting from", "ab", "desde"): it joins
// the figure's line, so the plan's price reads "Business: starting from $ 1,229 *" (extractor 6).
const FROM_LINE =
  /^\s*(?:starting (?:from|at)|starts at|from|as low as|prices? from|ab|preis ab|desde|à partir de|a partir de|vanaf|da|a partire da)\s*:?\s*$/i;
// How many lines above a figure its plan's heading may be (whatsupgold.com's cards list what each
// edition includes between its heading and its price). A card's feature list doesn't count
// towards it (buzzsprout.com's Audio card lists 8), up to HEADING_REACH lines in all.
const HEADING_WINDOW = 8;
const HEADING_REACH = 24;
export function labelFigures(markdown: string): string {
  const lines = markdown.split("\n");
  const drop = new Set<number>();
  // The lines this labelled: a second price takes its name only from one of them.
  const labelledBy = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!PRICE_ALONE.test(lines[i]!)) continue;
    let heading: number | undefined;
    // The plan's other price just above, already written with its name ("Premium: $ 28.59", then
    // "$ 26.00": a monthly/annual toggle's two prices, sharefile.com/plans): the same name (extractor 6).
    let sibling: string | undefined;
    let from: number | undefined;
    let seen = 0;
    let reach = 0;
    for (let j = i - 1; j >= 0 && seen < HEADING_WINDOW && reach < HEADING_REACH; j--) {
      const line = lines[j]!;
      if (!line.trim()) continue;
      reach++;
      if (!/^\s*(?:[-*+]|\d+\.)\s/.test(line) || reach === 1) seen++;
      if (seen === 1 && FROM_LINE.test(line)) from = j;
      if (/^\s*#{1,6}\s/.test(line)) {
        heading = j;
        break;
      }
      if (HAS_FIGURE.test(line)) {
        if (seen === 1 && labelledBy.has(j)) sibling = /^([^:]{1,60}): /.exec(line)?.[1];
        break;
      }
    }
    if (heading === undefined && sibling === undefined) continue;
    const name = sibling ?? shortLine(lines[heading!]!);
    if (!name || name.length > 60 || HAS_FIGURE.test(name) || !/\p{L}/u.test(name)) continue;
    let next = i + 1;
    while (next < lines.length && !lines[next]!.trim()) next++;
    const unit = next < lines.length ? lines[next]!.trim() : "";
    const joinsUnit = Boolean(unit) && UNIT_LINE.test(unit) && !HAS_FIGURE.test(unit) && unit.split(/\s+/).length <= 8;
    const lead = from !== undefined ? `${lines[from]!.trim().replace(/\s*:$/, "")} ` : "";
    lines[i] = `${name}: ${lead}${lines[i]!.trim()}${joinsUnit ? ` ${unit}` : ""}`;
    labelledBy.add(i);
    if (joinsUnit) drop.add(next);
    if (from !== undefined) drop.add(from);
  }
  return drop.size
    ? lines
        .filter((_, i) => !drop.has(i))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
    : lines.join("\n");
}

// "States: $ 59 per node, per year · $ 189": a key page's facts in a line, for Content.
export function factsLine(facts: PageFacts | null | undefined, max = 4): string | undefined {
  if (!facts) return undefined;
  const parts = [
    ...(facts.prices ?? []).map((p) => p.line),
    ...(facts.contacts ?? []).filter((c) => c.kind !== "form").map((c) => c.value),
    ...(facts.links ?? [])
      .filter((l) => l.intent === "trial" || l.intent === "quote")
      .map((l) => `${l.label ?? l.intent}: ${new URL(l.url).pathname}`),
  ];
  const unique = [...new Set(parts)];
  if (!unique.length) return undefined;
  return `States: ${unique.slice(0, max).join(" · ")}${unique.length > max ? ` · and ${unique.length - max} more` : ""}`;
}

// ---- finding a page for a question (validation's "Pages on the site that may answer this") ----

// matchWords and matchScore live in @launchpad/theme (relevance.ts): the widget picks sources by them too.
export { matchScore, matchWords } from "@launchpad/theme";

// A reason a page is left out, said short enough to count by ("12 pages would now be left out:
// 1 conversion page, 10 older than 2 years, 1 states a price, published 2016").
export function leaveOutLabel(detail: string): string {
  const reason = detail.startsWith(WOULD_LEAVE_OUT) ? detail.slice(WOULD_LEAVE_OUT.length) : detail;
  if (reason.startsWith(KEEP_ASKED)) return "Added by hand: waiting for a reason to keep it";
  if (reason.startsWith(KEEP_ASKED_LIVE)) return "Added by hand: in the chat, and needs a reason to stay";
  const stale = /^States (a price|a discount or offer|a version), published \d{1,2} \w{3} (\d{4})/.exec(reason);
  if (stale) return `States ${stale[1]}, published ${stale[2]}`;
  if (reason.startsWith("In another language")) return "In another language";
  if (reason.startsWith("A thank-you or confirmation page")) return "Conversion page";
  if (/: older than 2 years/.test(reason)) return "Older than 2 years";
  if (/: a campaign, event, webinar or news page/.test(reason)) return "Campaign, event, webinar or news page over 12 months old";
  if (reason.startsWith("Duplicate of")) return "Duplicate of another page";
  if (reason.startsWith("Marked noindex")) return "Marked noindex";
  if (reason.startsWith("Too little text")) return "Too little text to answer from";
  if (reason.startsWith("An error page")) return "Error page";
  if (reason.startsWith("An overview page")) return "Overview page";
  return reason;
}

interface StoredPage {
  url: string;
  title: string | null;
  lang: string | null;
  lastModified: Date | null;
  publishedAt: Date | null;
  pageModifiedAt: Date | null;
  text?: string | null;
}

// What's stored about a synced page, as the content rules read it. Pages synced before dates
// were kept have none: the address's stands in. Dates stored before the rule on dates after
// today (knownDate) count as unknown here too.
export function storedFacts(page: StoredPage, today: Date): RenderedFacts {
  const lang = pathLanguage(page.url) ?? page.lang;
  const stored = knownDate(page.lastModified, today);
  const urlDay = stored ? undefined : urlDate(page.url, today);
  const lastModified = stored ?? (urlDay ? new Date(`${urlDay}T00:00:00Z`) : undefined);
  const published = knownDate(page.publishedAt, today);
  const modified = knownDate(page.pageModifiedAt, today);
  return {
    url: page.url,
    ...(page.title && { title: page.title }),
    ...(lang && { lang }),
    ...(lastModified && { lastModified }),
    ...(published && { published }),
    ...(modified && { modified }),
    ...(page.text && { text: page.text }),
  };
}

// The flags a page carries from what's stored about it, for pages synced before the current
// rules (they're read again in the nightly batch; until then the content list still shows
// these). The overview and short-text flags need the page loaded: earlier ones are kept.
export function storedFlags(
  page: StoredPage & { flags: readonly string[] },
  opts: { served: readonly string[]; today: Date; keyPages?: boolean },
): PageFlag[] {
  const flags = pageFlags(storedFacts(page, opts.today), opts);
  // Without the text, a date without a year can't be looked at again: an earlier finding stays.
  const kept = page.flags.filter(
    (f): f is PageFlag => (f === "overview" || f === "short-text" || (f === "yearless-date" && !page.text)) && !flags.includes(f),
  );
  return PAGE_FLAGS.filter((f) => flags.includes(f) || kept.includes(f));
}

// "14 Mar 2025"
export function formatPlanDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
