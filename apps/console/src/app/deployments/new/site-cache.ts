// What New deployment reads while the partner fills in the form: each site's sitemap entries,
// which the plan is recomputed from as choices change, and scans waiting for the deployment to
// exist so they can be saved. Kept on globalThis: route handlers and server actions may be
// bundled apart, and must share it.

import type { SiteScan } from "@launchpad/theme";
import { type ProbedPage, probePages, readSitemapEntries, type SitemapEntries, scanSite } from "@/lib/sniffer.ts";

const ENTRIES_MS = 15 * 60_000;
const SCANS_MS = 30 * 60_000;

interface Caches {
  entries: Map<string, { at: number; read: Promise<SitemapEntries> }>;
  scans: Map<string, { at: number; host: string; scan: Promise<SiteScan | undefined> }>;
  probes?: Map<string, { at: number; page: ProbedPage }>;
}
const store = globalThis as { __launchpadNewDeployment?: Caches };
if (!store.__launchpadNewDeployment) store.__launchpadNewDeployment = { entries: new Map(), scans: new Map() };
const caches = store.__launchpadNewDeployment;

const hostOf = (site: string) => new URL(site).hostname.replace(/^www\./, "");

function prune<T extends { at: number }>(map: Map<string, T>, ttl: number, max: number) {
  for (const [key, value] of map) if (map.size > max || Date.now() - value.at > ttl) map.delete(key);
}

// One read per site (and sitemap address entered) while it's fresh: the plan as recomputed, and
// as stored on Create, comes from the same entries.
export function sitemapEntries(site: string, sitemap?: string): Promise<SitemapEntries> {
  const key = `${hostOf(site)} ${sitemap ?? ""}`;
  const cached = caches.entries.get(key);
  if (cached && Date.now() - cached.at < ENTRIES_MS) return cached.read;
  const read = readSitemapEntries(site, undefined, fetch, sitemap);
  caches.entries.set(key, { at: Date.now(), read });
  // An incomplete read (files that failed or weren't reached) is shown once, not kept: the next
  // change to the plan reads the site again.
  read.then(
    (r) => {
      if (r.failed?.length || r.unread?.length) caches.entries.delete(key);
    },
    () => caches.entries.delete(key),
  );
  prune(caches.entries, ENTRIES_MS, 4);
  return read;
}

// Whether each key page loads, kept for the plan's recomputations (each change can pick new ones).
// An address the sniffer couldn't answer for isn't kept, so the next change asks again.
export async function probedPages(urls: readonly string[]): Promise<Map<string, ProbedPage>> {
  caches.probes ??= new Map();
  const probes = caches.probes;
  const fresh = (url: string) => {
    const kept = probes.get(url);
    return kept && Date.now() - kept.at < ENTRIES_MS ? kept.page : undefined;
  };
  const wanted = [...new Set(urls)].filter((url) => !fresh(url));
  if (wanted.length) {
    for (const page of (await probePages(wanted)) ?? []) if (page.status) probes.set(page.url, { at: Date.now(), page });
    prune(probes, ENTRIES_MS, 400);
  }
  return new Map(urls.flatMap((url) => (fresh(url) ? [[url, fresh(url)!] as const] : [])));
}

export function startScan(token: string, site: string): Promise<SiteScan | undefined> {
  const existing = caches.scans.get(token);
  if (existing && existing.host === hostOf(site)) return existing.scan;
  const scan = scanSite(site);
  caches.scans.set(token, { at: Date.now(), host: hostOf(site), scan: scan.catch(() => undefined) });
  prune(caches.scans, SCANS_MS, 20);
  return scan;
}

// The scan the form started for this site, once (Create saves it).
export function takeScan(token: string | undefined, site: string): Promise<SiteScan | undefined> | undefined {
  const entry = token ? caches.scans.get(token) : undefined;
  if (!entry || entry.host !== hostOf(site)) return undefined;
  caches.scans.delete(token!);
  return entry.scan;
}
