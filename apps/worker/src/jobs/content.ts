// Content sync: keeps each deployment's Knowledge Box in step with its site. Pages come from
// the site's sitemaps (or a short crawl when it has none), ranked by the content plan's rules
// (the console's lib/content-plan.ts, the same code the plan on New deployment shows) within
// the partner's page budget, paths and languages. The sniffer renders each page and extracts
// its main content, which goes into the KB as Markdown under a slug fixed by the page's URL,
// with the URL as the citation link.
//
// Each run (every minute) does a slice of the work, so a large site never holds up the rest:
// start syncs that are due, send a batch of waiting pages (pages added by hand first, then
// first syncs, then re-syncs, then pages read again for a newer extractor or rules; deployments
// taking turns within each), check pages the KB is processing, take pages that were left out
// out of the KB, and close syncs with nothing left to send, after topping up the budget for
// pages that loading left out (duplicates, conversion pages, another language, overviews, and
// pages whose own date fails the plan's date rules). A re-sync skips pages whose sitemap
// lastmod hasn't changed and that the current extractor and rules read, resends only pages
// whose text changed, and takes pages that left the site out of the KB.
//
// Pages read by an older extractor or older rules are read again overnight, a deployment at a time,
// by Bring up to date overnight (jobs/rules-rollout.ts), behind every first sync. A re-read never
// takes an answerable page out by itself: it records why the current rules would, and the
// re-check (or the partner's Bring up to date) applies it. Each finished sync rebuilds the price
// table from the pricing pages' facts (refreshPriceTable). A page the site rate-limits is tried
// again more slowly (rateLimitedOutcome), and an incomplete listing takes nothing out of the chat
// (listingComplete).
//
// Every page is sent with its page-type labels (usermetadata.classifications, labelset
// launchpad_page: a key page's intent, and "events" for a page stating a date still to come), and
// its dates written without a year get their year in the text ("Thursday, November 5, 2026"). A
// key page's intent line is the resource's metadata, not its text. What each page states (prices,
// contacts, links, events) is stored on every read (content_pages.facts). Pages added by hand skip
// the budget and most rules, but not the date and stale-price rules unless a person kept them
// with a reason (sync_sources.kept). The tail stops replacing left-out pages after TAIL_STOP
// replacements in a row are left out too.
//
// Pages a person left out that are still in the chat (left out under older code, before Leave
// out took them out at once) are taken out once per deployment after an upgrade, with one alert
// (retractExcluded). Bring up to date's Add learns what actually joined and left once its sync
// finishes (settleKeyPages), which History then shows.

import { createHash } from "node:crypto";
import { auditLog, contentPages, deployments, loadKey, type PageFacts, syncSources, tenants } from "@launchpad/db";
import { KbClient, ParError } from "@launchpad/par-client";
import { and, desc, eq, gte, inArray, isNotNull, isNull, like, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { accountBlock, accountBlockState, BLOCKED, noteAccountBlock, UNBLOCKED } from "../../../console/src/lib/account-block.ts";
import { blockSentence, refusalOf } from "../../../console/src/lib/ask-refusal.ts";
import {
  announcesUpcoming,
  capKeyIntents,
  chromeLines,
  dateAnchor,
  dateFrom,
  dropChrome,
  duplicateTarget,
  EXTRACTOR_VERSION,
  errorPage,
  intentOf,
  isKeyIntent,
  isSitemapAddress,
  joinFigures,
  KEEP_ASKED,
  KEY_INTENTS,
  type KeyIntent,
  keepAsked,
  keepRule,
  keyIntentFor,
  keyIntentOfPage,
  knownDate,
  LEFT_OUT_BY_YOU,
  loadedFacts,
  MAX_PINNED,
  PAGE_LABELSET,
  type PageFlag,
  type PageLabel,
  type PlanRule,
  pageDate,
  pageFlags,
  pageKey,
  pageLabels,
  pageLanguage,
  pageMetadata,
  pathMatches,
  placeDates,
  planRules,
  RATE_LIMIT_TRIES,
  type RankedPage,
  REREAD,
  type RenderedFacts,
  RULES_VERSION,
  rankPages,
  rateLimitedDetail,
  rateLimitTries,
  ruleLeaveOut,
  SNIFFER_EXTRACTOR,
  selectPages,
  servedLanguages,
  statedFacts,
  storedFlags,
  takesKeyPages,
  unusableForKeys,
  urlDate,
  WOULD_LEAVE_OUT,
  withinRules,
  withoutTracking,
} from "../../../console/src/lib/content-plan.ts";
import { needsConfirmingAgain, priceTableFor } from "../../../console/src/lib/price-table.ts";
import { modelPriceReader } from "../../../console/src/lib/price-table-model.ts";
import {
  isRefusalNote,
  type LoadWatch,
  NO_ANSWER_SQL,
  NOT_READ,
  notTried,
  REFUSAL_WORDS,
  REFUSED_PAGES,
  refusalNote,
  refusalStep,
  refusedLoad,
  watchLoads,
} from "../../../console/src/lib/site-refusal.ts";
import type { JobContext } from "../context.ts";
import type { SitePage, Sniffer } from "../sniffer.ts";
import { postAlert } from "./alerts.ts";
import { refreshEventsList } from "./prompt-date.ts";

export const DEFAULT_PAGE_BUDGET = 100;
// Fetched and sent per run, in batches loaded side by side, so a run stays under a minute: about
// 60 pages a minute, so five first syncs of 200 pages started together are in within 20 minutes.
const PAGES_PER_RUN = 60;
const FETCH_BATCH = 20;
const MIN_WORDS = 40;
// A run that stopped without finishing (worker restarted) is picked up again after this.
const STALE_RUN_MS = 30 * 60_000;
// A page the KB hasn't processed after this long is reported as failed.
const PROCESSING_LIMIT_MS = 2 * 60 * 60_000;
// Every language the widget supports, for deployments that follow each visitor's.
const ALL_LANGUAGES = ["en", "es", "fr", "de", "nl", "pt", "it"];

// ---- rules (pure) ----

// The same page whatever its spelling: lower-case host, no fragment, no trailing slash, no
// ad-click or campaign parameters.
export function normalizeUrl(url: string): string {
  const u = new URL(withoutTracking(url));
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
  return `${u.origin}${path}${u.search}`;
}

export const slugFor = (url: string) => `page-${createHash("sha256").update(normalizeUrl(url)).digest("hex").slice(0, 32)}`;

// What the plan asks of every page once it's loaded.
export interface SyncRules {
  // The plan's ticked suggestions.
  rules: readonly PlanRule[];
  // Primary languages the sync keeps; empty: any.
  served: readonly string[];
  // The plan holds more pages than the budget takes, so an overview page can give way to them.
  spare: boolean;
  // A person added this page by hand: the plan's rules and the overview demotion don't apply,
  // except the date and stale-price rules (keepRule) unless they kept it with a reason.
  pinned?: boolean;
  kept?: boolean;
  // A key page's intent: its label, and its intent line in the resource's metadata (pageMetadata).
  intent?: KeyIntent;
  today?: Date;
}
const NO_RULES: SyncRules = { rules: [], served: [], spare: false };

export type PageVerdict =
  | {
      send: true;
      title: string;
      body: string;
      hash: string;
      words: number;
      // Its page-type labels, what it states, and a key page's metadata (its intent line).
      labels: PageLabel[];
      facts: PageFacts;
      metadata?: Record<string, unknown>;
    }
  // canonical: the page this one duplicates, to sync in its place.
  | { send: false; status: "skipped" | "failed"; detail: string; canonical?: string };

const bareHost = (url: string) => new URL(url).hostname.replace(/^www\./, "");

// A title the site repeats ("Connector - Sitefinity Insight Connector - Sitefinity Insight")
// once. Pure.
export function cleanTitle(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  const half = (t.length - 1) / 2;
  return Number.isInteger(half) && t[half] === " " && t.slice(0, half) === t.slice(half + 1) ? t.slice(0, half) : t;
}

// Why a page didn't load, for a partner: the browser's network errors as they are, and a script
// error in the page reader (Launchpad's own fault) in plain words. Pure.
export function loadProblem(error: string): string {
  if (/page\.evaluate|TypeError|ReferenceError|SyntaxError/.test(error)) {
    return "Launchpad's page reader couldn't read this page. Retry it; if it fails again, it's a bug to report.";
  }
  return `Didn't load: ${error}`;
}

export { dateFrom };

// What the content rules know about a loaded page (lib/content-plan.ts loadedFacts: the console
// reads a page the same way before a person keeps it).
export const pageFacts = (page: SitePage, planDate?: Date | null, today = new Date()): RenderedFacts => loadedFacts(page, planDate, today);

// What a loaded page states, as it's sent: its text with each date written without a year placed
// (placeDates: the next occurrence on or after the page's most recent date, agreeing with the day
// name), what it states (statedFacts: prices, contacts, a key page's links, events), and its
// page-type labels. Pure.
export interface ReadPage {
  markdown: string;
  facts: PageFacts;
  labels: PageLabel[];
}
export function readPage(page: SitePage, facts: RenderedFacts, intent: KeyIntent | null | undefined, today: Date): ReadPage {
  // Figures split across spans joined first ("9 .99" → "9.99"), so the text and the facts hold them.
  const placed = placeDates(joinFigures(page.markdown), dateAnchor(facts, today), pageLanguage(facts));
  const stated = statedFacts(
    {
      url: page.url,
      title: cleanTitle(page.title),
      text: placed.text,
      links: page.links,
      words: page.words,
      ...(pageLanguage(facts) && { lang: pageLanguage(facts)! }),
    },
    intent,
    placed,
    today,
  );
  return { markdown: placed.text, facts: stated, labels: pageLabels(intent, stated.events, today) };
}

// What a sent page's hash covers: its title, text and labels (a page whose labels change is sent
// again; one with none hashes as it did before labels).
export const pageHash = (title: string, body: string, labels: readonly string[] = []) =>
  createHash("sha256")
    .update(`${title}\n${body}${labels.length ? `\n${labels.join(" ")}` : ""}`)
    .digest("hex");

// "Crayola (UX review r5) › Main site": the internal customer name, then the deployment, as every
// alert's subject starts (jobs/alerts.ts where).
const alertWhere = (tenantName: string, deployment: string) => `${tenantName} › ${deployment}`;

// What happens to a fetched page, with the reason in words a partner can act on.
export function pageVerdict(
  page: SitePage,
  listed: ReadonlySet<string>,
  sync: SyncRules = NO_RULES,
  flags: readonly PageFlag[] = [],
  facts: RenderedFacts = pageFacts(page, undefined, sync.today),
  read?: ReadPage,
): PageVerdict {
  if (page.error) return { send: false, status: "failed", detail: loadProblem(page.error) };
  if (page.status >= 400) return { send: false, status: "failed", detail: `The site answered ${page.status}.` };
  // An error page answering 200, before anything else is said about it (imeche.org's /pricing, "We're
  // sorry", was left out as noindex and stayed the pricing key page).
  const notThere = errorPage({ title: page.title, markdown: page.markdown, words: page.words });
  if (notThere) return { send: false, status: "skipped", detail: notThere };
  if (page.noindex && !sync.pinned) {
    return { send: false, status: "skipped", detail: "Marked noindex, so it's left out, as search engines leave it out." };
  }
  if (page.canonical && !sync.pinned) {
    // Synced and cited without ad-click parameters, so a source link credits no campaign.
    const clean = withoutTracking(page.canonical);
    const canonical = normalizeUrl(clean);
    // A canonical that differs only by http or https is the page itself (whatsupgold.com's https
    // pages name their http address).
    const itself = canonical.replace(/^https?:/, "") === normalizeUrl(page.url).replace(/^https?:/, "");
    if (canonical !== normalizeUrl(page.url) && !itself) {
      if (listed.has(canonical)) return { send: false, status: "skipped", detail: `Duplicate of ${clean}, which is synced instead.` };
      // A/B and regional variants (/contact-m, /sign-up-for-demo-b) point at the page they copy.
      if (sync.rules.includes("duplicate") && bareHost(clean) === bareHost(page.url)) {
        return {
          send: false,
          status: "skipped",
          detail: `Duplicate of ${clean}, which is synced instead.`,
          canonical: clean,
        };
      }
    }
  }
  // Another language, a conversion page, a stale price in an article, and the plan's date rules
  // on the page's own date. A page added by hand answers only to the date and stale-price
  // rules, and not when a person kept it with a reason.
  const today = sync.today ?? new Date();
  const ruled = sync.pinned ? undefined : ruleLeaveOut(facts, flags, sync.rules, today);
  if (ruled) return { send: false, status: "skipped", detail: ruled };
  const keep = sync.pinned && !sync.kept ? keepRule(facts, flags, sync.rules, today) : undefined;
  if (keep) return { send: false, status: "skipped", detail: keepAsked(keep) };
  if (page.words < MIN_WORDS) {
    return { send: false, status: "skipped", detail: `Too little text to answer from (${page.words} words).` };
  }
  // Key pages aren't demoted as overviews: crayola.com's /support hubs are what a visitor needs. Nor
  // is an events index that dates something still to come: it's what "any upcoming events?" needs.
  if (flags.includes("overview") && sync.spare && !sync.pinned && !sync.intent && !announcesUpcoming(facts, today)) {
    return {
      send: false,
      status: "skipped",
      detail: "An overview page, mostly links: the specific pages it lists are taken first. It's taken when the budget has room.",
    };
  }
  const title = cleanTitle(page.title);
  const stated = read ?? readPage(page, facts, sync.intent, today);
  const body = pageMarkdown({ ...page, title, markdown: stated.markdown });
  const metadata = pageMetadata(sync.intent, pageLanguage(facts));
  return {
    send: true,
    title,
    body,
    hash: pageHash(title, body, stated.labels),
    words: page.words,
    labels: stated.labels,
    facts: stated.facts,
    ...(metadata && { metadata }),
  };
}

// A loaded page without the site's chrome lines (dropChrome), its word count with them gone.
export function withoutChrome(page: SitePage, chrome: ReadonlySet<string>, intent: KeyIntent | null): SitePage {
  if (page.error || !chrome.size) return page;
  const markdown = dropChrome(page.markdown, chrome, intent);
  return markdown === page.markdown ? page : { ...page, markdown, words: markdown.split(/\s+/).filter(Boolean).length };
}

// While sending, a page is updated only while it's still waiting (not taken out meanwhile).
const stillWaiting = (id: string) => and(eq(contentPages.id, id), eq(contentPages.status, "queued"));

// A page whose address a person left out while the sync ran: under Leave out now, unless it was
// added by hand and only a broader pattern covers it (its own path left out wins).
export const leftOutMeanwhile = (url: string, exclude: readonly string[], pinned: readonly string[]) =>
  pathMatches(url, exclude) && (!pinned.includes(url) || exclude.includes(new URL(url).pathname));

// The page's title and summary lead its text, so retrieval sees what the page is about. A key
// page's intent line isn't in it any more (answers quoted "About this page: …" back to visitors):
// its labels route the intent's questions to it, and the line is in its metadata.
export function pageMarkdown(page: Pick<SitePage, "title" | "description" | "markdown">): string {
  const parts: string[] = [];
  if (!page.markdown.startsWith("# ")) parts.push(`# ${page.title}`);
  if (page.description) parts.push(`> ${page.description}`);
  parts.push(page.markdown);
  return parts.join("\n\n");
}

// The languages a sync keeps (lib/content-plan.ts), for the worker's tests and callers.
export { servedLanguages };

// The page a skipped duplicate points at, from the reason it was left out.
export const duplicateOf = (detail: string | null) => duplicateTarget(detail);

const sameDay = (a: Date | null | undefined, day: string | undefined) => Boolean(a && day && a.toISOString().slice(0, 10) === day);
const dayDate = (day: string | undefined) => (day ? new Date(`${day}T00:00:00Z`) : null);

export interface ExistingPage {
  id: string;
  url: string;
  status: string;
  lastModified: Date | null;
  sitemapLastmod?: Date | null;
  contentHash: string | null;
  indexedAt: Date | null;
  sentAt: Date | null;
  extractorVersion?: number;
  rulesVersion?: number;
  keyIntent?: string | null;
}

// The key intent a listed page is stored with: the plan's key pages, and pages added by hand
// whose address names an intent (SE's /contact, added by hand past the budget). None on the
// selection from before key pages (keys false: takesKeyPages).
// A key page loading found unusable keeps its intent too, so Content can say which key pages
// couldn't be used, and why.
export const listedIntent = (url: string, page: RankedPage | undefined, pinned: boolean, keys = true): KeyIntent | null =>
  !keys ? null : page?.keyPage || page?.keyUnusable ? (page.intent ?? null) : pinned ? (intentOf(url) ?? null) : null;

// A page that answered 404 or 410 on its first load and has never been in the chat isn't a key page
// (round 7: northwesternenergy.com's /demo-area/demo-redirect-page stayed the trial key page, and
// Review said it "isn't on the site any more"). One that was in the chat keeps its intent, so Review
// can say the key page has gone.
export const goneKeyPage = (row: { detail: string | null; indexedAt?: Date | null }): boolean =>
  !row.indexedAt && /answered 4(?:04|10)\b|^An error page\b/.test(row.detail ?? "");

// What loading found unusable, for the key pages (lib/content-plan.ts PlanInput.unusable): too
// little text, an error page, a duplicate, not found or failing. Not a page waiting for a person
// to keep it, nor one an older rule left out as an overview (key pages aren't any more: it's
// sent when it's read again).
export const unusableKeys = (rows: readonly { url: string; status: string; detail: string | null }[]) =>
  new Set(rows.filter((r) => unusableForKeys(r)).map((r) => normalizeUrl(r.url)));

// Whether a deployment takes key pages (lib/content-plan.ts takesKeyPages: not yet published, or
// signed off under checks 3 or later), or a person switched it with Bring up to date's Add
// (lib/content.ts addKeyPages, audited content.key-pages). A live deployment signed off under
// older checks keeps the earlier selection on its re-syncs, so visitors get nothing new unasked.
async function keyPagesFor(ctx: JobContext, d: Pick<Deployment, "id" | "published" | "signOff">): Promise<boolean> {
  if (takesKeyPages(d)) return true;
  const [switched] = await ctx.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.targetType, "deployment"), eq(auditLog.targetId, d.id), eq(auditLog.action, "content.key-pages")))
    .limit(1);
  return Boolean(switched);
}

// Which ranked pages a sync takes (lib/content-plan.ts: Bring up to date previews with it too).
export { selectPages };

// Read by the current extractor and content rules.
export const currentVersions = (row: Pick<ExistingPage, "extractorVersion" | "rulesVersion">) =>
  (row.extractorVersion ?? 0) >= EXTRACTOR_VERSION && (row.rulesVersion ?? 0) >= RULES_VERSION;

// Answerable (or left out) and its sitemap lastmod unchanged since. Pages without a lastmod
// are always loaded again.
function lastmodUnchanged(page: RankedPage, row: ExistingPage | undefined): row is ExistingPage {
  if (!row || !page.entry.lastmod) return false;
  // The sitemap's own date, as listed (lastModified may be the page's own date by now).
  if (!sameDay(row.sitemapLastmod ?? row.lastModified, page.entry.lastmod)) return false;
  return (row.status === "indexed" && Boolean(row.contentHash && row.indexedAt)) || row.status === "skipped";
}

// A listed page that needn't be loaded again: unchanged since by its lastmod, and read by the
// current extractor and rules.
export function unchanged(page: RankedPage, row: ExistingPage | undefined): boolean {
  return lastmodUnchanged(page, row) && currentVersions(row);
}

// Unchanged by its lastmod, but read by an older extractor or rules: Bring up to date overnight
// (jobs/rules-rollout.ts) reads it again, not the re-sync (every page of every deployment would
// otherwise reload at once).
export function waitsForReread(page: RankedPage, row: ExistingPage | undefined): boolean {
  return lastmodUnchanged(page, row) && !currentVersions(row);
}

// Left to Bring up to date overnight: on a scheduled re-sync only. A sync a person asked for (Sync now, new
// settings, Leave out) reads such a page again now: it counts as changed unless both its
// extractor and rules versions are current.
export const deferToNight = (page: RankedPage, row: ExistingPage | undefined, requested: boolean) =>
  !requested && waitsForReread(page, row);

// ---- the run ----

export async function syncContent(ctx: JobContext, sniffer: Sniffer, now = new Date()): Promise<void> {
  await startDueSyncs(ctx, sniffer, now);
  await requeueAfterBlock(ctx, now);
  await sendWaitingPages(ctx, sniffer, now);
  await checkProcessing(ctx, now);
  await retractExcluded(ctx, now);
  await retractLeftOut(ctx);
  await finishSyncs(ctx, sniffer, now);
  await refreshFlags(ctx, now);
}

// Writing needs the writer key; deployments imported with only a manager key use that.
async function writerClient(ctx: JobContext, d: { id: string; zone: string; kbId: string | null }) {
  if (!d.kbId) return undefined;
  const key = (await loadKey(ctx.db, ctx.masterKey, d.id, "writer")) ?? (await loadKey(ctx.db, ctx.masterKey, d.id, "manager"));
  return key ? new KbClient({ zone: d.zone, kbId: d.kbId, credential: { kind: "key", token: key } }) : undefined;
}

type Source = typeof syncSources.$inferSelect;
type Deployment = typeof deployments.$inferSelect;

// Where the sync reads a site's pages from: the content settings' address is either a sitemap
// file to read directly, or a page to find sitemaps from (and crawl from, without one).
export function discoveryFrom(source: Pick<Source, "sitemapUrl">, siteUrl: string): { site: string; sitemap?: string } {
  if (isSitemapAddress(source.sitemapUrl)) return { site: siteUrl, sitemap: source.sitemapUrl! };
  return { site: source.sitemapUrl ?? siteUrl };
}

const servedFor = (d: Pick<Deployment, "language">) => (d.language === "auto" ? ALL_LANGUAGES : [d.language]);

// What a sync does with a page the site rate-limited (429 or 503, even after the sniffer's pauses):
// it waits for another try on a later run, up to RATE_LIMIT_TRIES; then a page in the chat goes
// back to answering from its copy, and any other is failed with the reason. The next sync tries
// either again. Never a final failure on the first 429 (round 6: hms-networks.com). Pure.
export function rateLimitedOutcome(
  page: { detail: string | null; indexedAt: Date | null; contentHash: string | null },
  status: number,
): { status: "queued" | "indexed" | "failed"; detail: string } {
  const tries = rateLimitTries(page.detail) + 1;
  const detail = rateLimitedDetail(status || 429, tries);
  if (tries < RATE_LIMIT_TRIES) return { status: "queued", detail };
  return { status: page.indexedAt && page.contentHash ? "indexed" : "failed", detail };
}

// Whether a sync's listing is the site's whole list, so pages missing from it have left the site:
// a sitemap read with no file failed, unreached or blocked, or a crawl that found at least most of
// what's answerable now. An incomplete listing takes nothing out of the chat: "Sync now" on a site
// that rate-limited the crawl's start page found 0 pages and would have emptied the chat (round 6:
// hms-networks.com). Pure.
export function listingComplete(
  listing: { kind: "sitemap"; failed: number; unread: number; blocked: boolean } | { kind: "crawl"; found: number },
  answerable: number,
): boolean {
  if (listing.kind === "sitemap") return !listing.failed && !listing.unread && !listing.blocked;
  return listing.found > 0 && listing.found >= answerable * 0.8;
}

// The sitemaps couldn't be read this time (a rate limit, an error, bot protection): the sync stops
// there rather than crawl a site whose sitemaps it has read before, and keeps every page it has.
export class SitemapUnreadable extends Error {}

// The sitemaps' pages, ranked by the plan's rules: the order every sync takes them in. Key pages a
// first sync would take are checked to load first (the plan's check, apps/console's plan route): one
// answering 4xx or 5xx gives its place to the next of its intent.
async function rankedPages(ctx: JobContext, sniffer: Sniffer, source: Source, d: Deployment, now: Date, keys: boolean) {
  const from = discoveryFrom(source, d.siteUrl);
  let read = await sniffer.sitemapEntries(from.site, from.sitemap);
  // Files that failed or weren't reached (the plan's read may have been one): read once more
  // (the sniffer keeps no incomplete read), and go with the fuller of the two.
  if (read.failed?.length || read.unread?.length) {
    const again = await sniffer.sitemapEntries(from.site, from.sitemap).catch(() => undefined);
    if (again && again.total >= read.total) read = again;
    const missing = (read.failed?.length ?? 0) + (read.unread?.length ?? 0);
    if (missing) ctx.log(`content sync for ${d.id}: ${missing} sitemap files still couldn't be read; ranking the ${read.total} pages read`);
  }
  const incomplete = Boolean(read.failed?.length || read.unread?.length || read.blocked);
  if (!read.total) {
    if (read.blocked) throw new SitemapUnreadable(`The site blocked the sitemap read (${read.blocked.by} bot protection).`);
    // A site whose sitemaps were read before: a failed read isn't "no sitemap".
    if (incomplete && source.discovery !== "crawl")
      throw new SitemapUnreadable(
        `The site's sitemaps couldn't be read this time (${read.failed?.[0]?.reason ?? "not reached in time"}${read.rateLimited ? "; the site rate-limited the read" : ""}).`,
      );
    return undefined;
  }
  const rows = await ctx.db.select().from(contentPages).where(eq(contentPages.deploymentId, d.id));
  const known = new Map(rows.filter((r) => r.flags.length).map((r) => [normalizeUrl(r.url), r.flags]));
  const input = {
    entries: read.entries,
    served: servedFor(d),
    languages: source.languages,
    rules: planRules(source.plan),
    include: source.includePatterns,
    exclude: source.excludePatterns,
    budget: source.pageBudget ?? DEFAULT_PAGE_BUDGET,
    today: now,
    known,
    keyPages: keys,
  };
  const unusable = unusableKeys(rows);
  let { ranked } = rankPages({ ...input, unusable });
  // Key pages never loaded yet, checked as the plan checked them (a sniffer without /probe: not).
  if (keys && sniffer.probe) {
    const loaded = new Set(rows.map((r) => normalizeUrl(r.url)));
    for (let round = 0; round < 2; round++) {
      const fresh = ranked.filter((c) => c.keyPage && !loaded.has(normalizeUrl(c.entry.url)));
      if (!fresh.length) break;
      const probed = await sniffer.probe(fresh.map((c) => c.entry.url)).catch(() => []);
      for (const c of fresh) loaded.add(normalizeUrl(c.entry.url));
      const failing = probed.filter((p) => p.status >= 400 || p.blocked);
      if (!failing.length) break;
      for (const p of failing) unusable.add(normalizeUrl(p.url));
      ctx.log(
        `content sync for ${d.id}: ${failing.length} key pages didn't load (${failing.map((p) => `${p.url} ${p.status}`).join(", ")}); the next of each intent takes its place`,
      );
      ({ ranked } = rankPages({ ...input, unusable }));
    }
  }
  return { ranked, rows, complete: !incomplete };
}

async function startDueSyncs(ctx: JobContext, sniffer: Sniffer, now: Date) {
  const stale = new Date(now.getTime() - STALE_RUN_MS);
  // Syncs a person asked for (Sync now, new settings, Leave out): they read again every page read
  // under an older extractor or rules too. Scheduled re-syncs leave those to Bring up to date
  // overnight (2 deployments a run), so a version bump doesn't reload every deployment at once.
  const requested = new Set(
    (
      await ctx.db
        .select({ id: syncSources.id })
        .from(syncSources)
        .where(and(eq(syncSources.kind, "sitemap"), eq(syncSources.lastJobStatus, "queued")))
    ).map((r) => r.id),
  );
  // Claimed in one statement: requested ones, stalled ones, and those due a scheduled re-sync.
  const claimed = await ctx.db
    .update(syncSources)
    .set({ lastJobStatus: "running", startedAt: now, lastError: null })
    .where(
      and(
        eq(syncSources.kind, "sitemap"),
        sql`(${syncSources.lastJobStatus} = 'queued'
          or (${syncSources.lastJobStatus} = 'running' and ${syncSources.startedAt} < ${stale.toISOString()}
              and coalesce(${syncSources.lastError}, '') not like ${`%${REFUSAL_WORDS}%`})
          or (${syncSources.lastJobStatus} in ('ok', 'partial') and ${syncSources.resyncHours} is not null
              and ${syncSources.lastSyncedAt} < ${now.toISOString()}::timestamptz - make_interval(hours => ${syncSources.resyncHours})))`,
      ),
    )
    .returning();

  for (const source of claimed) {
    const [d] = await ctx.db.select().from(deployments).where(eq(deployments.id, source.deploymentId));
    try {
      if (!d?.kbId || !["live", "paused"].includes(d.status)) throw new Error("The deployment has no live Knowledge Box yet.");
      const budget = source.pageBudget ?? DEFAULT_PAGE_BUDGET;
      const keys = await keyPagesFor(ctx, d);
      const plan = await rankedPages(ctx, sniffer, source, d, now, keys);
      // Pages added by hand come first and don't count against the budget, unless a person left
      // the page out since (its exact path in Leave out: the marketer's 2016 post in round 4).
      const pinnedUrls = source.pinned.filter((url) => !source.excludePatterns.includes(new URL(url).pathname)).slice(0, MAX_PINNED);
      const pinned = new Set(pinnedUrls.map(normalizeUrl));
      let listed: { url: string; page?: RankedPage; intent: KeyIntent | null }[];
      let found: number;
      let discovery: "sitemap" | "crawl";
      let complete: boolean;
      if (plan) {
        const existing = new Map(plan.rows.map((r) => [normalizeUrl(r.url), r]));
        const byKey = new Map(plan.ranked.map((p) => [p.key, p]));
        listed = [
          ...pinnedUrls.map((url) => {
            const page = byKey.get(normalizeUrl(url));
            return { url, ...(page && { page }), intent: listedIntent(url, page, true, keys) };
          }),
          ...selectPages(plan.ranked, existing, budget, pinned).map((page) => ({
            url: page.entry.url,
            page,
            intent: listedIntent(page.entry.url, page, false, keys),
          })),
        ];
        found = plan.ranked.length;
        discovery = "sitemap";
        complete = plan.complete;
      } else {
        // No usable sitemap: the sniffer crawls from the start page instead.
        const crawl = await sniffer.listPages(discoveryFrom(source, d.siteUrl).site, {
          limit: budget,
          include: source.includePatterns,
          exclude: source.excludePatterns,
        });
        // No ranking: the crawled pages whose addresses name an intent, a few of each (capKeyIntents).
        listed = [
          ...pinnedUrls.map((url) => ({ url, intent: keys ? (intentOf(url) ?? null) : null })),
          ...capKeyIntents(
            crawl.urls
              .filter((url) => !pinned.has(normalizeUrl(url)))
              .map((url) => ({ url, intent: keys ? (intentOf(url) ?? null) : null })),
          ),
        ];
        found = crawl.total;
        discovery = crawl.discovery;
        complete =
          crawl.discovery === "sitemap" || listingComplete({ kind: "crawl", found: crawl.urls.length }, await answerable(ctx, d.id));
      }
      if (!listed.length) {
        throw new Error(
          plan
            ? "No pages left in the plan: its languages, paths and suggested exclusions leave out every page in the sitemaps."
            : "No pages found: the site has no sitemap, and its start page links to nothing within the path rules.",
        );
      }
      const byKey = new Map(listed.map((l) => [normalizeUrl(l.url), l]));
      const existing = plan?.rows ?? (await ctx.db.select().from(contentPages).where(eq(contentPages.deploymentId, d.id)));
      const known = new Map(existing.map((p) => [normalizeUrl(p.url), p]));
      // Pages synced in place of a listed duplicate stay with it.
      const replacements = new Set(
        existing.flatMap((p) => {
          const target = p.status === "skipped" && byKey.has(normalizeUrl(p.url)) ? duplicateOf(p.detail) : undefined;
          return target ? [normalizeUrl(target)] : [];
        }),
      );

      // Pages that left the site, or now fall outside the plan or the budget, leave the KB too; but
      // an incomplete listing (a sitemap file that failed, a crawl the site rate-limited) only takes
      // out the pages a person left out: "Sync now" never discards the pages it has.
      const gone = existing.filter(
        (p) =>
          p.status !== "removed" &&
          !byKey.has(normalizeUrl(p.url)) &&
          !replacements.has(normalizeUrl(p.url)) &&
          (complete || pathMatches(p.url, source.excludePatterns)),
      );
      if (!complete) ctx.log(`content sync for ${d.id}: the listing is incomplete, so pages it doesn't list stay as they are this time`);
      const kb = gone.some((p) => p.sentAt) ? await writerClient(ctx, d) : undefined;
      for (const page of gone) {
        if (page.sentAt) await kb?.deleteResourceBySlug(page.slug);
        // Not indexed any more: if it comes back, it's sent again.
        await ctx.db
          .update(contentPages)
          .set({
            status: "removed",
            detail: pathMatches(page.url, source.excludePatterns)
              ? LEFT_OUT_BY_YOU
              : "No longer listed within the plan and the page budget.",
            sentAt: null,
            indexedAt: null,
          })
          .where(eq(contentPages.id, page.id));
      }

      // New pages queue in ranking order (createdAt orders the queue), with the plan's date (the
      // sitemap's, unless bulk-stamped, else the address's) until their own is read.
      const fresh = [...byKey]
        .filter(([key]) => !known.has(key))
        .map(([, l], i) => ({
          deploymentId: d.id,
          url: l.url,
          slug: slugFor(l.url),
          lastModified: dayDate(l.page?.date),
          sitemapLastmod: dayDate(l.page?.entry.lastmod),
          keyIntent: l.intent,
          createdAt: new Date(now.getTime() + i),
        }));
      if (fresh.length) await ctx.db.insert(contentPages).values(fresh).onConflictDoNothing();
      // A page that became a key page, or stopped being one, is loaded again: its text gains or
      // loses the intent line.
      // A page loaded before is judged by its title too: a buying page titled for its prices is a
      // price page (keyIntentFor), as loading it decided.
      const intentChanged = new Map<string, KeyIntent | null>();
      for (const row of existing) {
        const l = byKey.get(normalizeUrl(row.url));
        const want = l ? (goneKeyPage(row) ? null : keyIntentFor(l.intent, row.title)) : undefined;
        if (l && (row.keyIntent ?? null) !== want) intentChanged.set(row.id, want ?? null);
      }
      for (const intent of [...KEY_INTENTS, null]) {
        const ids = [...intentChanged].filter(([, want]) => want === intent).map(([id]) => id);
        if (ids.length) await ctx.db.update(contentPages).set({ keyIntent: intent }).where(inArray(contentPages.id, ids));
      }
      // Every other listed page is checked again, except those whose lastmod says nothing changed
      // (they aren't even loaded; those read by an older extractor or rules wait for Bring up to
      // date overnight); pages still being processed (a sync restarted with new rules) are left to finish.
      const recheck: string[] = [];
      let kept = 0;
      let later = 0;
      for (const row of existing) {
        const l = byKey.get(normalizeUrl(row.url));
        if (!l || row.status === "processing") continue;
        // Pages synced before the sitemap's date was kept apart get it now, so comparing it
        // still works once their own dates replace lastModified.
        if (!row.sitemapLastmod && l.page?.entry.lastmod && sameDay(row.lastModified, l.page.entry.lastmod)) {
          row.sitemapLastmod = dayDate(l.page.entry.lastmod);
          await ctx.db.update(contentPages).set({ sitemapLastmod: row.sitemapLastmod }).where(eq(contentPages.id, row.id));
        }
        if (l.page && unchanged(l.page, row) && !intentChanged.has(row.id)) {
          kept += 1;
          continue;
        }
        if (
          l.page &&
          deferToNight(l.page, row, requested.has(source.id)) &&
          !pinned.has(normalizeUrl(row.url)) &&
          !intentChanged.has(row.id)
        ) {
          later += 1;
          continue;
        }
        recheck.push(row.id);
        const sitemapDay = dayDate(l.page?.entry.lastmod);
        if (sitemapDay && sitemapDay.getTime() !== row.sitemapLastmod?.getTime()) {
          // The sitemap's date stands for the page's only while the page states none of its own.
          const own = row.publishedAt || row.pageModifiedAt;
          await ctx.db
            .update(contentPages)
            .set({ sitemapLastmod: sitemapDay, ...(!own && { lastModified: dayDate(l.page?.date) }) })
            .where(eq(contentPages.id, row.id));
        }
      }
      if (recheck.length) await ctx.db.update(contentPages).set({ status: "queued" }).where(inArray(contentPages.id, recheck));

      await ctx.db.update(syncSources).set({ pagesFound: found, discovery }).where(eq(syncSources.id, source.id));
      ctx.log(
        `content sync started for ${d.id}: ${listed.length} of ${found} pages (${discovery})${kept ? `, ${kept} unchanged since the last sync` : ""}${later ? `, ${later} to read again tonight` : ""}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // "Sync failed" (and its alert) only when the chat has nothing answerable: otherwise the pages
      // it has are kept, the run counts as partial, and the next scheduled sync tries again.
      const kept = await answerable(ctx, source.deploymentId).catch(() => 0);
      await noteAccountBlock(ctx.db, err, "content sync");
      const outcome = startFailure(blockFree(err, message), kept, now);
      await ctx.db.update(syncSources).set(outcome).where(eq(syncSources.id, source.id));
      ctx.log(`content sync ${kept ? "couldn't run" : "failed to start"} for ${source.deploymentId}: ${message}`);
    }
  }
}

// Pages the chat answers from now (in the Knowledge Box, whatever is being read again).
async function answerable(ctx: JobContext, deploymentId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(contentPages)
    .where(and(eq(contentPages.deploymentId, deploymentId), isNotNull(contentPages.indexedAt), ne(contentPages.status, "removed")));
  return row?.n ?? 0;
}

// How a sync that couldn't start is recorded: failed (the alert) only when the chat has no
// answerable page; otherwise partial, its pages kept, with when it ran, so the next scheduled sync
// tries again rather than the next minute. Pure.
export function startFailure(
  message: string,
  answerablePages: number,
  now: Date,
): { lastJobStatus: "failed" | "partial"; lastError: string; lastSyncedAt?: Date } {
  if (!answerablePages) return { lastJobStatus: "failed", lastError: message };
  const n = answerablePages.toLocaleString("en");
  return {
    lastJobStatus: "partial",
    lastError: `${message} The ${n} answerable ${answerablePages === 1 ? "page is" : "pages are"} kept; the next sync tries again.`,
    lastSyncedAt: now,
  };
}

// The queue's order, best first: 0 pages a person added by hand, 1 first syncs, 2 re-syncs (and
// re-reads a partner asked for), 3 the nightly re-read. Shared with the console's estimate.
export const queueTier = sql<number>`case
  when ${contentPages.url} = any(${syncSources.pinned}) then 0
  when ${syncSources.lastSyncedAt} is null then 1
  when ${contentPages.detail} = ${REREAD.nightly} then 3
  else 2 end`;

// Hosts that rate-limited the sync lately: none of their pages is sent before `until` (the site's
// Retry-After, at least a minute), and then at most SLOW_PAGES a run for SLOW_MS (the sniffer paces
// the loads themselves: apps/sniffer/src/pace.ts). Kept by the worker process.
const SLOW_PAGES = 5;
const SLOW_MS = 15 * 60_000;
const limitedHosts = new Map<string, { until: number; slowUntil: number; pages?: number }>();
const hostOf = (url: string) => new URL(url).hostname.replace(/^www\./, "").toLowerCase();
function slowDown(url: string, retryAfterMs: number | undefined, now: Date) {
  const at = now.getTime();
  limitedHosts.set(hostOf(url), { until: at + Math.max(retryAfterMs ?? 0, 60_000) - 5_000, slowUntil: at + SLOW_MS });
}

// Hosts whose loads are being watched for a refusal (lib/site-refusal.ts), kept by the worker process
// like the pauses, and forgotten two hours after their last load.
const WATCH_MS = 2 * 60 * 60_000;
const loadWatches = new Map<string, LoadWatch>();

// After a run's loads: what each host's run says about it, by host.
function watchHosts(loads: readonly { url: string; refused: boolean; silent: boolean }[], now: number) {
  for (const [host, w] of loadWatches) if (now - w.at > WATCH_MS) loadWatches.delete(host);
  const steps = new Map<string, ReturnType<typeof refusalStep>>();
  for (const host of new Set(loads.map((l) => hostOf(l.url)))) {
    const mine = loads.filter((l) => hostOf(l.url) === host);
    const step = refusalStep(
      watchLoads(
        loadWatches.get(host),
        mine.map((l) => l.refused),
        now,
        mine.some((l) => l.silent),
      ),
      now,
    );
    loadWatches.set(host, step.watch);
    steps.set(host, step);
    // Until the pause ends, then a few pages a run. A person's Retry goes at this pace too, for as long.
    if (step.kind === "pause") limitedHosts.set(host, { until: step.until, slowUntil: step.until + SLOW_MS, pages: REFUSED_PAGES });
    if (step.kind === "stop") limitedHosts.set(host, { until: now + 5 * 60_000, slowUntil: now + 4 * SLOW_MS, pages: REFUSED_PAGES });
  }
  return steps;
}

// The pages a run sends, after the hosts' pauses: a host that rate-limited waits out its pause, then
// sends a few pages a run. Pure (now and the hosts passed in).
export function pacedSelection<T extends { page: { url: string } }>(
  waiting: readonly T[],
  limit: number,
  now: number,
  hosts: ReadonlyMap<string, { until: number; slowUntil: number; pages?: number }> = limitedHosts,
): T[] {
  const taken = new Map<string, number>();
  const out: T[] = [];
  for (const w of waiting) {
    if (out.length >= limit) break;
    const host = hostOf(w.page.url);
    const pace = hosts.get(host);
    if (pace && now < pace.until) continue;
    if (pace && now < pace.slowUntil && (taken.get(host) ?? 0) >= (pace.pages ?? SLOW_PAGES)) continue;
    taken.set(host, (taken.get(host) ?? 0) + 1);
    out.push(w);
  }
  return out;
}

async function sendWaitingPages(ctx: JobContext, sniffer: Sniffer, now: Date) {
  // While the account is blocked nothing can be sent: pages wait in the queue, as they are (a page in
  // the chat stays answerable from its copy), and go when it clears. They aren't marked failed.
  if (await accountBlock(ctx.db).catch(() => undefined)) return;
  // Within each tier, deployments take turns a page at a time (each in the order its pages were
  // listed), so three onboardings at once all get answerable pages within minutes. Hosts that
  // rate-limited lately send fewer (pacedSelection).
  const candidates = await ctx.db
    .select({ page: contentPages, deployment: deployments, source: syncSources })
    .from(contentPages)
    .innerJoin(deployments, eq(deployments.id, contentPages.deploymentId))
    .innerJoin(syncSources, and(eq(syncSources.deploymentId, contentPages.deploymentId), eq(syncSources.kind, "sitemap")))
    .where(and(eq(contentPages.status, "queued"), eq(syncSources.lastJobStatus, "running")))
    .orderBy(
      queueTier,
      sql`row_number() over (partition by ${contentPages.deploymentId}, ${queueTier} order by ${contentPages.createdAt}, ${contentPages.id})`,
      contentPages.createdAt,
    )
    .limit(PAGES_PER_RUN * 3);
  for (const [host, pace] of limitedHosts) if (now.getTime() >= pace.slowUntil) limitedHosts.delete(host);
  const waiting = pacedSelection(candidates, PAGES_PER_RUN, now.getTime());
  if (!waiting.length) return;

  const clients = new Map<string, KbClient | undefined>();
  const listedBy = new Map<string, Set<string>>();
  // Per deployment: whether key, FAQ, help and support pages are spared the age rule.
  const keysBy = new Map<string, boolean>();
  // The batches load side by side (the sniffer's sync lane takes three at once): the worker's
  // pace is the floor under every first sync's time.
  const batches = Array.from({ length: Math.ceil(waiting.length / FETCH_BATCH) }, (_, i) =>
    waiting.slice(i * FETCH_BATCH, (i + 1) * FETCH_BATCH),
  );
  // Every batch is loaded first, so the chrome check (lib/content-plan.ts chromeLines) sees the
  // pages read this run as well as those sent before: a first sync's first pages lose their footer
  // too.
  const fetchedAll = await Promise.all(batches.map((batch) => sniffer.fetchPages(batch.map((w) => w.page.url))));
  const steps = watchHosts(
    batches.flatMap((batch, b) =>
      batch.flatMap((w, n) => {
        const loaded = fetchedAll[b]![n]!;
        return loaded.rateLimited ? [] : [{ url: w.page.url, refused: refusedLoad(loaded), silent: notTried(loaded.error) }];
      }),
    ),
    now.getTime(),
  );
  const chromeBy = new Map<string, Set<string>>();
  for (const id of new Set(waiting.map((w) => w.page.deploymentId))) {
    const fresh = batches.flatMap((batch, b) =>
      batch.flatMap((w, n) => {
        const loaded = fetchedAll[b]![n]!;
        return w.page.deploymentId === id && !loaded.error ? [{ url: w.page.url, text: loaded.markdown }] : [];
      }),
    );
    const freshKeys = new Set(fresh.map((f) => normalizeUrl(f.url)));
    const stored = await ctx.db
      .select({ url: contentPages.url, text: contentPages.text })
      .from(contentPages)
      .where(and(eq(contentPages.deploymentId, id), inArray(contentPages.status, ["indexed", "processing"]), isNotNull(contentPages.text)))
      .limit(400);
    chromeBy.set(
      id,
      chromeLines([...stored.filter((r) => !freshKeys.has(normalizeUrl(r.url))).map((r) => ({ url: r.url, text: r.text! })), ...fresh]),
    );
  }
  // Each deployment's Leave out as it is now, after the loads: a person may have added to it.
  const excludeNow = new Map(
    (
      await ctx.db
        .select({ deploymentId: syncSources.deploymentId, exclude: syncSources.excludePatterns })
        .from(syncSources)
        .where(
          and(eq(syncSources.kind, "sitemap"), inArray(syncSources.deploymentId, [...new Set(waiting.map((w) => w.page.deploymentId))])),
        )
    ).map((r) => [r.deploymentId, r.exclude]),
  );
  const sendBatch = async (batch: typeof waiting, fetched: SitePage[]) => {
    // Leave out (or new settings) may have taken pages out while they loaded: those are skipped,
    // and a page whose address a person left out meanwhile leaves now, with that reason.
    const current = await ctx.db
      .select({ id: contentPages.id, status: contentPages.status })
      .from(contentPages)
      .where(
        inArray(
          contentPages.id,
          batch.map((w) => w.page.id),
        ),
      );
    const statusNow = new Map(current.map((r) => [r.id, r.status]));
    for (const [n, { page, deployment: d, source }] of batch.entries()) {
      const id = page.deploymentId;
      if (statusNow.get(page.id) !== "queued") continue;
      const exclude = excludeNow.get(id) ?? source.excludePatterns;
      if (leftOutMeanwhile(page.url, exclude, source.pinned)) {
        await ctx.db.update(contentPages).set({ status: "removed", detail: LEFT_OUT_BY_YOU }).where(stillWaiting(page.id));
        continue;
      }
      // The site rate-limited it, even after the sniffer's pauses: tried again on a later run, more
      // slowly, never a final failure on the first 429; a page in the chat keeps its copy.
      const got = fetched[n]!;
      if (got.rateLimited || got.status === 429) {
        const next = rateLimitedOutcome(page, got.status);
        await ctx.db.update(contentPages).set({ status: next.status, detail: next.detail }).where(stillWaiting(page.id));
        slowDown(page.url, got.retryAfterMs, now);
        continue;
      }
      // The site is refusing and paused: the page waits for the next try, as it is.
      if (steps.get(hostOf(page.url))?.kind === "pause" && refusedLoad(got)) continue;
      if (!clients.has(id)) clients.set(id, await writerClient(ctx, d));
      if (!listedBy.has(id)) {
        const rows = await ctx.db
          .select({ url: contentPages.url })
          .from(contentPages)
          .where(and(eq(contentPages.deploymentId, id), ne(contentPages.status, "removed")));
        listedBy.set(id, new Set(rows.map((r) => normalizeUrl(r.url))));
      }
      // Without the site's chrome lines, except on the key pages they're about.
      const loaded = withoutChrome(
        fetched[n]!,
        chromeBy.get(id)!,
        isKeyIntent(page.keyIntent) ? keyIntentFor(page.keyIntent, fetched[n]!.title) : null,
      );
      const served = servedLanguages(source.languages, d.language);
      // By what the page says, once loaded: not a welfare fund as support.
      const pageIntent = isKeyIntent(page.keyIntent)
        ? loaded.error
          ? page.keyIntent
          : keyIntentOfPage(page.keyIntent, loaded.title, loaded.markdown)
        : null;
      // Pages synced before dates were kept have none: the address's stands in.
      const facts = pageFacts(loaded, knownDate(page.lastModified, now) ?? dayDate(urlDate(page.url, now)), now);
      if (!keysBy.has(id)) keysBy.set(id, await keyPagesFor(ctx, d));
      const flags = loaded.error ? (page.flags as PageFlag[]) : pageFlags(facts, { served, today: now, keyPages: keysBy.get(id)! });
      const sync: SyncRules = {
        rules: planRules(source.plan),
        served,
        spare: source.discovery === "sitemap" && (source.pagesFound ?? 0) > (source.pageBudget ?? DEFAULT_PAGE_BUDGET),
        pinned: source.pinned.includes(page.url),
        kept: (source.kept ?? []).some((k) => pageKey(k.url) === pageKey(page.url)),
        // A key page titled for its prices is a price page, with the price line.
        ...(pageIntent && { intent: pageIntent }),
        today: now,
      };
      // What it states (prices, contacts, links, events) and its labels, with its dates placed.
      const read = loaded.error ? undefined : readPage(loaded, facts, sync.intent, now);
      let verdict = pageVerdict(loaded, listedBy.get(id)!, sync, flags, facts, read);
      // What loading learnt about the page: its dates (the best one as lastModified), language,
      // flags, what it states, and the extractor and rules that read it.
      const best = loaded.error ? undefined : pageDate(facts)?.date;
      const known = loaded.error
        ? { flags }
        : {
            lastModified: best ?? page.lastModified,
            publishedAt: facts.published ?? null,
            pageModifiedAt: facts.modified ?? null,
            lang: facts.lang ?? null,
            flags,
            facts: read?.facts ?? {},
            // The sniffer's extractor, with what the sync does to its text since (EXTRACTOR_VERSION).
            extractorVersion: (loaded.extractor ?? 0) >= SNIFFER_EXTRACTOR ? EXTRACTOR_VERSION : (loaded.extractor ?? 0),
            rulesVersion: RULES_VERSION,
            ...(sync.intent && { keyIntent: sync.intent }),
            ...(isKeyIntent(page.keyIntent) && !pageIntent && { keyIntent: null }),
            // A page that isn't there is never a key page, unless it was in the chat before.
            ...(!verdict.send &&
              goneKeyPage({ detail: verdict.detail, indexedAt: page.indexedAt }) && {
                keyIntent: null,
              }),
          };
      // Reading an answerable page under a newer extractor or rules keeps it answerable: it says
      // why the current rules would leave it out, until Bring up to date applies it (or asked for
      // this read to), and a page that didn't load stays as it was, to be read again.
      let held: string | undefined;
      const wasHeld = page.detail?.startsWith(WOULD_LEAVE_OUT) ?? false;
      const hold = page.indexedAt && page.contentHash && page.detail !== REREAD.apply && (!currentVersions(page) || wasHeld);
      if (hold && !verdict.send) {
        if (verdict.status === "failed") {
          await ctx.db.update(contentPages).set({ status: "indexed", detail: null }).where(stillWaiting(page.id));
          continue;
        }
        held = `${WOULD_LEAVE_OUT}${verdict.detail}`;
        const kept = pageVerdict(loaded, listedBy.get(id)!, { ...sync, pinned: true, kept: true }, flags, facts, read);
        if (!kept.send) {
          await ctx.db
            .update(contentPages)
            .set({ status: "indexed", detail: held, ...known })
            .where(stillWaiting(page.id));
          continue;
        }
        verdict = kept;
      }
      try {
        if (!verdict.send) {
          if (page.sentAt) await clients.get(id)?.deleteResourceBySlug(page.slug);
          await ctx.db
            .update(contentPages)
            .set({ status: verdict.status, detail: verdict.detail, sentAt: null, indexedAt: null, ...known })
            .where(stillWaiting(page.id));
          // The page a duplicate points at takes its place, when the plan's paths allow it.
          if (verdict.canonical) {
            const key = normalizeUrl(verdict.canonical);
            if (!listedBy.get(id)!.has(key) && withinRules(verdict.canonical, source.includePatterns, source.excludePatterns)) {
              await ctx.db
                .insert(contentPages)
                .values({ deploymentId: id, url: verdict.canonical, slug: slugFor(verdict.canonical), createdAt: now })
                .onConflictDoUpdate({ target: [contentPages.deploymentId, contentPages.url], set: { status: "queued", detail: null } });
              listedBy.get(id)!.add(key);
            }
          }
          continue;
        }
        // Unchanged since it was last indexed: nothing to send.
        if (verdict.hash === page.contentHash && page.indexedAt) {
          await ctx.db
            .update(contentPages)
            .set({ status: "indexed", detail: held ?? null, title: verdict.title, ...known })
            .where(stillWaiting(page.id));
          continue;
        }
        const kb = clients.get(id);
        if (!kb) throw new Error("The deployment has no writer key.");
        const put = await kb.putTextResource({
          slug: page.slug,
          title: verdict.title,
          originUrl: page.url,
          body: verdict.body,
          labels: verdict.labels.map((label) => ({ labelset: PAGE_LABELSET, label })),
          ...(verdict.metadata && { metadata: verdict.metadata }),
        });
        if (!put.labelled) ctx.log(`content: Agentic RAG refused the labels of ${page.url}; sent without them`);
        const sent = await ctx.db
          .update(contentPages)
          .set({
            status: "processing",
            detail: held ?? null,
            title: verdict.title,
            words: verdict.words,
            contentHash: verdict.hash,
            text: verdict.body,
            sentAt: new Date(),
            // A page already in the chat stays answerable from its indexed copy while Agentic RAG
            // processes the new text (lib/content.ts counts it as answerable meanwhile); a new one
            // isn't until it's processed.
            ...(!page.indexedAt && { indexedAt: null }),
            ...known,
            ...(put.uuid && { resourceId: put.uuid }),
          })
          .where(stillWaiting(page.id))
          .returning({ id: contentPages.id });
        // Taken out while it was sent: it leaves the Knowledge Box again at once.
        if (!sent.length) await kb.deleteResourceBySlug(page.slug);
      } catch (err) {
        // The account blocked: the page stays queued, sent again after the block.
        if (await noteAccountBlock(ctx.db, err, "content sync")) continue;
        const message = err instanceof Error ? err.message : String(err);
        ctx.log(`couldn't send ${page.url}: ${message}`);
        await ctx.db
          .update(contentPages)
          .set({ status: "failed", detail: `Couldn't send it to the Knowledge Box: ${sendProblem(err)}`, flags })
          .where(stillWaiting(page.id));
      }
    }
  };
  await Promise.all(batches.map((batch, i) => sendBatch(batch, fetchedAll[i]!)));
  await recordRefusals(ctx, waiting, steps);
  ctx.log(`content sync sent or checked ${waiting.length} pages`);
}

// What a run's watch found, per sync on a refusing host: the sentence, and its pages. Paused, the
// pages that failed for no answer earlier in this sync wait with the others for the slower tries;
// stopped, every page still waiting fails with the reason (a page in the chat keeps its copy).
async function recordRefusals(
  ctx: JobContext,
  waiting: readonly { page: { url: string; deploymentId: string }; source: { id: string; lastError: string | null } }[],
  steps: ReadonlyMap<string, ReturnType<typeof refusalStep>>,
) {
  const sources = new Map(waiting.map((w) => [w.source.id, w]));
  for (const { page, source } of sources.values()) {
    const site = new URL(page.url);
    const step = steps.get(hostOf(page.url));
    if (!step || step.kind === "none" || (step.kind === "slow" && !isRefusalNote(source.lastError))) continue;
    const mine = and(eq(contentPages.deploymentId, page.deploymentId), like(contentPages.url, `%//${site.host}/%`));
    if (step.kind === "pause") {
      await ctx.db
        .update(contentPages)
        .set({ status: "queued", detail: null })
        .where(and(mine, eq(contentPages.status, "failed"), sql`${contentPages.detail} ~ ${NO_ANSWER_SQL}`));
    } else if (step.kind === "stop") {
      await ctx.db
        .update(contentPages)
        .set({ status: "indexed", detail: null })
        .where(and(mine, eq(contentPages.status, "queued"), isNotNull(contentPages.indexedAt), isNotNull(contentPages.contentHash)));
      await ctx.db
        .update(contentPages)
        .set({ status: "failed", detail: `Didn't load: ${NOT_READ}` })
        .where(and(mine, eq(contentPages.status, "queued")));
    }
    const note = refusalNote(site.hostname, step.watch.loaded, step);
    if (note === source.lastError) continue;
    await ctx.db.update(syncSources).set({ lastError: note }).where(eq(syncSources.id, source.id));
    ctx.log(`content sync for ${page.deploymentId}: ${note}`);
  }
}

// What a person reads when a page couldn't be sent: no raw request, no ids. Pure.
export const sendProblem = (err: unknown): string => {
  const r = refusalOf(err);
  if (r.kind === "server") return "Agentic RAG reported a server error.";
  if (r.kind === "timeout") return "Agentic RAG didn't answer in time.";
  if (r.kind === "unreachable") return "Agentic RAG couldn't be reached.";
  if (r.kind === "block") return blockSentence(r.state);
  return err instanceof ParError ? `Agentic RAG refused it (status ${err.status}).` : "Something went wrong sending it.";
};
const blockFree = (err: unknown, message: string): string => {
  const state = accountBlockState(err);
  return state ? blockSentence(state) : message;
};

// A stored hash no text has: the page is sent again, and still counts as having a copy in the chat.
const RESEND = "resend-after-block";

export const PROCESS_FAILED = "Agentic RAG couldn't process the page's text.";

// Whether a failed page failed because of a block, so it goes back in the queue when it clears: a send
// the block refused (its detail says so, from before pages waited in the queue), or a page Agentic RAG
// failed to process during the block's window. Pure.
export function failedInBlock(page: { detail: string | null; updatedAt: Date }, window: { from: Date; to: Date } | undefined): boolean {
  const detail = page.detail ?? "";
  if (
    detail.startsWith("Couldn't send it to the Knowledge Box") &&
    (/\b402\b/.test(detail) || /AccountBlockingState|has stopped answering/.test(detail))
  )
    return true;
  return Boolean(detail === PROCESS_FAILED && window && page.updatedAt >= window.from && page.updatedAt <= window.to);
}

// After a block: the pages it failed, queued again. Nothing to do while one stands; it finds nothing
// the next time, so it can run with each sync.
async function requeueAfterBlock(ctx: JobContext, now: Date) {
  const entries = await ctx.db
    .select({ action: auditLog.action, at: auditLog.at })
    .from(auditLog)
    .where(and(eq(auditLog.targetType, "account"), inArray(auditLog.action, [BLOCKED, UNBLOCKED])))
    .orderBy(desc(auditLog.at))
    .limit(2);
  if (entries[0]?.action === BLOCKED) return;
  // Processing failures can come a little before the first refusal names the block.
  const window =
    entries[0] && entries[1]?.action === BLOCKED ? { from: new Date(entries[1].at.getTime() - 10 * 60_000), to: entries[0].at } : undefined;
  const failed = await ctx.db
    .select({ id: contentPages.id, detail: contentPages.detail, updatedAt: contentPages.updatedAt })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.status, "failed"),
        or(like(contentPages.detail, "Couldn't send it to the Knowledge Box%"), eq(contentPages.detail, PROCESS_FAILED)),
      ),
    );
  const ids = failed.filter((p) => failedInBlock(p, window)).map((p) => p.id);
  if (!ids.length) return;
  await ctx.db.update(contentPages).set({ status: "queued", detail: null, contentHash: RESEND }).where(inArray(contentPages.id, ids));
  ctx.log(`content sync: ${ids.length} pages that failed during an account block queued again (${now.toISOString()})`);
}

// A page that states events, now in the chat: the events list has it to add (recheck 8b: a first sync
// finishes with most pages still processing, so its list said "none is dated today or later"). Pure.
export const addsToEventsList = (page: { facts?: { events?: readonly unknown[] } | null }): boolean => Boolean(page.facts?.events?.length);

async function checkProcessing(ctx: JobContext, now: Date) {
  const processing = await ctx.db
    .select({ page: contentPages, zone: deployments.zone, kbId: deployments.kbId })
    .from(contentPages)
    .innerJoin(deployments, eq(deployments.id, contentPages.deploymentId))
    .innerJoin(syncSources, and(eq(syncSources.deploymentId, contentPages.deploymentId), eq(syncSources.kind, "sitemap")))
    .where(eq(contentPages.status, "processing"))
    // Pages added by hand first, so the question waiting on them is asked again soonest; then the
    // longest waiting.
    .orderBy(sql`case when ${contentPages.url} = any(${syncSources.pinned}) then 0 else 1 end`, contentPages.sentAt)
    .limit(200);
  const clients = new Map<string, KbClient | undefined>();
  const eventsChanged = new Set<string>();
  for (const { page, zone, kbId } of processing) {
    const id = page.deploymentId;
    if (!clients.has(id)) clients.set(id, await writerClient(ctx, { id, zone, kbId }));
    try {
      const status = (await clients.get(id)?.getResourceBySlug(page.slug))?.metadata?.status;
      if (status === "PROCESSED") {
        await ctx.db.update(contentPages).set({ status: "indexed", indexedAt: now }).where(eq(contentPages.id, page.id));
        if (addsToEventsList(page)) eventsChanged.add(id);
      } else if (status === "ERROR") {
        // During a block processing fails too: the page goes back in the queue instead.
        const blocked = await accountBlock(ctx.db).catch(() => undefined);
        await ctx.db
          .update(contentPages)
          .set(blocked ? { status: "queued", detail: null, contentHash: RESEND } : { status: "failed", detail: PROCESS_FAILED })
          .where(eq(contentPages.id, page.id));
      } else if (page.sentAt && now.getTime() - page.sentAt.getTime() > PROCESSING_LIMIT_MS) {
        await ctx.db
          .update(contentPages)
          .set({ status: "failed", detail: "Still processing two hours after it was sent." })
          .where(eq(contentPages.id, page.id));
      }
    } catch (err) {
      await noteAccountBlock(ctx.db, err, "content sync");
      ctx.log(`status check failed for ${page.url}: ${err instanceof Error ? err.message : err}`);
    }
  }
  for (const id of eventsChanged) await refreshEventsList(ctx, id, now);
}

// Pages left out while their text was in the KB (Bring up to date's Apply marks them in the
// console, which holds no writer key) leave the KB here.
async function retractLeftOut(ctx: JobContext) {
  const left = await ctx.db
    .select({ page: contentPages, zone: deployments.zone, kbId: deployments.kbId })
    .from(contentPages)
    .innerJoin(deployments, eq(deployments.id, contentPages.deploymentId))
    .where(and(inArray(contentPages.status, ["skipped", "removed"]), isNotNull(contentPages.sentAt)))
    .limit(100);
  const clients = new Map<string, KbClient | undefined>();
  for (const { page, zone, kbId } of left) {
    const id = page.deploymentId;
    if (!clients.has(id)) clients.set(id, await writerClient(ctx, { id, zone, kbId }));
    try {
      await clients.get(id)?.deleteResourceBySlug(page.slug);
      await ctx.db.update(contentPages).set({ sentAt: null, indexedAt: null }).where(eq(contentPages.id, page.id));
    } catch (err) {
      ctx.log(`couldn't take ${page.url} out of the KB: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ---- pages a person left out that are still in the chat ----

// Pages whose address is in Leave out (or that a person left out on Content) but are still in the
// chat or the sync: before Leave out took a page out at once, a page added by hand and then left
// out stayed answerable (round 5: a 2016 price stayed live for hours while Content, Review and
// Bring up to date said it was out). A page added by hand stays only when a broader pattern, not
// its own path, covers it (leftOutMeanwhile). Pure.
export function stillLeftIn(
  rows: readonly { url: string; status: string; detail: string | null; sentAt: Date | null }[],
  exclude: readonly string[],
  pinned: readonly string[],
): string[] {
  return rows
    .filter(
      (r) =>
        ["queued", "processing", "indexed", "failed"].includes(r.status) &&
        (leftOutMeanwhile(r.url, exclude, pinned) || (r.detail === LEFT_OUT_BY_YOU && r.status !== "queued")),
    )
    .map((r) => r.url);
}

// The alert for pages taken out of the chat on an upgrade: one per deployment, naming them. Pure.
export function retractedAlert(
  d: { id: string; name: string; tenantId: string; tenantName: string },
  urls: readonly string[],
  base: string,
): { key: string; message: { subject: string; text: string; link?: string } } {
  const paths = urls.map((u) => {
    try {
      return new URL(u).pathname;
    } catch {
      return u;
    }
  });
  const shown = paths.slice(0, 10).join(", ");
  return {
    key: `retracted:${d.id}:${[...paths].sort().join("|").slice(0, 400)}`,
    message: {
      subject: `${alertWhere(d.tenantName, d.name)}: ${urls.length === 1 ? "a page left out by hand was" : `${urls.length} pages left out by hand were`} still in the chat, and ${urls.length === 1 ? "is" : "are"} out now`,
      text: `Left out earlier, but still answering: ${shown}${paths.length > 10 ? `, and ${paths.length - 10} more` : ""}. They leave the Knowledge Box within a minute; questions only they answered get the no-answer reply from then on. Content lists them as "Left out by you".`,
      ...(base && { link: `${base}/customers/${d.tenantId}/deployments/${d.id}/content?status=removed` }),
    },
  };
}

// Once per deployment per worker process (so the first runs after an upgrade sweep every
// deployment, a few a run): pages a person left out that are still in the chat or the sync are
// taken out (retractLeftOut then deletes them from the Knowledge Box), no longer added by hand,
// audited, and alerted once.
const sweptForLeftOut = new Set<string>();
export async function retractExcluded(ctx: JobContext, now = new Date(), perRun = 5): Promise<number> {
  const sources = await ctx.db
    .select({
      id: syncSources.id,
      deploymentId: syncSources.deploymentId,
      exclude: syncSources.excludePatterns,
      pinned: syncSources.pinned,
      kept: syncSources.kept,
      name: deployments.name,
      tenantId: deployments.tenantId,
      tenantName: tenants.name,
    })
    .from(syncSources)
    .innerJoin(deployments, eq(deployments.id, syncSources.deploymentId))
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .where(eq(syncSources.kind, "sitemap"));
  let taken = 0;
  for (const s of sources.filter((x) => !sweptForLeftOut.has(x.deploymentId)).slice(0, perRun)) {
    sweptForLeftOut.add(s.deploymentId);
    const rows = await ctx.db
      .select({
        id: contentPages.id,
        url: contentPages.url,
        status: contentPages.status,
        detail: contentPages.detail,
        sentAt: contentPages.sentAt,
      })
      .from(contentPages)
      .where(
        and(eq(contentPages.deploymentId, s.deploymentId), inArray(contentPages.status, ["queued", "processing", "indexed", "failed"])),
      );
    const urls = stillLeftIn(rows, s.exclude, s.pinned);
    if (!urls.length) continue;
    const ids = rows.filter((r) => urls.includes(r.url)).map((r) => r.id);
    await ctx.db.update(contentPages).set({ status: "removed", detail: LEFT_OUT_BY_YOU }).where(inArray(contentPages.id, ids));
    // As Leave out does now: a page left out by its own path is no longer added by hand or kept.
    const own = new Set(s.exclude);
    const pinned = s.pinned.filter((u) => !own.has(new URL(u).pathname));
    const kept = s.kept.filter((k) => !own.has(new URL(k.url).pathname));
    if (pinned.length < s.pinned.length || kept.length < s.kept.length) {
      await ctx.db.update(syncSources).set({ pinned, kept }).where(eq(syncSources.id, s.id));
    }
    await ctx.db.insert(auditLog).values({
      actorUserId: null,
      action: "content.retracted",
      targetType: "deployment",
      targetId: s.deploymentId,
      detail: { pages: urls, auto: "upgrade" },
    });
    await postAlert(
      ctx,
      retractedAlert(
        { id: s.deploymentId, name: s.name, tenantId: s.tenantId, tenantName: s.tenantName },
        urls,
        (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
      ),
    ).catch((err) => ctx.log(`alert for pages taken out of ${s.deploymentId} failed: ${err instanceof Error ? err.message : err}`));
    ctx.log(
      `content: ${urls.length} pages left out by hand were still in the chat for ${s.deploymentId}; taken out (${now.toISOString()})`,
    );
    taken += urls.length;
  }
  return taken;
}

// ---- Bring up to date's Add, as it turned out ----

// What Add's sync actually changed: the pages in the chat now that weren't before Add (key pages
// apart), and those that were and aren't. before: the pages in the sync when Add was clicked
// (lib/content.ts addKeyPages). Pure.
export function keyPagesOutcome(
  before: readonly string[],
  rows: readonly { url: string; status: string; keyIntent: string | null; indexedAt?: Date | null }[],
): { added: string[]; joined: string[]; dropped: string[] } {
  const was = new Set(before.map(normalizeUrl));
  const inChat = rows.filter((r) => r.status === "indexed" || r.status === "processing" || (r.status === "failed" && r.indexedAt));
  const now = new Set(inChat.map((r) => normalizeUrl(r.url)));
  const joining = inChat.filter((r) => !was.has(normalizeUrl(r.url)));
  return {
    added: joining.filter((r) => isKeyIntent(r.keyIntent)).map((r) => r.url),
    joined: joining.filter((r) => !isKeyIntent(r.keyIntent)).map((r) => r.url),
    dropped: before.filter((u) => !now.has(normalizeUrl(u))),
  };
}

// Once Add's sync has finished, its History line says what actually joined and left: the entry's
// added, joined and dropped become the outcome, with what Add previewed kept as proposed. An
// entry from before Add recorded what was in the sync keeps its preview, marked settled.
async function settleKeyPages(ctx: JobContext, deploymentId: string, startedAt: Date | null, now: Date) {
  const entries = await ctx.db
    .select({ id: auditLog.id, at: auditLog.at, detail: auditLog.detail })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetType, "deployment"),
        eq(auditLog.targetId, deploymentId),
        eq(auditLog.action, "content.key-pages"),
        sql`(${auditLog.detail}->>'settled') is null`,
      ),
    );
  // Only entries this sync followed: an Add clicked after it started has a sync of its own.
  const due = entries.filter((e) => !startedAt || e.at <= startedAt);
  if (!due.length) return;
  const rows = await ctx.db
    .select({ url: contentPages.url, status: contentPages.status, keyIntent: contentPages.keyIntent, indexedAt: contentPages.indexedAt })
    .from(contentPages)
    .where(eq(contentPages.deploymentId, deploymentId));
  for (const e of due) {
    const detail = (e.detail ?? {}) as Record<string, unknown>;
    const before = Array.isArray(detail.before) ? detail.before.filter((u): u is string => typeof u === "string") : undefined;
    const outcome = before ? keyPagesOutcome(before, rows) : undefined;
    const { before: _before, ...rest } = detail;
    await ctx.db
      .update(auditLog)
      .set({
        detail: {
          ...rest,
          ...(outcome && { proposed: { added: detail.added, joined: detail.joined, dropped: detail.dropped }, ...outcome }),
          settled: now.toISOString(),
        },
      })
      .where(eq(auditLog.id, e.id));
  }
}

// The sync's tail: pages taken in place of left-out ones. Once TAIL_STOP of them in a row are
// left out too (mostly hub pages: the plan ranks undated folders last), the sync is finished.
// telerik.com's first sync spent 13 minutes loading one /webinars hub after another.
export const TAIL_STOP = 5;

// Replacements left out in a row, after the latest ones' outcomes, in the order they were queued.
export function tailStreak(streak: number, outcomes: readonly (string | undefined)[]): number {
  let n = streak;
  for (const status of outcomes) n = status === "skipped" ? n + 1 : 0;
  return n;
}

// Per running sync (source and start): the replacements last queued, and the streak before them.
// In memory: a restarted worker counts again from 0, at most TAIL_STOP more pages.
const tails = new Map<string, { startedAt: number; urls: string[]; streak: number }>();

// Pages that loading left out (duplicates, conversion pages, other languages, overviews, pages
// whose own date fails the date rules) don't use up the budget: the next pages in the ranking
// take their places, until TAIL_STOP replacements in a row are left out too. Pages added by hand
// don't count either. Returns how many joined, and whether the tail stopped.
async function topUp(ctx: JobContext, sniffer: Sniffer, source: Source, now: Date): Promise<{ added: number; stopped?: number }> {
  const budget = source.pageBudget ?? DEFAULT_PAGE_BUDGET;
  const [counts] = await ctx.db
    .select({ taken: sql<number>`count(*)`.mapWith(Number) })
    .from(contentPages)
    .where(
      and(
        eq(contentPages.deploymentId, source.deploymentId),
        inArray(contentPages.status, ["queued", "processing", "indexed", "failed"]),
        source.pinned.length ? notInArray(contentPages.url, source.pinned) : undefined,
      ),
    );
  const deficit = budget - (counts?.taken ?? 0);
  if (source.discovery !== "sitemap" || deficit <= 0 || (source.pagesFound ?? 0) <= (counts?.taken ?? 0)) return { added: 0 };
  const run = source.startedAt?.getTime() ?? 0;
  const tail = tails.get(source.id);
  let streak = tail?.startedAt === run ? tail.streak : 0;
  if (tail?.startedAt === run && tail.urls.length) {
    const rows = await ctx.db
      .select({ url: contentPages.url, status: contentPages.status })
      .from(contentPages)
      .where(and(eq(contentPages.deploymentId, source.deploymentId), inArray(contentPages.url, tail.urls)));
    const status = new Map(rows.map((r) => [r.url, r.status]));
    streak = tailStreak(
      streak,
      tail.urls.map((u) => status.get(u)),
    );
  }
  if (streak >= TAIL_STOP) return { added: 0, stopped: streak };
  const [d] = await ctx.db.select().from(deployments).where(eq(deployments.id, source.deploymentId));
  if (!d) return { added: 0 };
  const keys = await keyPagesFor(ctx, d);
  const plan = await rankedPages(ctx, sniffer, source, d, now, keys);
  if (!plan) return { added: 0 };
  const rows = new Map(plan.rows.map((r) => [normalizeUrl(r.url), r]));
  const pinned = new Set(source.pinned.map(normalizeUrl));
  const next = plan.ranked
    .filter((p) => !pinned.has(p.key) && (!rows.has(p.key) || rows.get(p.key)!.status === "removed"))
    .slice(0, deficit);
  for (const [i, page] of next.entries()) {
    const values = {
      lastModified: dayDate(page.date),
      sitemapLastmod: dayDate(page.entry.lastmod),
      keyIntent: listedIntent(page.entry.url, page, false, keys),
      createdAt: new Date(now.getTime() + i),
    };
    await ctx.db
      .insert(contentPages)
      .values({ deploymentId: d.id, url: page.entry.url, slug: slugFor(page.entry.url), ...values })
      .onConflictDoUpdate({ target: [contentPages.deploymentId, contentPages.url], set: { status: "queued", detail: null, ...values } });
  }
  tails.set(source.id, { startedAt: run, urls: next.map((p) => p.entry.url), streak });
  return { added: next.length };
}

// A sync is done once every page has been sent or left out, and the budget is topped up.
// Pages still being processed are shown as such; they don't hold the sync open.
async function finishSyncs(ctx: JobContext, sniffer: Sniffer, now: Date) {
  const running = await ctx.db
    .select()
    .from(syncSources)
    .where(and(eq(syncSources.kind, "sitemap"), eq(syncSources.lastJobStatus, "running")));
  for (const source of running) {
    const [counts] = await ctx.db
      .select({
        waiting: sql<number>`count(*) filter (where ${contentPages.status} = 'queued')`.mapWith(Number),
        failed: sql<number>`count(*) filter (where ${contentPages.status} = 'failed')`.mapWith(Number),
        noAnswer:
          sql<number>`count(*) filter (where ${contentPages.status} = 'failed' and ${contentPages.detail} ~ ${NO_ANSWER_SQL})`.mapWith(
            Number,
          ),
      })
      .from(contentPages)
      .where(
        and(
          eq(contentPages.deploymentId, source.deploymentId),
          source.startedAt ? gte(contentPages.updatedAt, source.startedAt) : isNull(contentPages.id),
        ),
      );
    const [left] = await ctx.db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(contentPages)
      .where(and(eq(contentPages.deploymentId, source.deploymentId), eq(contentPages.status, "queued")));
    if (left?.n) continue;
    try {
      const { added, stopped } = await topUp(ctx, sniffer, source, now);
      if (added) {
        ctx.log(`content sync for ${source.deploymentId}: ${added} more pages fill the budget`);
        continue;
      }
      if (stopped)
        ctx.log(`content sync for ${source.deploymentId}: ${stopped} replacements in a row were left out too, so it stops there`);
    } catch (err) {
      ctx.log(`content sync top-up failed for ${source.deploymentId}: ${err instanceof Error ? err.message : err}`);
    }
    // Still running: the partner may have just saved new rules, which start it over.
    const [finished] = await ctx.db
      .update(syncSources)
      // The site answered in the end: its sentence goes.
      .set({
        lastJobStatus: counts?.failed ? "partial" : "ok",
        lastSyncedAt: now,
        ...(isRefusalNote(source.lastError) && !counts?.noAnswer && { lastError: null }),
      })
      .where(and(eq(syncSources.id, source.id), eq(syncSources.lastJobStatus, "running")))
      .returning({ id: syncSources.id });
    if (!finished) continue;
    tails.delete(source.id);
    await settleKeyPages(ctx, source.deploymentId, source.startedAt, now).catch((err) =>
      ctx.log(`couldn't record what Add changed for ${source.deploymentId}: ${err instanceof Error ? err.message : err}`),
    );
    await refreshPriceTable(ctx, source.deploymentId, now);
    await refreshEventsList(ctx, source.deploymentId, now);
    ctx.log(`content sync finished for ${source.deploymentId}${counts?.failed ? ` with ${counts.failed} failed pages` : ""}`);
  }
}

// ---- the price table ----

// After each sync: the price table rebuilt from the pricing pages, proposed by the model and proved
// by code (lib/price-table-model.ts), the patterns standing in when the model's call fails; written
// when a figure or plan changed (price-table.ts pageChanges), and audited (deployment.price-table.read).
// Only here: never on a chat's path. A change to rows a person confirmed asks them again: Review's line
// and Needs attention read the hashes (review.ts priceTableState "changed"), and the channel hears it.
export async function refreshPriceTable(ctx: JobContext, deploymentId: string, now = new Date()): Promise<boolean> {
  // Not during a block: the model can't read, and the table stands until it can.
  if (await accountBlock(ctx.db).catch(() => undefined)) return false;
  try {
    const { table, changed, before, confirmation, calls, error } = await priceTableFor(deploymentId, {
      now,
      database: ctx.db,
      read: modelPriceReader(),
    });
    if (calls) ctx.log(`price table for ${deploymentId}: ${calls} model calls${error ? `; ${error}` : ""}`);
    if (!changed || !table) return false;
    const again = needsConfirmingAgain(table, confirmation);
    await ctx.db.insert(auditLog).values({
      actorUserId: null,
      action: "deployment.price-table.read",
      targetType: "deployment",
      targetId: deploymentId,
      detail: {
        rows: table.rows.length,
        hash: table.hash,
        pages: table.pages,
        ...(table.builtBy && { builtBy: table.builtBy }),
        ...(table.rejected?.length && { rejected: table.rejected.length }),
        ...(table.modelError && { modelError: table.modelError }),
        ...(before && { before: { rows: before.rows.length, hash: before.hash } }),
        ...(again && { confirmAgain: true, confirmedBy: confirmation?.by, auto: "re-read" }),
        ...(table.changes?.length && { changes: table.changes }),
      },
    });
    ctx.log(
      `price table for ${deploymentId}: ${table.rows.length} rows from ${table.pages.length} pricing pages, built by ${table.builtBy ?? "patterns"}${again ? "; it changed since it was confirmed, so it asks to be confirmed again" : ""}`,
    );
    return true;
  } catch (err) {
    ctx.log(`price table for ${deploymentId} couldn't be rebuilt: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// ---- pages read by an older extractor or rules ----

// Flags for pages synced before the current rules, computed from what's stored (the address,
// title, language and dates), so the content list shows them before the nightly re-read loads
// the pages. Once per deployment per worker process, a few deployments a run.
const flagsRefreshed = new Set<string>();
async function refreshFlags(ctx: JobContext, now: Date, perRun = 3) {
  const due = await ctx.db
    .selectDistinct({
      id: contentPages.deploymentId,
      language: deployments.language,
      languages: syncSources.languages,
      published: deployments.published,
      signOff: deployments.signOff,
    })
    .from(contentPages)
    .innerJoin(deployments, eq(deployments.id, contentPages.deploymentId))
    .innerJoin(syncSources, and(eq(syncSources.deploymentId, contentPages.deploymentId), eq(syncSources.kind, "sitemap")))
    .where(and(lt(contentPages.rulesVersion, RULES_VERSION), ne(contentPages.status, "removed")));
  let changed = 0;
  for (const d of due.filter((x) => !flagsRefreshed.has(x.id)).slice(0, perRun)) {
    flagsRefreshed.add(d.id);
    const served = servedLanguages(d.languages, d.language);
    const keys = await keyPagesFor(ctx, d);
    const rows = await ctx.db
      .select({
        id: contentPages.id,
        url: contentPages.url,
        title: contentPages.title,
        lang: contentPages.lang,
        lastModified: contentPages.lastModified,
        publishedAt: contentPages.publishedAt,
        pageModifiedAt: contentPages.pageModifiedAt,
        flags: contentPages.flags,
      })
      .from(contentPages)
      .where(and(eq(contentPages.deploymentId, d.id), lt(contentPages.rulesVersion, RULES_VERSION), ne(contentPages.status, "removed")));
    for (const row of rows) {
      const flags = storedFlags(row, { served, today: now, keyPages: keys });
      if (flags.join() === row.flags.join()) continue;
      await ctx.db.update(contentPages).set({ flags }).where(eq(contentPages.id, row.id));
      changed += 1;
    }
  }
  if (changed) ctx.log(`content flags computed for ${changed} pages synced before the current rules`);
}
