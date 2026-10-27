// Internal HTTP service used by the console's provisioning wizard. Not exposed publicly:
// callers must send the shared SNIFFER_TOKEN.
//
//   POST /scan {"url": "https://www.example.com"}
//   → platform, sitemap page count, proposed theme (+ confidence, sources, warnings), screenshot

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolveTheme } from "@launchpad/theme";
import { deriveTheme } from "./derive.ts";
import { countSitemapPages, detectPlatform, sitemapsFromRobots } from "./detect.ts";
import { assertPublicUrl, safeFetchText, UnsafeUrlError } from "./net.ts";
import { closeBrowser, scanPage } from "./scan.ts";

const PORT = Number(process.env.PORT ?? 4100);
const TOKEN = process.env.SNIFFER_TOKEN;
if (!TOKEN) throw new Error("SNIFFER_TOKEN is not set.");
const MAX_CONCURRENT_SCANS = 2;
let running = 0;

async function scan(rawUrl: string) {
  const url = await assertPublicUrl(rawUrl);
  const page = await scanPage(url);
  const origin = new URL(page.finalUrl).origin;

  const robots = await safeFetchText(`${origin}/robots.txt`).catch(() => undefined);
  const sitemaps = sitemapsFromRobots(robots?.status === 200 ? robots.text : "", origin);
  const fetchText = async (u: string) => {
    const res = await safeFetchText(u);
    return res.status === 200 ? res.text : "";
  };
  const sitemap = await countSitemapPages(sitemaps[0]!, fetchText).catch(() => ({ pages: 0, truncated: false }));

  const derived = deriveTheme(page.raw);
  const { theme, warnings } = resolveTheme(derived.input);
  return {
    url: url.href,
    finalUrl: page.finalUrl,
    status: page.status,
    platform: detectPlatform(page.html),
    sitemaps,
    sitemapPages: sitemap.pages,
    sitemapTruncated: sitemap.truncated,
    theme,
    confidence: derived.confidence,
    sources: derived.sources,
    warnings,
    logo: page.raw.logo,
    icons: page.raw.icons,
    screenshot: `data:image/jpeg;base64,${page.screenshot}`,
  };
}

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
  if (req.method !== "POST" || req.url !== "/scan") return send(res, 404, { error: "Not found" });
  if (!authorised(req)) return send(res, 401, { error: "Unauthorised" });
  if (running >= MAX_CONCURRENT_SCANS) return send(res, 429, { error: "Busy; retry shortly." });

  running += 1;
  try {
    const body = await readJson(req, 4096);
    send(res, 200, await scan(String(body.url ?? "")));
  } catch (err) {
    if (err instanceof UnsafeUrlError || err instanceof SyntaxError) return send(res, 400, { error: err.message });
    console.error("[sniffer] scan failed:", err instanceof Error ? err.message : err);
    send(res, 502, { error: "The site could not be scanned." });
  } finally {
    running -= 1;
  }
});

server.listen(PORT, () => console.log(`[sniffer] listening on :${PORT}`));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close();
    void closeBrowser().finally(() => process.exit(0));
  });
}
