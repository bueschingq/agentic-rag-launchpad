// Loads a page in headless Chromium and reads its computed styles. Every request the page
// makes (scripts, images, iframes, redirects) goes through the same public-address check.

import { type Browser, chromium } from "playwright";
import { extractStyles, type RawStyles } from "./extract.ts";
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

export async function scanPage(url: URL, opts: { timeoutMs?: number } = {}): Promise<PageScan> {
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

  const page = await context.newPage();
  try {
    const response = await page.goto(url.href, { waitUntil: "load", timeout: opts.timeoutMs ?? 20_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const raw = await page.evaluate(extractStyles);
    return {
      finalUrl: page.url(),
      status: response?.status() ?? 0,
      html: await page.content(),
      raw,
      screenshot: (await page.screenshot({ type: "jpeg", quality: 70 })).toString("base64"),
    };
  } finally {
    await context.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) await (await browser).close();
  browser = undefined;
}
