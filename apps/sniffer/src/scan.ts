// Loads a page in headless Chromium and reads its computed styles. Every request the page
// makes (scripts, images, iframes, redirects) goes through the same public-address check.

import { type Browser, type BrowserContext, chromium, type Page, type Request } from "playwright";
import { extractStyles, hideOverlays, measureIcons, type RawStyles } from "./extract.ts";
import { assertPublicUrl, USER_AGENT } from "./net.ts";

export interface PageScan {
  finalUrl: string;
  status: number;
  html: string;
  raw: RawStyles;
  // JPEG, base64: the theme editor previews the widget on top of it (most sites forbid iframes).
  screenshot: string;
}

let browser: Promise<Browser> | undefined;

// A browser context whose every request passes the public-address check. Close it when done.
export async function guardedContext(): Promise<BrowserContext> {
  browser ??= chromium.launch();
  const context = await (await browser).newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: USER_AGENT,
    serviceWorkers: "block",
    acceptDownloads: false,
  });

  const allowedHosts = new Map<string, Promise<boolean>>();
  await context.route("**/*", async (route) => {
    const target = new URL(route.request().url());
    if (route.request().method() !== "GET" && readingOnly(route.request())) return route.abort("blockedbyclient").catch(() => {});
    if (target.protocol === "data:" || target.protocol === "blob:") return route.continue();
    let verdict = allowedHosts.get(target.host);
    if (!verdict) {
      verdict = assertPublicUrl(target.href).then(
        () => true,
        () => false,
      );
      allowedHosts.set(target.host, verdict);
    }
    return (await verdict) ? route.continue() : route.abort("blockedbyclient");
  });
  return context;
}

// Pages whose toggles are being operated (pages.ts operateToggles): only GET requests leave them,
// so a click can't change anything on the site.
export const readOnlyPages = new WeakSet<Page>();
const readingOnly = (request: Request): boolean => {
  try {
    return readOnlyPages.has(request.frame().page());
  } catch {
    return false;
  }
};

export async function scanPage(url: URL, opts: { timeoutMs?: number } = {}): Promise<PageScan> {
  const context = await guardedContext();
  const page = await context.newPage();
  try {
    const response = await page.goto(url.href, { waitUntil: "load", timeout: opts.timeoutMs ?? 20_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const raw = await page.evaluate(extractStyles);
    // How big the icons really are, for the avatar: most favicons declare no size.
    raw.iconLinks = await page.evaluate(measureIcons, raw.iconLinks ?? []).catch(() => raw.iconLinks);
    raw.icons = (raw.iconLinks ?? []).map((i) => i.url);
    return {
      finalUrl: page.url(),
      status: response?.status() ?? 0,
      html: await page.content(),
      raw,
      // With cookie walls and chat widgets hidden, so the preview shows the site itself.
      screenshot: await page
        .evaluate(hideOverlays)
        .catch(() => 0)
        .then(() => page.screenshot({ type: "jpeg", quality: 70 }))
        .then((jpeg) => jpeg.toString("base64")),
    };
  } finally {
    await context.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) await (await browser).close();
  browser = undefined;
}
