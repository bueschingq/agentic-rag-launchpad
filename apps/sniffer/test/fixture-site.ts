// A test site for the sync's site reading, on this machine (round 6, item 2): a Sitefinity-like
// site whose robots.txt lists a gzipped sitemap index of gzipped sitemaps, and which answers 429
// (with Retry-After: 1) above `rate` requests a second, the start page included. It doesn't
// depend on the review environment or the network. With blocked: true, every address answers
// Cloudflare's challenge page instead.
//
//   const site = await startFixtureSite({ rate: 2 });
//   ... site.origin, site.pages, site.stats ...
//   await site.close();
//
// The sniffer loads it with SNIFFER_ALLOW_LOOPBACK=1 (net.ts), as in development.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

export interface FixtureSite {
  origin: string;
  // Every page the sitemaps list, as addresses.
  pages: string[];
  stats: { requests: number; served: number; limited: number; byPath: Map<string, number> };
  close(): Promise<void>;
}

const PATHS = [
  "/",
  "/pricing",
  "/plans",
  "/technical-support",
  "/product-feature/regulatory-compliance-support",
  "/contact-us",
  "/events",
  "/events/automation-summit-2026",
  "/events/open-house-2026",
  ...Array.from({ length: 24 }, (_, i) => `/products/gateway-${i + 1}`),
  ...Array.from({ length: 12 }, (_, i) => `/de/produkte/gateway-${i + 1}`),
];

const TITLES: Record<string, string> = {
  "/": "Fixture Networks - Industrial communication",
  "/pricing": "Plans &amp; Pricing - Fixture Networks",
  "/plans": "Plans &amp; Pricing - Fixture Networks",
  "/technical-support": "Technical support for Fixture products",
  "/contact-us": "Contact Fixture Networks",
};

function pageHtml(path: string): string {
  const title = TITLES[path] ?? `Fixture page ${path}`;
  const prices =
    path === "/plans"
      ? "<h5>Advanced</h5><p>$ 18.15</p><p>$ 16.50</p><p>Per user/month Minimum of 3 users</p><h5>Premium</h5><p>$ 28.59</p><p>$ 26.00</p>"
      : "";
  return `<!doctype html><html lang="${path.startsWith("/de/") ? "de" : "en"}"><head><title>${title}</title></head><body><main><h1>${title}</h1>${prices}<p>${"This fixture page states what a visitor needs to know about it. ".repeat(8)}</p></main></body></html>`;
}

const urlset = (origin: string, paths: readonly string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
    .map((p) => `<url><loc>${origin}${p}</loc><lastmod>2026-10-01</lastmod></url>`)
    .join("")}</urlset>`;

const CHALLENGE =
  '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><div id="challenge"><noscript>Enable JavaScript and cookies to continue</noscript></div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>';

export async function startFixtureSite(opts: { rate?: number; blocked?: boolean } = {}): Promise<FixtureSite> {
  const rate = opts.rate ?? 2;
  const served: number[] = [];
  const stats = { requests: 0, served: 0, limited: 0, byPath: new Map<string, number>() };
  let origin = "";
  const files = (): Record<string, { body: Buffer | string; type: string; encoding?: string }> => {
    // Three sitemap files under a gzipped index: two gzipped files, and one served with
    // Content-Encoding: gzip (fetch undoes that one itself).
    const thirds = [PATHS.slice(0, 15), PATHS.slice(15, 30), PATHS.slice(30)];
    const index = `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[
      "/sitemap/pages-1.xml.gz",
      "/sitemap/pages-2.xml.gz",
      "/sitemap/pages-3.xml",
    ]
      .map((p) => `<sitemap><loc>${origin}${p}</loc></sitemap>`)
      .join("")}</sitemapindex>`;
    return {
      "/robots.txt": { body: `User-agent: *\nDisallow: /sitefinity\nSitemap: ${origin}/sitemap/sitemap.gz\n`, type: "text/plain" },
      "/sitemap/sitemap.gz": { body: gzipSync(index), type: "application/x-gzip" },
      "/sitemap/pages-1.xml.gz": { body: gzipSync(urlset(origin, thirds[0]!)), type: "application/octet-stream" },
      "/sitemap/pages-2.xml.gz": { body: gzipSync(urlset(origin, thirds[1]!)), type: "application/x-gzip" },
      "/sitemap/pages-3.xml": { body: gzipSync(urlset(origin, thirds[2]!)), type: "application/xml", encoding: "gzip" },
    };
  };

  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    stats.requests += 1;
    stats.byPath.set(path, (stats.byPath.get(path) ?? 0) + 1);
    if (opts.blocked) {
      res.writeHead(403, {
        "Content-Type": "text/html; charset=UTF-8",
        Server: "cloudflare",
        "cf-mitigated": "challenge",
        "cf-ray": "8f0-LHR",
      });
      res.end(CHALLENGE);
      return;
    }
    const now = Date.now();
    while (served.length && served[0]! <= now - 1000) served.shift();
    if (served.length >= rate) {
      stats.limited += 1;
      res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "1" });
      res.end("Too Many Requests");
      return;
    }
    served.push(now);
    stats.served += 1;
    const file = files()[path];
    if (file) {
      res.writeHead(200, { "Content-Type": file.type, ...(file.encoding && { "Content-Encoding": file.encoding }) });
      res.end(file.body);
      return;
    }
    if (PATHS.includes(path)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pageHtml(path));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("<html><head><title>Not found</title></head><body>Not found</body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    pages: PATHS.map((p) => `${origin}${p}`),
    stats,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
