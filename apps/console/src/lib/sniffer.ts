// Client for the style sniffer (apps/sniffer), an internal service the console calls to scan
// a customer's site for its look and read its sitemaps for the content plan. Failures come
// back as messages a partner can act on.

import type { SiteScan } from "@launchpad/theme";
import type { LoadedPage, PlanEntry, SitemapDiscovery } from "./content-plan.ts";

// A scan loads the page (up to 20 s), waits for it to settle, and reads the sitemap.
const SCAN_TIMEOUT_MS = 60_000;
// The sniffer stops reading sitemaps after 25 s and answers with what it has.
const PLAN_TIMEOUT_MS = 45_000;

export class ScanError extends Error {}

// Read on their own, like publicBaseUrl(): scanning needs no Agentic RAG credentials.
export function snifferSettings(e: NodeJS.ProcessEnv = process.env): { url: string; token: string } | undefined {
  const url = e.SNIFFER_URL?.trim().replace(/\/$/, "");
  const token = e.SNIFFER_TOKEN?.trim();
  return url && token ? { url, token } : undefined;
}

export async function scanSite(siteUrl: string, settings = snifferSettings(), fetchImpl: typeof fetch = fetch): Promise<SiteScan> {
  if (!settings) throw new ScanError("Site scans need SNIFFER_URL and SNIFFER_TOKEN in the console's environment.");
  let res: Response;
  try {
    res = await fetchImpl(`${settings.url}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sniffer-token": settings.token },
      body: JSON.stringify({ url: siteUrl }),
      signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") throw new ScanError("The scan took over a minute. Try again shortly.");
    throw new ScanError(`The sniffer isn't reachable at ${settings.url}. Check that it's running.`);
  }
  if (res.ok) return (await res.json()) as SiteScan;

  const detail = await res
    .json()
    .then((body: unknown) => {
      const error = (body as { error?: unknown } | null)?.error;
      return typeof error === "string" ? error : "";
    })
    .catch(() => "");
  if (res.status === 400) throw new ScanError(`This address can't be scanned: ${detail || "it was refused"}`);
  if (res.status === 401) throw new ScanError("The sniffer refused the console's token. Check that SNIFFER_TOKEN matches on both.");
  if (res.status === 429) throw new ScanError("The sniffer is busy with other scans. Try again in a minute.");
  throw new ScanError("The site didn't load in the scanner. It may be down, slow, or blocking automated browsers.");
}

export interface SitemapEntries {
  sitemaps: string[];
  files: number;
  entries: PlanEntry[];
  // Every page the sitemaps list (up to the sniffer's cap): the one count.
  total: number;
  truncated: boolean;
  ms: number;
  // Which files gave the pages, and why those (discoveryNote words it).
  discovery?: SitemapDiscovery;
  // Files that couldn't be read even when tried again, and files not reached in time: the read
  // is incomplete (incompleteNote words it). Missing from a sniffer older than round 6.
  failed?: { url: string; status?: number; reason: string }[];
  unread?: string[];
  // robots.txt, a sitemap or the start page came back as a bot-protection page (blockedNote).
  blocked?: { url: string; status?: number; by: string };
  // Files the site rate-limited (429) at least once (rateLimitNote).
  rateLimited?: number;
  // Of the files read, those gzipped; and pages no sitemap lists, found from the home page's links
  // or common addresses (in entries too).
  gzipped?: number;
  found?: string[];
}

// The site's sitemap entries for the content plan: no page is loaded, so this takes seconds.
// sitemap: an address the partner entered, read before robots.txt's.
export async function readSitemapEntries(
  siteUrl: string,
  settings = snifferSettings(),
  fetchImpl: typeof fetch = fetch,
  sitemap?: string,
): Promise<SitemapEntries> {
  if (!settings) throw new ScanError("The content plan needs SNIFFER_URL and SNIFFER_TOKEN in the console's environment.");
  let res: Response;
  try {
    res = await fetchImpl(`${settings.url}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sniffer-token": settings.token },
      body: JSON.stringify({ url: siteUrl, ...(sitemap && { sitemap }) }),
      signal: AbortSignal.timeout(PLAN_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError")
      throw new ScanError("Reading the sitemaps took over 45 seconds. Try again shortly.");
    throw new ScanError(`The sniffer isn't reachable at ${settings.url}. Check that it's running.`);
  }
  if (res.ok) return (await res.json()) as SitemapEntries;
  const detail = await res
    .json()
    .then((body: unknown) => {
      const error = (body as { error?: unknown } | null)?.error;
      return typeof error === "string" ? error : "";
    })
    .catch(() => "");
  if (res.status === 400) throw new ScanError(`This address can't be read: ${detail || "it was refused"}`);
  if (res.status === 401) throw new ScanError("The sniffer refused the console's token. Check that SNIFFER_TOKEN matches on both.");
  throw new ScanError("The site's sitemaps couldn't be read. It may be down or slow.");
}

// An address as the sniffer fetched it, without rendering: its status, final address and title.
export interface ProbedPage {
  url: string;
  status: number;
  finalUrl?: string;
  title?: string;
  blocked?: string;
  error?: string;
}

// Whether the plan's key pages load (a 404 "trial" page isn't taken: round 6, sharefile.com's
// /try/advanced-plan), with their titles. Undefined when the sniffer couldn't say in time (an
// older sniffer has no /probe): the plan goes by addresses alone then.
export async function probePages(
  urls: readonly string[],
  settings = snifferSettings(),
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 9_000,
): Promise<ProbedPage[] | undefined> {
  if (!settings || !urls.length) return undefined;
  try {
    const res = await fetchImpl(`${settings.url}/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sniffer-token": settings.token },
      body: JSON.stringify({ urls: urls.slice(0, 30) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { pages?: ProbedPage[] };
    return Array.isArray(body.pages) ? body.pages : undefined;
  } catch {
    return undefined;
  }
}

// A page the sniffer loaded: what the content rules read, and whether it loaded.
export type FetchedPage = LoadedPage & { status: number; error?: string };

// A few pages loaded now, in the sniffer's interactive lane (a sniffer older than the lane
// takes them in the sync lane): the dates and text a page added by hand is checked by before
// it's kept. Undefined when they couldn't be loaded in time; the worker checks again as it
// loads them.
export async function fetchPages(
  urls: readonly string[],
  settings = snifferSettings(),
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30_000,
): Promise<FetchedPage[] | undefined> {
  if (!settings || !urls.length) return undefined;
  try {
    const res = await fetchImpl(`${settings.url}/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sniffer-token": settings.token },
      body: JSON.stringify({ urls: urls.slice(0, 20), interactive: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { pages?: FetchedPage[] };
    return Array.isArray(body.pages) ? body.pages : undefined;
  } catch {
    return undefined;
  }
}
