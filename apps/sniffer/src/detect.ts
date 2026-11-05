// Platform and sitemap detection from fetched HTML and robots.txt.
// M0: Sitefinity sites often strip the generator meta tag (crayola.com did), so markup
// fingerprints carry most of the weight.

import type { SitePlatform } from "@launchpad/theme";

export type PlatformGuess = SitePlatform;

const count = (html: string, re: RegExp) => html.match(re)?.length ?? 0;

export function generatorMeta(html: string): string | undefined {
  return (
    /<meta[^>]+name=["']generator["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ??
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']generator["']/i.exec(html)?.[1]
  );
}

export function detectPlatform(html: string): PlatformGuess {
  const generator = generatorMeta(html);
  const evidence: string[] = [];
  if (generator) evidence.push(`generator meta: ${generator}`);

  const sf = [
    ["data-sf- attributes", count(html, /\sdata-sf-[\w-]+=/gi)],
    ["Sitefinity resource paths", count(html, /\/(Sitefinity|sfres|ResourcePackages)\//gi)],
    ["Telerik.Sitefinity references", count(html, /Telerik\.Sitefinity/gi)],
  ] as const;
  for (const [label, n] of sf) if (n > 0) evidence.push(`${label}: ${n}`);

  if (/sitefinity/i.test(generator ?? "") || sf.some(([, n]) => n > 0)) {
    const version = /sitefinity\s+(\d+\.\d+(?:\.\d+)?)/i.exec(generator ?? "")?.[1];
    return { platform: "sitefinity", ...(version && { version }), evidence };
  }
  if (/wordpress/i.test(generator ?? "") || /\/wp-(content|includes)\//i.test(html)) return { platform: "wordpress", evidence };
  if (/drupal/i.test(generator ?? "") || /Drupal\.settings|\/sites\/default\/files\//.test(html)) return { platform: "drupal", evidence };
  if (/sitecore/i.test(generator ?? "") || /\/-\/media\//i.test(html)) return { platform: "sitecore", evidence };
  return { platform: "unknown", evidence };
}

// Where a site's own sitemap usually is, when robots.txt names none or names another site's:
// the usual place, Sitefinity's (its sitemap module publishes /sitemap/sitemap.xml), and the
// index WordPress SEO plugins publish.
export const SITEMAP_FALLBACKS = ["/sitemap.xml", "/sitemap/sitemap.xml", "/sitemap_index.xml"];

// The sitemaps robots.txt lists, as given (they may be on another host).
export function robotsSitemaps(robotsTxt: string, origin: string): string[] {
  const listed = [...robotsTxt.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]!);
  const urls = listed.flatMap((u) => {
    try {
      return [new URL(u, origin).href];
    } catch {
      return [];
    }
  });
  return [...new Set(urls)];
}

export function sitemapsFromRobots(robotsTxt: string, origin: string): string[] {
  const urls = robotsSitemaps(robotsTxt, origin);
  return urls.length ? urls : SITEMAP_FALLBACKS.map((path) => new URL(path, origin).href);
}

export function parseSitemap(xml: string): { kind: "index" | "urlset" | "unknown"; locs: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) =>
    m[1]!.replace(/&amp;/g, "&"),
  );
  const kind = /<sitemapindex[\s>]/i.test(xml) ? "index" : /<urlset[\s>]/i.test(xml) ? "urlset" : "unknown";
  return { kind, locs };
}

export interface SitemapEntry {
  url: string;
  // The sitemap's lastmod as a day (YYYY-MM-DD), when it gives a valid one.
  lastmod?: string;
  priority?: number;
  // The language the url's own hreflang link gives it (lower case), and how many languages its
  // links offer: a lone self-link is often a CMS default rather than a translation set.
  lang?: string;
  alternates?: number;
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

function day(raw: string | undefined): string | undefined {
  const t = raw ? Date.parse(raw.trim()) : Number.NaN;
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

// A sitemap file with each url's dates, priority and language: what the content plan reads.
export function parseSitemapEntries(xml: string): { kind: "index" | "urlset" | "unknown"; sitemaps: string[]; entries: SitemapEntry[] } {
  const parsed = parseSitemap(xml);
  if (parsed.kind !== "urlset") return { kind: parsed.kind, sitemaps: parsed.kind === "index" ? parsed.locs : [], entries: [] };
  const entries: SitemapEntry[] = [];
  for (const [, block] of xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
    const url = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)/i.exec(block!)?.[1]?.replace(/&amp;/g, "&");
    if (!url) continue;
    const entry: SitemapEntry = { url };
    const lastmod = day(/<lastmod>\s*([^<]+)</i.exec(block!)?.[1]);
    if (lastmod) entry.lastmod = lastmod;
    const priority = Number(/<priority>\s*([\d.]+)\s*</i.exec(block!)?.[1]);
    if (Number.isFinite(priority) && priority >= 0 && priority <= 1) entry.priority = priority;
    const links = [...block!.matchAll(/<(?:xhtml:)?link\b[^>]*>/gi)]
      .map(([tag]) => ({ lang: attr(tag, "hreflang")?.toLowerCase(), href: attr(tag, "href")?.replace(/&amp;/g, "&") }))
      .filter((l): l is { lang: string; href: string } => Boolean(l.lang && l.href && l.lang !== "x-default"));
    const self = links.find((l) => sameUrl(l.href, url));
    if (self) {
      entry.lang = self.lang;
      entry.alternates = new Set(links.map((l) => l.lang)).size;
    }
    entries.push(entry);
  }
  return { kind: "urlset", sitemaps: [], entries };
}

// Page count across a sitemap, following one level of sitemap index (up to `maxChildren`).
export async function countSitemapPages(
  url: string,
  fetchText: (url: string) => Promise<string>,
  maxChildren = 25,
): Promise<{ pages: number; truncated: boolean }> {
  const root = parseSitemap(await fetchText(url));
  if (root.kind !== "index") return { pages: root.locs.length, truncated: false };
  let pages = 0;
  for (const child of root.locs.slice(0, maxChildren)) {
    pages += parseSitemap(await fetchText(child).catch(() => "")).locs.length;
  }
  return { pages, truncated: root.locs.length > maxChildren };
}
