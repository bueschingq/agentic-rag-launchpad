// The worker's client for the sniffer (apps/sniffer): which pages a site has, and their main
// content. Both run in the sniffer, which renders pages in a browser behind its SSRF guard.

import type { PlanEntry, SitemapDiscovery } from "../../console/src/lib/content-plan.ts";

export interface SiteListing {
  sitemaps: string[];
  urls: string[];
  total: number;
  // "sitemap", or "crawl" when the site has no usable sitemap.
  discovery: "sitemap" | "crawl";
}

// Every page in the site's sitemaps with its lastmod, priority and hreflang (no page loaded):
// what the content plan ranks, and which files gave them and why.
export interface SitemapEntries {
  sitemaps: string[];
  entries: PlanEntry[];
  total: number;
  truncated: boolean;
  discovery?: SitemapDiscovery;
  // Files that couldn't be read even when tried again, and files not reached in time.
  failed?: { url: string; status?: number; reason: string }[];
  unread?: string[];
  // robots.txt or a sitemap came back as a bot-protection page; files the site rate-limited.
  blocked?: { url: string; status?: number; by: string };
  rateLimited?: number;
}

export interface SitePage {
  url: string;
  finalUrl: string;
  status: number;
  title: string;
  description?: string;
  lang?: string;
  canonical?: string;
  noindex: boolean;
  markdown: string;
  words: number;
  links: string[];
  // The content area's characters (hidden text included) against the extract's, link text's
  // share of the extract, the page's own dates as it states them, and its structured-data
  // article type.
  rootChars?: number;
  textChars?: number;
  linkShare?: number;
  datePublished?: string;
  dateModified?: string;
  articleType?: string;
  published?: string;
  // The extractor version that read it; missing from a sniffer older than versions.
  extractor?: number;
  // The site rate-limited it (429 or 503) even after the sniffer's pauses: tried again later,
  // keeping any copy the chat has. retryAfterMs: the site's Retry-After, when it gave one.
  rateLimited?: boolean;
  retryAfterMs?: number;
  error?: string;
}

// An address fetched without rendering: whether a key page loads before the first sync takes it.
export interface ProbedPage {
  url: string;
  status: number;
  title?: string;
  blocked?: string;
}

export interface Sniffer {
  // sitemap: an address the partner entered, read before robots.txt's.
  sitemapEntries(site: string, sitemap?: string): Promise<SitemapEntries>;
  // The crawl, for sites without a sitemap.
  listPages(site: string, opts: { limit: number; include: string[]; exclude: string[] }): Promise<SiteListing>;
  fetchPages(urls: string[]): Promise<SitePage[]>;
  // Missing from a sniffer older than round 7 (its /probe answers 404): the sync goes without.
  probe?(urls: string[]): Promise<ProbedPage[]>;
}

export function snifferClient(url = process.env.SNIFFER_URL, token = process.env.SNIFFER_TOKEN): Sniffer | undefined {
  if (!url || !token) return undefined;
  const base = url.replace(/\/$/, "");
  const post = async <T>(path: string, body: unknown, timeoutMs: number): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sniffer-token": token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(`sniffer ${path} ${res.status}: ${json.error ?? "no detail"}`);
    return json;
  };
  return {
    sitemapEntries: (site, sitemap) => post<SitemapEntries>("/sitemap", { url: site, entries: true, ...(sitemap && { sitemap }) }, 120_000),
    listPages: (site, opts) => post<SiteListing>("/sitemap", { url: site, ...opts }, 180_000),
    fetchPages: async (urls) => (await post<{ pages: SitePage[] }>("/pages", { urls }, 300_000)).pages,
    probe: async (urls) => (await post<{ pages: ProbedPage[] }>("/probe", { urls }, 30_000)).pages,
  };
}
