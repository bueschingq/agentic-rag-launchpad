// Internal HTTP service used by the console's provisioning wizard. Not exposed publicly:
// callers must send the shared SNIFFER_TOKEN.
//
//   POST /scan {"url": "https://www.example.com"}
//   → platform, sitemap page count, proposed theme (+ confidence, sources, warnings), screenshot
//   POST /plan {"url", "sitemap"?}
//   → every page in the site's sitemaps with its lastmod, priority and hreflang, without
//     loading any page, and which files gave them and why: what the console's content plan and
//     the sync rank pages from. "sitemap" is an address the partner entered, read first.
//     "blocked": robots.txt, a sitemap or the start page came back as a bot-protection page
//     (answered as soon as that's known, within seconds, with whatever was read).
//   POST /probe {"urls": [... up to 30]}
//   → each address's status, final address and title, without rendering: the plan checks that
//     its key pages load before Create.
//   POST /sitemap {"url", "sitemap"?, "limit", "include": ["/blog"], "exclude": ["/search"]}
//   → the site's pages from its sitemaps (a short crawl when it has none), within the rules;
//     with {"entries": true}, what /plan returns, for the sync
//   POST /pages {"urls": [... up to 20], "interactive"?: true}
//   → each page's title and main content as Markdown, its language, own dates and same-site
//     links, and the extractor version that read it. "interactive": a person is waiting (the
//     console checks a page added by hand before it's kept), so it runs in the interactive lane.
//   POST /check {"url"}
//   → a page's CSP, the widget's script tags and elements, whether it rendered, what it logged

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolveTheme, type SiteScan } from "@launchpad/theme";
import { type Blocked, botProtection } from "./blocked.ts";
import { deriveTheme, siteDetails } from "./derive.ts";
import { detectPlatform } from "./detect.ts";
import { checkInstall } from "./install.ts";
import { assertPublicUrl, safeFetchText, UnsafeUrlError } from "./net.ts";
import { crawlSite, fetchPages, fetchSitemapFile, findKeyPages, listSitemapPages, readSitemaps, type SitemapRead } from "./pages.ts";
import { closeBrowser, scanPage } from "./scan.ts";

const PORT = Number(process.env.PORT ?? 4100);
const TOKEN = process.env.SNIFFER_TOKEN;
if (!TOKEN) throw new Error("SNIFFER_TOKEN is not set.");
const MAX_PAGES_PER_REQUEST = 20;
const MAX_SITEMAP_LIMIT = 5000;
const MAX_CRAWL_PAGES = 200;
const MAX_PROBES = 30;

// Two lanes, so a sync's page loads never make a partner wait: scans, install checks and the
// content plan have their own capacity, and sync requests theirs. A full lane queues requests
// for a while rather than turning them away.
class Lane {
  private running = 0;
  private waiting: (() => void)[] = [];
  private readonly limit: number;
  private readonly maxWaiting: number;
  constructor(limit: number, maxWaiting: number) {
    this.limit = limit;
    this.maxWaiting = maxWaiting;
  }
  // undefined when even the queue is full.
  async run<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (this.running >= this.limit) {
      if (this.waiting.length >= this.maxWaiting) return undefined;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running += 1;
    try {
      return await work();
    } finally {
      this.running -= 1;
      this.waiting.shift()?.();
    }
  }
}
const interactive = new Lane(4, 12);
// Three: the worker loads its batches side by side.
const sync = new Lane(3, 6);
const LANES: Record<string, Lane> = {
  "/scan": interactive,
  "/check": interactive,
  "/plan": interactive,
  "/probe": interactive,
  "/sitemap": sync,
  "/pages": sync,
};

// Anything but a 200 is a failure the reader may try again and reports, never an empty file
// (pages.ts fetchSitemapFile: gzipped files are read, and a bot-protection page stops the read).
// Each file read is kept for half an hour (up to about 200 MB in all), so the read after an
// incomplete one (the first sync's, after the plan's) fetches only the files that failed or
// weren't reached, and a site that rate-limits is completed rather than started over.
const FILE_TTL_MS = 30 * 60_000;
const FILE_CACHE_CHARS = 200_000_000;
const sitemapFiles = new Map<string, { at: number; text: string }>();
const fetchSitemap = async (u: string) => {
  const kept = sitemapFiles.get(u);
  if (kept && Date.now() - kept.at < FILE_TTL_MS) return kept.text;
  const text = await fetchSitemapFile(u);
  sitemapFiles.set(u, { at: Date.now(), text });
  let chars = 0;
  for (const [url, file] of [...sitemapFiles].reverse()) {
    chars += file.text.length;
    if (chars > FILE_CACHE_CHARS || Date.now() - file.at >= FILE_TTL_MS) sitemapFiles.delete(url);
  }
  return text;
};

// The plan, the scan's page count and the first sync read the same sitemaps minutes apart:
// one read per site for 10 minutes, so they agree on the count and the site is read once.
const SITEMAP_TTL_MS = 10 * 60_000;
const sitemapReads = new Map<string, { at: number; read: Promise<SitemapRead> }>();
// The sync's reads (the worker waits up to 2 minutes) may take longer than the plan's 25 s: a site
// that rate-limits is read one file at a time.
const SYNC_READ_MS = 90_000;
function sitemapsOf(site: URL, sitemap?: URL, deadlineMs?: number): Promise<SitemapRead> {
  const key = `${site.hostname.replace(/^www\./, "")} ${sitemap?.href ?? ""}`;
  const cached = sitemapReads.get(key);
  if (cached && Date.now() - cached.at < SITEMAP_TTL_MS) return cached.read;
  const read = readSitemaps(site.origin, fetchSitemap, { ...(sitemap && { sitemap: sitemap.href }), ...(deadlineMs && { deadlineMs }) });
  sitemapReads.set(key, { at: Date.now(), read });
  // An incomplete read isn't kept: the next one (the first sync's, a minute after Create) tries
  // the files that failed again.
  read.then(
    (r) => {
      if (r.failed.length || r.unread.length || r.blocked) sitemapReads.delete(key);
    },
    () => sitemapReads.delete(key),
  );
  // A few sites at most: each read can hold 100,000 entries.
  for (const [k, v] of sitemapReads) if (sitemapReads.size > 6 || Date.now() - v.at >= SITEMAP_TTL_MS) sitemapReads.delete(k);
  return read;
}

// Whether the start page comes back as a bot-protection page, fetched as the sitemaps are (not
// rendered: a firewall answers that within a second or two). Kept 10 minutes per address, so the
// plan's recomputations ask once.
const START_CHECK_MS = 8_000;
const startChecks = new Map<string, { at: number; check: Promise<Blocked | undefined> }>();
function startPageBlocked(site: URL): Promise<Blocked | undefined> {
  const cached = startChecks.get(site.href);
  if (cached && Date.now() - cached.at < SITEMAP_TTL_MS) return cached.check;
  const check = safeFetchText(site.href, { maxBytes: 3_000_000, timeoutMs: START_CHECK_MS }).then(
    (res) => {
      const by = botProtection(res, "html");
      return by ? { url: res.url, status: res.status, by } : undefined;
    },
    () => undefined,
  );
  startChecks.set(site.href, { at: Date.now(), check });
  for (const [k, v] of startChecks) if (startChecks.size > 20 || Date.now() - v.at >= SITEMAP_TTL_MS) startChecks.delete(k);
  return check;
}

// The pricing and contact pages the listed addresses don't name (findKeyPages), kept a while so
// the plan and the first sync make these requests once.
const KEY_PAGES_MS = 10 * 60_000;
const keyPagesFound = new Map<string, { at: number; pages: Promise<{ found: string[]; unreached: string[] }> }>();
function keyPagesFor(site: URL, listed: readonly string[]) {
  const kept = keyPagesFound.get(site.origin);
  if (kept && Date.now() - kept.at < KEY_PAGES_MS) return kept.pages;
  const pages = findKeyPages(site.origin, listed, (url) => safeFetchText(url, { maxBytes: 3_000_000, timeoutMs: 5_000, maxRedirects: 5 }));
  for (const [key, value] of keyPagesFound) if (Date.now() - value.at >= KEY_PAGES_MS) keyPagesFound.delete(key);
  keyPagesFound.set(site.origin, { at: Date.now(), pages });
  return pages;
}
// A sitemap read with the key pages it doesn't list added. Nothing is added to an empty read (the
// crawl adds them) or a blocked one; what couldn't be reached counts as unread.
async function withKeyPages(site: URL, read: SitemapRead): Promise<SitemapRead> {
  if (!read.entries.length || read.blocked) return read;
  const { found, unreached } = await keyPagesFor(
    site,
    read.entries.map((e) => e.url),
  );
  if (!found.length && !unreached.length) return read;
  return {
    ...read,
    entries: [...read.entries, ...found.map((url) => ({ url }))],
    ...(found.length && { found }),
    unread: [...new Set([...read.unread, ...unreached])],
  };
}

// A finished read waits this long after the plan started for the start page's check.
const START_WAIT_MS = 3_000;
const never = new Promise<never>(() => {});

// The plan's read, answered early when the start page is blocked (the read goes on, and is kept).
async function plan(site: URL, sitemap: URL | undefined) {
  const started = Date.now();
  const reading = sitemapsOf(site, sitemap);
  const start = startPageBlocked(site);
  const first = await Promise.race([reading, start.then((b) => (b ? { early: b } : never))]);
  const ms = () => Date.now() - started;
  if ("early" in first) {
    const empty: SitemapRead = {
      sitemaps: [],
      files: 0,
      entries: [],
      truncated: true,
      discovery: { how: "robots", elsewhere: [], used: [] },
      failed: [],
      unread: [],
    };
    return { ...empty, blocked: first.early, total: 0, ms: ms() };
  }
  const late =
    first.blocked ??
    (await Promise.race([start, new Promise<undefined>((resolve) => setTimeout(resolve, Math.max(0, START_WAIT_MS - ms())))]));
  const read = late ? first : await withKeyPages(site, first);
  return { ...read, ...(late && { blocked: late }), total: first.entries.length, ms: ms() };
}

// Each address's status, final address and title, a few at a time (the plan's key pages).
async function probe(urls: string[]) {
  const results: { url: string; status: number; finalUrl?: string; title?: string; blocked?: string; error?: string }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++]!;
      try {
        const res = await safeFetchText(url, { maxBytes: 3_000_000, timeoutMs: 8_000, maxRedirects: 5 });
        const title = /<title[^>]*>([^<]{0,300})<\/title>/i
          .exec(res.text)?.[1]
          ?.replace(/\s+/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&#0?39;|&apos;/g, "'")
          .replace(/&quot;/g, '"')
          .trim();
        const by = botProtection(res, "html");
        results.push({ url, status: res.status, finalUrl: res.url, ...(title && { title }), ...(by && { blocked: by }) });
      } catch (err) {
        results.push({ url, status: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, urls.length) }, worker));
  return urls.map((url) => results.find((r) => r.url === url)!);
}

async function scan(rawUrl: string): Promise<SiteScan> {
  const url = await assertPublicUrl(rawUrl);
  // The sitemaps are read while the page loads; the count is the content plan's.
  const early = sitemapsOf(url).catch(() => undefined);
  const page = await scanPage(url);
  const final = new URL(page.finalUrl);
  const sameSite = final.hostname.replace(/^www\./, "") === url.hostname.replace(/^www\./, "");
  const sitemap = await (sameSite ? early : sitemapsOf(await assertPublicUrl(final.origin)).catch(() => undefined));

  const derived = deriveTheme(page.raw);
  const { theme, warnings } = resolveTheme(derived.input);
  return {
    url: url.href,
    finalUrl: page.finalUrl,
    status: page.status,
    platform: detectPlatform(page.html),
    sitemaps: sitemap?.sitemaps ?? [],
    sitemapPages: sitemap?.entries.length ?? 0,
    sitemapTruncated: sitemap?.truncated ?? false,
    theme,
    confidence: derived.confidence,
    sources: derived.sources,
    warnings,
    ...(page.raw.logo && { logo: page.raw.logo }),
    icons: page.raw.icons,
    ...siteDetails(page.raw, page.finalUrl),
    screenshot: `data:image/jpeg;base64,${page.screenshot}`,
  };
}

const strings = (value: unknown, max: number): string[] =>
  (Array.isArray(value) ? value : []).filter((v): v is string => typeof v === "string").slice(0, max);

// The sitemap address a partner entered, checked like any address the sniffer loads.
const givenSitemap = async (body: Record<string, unknown>) =>
  typeof body.sitemap === "string" && body.sitemap.trim() ? assertPublicUrl(body.sitemap.trim()) : undefined;

const ROUTES: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  "/scan": (body) => scan(String(body.url ?? "")),
  "/plan": async (body) => plan(await assertPublicUrl(String(body.url ?? "")), await givenSitemap(body)),
  "/probe": async (body) => {
    const urls = strings(body.urls, MAX_PROBES);
    for (const url of urls) await assertPublicUrl(url);
    return { pages: await probe(urls) };
  },
  "/sitemap": async (body) => {
    const site = await assertPublicUrl(String(body.url ?? ""));
    const sitemap = await givenSitemap(body);
    // The sync's own read of the plan's entries, in the sync lane.
    if (body.entries === true) {
      const read = await sitemapsOf(site, sitemap, SYNC_READ_MS);
      return { ...(await withKeyPages(site, read)), total: read.entries.length };
    }
    const limit = Math.min(Math.max(Number(body.limit) || 100, 1), MAX_SITEMAP_LIMIT);
    const rules = { include: strings(body.include, 50), exclude: strings(body.exclude, 50) };
    const listing = listSitemapPages(await sitemapsOf(site, sitemap, SYNC_READ_MS), { limit, ...rules });
    if (listing.total > 0) return { ...listing, discovery: "sitemap" };
    // No usable sitemap: crawl from the given page instead, more modestly.
    const crawled = await crawlSite(site.href, { limit: Math.min(limit, MAX_CRAWL_PAGES), ...rules });
    const { found } = await keyPagesFor(site, crawled);
    const urls = [...crawled, ...found.filter((url) => !crawled.includes(url))];
    return { sitemaps: listing.sitemaps, urls, total: urls.length, discovery: "crawl" };
  },
  "/check": async (body) => checkInstall((await assertPublicUrl(String(body.url ?? ""))).href),
  "/pages": async (body) => {
    const urls = strings(body.urls, MAX_PAGES_PER_REQUEST);
    for (const url of urls) await assertPublicUrl(url);
    return { pages: await fetchPages(urls) };
  },
};

function authorised(req: IncomingMessage): boolean {
  const given = Buffer.from(String(req.headers["x-sniffer-token"] ?? ""));
  const expected = Buffer.from(TOKEN!);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new UnsafeUrlError("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
  const route = req.method === "POST" ? ROUTES[req.url ?? ""] : undefined;
  if (!route) return send(res, 404, { error: "Not found" });
  if (!authorised(req)) return send(res, 401, { error: "Unauthorised" });

  try {
    const body = await readJson(req, 64 * 1024);
    // A few pages a person is waiting for go in the interactive lane, not behind the syncs.
    const lane = req.url === "/pages" && body.interactive === true && strings(body.urls, 99).length <= 5 ? interactive : LANES[req.url!]!;
    const result = await lane.run(() => route(body));
    if (result === undefined) return send(res, 429, { error: "Busy; retry shortly." });
    send(res, 200, result);
  } catch (err) {
    if (err instanceof UnsafeUrlError || err instanceof SyntaxError) return send(res, 400, { error: err.message });
    console.error(`[sniffer] ${req.url} failed:`, err instanceof Error ? err.message : err);
    send(res, 502, { error: "The site could not be scanned." });
  }
});

server.listen(PORT, () => console.log(`[sniffer] listening on :${PORT}`));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close();
    void closeBrowser().finally(() => process.exit(0));
  });
}
