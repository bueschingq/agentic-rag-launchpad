// Platform and sitemap detection from fetched HTML and robots.txt.
// M0: Sitefinity sites often strip the generator meta tag (crayola.com did), so markup
// fingerprints carry most of the weight.

export interface PlatformGuess {
  platform: "sitefinity" | "wordpress" | "drupal" | "sitecore" | "unknown";
  version?: string;
  evidence: string[];
}

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

export function sitemapsFromRobots(robotsTxt: string, origin: string): string[] {
  const listed = [...robotsTxt.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]!);
  const urls = listed.flatMap((u) => {
    try {
      return [new URL(u, origin).href];
    } catch {
      return [];
    }
  });
  return urls.length ? [...new Set(urls)] : [new URL("/sitemap.xml", origin).href];
}

export function parseSitemap(xml: string): { kind: "index" | "urlset" | "unknown"; locs: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) =>
    m[1]!.replace(/&amp;/g, "&"),
  );
  const kind = /<sitemapindex[\s>]/i.test(xml) ? "index" : /<urlset[\s>]/i.test(xml) ? "urlset" : "unknown";
  return { kind, locs };
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
