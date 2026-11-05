// Which pages of a site to sync, and their main content. The console's content plan and sync
// read the sitemaps' entries (a short crawl when there are none), then fetch pages in batches
// and store each one's Markdown in the Knowledge Box with its URL for citations.

import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import { type Blocked, botProtection } from "./blocked.ts";
import { EXTRACT_SCRIPT, EXTRACTOR_VERSION, type RawPage, toggleControls } from "./content.ts";
import { parseSitemapEntries, robotsSitemaps, SITEMAP_FALLBACKS, type SitemapEntry } from "./detect.ts";
import { retryAfterMs, safeFetchText } from "./net.ts";
import { HostPacer, NO_ANSWER, NOT_TRIED, SilentHosts } from "./pace.ts";
import { guardedContext, readOnlyPages } from "./scan.ts";

// Files a sitemap may list that aren't pages; the KB takes them through other means.
const NOT_PAGES = /\.(pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif|svg|webp|mp4|mp3|xml|json|txt|ics)$/i;

// "/blog" matches /blog and everything under it; "*" matches anything, so "/*/careers" or
// "*.aspx" work too. Case-insensitive, like most CMS URLs.
export function pathMatches(url: string, patterns: readonly string[]): boolean {
  const path = new URL(url).pathname.toLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) return false;
    if (!pattern.includes("*")) {
      const prefix = pattern.replace(/\/+$/, "");
      return path === prefix || path.startsWith(`${prefix}/`);
    }
    const re = new RegExp(
      `^${pattern
        .split("*")
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    );
    return re.test(path);
  });
}

export interface PageFilter {
  include?: string[];
  exclude?: string[];
}

// Same host (www or not), a page rather than a file, and within the partner's rules.
export function wantedPage(url: string, host: string, filter: PageFilter = {}): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const bare = (h: string) => h.replace(/^www\./, "");
  if (!/^https?:$/.test(u.protocol) || bare(u.hostname) !== bare(host) || NOT_PAGES.test(u.pathname)) return false;
  if (filter.include?.some((p) => p.trim()) && !pathMatches(url, filter.include)) return false;
  return !(filter.exclude && pathMatches(url, filter.exclude));
}

// How the sitemaps were found, for the plan to say which files it used and why:
// - "given": the sitemap address the partner entered;
// - "robots": robots.txt's Sitemap lines;
// - "fallback": the usual places on the site (SITEMAP_FALLBACKS), because robots.txt names
//   none ("none-listed"), names another site's ("elsewhere": kemptechnologies.com's points to
//   www.chef.io), or its sitemaps list none of this site's pages ("no-pages").
export interface SitemapDiscovery {
  how: "given" | "robots" | "fallback";
  why?: "none-listed" | "elsewhere" | "no-pages";
  // robots.txt's sitemaps on another host.
  elsewhere: string[];
  // The files (as listed, before following indexes) that gave this site's pages.
  used: string[];
  // A sitemap address was entered but lists none of this site's pages; discovery went on without it.
  givenEmpty?: string;
}

export interface SitemapRead {
  // Where reading started: the files listed or tried, before following indexes.
  sitemaps: string[];
  // Sitemap files read, counting those an index pointed to.
  files: number;
  // The site's pages (not files, same host with or without www), each once, in sitemap order.
  entries: SitemapEntry[];
  // Stopped at the file or page cap, or the deadline, before reading every sitemap.
  truncated: boolean;
  discovery: SitemapDiscovery;
  // Files that couldn't be read even when tried again (a rate limit, an error, not found: never
  // taken for an empty file), and files not reached before the deadline. The pages they list
  // are missing from the read, and with them perhaps whole languages; such a read isn't kept.
  failed: { url: string; status?: number; reason: string }[];
  unread: string[];
  // robots.txt or a sitemap came back as a bot-protection page (blocked.ts): the read stopped there.
  blocked?: Blocked;
  // Files the site rate-limited (429) at least once, read in the end or not.
  rateLimited?: number;
  // Of the files read, those gzipped (.gz addresses): the plan says so.
  gzipped?: number;
  // Pages no sitemap lists, found from the home page's links or common addresses, and added to
  // entries (findKeyPages).
  found?: string[];
}

// A sitemap file that didn't come back as a 200 (status), or didn't come back at all.
// retryAfterMs: the site's Retry-After on a 429 or 503; blocked: who blocked it, when the answer
// was a bot-protection page (blocked.ts), which no retry gets past.
export class SitemapFetchError extends Error {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly blocked: string | undefined;
  constructor(message: string, status?: number, more: { retryAfterMs?: number; blocked?: string } = {}) {
    super(message);
    this.status = status;
    this.retryAfterMs = more.retryAfterMs;
    this.blocked = more.blocked;
  }
}

// Pauses before trying a failed file again: a rate limit (teamleader.eu answered 67 of its 120
// files, then nothing) usually lets the next try through.
const SITEMAP_RETRY_MS = [1000, 3000, 6000];
// Once a site rate-limits, files are read one at a time, this far apart.
const SITEMAP_SLOW_GAP_MS = 400;
// The longest Retry-After a read waits out (a pause past the deadline isn't waited for at all).
const MAX_RETRY_AFTER_MS = 20_000;

// How long to wait before trying a failed file again: the site's Retry-After when it gives one
// (up to MAX_RETRY_AFTER_MS), else the next of the increasing pauses. Undefined: no more tries. Pure.
export function retryPause(attempt: number, retryAfterMs?: number): number | undefined {
  const pause = SITEMAP_RETRY_MS[attempt];
  if (pause === undefined) return undefined;
  return retryAfterMs === undefined ? pause : Math.max(pause, Math.min(retryAfterMs, MAX_RETRY_AFTER_MS));
}

// One sitemap file (or robots.txt) as the reader takes it: the text of a 200, gunzipped when it's
// a .gz file (net.ts decodeBody); anything else is a SitemapFetchError the reader may try again
// (with the site's Retry-After), and a bot-protection page in its place (blocked.ts) one it won't.
// Sitemaps may be up to 50 MB (the protocol's limit); progress.com's is over 5.
export async function fetchSitemapFile(url: string, fetchImpl?: typeof fetch): Promise<string> {
  const res = await safeFetchText(url, { maxBytes: 50_000_000, timeoutMs: 30_000, ...(fetchImpl && { fetch: fetchImpl }) });
  const by = botProtection(res, "text");
  if (by) throw new SitemapFetchError(`${url} answered with ${by}'s block page`, res.status, { blocked: by });
  if (res.status !== 200)
    throw new SitemapFetchError(`${url} answered ${res.status}`, res.status, {
      ...(res.retryAfterMs !== undefined && { retryAfterMs: res.retryAfterMs }),
    });
  return res.text;
}

// How many blocked files, with no page read, mean the site is blocking us.
const BLOCKED_FILES = 3;
export const MAX_SITEMAP_FILES = 400;
// telerik.com's sitemaps list 390,000 pages, 289,000 of them forum threads listed last: the
// cap keeps the plan's read (and what the console holds) to a size it handles in seconds.
export const MAX_SITEMAP_PAGES = 150_000;

const bareHost = (h: string) => h.replace(/^www\./, "").toLowerCase();

// Every page in a site's sitemaps, with its lastmod, priority and hreflang, without loading a
// page. The files are the sitemap address given, else robots.txt's; when robots.txt names none,
// names only another site's, or its files list none of this site's pages, the usual places on
// the site are tried too. Indexes are followed (nested ones too), a few files at a time, always
// the earliest in sitemap order next, so a cap cuts the same files every time. Past the
// deadline or a cap, what was read is the answer, marked truncated.
export async function readSitemaps(
  site: string,
  fetchText: (url: string) => Promise<string>,
  opts: { maxFiles?: number; maxPages?: number; deadlineMs?: number; concurrency?: number; sitemap?: string } = {},
): Promise<SitemapRead> {
  const deadline = Date.now() + (opts.deadlineMs ?? 25_000);
  const origin = new URL(site).origin;
  const host = new URL(site).hostname;
  // A language's own sitemap, tried first (languageSitemaps), isn't fetched a second time.
  const probed = new Map<string, string>();
  const reader = sitemapReader(host, (url) => (probed.has(url) ? Promise.resolve(probed.get(url)!) : fetchText(url)), {
    ...opts,
    deadline,
  });
  // The read's result, with what the sitemaps of languages it doesn't list add to it.
  const finish = async (sitemaps: string[], discovery: SitemapDiscovery): Promise<SitemapRead> => {
    if (reader.halted() || !discovery.used.length) return reader.result(sitemaps, discovery);
    const files = await languageSitemaps(origin, fetchText, probed, sitemaps, deadline);
    if (!files.length) return reader.result(sitemaps, discovery);
    const used = await reader.read(files, new Set(files));
    return reader.result([...sitemaps, ...files], { ...discovery, used: [...discovery.used, ...used] });
  };
  const fallbacks = SITEMAP_FALLBACKS.map((path) => new URL(path, origin).href);

  let givenEmpty: string | undefined;
  if (opts.sitemap) {
    const used = await reader.read([opts.sitemap]);
    if (used.length) return reader.result([opts.sitemap], { how: "given", elsewhere: [], used });
    givenEmpty = opts.sitemap;
  }
  const robots = await reader.robots(`${origin}/robots.txt`);
  if (reader.halted()) return reader.result([], { how: "robots", elsewhere: [], used: [] });
  const listed = robotsSitemaps(robots, origin);
  const elsewhere = listed.filter((url) => bareHost(new URL(url).hostname) !== bareHost(host));
  const note = givenEmpty ? { givenEmpty } : {};
  // The usual places may simply not exist: a missing one there isn't a failure.
  const quiet = new Set(fallbacks);
  if (!listed.length) {
    const used = await reader.read(fallbacks, quiet);
    return finish(fallbacks, { how: "fallback", why: "none-listed", elsewhere, used, ...note });
  }
  // Another site's sitemap may still list this site's pages, so it's read too, alongside the
  // usual places.
  const tried = elsewhere.length ? [...listed, ...fallbacks.filter((url) => !listed.includes(url))] : listed;
  const used = await reader.read(tried, quiet);
  if (used.some((url) => listed.includes(url))) return finish(tried, { how: "robots", elsewhere, used, ...note });
  if (used.length) return finish(tried, { how: "fallback", why: "elsewhere", elsewhere, used, ...note });
  const again = fallbacks.filter((url) => !tried.includes(url));
  const late = again.length ? await reader.read(again, quiet) : [];
  return reader.result([...tried, ...again], {
    how: "fallback",
    why: elsewhere.length ? "elsewhere" : "no-pages",
    elsewhere,
    used: late,
    ...note,
  });
}

// Languages a site may keep in a sitemap of their own that robots.txt doesn't name: the widget's
// languages, and any the home page's hreflang links name. Round 7: seeburger.com's /de/sitemap.xml
// answered 200, but the plan read only the root sitemap and never offered German.
const LANGUAGE_FOLDERS = ["en", "de", "fr", "es", "it", "nl", "pt"];
const MAX_LANGUAGE_PROBES = 10;
const LANGUAGE_PROBE_MS = 4000;

// The folders the home page's alternate links name: <link rel="alternate" hreflang="de" href="/de/">.
export function hreflangFolders(html: string, origin: string): string[] {
  const folders: string[] = [];
  for (const tag of html.matchAll(/<link\b[^>]*\bhreflang=[^>]*>/gi)) {
    const href = /\bhref=["']([^"']+)["']/i.exec(tag[0])?.[1];
    if (!href) continue;
    try {
      const u = new URL(href, origin);
      const first = u.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
      if (u.origin === origin && first && /^[a-z]{2}(?:-[a-z]{2})?$/.test(first)) folders.push(first);
    } catch {
      // Not an address.
    }
  }
  return [...new Set(folders)];
}

// Which /<language>/sitemap.xml files exist and aren't among the files already tried. A file that
// isn't there, or isn't a sitemap, is simply not one: never a failure. Their texts go in `probed`.
async function languageSitemaps(
  origin: string,
  fetchText: (url: string) => Promise<string>,
  probed: Map<string, string>,
  tried: readonly string[],
  deadline: number,
): Promise<string[]> {
  const left = Math.min(LANGUAGE_PROBE_MS, deadline - Date.now());
  if (left <= 0) return [];
  const within = <T>(work: Promise<T>): Promise<T | undefined> =>
    Promise.race([work.catch(() => undefined), sleep(left, undefined, { ref: false })]);
  const home = (await within(fetchText(`${origin}/`))) ?? "";
  const folders = [...new Set([...hreflangFolders(home, origin), ...LANGUAGE_FOLDERS])].slice(0, MAX_LANGUAGE_PROBES);
  const urls = folders.map((f) => `${origin}/${f}/sitemap.xml`).filter((url) => !tried.includes(url));
  const texts = await Promise.all(urls.map((url) => within(fetchText(url))));
  return urls.filter((url, i) => {
    const text = texts[i];
    if (!text || !/<(?:urlset|sitemapindex)\b/i.test(text)) return false;
    probed.set(url, text);
    return true;
  });
}

// Reads sitemap files (and the files their indexes list) into one ordered list of this site's
// pages. Each read() call's files come after the previous call's in sitemap order; it returns
// those of its files that gave pages.
function sitemapReader(
  host: string,
  fetchText: (url: string) => Promise<string>,
  opts: { maxFiles?: number; maxPages?: number; deadline: number; concurrency?: number },
) {
  const { deadline } = opts;
  const maxFiles = opts.maxFiles ?? MAX_SITEMAP_FILES;
  const maxPages = opts.maxPages ?? MAX_SITEMAP_PAGES;
  // Files are read concurrently but kept in discovery order (an index's children in its order),
  // so "sitemap order" means the same thing on every read.
  const byOrder = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
  };
  const read: { order: number[]; entries: SitemapEntry[] }[] = [];
  const seen = new Set<string>();
  let files = 0;
  let gzipped = 0;
  let pages = 0;
  let cut = false;
  let calls = 0;
  let left = 0;
  // A bot-protection page on robots.txt stops the read, as does one on every one of the first
  // BLOCKED_FILES files: the site is blocking us. One blocked file among others that read isn't the
  // site blocking us: it's a file that couldn't be read (round 7: procore.com's /jobsite/sitemap.xml
  // answered with a cookie wall, the plan said "Creating the deployment now would sync nothing", and
  // the sync then read 197 of 200 pages).
  let blocked: Blocked | undefined;
  let blockedFiles = 0;
  const siteBlocked = () => Boolean(blocked) && (halting || (pages === 0 && blockedFiles >= BLOCKED_FILES));
  let halting = false;
  let rateLimited = 0;
  const stopped = () => siteBlocked() || files >= maxFiles || pages >= maxPages || Date.now() >= deadline;
  const failed: SitemapRead["failed"] = [];
  const unread: string[] = [];
  // A file still downloading at the deadline doesn't hold the answer up (undefined). A failed one
  // is tried again after a pause (a rate limit, an error, no answer), but not one that isn't
  // there (404, 410) or that the site refuses (other 4xx); it's never taken for an empty file.
  // After a rate limit (429), every further file waits its turn, one at a time, a gap apart.
  let slow = false;
  let cool = 0;
  let gate: Promise<void> = Promise.resolve();
  const paced = async (url: string): Promise<string> => {
    if (!slow) return fetchText(url);
    const before = gate;
    let release = () => {};
    gate = new Promise((resolve) => {
      release = resolve;
    });
    await before;
    try {
      const wait = Math.min(cool - Date.now(), deadline - Date.now());
      if (wait > 0) await sleep(wait);
      return await fetchText(url);
    } finally {
      cool = Math.max(cool, Date.now() + SITEMAP_SLOW_GAP_MS);
      release();
    }
  };
  const fetchBefore = async (url: string): Promise<{ xml: string } | { status?: number; reason: string } | undefined> => {
    for (let attempt = 0; ; attempt++) {
      const done = new AbortController();
      let outcome: { xml: string } | { error: unknown } | undefined;
      try {
        outcome = await Promise.race([
          paced(url).then(
            (xml) => ({ xml }),
            (error: unknown) => ({ error }),
          ),
          sleep(Math.max(0, deadline - Date.now()), undefined, { signal: done.signal }).then(
            () => undefined,
            () => undefined,
          ),
        ]);
      } finally {
        done.abort();
      }
      if (!outcome) return undefined;
      if ("xml" in outcome) return outcome;
      const failure = outcome.error instanceof SitemapFetchError ? outcome.error : undefined;
      const status = failure?.status;
      if (failure?.blocked) {
        blocked ??= { url, status: status ?? 0, by: failure.blocked };
        blockedFiles += 1;
        return { ...(status && { status }), reason: `blocked by ${failure.blocked}` };
      }
      const reason = status ? `the site answered ${status}` : outcome.error instanceof Error ? outcome.error.message : "no answer";
      const passing = status === undefined || status === 408 || status === 429 || status >= 500;
      const pause = retryPause(attempt, failure?.retryAfterMs);
      if (status === 429) {
        if (attempt === 0) rateLimited += 1;
        slow = true;
        cool = Math.max(cool, Date.now() + (pause ?? 0));
      }
      if (!passing || pause === undefined || Date.now() + pause >= deadline) return { ...(status && { status }), reason };
      await sleep(pause);
    }
  };
  const rootsOf: string[][] = [];
  const readFiles = async (roots: string[], quiet: ReadonlySet<string> = new Set()): Promise<string[]> => {
    const call = calls++;
    rootsOf[call] = roots;
    const queue = roots.filter((url) => !seen.has(url)).map((url) => ({ url, order: [call, roots.indexOf(url)] }));
    for (const { url } of queue) seen.add(url);
    const found = new Map<number, number>();
    let inFlight = 0;
    const worker = async () => {
      for (;;) {
        if (stopped()) return;
        const next = queue.shift();
        if (!next) {
          // An index still downloading may add files: wait for it rather than leave early.
          if (inFlight === 0) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        files += 1;
        if (/\.gz$/i.test(new URL(next.url).pathname)) gzipped += 1;
        inFlight += 1;
        try {
          const got = await fetchBefore(next.url);
          if (got === undefined) {
            cut = true;
            unread.push(next.url);
            return;
          }
          if (!("xml" in got)) {
            // A usual place that isn't there is no failure; a file robots.txt or an index lists is.
            const missing = got.status === 404 || got.status === 410;
            if (!(missing && quiet.has(next.url))) failed.push({ url: next.url, ...got });
            continue;
          }
          const parsed = parseSitemapEntries(got.xml);
          parsed.sitemaps.forEach((url, i) => {
            // Nested indexes up to three deep; a file listed twice is read once.
            if (next.order.length < 5 && !seen.has(url)) {
              seen.add(url);
              queue.push({ url, order: [...next.order, i] });
            }
          });
          queue.sort((a, b) => byOrder(a.order, b.order));
          const entries = parsed.entries.filter((e) => wantedPage(e.url, host));
          pages += entries.length;
          found.set(next.order[1]!, (found.get(next.order[1]!) ?? 0) + entries.length);
          read.push({ order: next.order, entries });
        } finally {
          inFlight -= 1;
        }
      }
    };
    await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));
    left += queue.length;
    unread.push(...queue.map((q) => q.url));
    return roots.filter((_, i) => (found.get(i) ?? 0) > 0);
  };

  // The files used are those that gave pages no earlier file listed (a site's /sitemap/sitemap.xml
  // is often its /sitemap.xml again).
  const result = (sitemaps: string[], discovery: SitemapDiscovery): SitemapRead => {
    const unique = new Map<string, SitemapEntry>();
    const gave = new Set<string>();
    for (const file of read.sort((a, b) => byOrder(a.order, b.order))) {
      for (const entry of file.entries) {
        const url = entry.url.split("#")[0]!;
        const key = url.replace(/\/+$/, "").toLowerCase();
        if (!unique.has(key) && unique.size < maxPages) {
          unique.set(key, { ...entry, url });
          gave.add(rootsOf[file.order[0]!]![file.order[1]!]!);
        }
      }
    }
    const used = discovery.used.filter((url) => gave.has(url));
    return {
      sitemaps,
      files,
      entries: [...unique.values()],
      truncated: cut || left > 0 || pages > maxPages || (Boolean(blocked) && pages === 0),
      discovery: { ...discovery, used },
      failed: [...failed],
      unread: [...new Set(unread)],
      // With pages read, a blocked file is only one that failed.
      ...(blocked && pages === 0 && { blocked }),
      ...(rateLimited && { rateLimited }),
      ...(gzipped && { gzipped }),
    };
  };
  // robots.txt, tried again like a sitemap file after a rate limit or an error; "" when it isn't
  // there. A bot-protection page there stops the read (halted).
  const robots = async (url: string): Promise<string> => {
    const got = await fetchBefore(url);
    if (blocked) halting = true;
    return got && "xml" in got ? got.xml : "";
  };
  return { read: readFiles, result, robots, halted: () => siteBlocked() };
}

export interface SitemapListing {
  sitemaps: string[];
  // Pages that pass the rules, up to the limit.
  urls: string[];
  // Every page that passed the rules, so the partner sees what the budget leaves out.
  total: number;
}

// The pages within the rules, shallowest first (home and section pages before deep archives),
// in sitemap order within each depth. The worker now ranks pages itself from the plan's
// entries (see the console's lib/content-plan.ts); this stays for older callers.
export function listSitemapPages(read: SitemapRead, opts: PageFilter & { limit: number }): SitemapListing {
  const host = (url: string) => new URL(url).hostname;
  const depth = (url: string) => new URL(url).pathname.split("/").filter(Boolean).length;
  const all = read.entries
    .filter((e) => wantedPage(e.url, host(e.url), opts))
    .map((e, i) => ({ url: e.url, i, d: depth(e.url) }))
    .sort((a, b) => a.d - b.d || a.i - b.i);
  return { sitemaps: read.sitemaps, urls: all.slice(0, opts.limit).map((p) => p.url), total: all.length };
}

// A pricing or contact page the sitemaps don't list (round 7: buzzsprout.com's /pricing). When the
// listed addresses name none, the home page's links are looked through, then a few common
// addresses, and the first that answers 200 and reads as that page is taken: at most
// KEY_PAGE_REQUESTS requests, each tried once. An address that errored or answered 429 or 5xx is in
// unreached, so a listing without it isn't taken as the whole site's. Pure but for fetchText.
const PRICING_SEGMENT =
  /^(?:pricing|prices?|plans?|preise|preisliste|precios|tarifs?|tarification|prijzen|precos|prezzi|tariffe|tarifas|buy|how-to-buy|purchase|shop|store|kaufen|comprar|acheter)(?:[-_.]|$)/i;
const CONTACT_SEGMENT = /^(?:contact|contacts|contactus|contact-us|kontakt|contacto|contacter|contatti|contato|get-in-touch)(?:[-_.]|$)/i;
const PRICING_PATHS = ["/pricing", "/plans", "/price", "/pricing/"];
const CONTACT_PATHS = ["/contact", "/contact-us"];
const PRICE_TEXT = /[$€£¥]\s?\d|\d\s?[€$]|\b(?:USD|EUR|GBP)\s?\d|\b(?:pricing|prices?|per month|preise|precios|tarifs?|prijzen)\b/i;
export const KEY_PAGE_REQUESTS = 6;

const namesPage = (url: string, segment: RegExp) => {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  const at = segments[0] && /^[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0]) ? 1 : 0;
  return segments.slice(at, at + 2).some((s) => segment.test(s));
};

export async function findKeyPages(
  origin: string,
  listed: readonly string[],
  fetchText: (url: string) => Promise<{ url: string; status: number; text: string }>,
): Promise<{ found: string[]; unreached: string[] }> {
  const wanted = [
    { segment: PRICING_SEGMENT, paths: PRICING_PATHS, reads: (text: string) => PRICE_TEXT.test(text) },
    { segment: CONTACT_SEGMENT, paths: CONTACT_PATHS, reads: () => true },
  ].filter((w) => !listed.some((url) => namesPage(url, w.segment)));
  const found: string[] = [];
  const unreached: string[] = [];
  if (!wanted.length) return { found, unreached };
  const host = bareHost(new URL(origin).hostname);
  let requests = 0;
  const get = async (url: string) => {
    requests += 1;
    try {
      const res = await fetchText(url);
      if (res.status === 429 || res.status >= 500) unreached.push(url);
      return res;
    } catch {
      unreached.push(url);
      return undefined;
    }
  };
  const home = await get(`${origin}/`);
  const links: string[] = [];
  for (const m of (home?.text ?? "").matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)/gi)) {
    try {
      const link = new URL(m[1]!, home!.url);
      if (bareHost(link.hostname) === host && /^https?:$/.test(link.protocol)) links.push(`${link.origin}${link.pathname}`);
    } catch {
      // Not an address.
    }
  }
  for (const w of wanted) {
    const fromHome = [...new Set(links.filter((l) => namesPage(l, w.segment)))].slice(0, 2);
    for (const url of [...fromHome, ...w.paths.map((p) => `${origin}${p}`)]) {
      if (requests >= KEY_PAGE_REQUESTS) break;
      const res = await get(url);
      if (!res || res.status !== 200) continue;
      // A redirect home isn't that page.
      const final = new URL(res.url);
      if (bareHost(final.hostname) !== host || !namesPage(res.url, w.segment) || !w.reads(res.text)) continue;
      found.push(`${final.origin}${final.pathname}`);
      break;
    }
  }
  return { found, unreached: found.length === wanted.length ? [] : unreached };
}

// For sites without a sitemap: follow same-site links from the start page, breadth first, up
// to `limit` pages and three clicks deep. Loading pages is the cost, so that's capped too (in
// count and time): rules that match little must not turn into a crawl of the whole site.
export async function crawlSite(start: string, opts: PageFilter & { limit: number; deadlineMs?: number }): Promise<string[]> {
  const host = new URL(start).hostname;
  const found: string[] = [];
  const seen = new Set<string>();
  const maxLoads = Math.max(opts.limit * 2, 30);
  const deadline = Date.now() + (opts.deadlineMs ?? 90_000);
  const more = () => found.length < opts.limit && seen.size < maxLoads && Date.now() < deadline;
  let frontier = [start.split("#")[0]!];
  for (let depth = 0; depth < 3 && frontier.length && more(); depth++) {
    const next: string[] = [];
    for (let i = 0; i < frontier.length && more(); i += 5) {
      const batch = frontier.slice(i, i + 5).filter((u) => !seen.has(u));
      for (const u of batch) seen.add(u);
      for (const page of await fetchPages(batch)) {
        if (page.error || page.status >= 400) continue;
        // The start page counts even when the rules exclude it: its links lead to the rest.
        if (wantedPage(page.url, host, opts)) found.push(page.url);
        for (const link of page.links) if (!seen.has(link) && wantedPage(link, host, {})) next.push(link);
      }
    }
    frontier = [...new Set(next)];
  }
  return found.slice(0, opts.limit);
}

// "Product name | Brand" → "Product name": the brand on every page says nothing in a source list.
export function cleanTitle(page: Pick<RawPage, "title" | "ogTitle" | "h1">, url: string): string {
  const base = (page.ogTitle || page.title || page.h1 || "").trim();
  const parts = base.split(/\s+[|–—·]\s+|\s+-\s+|\s+::\s+/);
  const title = parts.length > 1 && parts.at(-1)!.length <= 50 ? parts.slice(0, -1).join(" - ") : base;
  return title.trim() || page.h1 || new URL(url).pathname;
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  title: string;
  description?: string;
  lang?: string;
  canonical?: string;
  noindex: boolean;
  root: string;
  markdown: string;
  words: number;
  links: string[];
  // See RawPage: the content area's characters against the extract's, link text's share of the
  // extract, and the page's own dates and article type.
  rootChars: number;
  textChars: number;
  linkShare: number;
  datePublished?: string;
  dateModified?: string;
  articleType?: string;
  published?: string;
  // The extractor version that read it (EXTRACTOR_VERSION).
  extractor: number;
  // The site rate-limited it (429 or 503) even when tried again after its pause, or the pause was
  // longer than a load waits: the sync tries it again later, keeping any copy it has. retryAfterMs:
  // the site's Retry-After, when it gave one.
  rateLimited?: boolean;
  retryAfterMs?: number;
  error?: string;
}

// Every page load, across requests: a host that rate-limits is paced for all of them (pace.ts).
const pacer = new HostPacer();
// A host whose last loads got no answer isn't loaded again for a minute: each costs 20 s and may be
// why it stopped (round 7: servicetitan.com). The page comes back "Not tried", and the sync decides.
const silent = new SilentHosts();

// A billing toggle that reloads the page (RawPage.billingViews): the page's text with each price
// line saying the billing it's shown for ("$25 / month, billed annually", where the card's own
// "When billed annually" line was a repeat the extract drops), then the other views' prices under
// their plans' headings: "## Prices billed monthly", "### Audio", "$18 / month, billed monthly".
// A view whose prices are the page's adds nothing. Pure.
const SHORT_PRICE = /^(?:US\$|[$€£¥]|\b(?:USD|EUR|GBP|CHF)\b)\s?\d[\d.,]*(?:\s*(?:\/|per\b)\s*\p{L}+)?\s*$/iu;
const BILLED_LINE = /^(?:when |if )?billed\b/i;
export const billedFor = (period: string) =>
  /^month/i.test(period) ? "billed monthly" : /^annual/i.test(period) ? "billed annually" : "billed yearly";
export function withBillingViews(
  markdown: string,
  shown: string | undefined,
  views: readonly { period: string; markdown: string }[],
): string {
  const priceLines = (text: string) => text.split("\n").filter((l) => SHORT_PRICE.test(l.trim()));
  const lines = markdown.split("\n");
  if (shown) {
    for (let i = 0; i < lines.length; i++) {
      if (!SHORT_PRICE.test(lines[i]!.trim())) continue;
      let next = i + 1;
      while (next < lines.length && !lines[next]!.trim()) next++;
      if (!BILLED_LINE.test(lines[next]?.trim() ?? "")) lines[i] = `${lines[i]!.trim()}, ${billedFor(shown)}`;
    }
  }
  const own = new Set(priceLines(markdown).map((l) => l.trim()));
  const added: string[] = [];
  for (const view of views) {
    const viewLines = view.markdown.split("\n");
    if (priceLines(view.markdown).every((l) => own.has(l.trim()))) continue;
    const out: string[] = [];
    let heading: string | undefined;
    let said: string | undefined;
    for (const line of viewLines) {
      const trimmed = line.trim();
      if (/^#{1,6}\s/.test(trimmed)) heading = trimmed;
      if (!SHORT_PRICE.test(trimmed)) continue;
      if (heading && heading !== said) {
        out.push(heading);
        said = heading;
      }
      out.push(`${trimmed}, ${billedFor(view.period)}`);
    }
    if (out.length) added.push(`## Prices ${billedFor(view.period)}`, ...out);
  }
  return [lines.join("\n"), ...added].join("\n\n");
}

// A figure with a currency, to tell whether operating a toggle changed what the page states.
const FIGURES = /(?:US\$|[$€£¥]|\b(?:USD|EUR|GBP|CHF)\b)\s?\d[\d.,]*|\d[\d.,]*\s?(?:[$€£¥]|\b(?:USD|EUR|GBP|CHF)\b)/giu;
export const figuresIn = (text: string): Set<string> => new Set([...text.matchAll(FIGURES)].map((m) => m[0].replace(/\s+/g, "")));

// What a page shows with a toggle operated (RawPage's text under another setting), added to its
// text: for each setting, the lines the page's own text doesn't have, under the headings they sit
// beneath: `## Prices with "MONTHLY" selected`, `## Direct`, `$ 29.00`. Nothing is worked out: only what the
// page showed. The setting shown first is named when known. A setting that adds no figure adds
// nothing. A setting that names a billing cycle says so on its prices, in the words a billing toggle
// that reloads the page gets ("$ 29.00, billed monthly"), the setting shown first too: two prices of
// one plan in one period are told apart by them. Pure.
const MONTHLY_SETTING = /^(?:month|monthly|monatlich|monat|mensual|mensuel|mensile|mese|mes|mois|maandelijks|maand)\b/iu;
const YEARLY_SETTING = /^(?:year|yearly|annual|annually|jährlich|jahr|anual|annuel|annuale|anno|año|jaarlijks|jaar)(?![\p{L}])/iu;
const billedBy = (label: string | undefined) =>
  !label
    ? undefined
    : MONTHLY_SETTING.test(label.trim())
      ? "billed monthly"
      : YEARLY_SETTING.test(label.trim())
        ? "billed annually"
        : undefined;
const MAX_VIEW_LINES = 60;
export function withToggleViews(
  markdown: string,
  shown: string | undefined,
  views: readonly { label: string; markdown: string }[],
): string {
  const own = new Set(markdown.split("\n").map((l) => l.trim()));
  const ownFigures = figuresIn(markdown);
  const added: string[] = [];
  for (const view of views) {
    const out: string[] = [];
    let heading: string | undefined;
    let said: string | undefined;
    let before: string[] = [];
    for (const line of view.markdown.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // A figure set as a heading ("##### $ 4,620") names nothing.
      if (/^#{1,6}\s/.test(trimmed) && !figuresIn(trimmed).size) {
        heading = trimmed;
        before = [];
      }
      const fresh = !own.has(trimmed) && [...figuresIn(trimmed)].length > 0;
      if (fresh && out.length < MAX_VIEW_LINES) {
        if (heading && heading !== said && heading !== trimmed) {
          out.push(heading);
          said = heading;
        }
        // A line that only states a figure keeps the lines above it that name it ("24x7 Live Support",
        // "starting from").
        const bare = trimmed.replace(FIGURES, "").replace(/[\W\d_]+/gu, "").length < 3;
        if (bare) for (const l of before) if (l !== heading && !out.includes(l)) out.push(l);
        const billed = billedBy(view.label);
        out.push(billed && SHORT_PRICE.test(trimmed) ? `${trimmed}, ${billed}` : trimmed);
      }
      if (trimmed !== heading) before = [...before, trimmed].filter((l) => !figuresIn(l).size).slice(-2);
    }
    if (out.some((l) => [...figuresIn(l)].some((f) => !ownFigures.has(f)))) added.push(`## Prices with "${view.label}" selected`, ...out);
  }
  if (!added.length) return markdown;
  const billed = billedBy(shown);
  const lines = markdown.split("\n");
  if (billed) {
    for (let i = 0; i < lines.length; i++) {
      if (!SHORT_PRICE.test(lines[i]!.trim())) continue;
      let next = i + 1;
      while (next < lines.length && !lines[next]!.trim()) next++;
      if (!BILLED_LINE.test(lines[next]?.trim() ?? "")) lines[i] = `${lines[i]!.trim()}, ${billed}`;
    }
  }
  const page = lines.join("\n");
  return [...(shown ? [page, `The prices above are with "${shown}" selected.`] : [page]), ...added].join("\n\n");
}

// How many controls a read clicks on a page, and how many other settings it keeps, at most: the
// same few extra looks as a toggle that reloads the page, and about a second each.
const MAX_TOGGLE_CLICKS = 6;
const MAX_TOGGLE_VIEWS = 3;
const TOGGLE_SETTLE_MS = 500;

// Operates a page's client-side toggles once (Monthly/Yearly, tabs of products): each control the
// page offers (toggleControls) is clicked, and a setting whose figures differ is read. The test is
// the figures, not the words, so it works in any language and any markup. Requests other than GET
// are refused meanwhile, so a click can't change anything on the site. It ends when a click leaves
// the page. Only for a page that states a figure. Returns the other settings, and the one shown first.
export async function operateToggles(page: Page, base: RawPage): Promise<{ shown?: string; views: { label: string; markdown: string }[] }> {
  const views: { label: string; markdown: string }[] = [];
  const baseFigures = figuresIn(base.markdown);
  if (!baseFigures.size) return { views };
  const address = page.url();
  let shown: string | undefined;
  readOnlyPages.add(page);
  try {
    const controls = await page.evaluate(toggleControls);
    let clicks = 0;
    const known = new Set(baseFigures);
    const dead = new Set<number>();
    for (const control of controls) {
      if (control.active && !shown) shown = control.label;
      if (control.active || dead.has(control.group)) continue;
      if (clicks >= MAX_TOGGLE_CLICKS || views.length >= MAX_TOGGLE_VIEWS) break;
      clicks += 1;
      const clicked = await page
        .locator(`[data-arag-toggle="${control.id}"]`)
        .click({ timeout: 1000, noWaitAfter: true })
        .then(() => true)
        .catch(() => false);
      if (!clicked) continue;
      await page.waitForTimeout(TOGGLE_SETTLE_MS);
      if (page.url().split("#")[0] !== address.split("#")[0]) break;
      const after = await page.evaluate<RawPage>(EXTRACT_SCRIPT);
      const fresh = [...figuresIn(after.markdown)].filter((f) => !known.has(f));
      if (!fresh.length) {
        dead.add(control.group);
        continue;
      }
      for (const f of fresh) known.add(f);
      views.push({ label: control.label, markdown: after.markdown });
    }
  } catch {
    // The page's own text stands.
  } finally {
    readOnlyPages.delete(page);
  }
  return { ...(shown && views.length && { shown }), views };
}

const emptyPage = (url: string, more: Partial<FetchedPage>): FetchedPage => ({
  url,
  finalUrl: url,
  status: 0,
  title: url,
  noindex: false,
  root: "",
  markdown: "",
  words: 0,
  links: [],
  rootChars: 0,
  textChars: 0,
  linkShare: 0,
  extractor: EXTRACTOR_VERSION,
  ...more,
});

// Loads pages in a guarded browser context, a few at a time, and extracts their content.
// A page that fails comes back with an error rather than failing the batch.
export async function fetchPages(urls: string[], opts: { concurrency?: number; timeoutMs?: number } = {}): Promise<FetchedPage[]> {
  const context = await guardedContext();
  const results: FetchedPage[] = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      const url = urls[i]!;
      if (silent.stopped(url)) {
        results[i] = emptyPage(url, { error: NOT_TRIED });
        continue;
      }
      const page = await context.newPage();
      try {
        const paced = await pacer.run(url, async () => {
          const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs ?? 20_000 });
          const status = res?.status() ?? 0;
          const wait = status === 429 || status === 503 ? retryAfterMs(res?.headers()["retry-after"]) : undefined;
          return { status, ...(wait !== undefined && { retryAfterMs: wait }) };
        });
        if ("skipped" in paced || paced.result.status === 429 || (paced.rateLimited && paced.result.status === 503)) {
          const status = "skipped" in paced ? 429 : paced.result.status;
          const wait = "skipped" in paced ? paced.retryAfterMs : paced.result.retryAfterMs;
          results[i] = emptyPage(url, { status, rateLimited: true, ...(wait !== undefined && { retryAfterMs: wait }) });
          continue;
        }
        silent.answered(url);
        await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
        const raw = await page.evaluate<RawPage>(EXTRACT_SCRIPT);
        const finalUrl = page.url();
        // A billing toggle that reloads the page: its other views' prices are read too (at most 2
        // more loads), so both billing cycles reach the text and the price table.
        if (raw.billingViews?.length) {
          const views: { period: string; markdown: string }[] = [];
          for (const view of raw.billingViews.slice(0, 2)) {
            try {
              const loaded = await pacer.run(view.url, async () => ({
                status: (await page.goto(view.url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs ?? 20_000 }))?.status() ?? 0,
              }));
              if ("skipped" in loaded || loaded.result.status >= 400) continue;
              await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
              views.push({ period: view.period, markdown: (await page.evaluate<RawPage>(EXTRACT_SCRIPT)).markdown });
            } catch {
              // The other view didn't load: the page's own prices stand.
            }
          }
          raw.markdown = withBillingViews(raw.markdown, raw.billingShown, views);
        } else {
          // A toggle the page's own script handles: operated once, and what it shows is added.
          const toggled = await operateToggles(page, raw);
          raw.markdown = withToggleViews(raw.markdown, toggled.shown, toggled.views);
        }
        results[i] = {
          url,
          finalUrl,
          status: paced.result.status,
          title: cleanTitle(raw, url),
          ...(raw.description && { description: raw.description }),
          ...(raw.lang && { lang: raw.lang }),
          ...(raw.canonical && { canonical: raw.canonical }),
          noindex: raw.noindex,
          root: raw.root,
          markdown: raw.markdown,
          words: raw.markdown.split(/\s+/).filter(Boolean).length,
          links: raw.links,
          rootChars: raw.rootChars,
          textChars: raw.textChars,
          linkShare: raw.linkShare,
          ...(raw.datePublished && { datePublished: raw.datePublished }),
          ...(raw.dateModified && { dateModified: raw.dateModified }),
          ...(raw.articleType && { articleType: raw.articleType }),
          ...(raw.published && { published: raw.published }),
          extractor: EXTRACTOR_VERSION,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message.split("\n")[0]! : String(err);
        if (NO_ANSWER.test(error)) silent.noAnswer(url);
        results[i] = emptyPage(url, { error });
      } finally {
        await page.close();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 3, urls.length) }, worker));
  } finally {
    await context.close();
  }
  return results;
}
