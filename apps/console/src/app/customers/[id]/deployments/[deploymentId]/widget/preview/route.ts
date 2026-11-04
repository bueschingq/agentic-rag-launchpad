// The page inside the configurator's preview frame: the customer's site as a screenshot (most
// sites refuse to be framed) with a real <arag-chat> on top. The configurator posts each
// draft here; the widget's events go back to it for the analytics list.
//
// The widget uses fonts already on the page, so this page loads the web fonts the scan found
// on the site, where their host allows it, and tells the configurator which it couldn't.
//
// The screenshot is taken with cookie bars hidden, so a bar the scan measured along the bottom
// of the window is drawn back as a labelled, hatched band at its height: the chat button lifts
// above it as it will on the site (or doesn't, with the lift turned off).

import { allWidgetStrings, type BottomBar, type SiteScanExtras } from "@launchpad/theme";
import { loadWidgetPage } from "@/lib/widget.ts";
import { previewFonts } from "@/lib/widget-form.ts";

type Params = { params: Promise<{ id: string; deploymentId: string }> };

// JSON inside <script>: "<" escaped, so no value can close the tag.
const inline = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The bar the scan measured, as a band: its label says what it is and where that came from.
function scannedBar(result: object | undefined): string {
  const bar = (result as SiteScanExtras | undefined)?.bottomBar as BottomBar | undefined;
  const height = Math.round(Number(bar?.height));
  if (!bar || !Number.isFinite(height) || height < 8 || height > 400) return "";
  const label = String(bar.label ?? "").slice(0, 80);
  // "OneTrust cookie banner" reads as is; a bare selector ("#bottom-nav") says what it is.
  const what = /\s/.test(label) || /^[A-Z]/.test(label) ? label : `A bar along the bottom (${label})`;
  return `<div class="scan-bar" role="note" style="height:${height}px"><span>${escapeHtml(`${what}, from the scan: ${height} px`)}</span></div>`;
}

export async function GET(_request: Request, { params }: Params) {
  const { id, deploymentId } = await params;
  const page = await loadWidgetPage(id, deploymentId);
  if (!page) return new Response("Not found", { status: 404 });

  const base = `/customers/${id}/deployments/${deploymentId}/widget`;
  // Keyed on the scan's time: a rescan replaces the row but not its id.
  const screenshot = page.scan && `${base}/screenshot?v=${page.scan.createdAt.getTime()}`;
  // Before a scan: a plain stand-in page, so the widget is still seen against something.
  const background = screenshot ? `#fff url("${screenshot}") top center / 1366px auto no-repeat` : "#eef0f3";
  const fonts = previewFonts(page.scan?.result);
  const bar = scannedBar(page.scan?.result);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Widget preview</title>
<style>
  html, body { margin: 0; }
  body { min-height: 100vh; background: ${background}; font-family: system-ui, sans-serif; }
  /* The phone frame: the desktop screenshot, shrunk to the width. */
  @media (max-width: 480px) { body { background-size: 100% auto; } }
  .mock { position: absolute; inset: 0; pointer-events: none; }
  .mock div { margin: 24px auto; width: min(860px, calc(100% - 48px)); border-radius: 8px; background: #dde1e7; }
  #slot { position: relative; width: min(560px, calc(100% - 32px)); margin: 80px auto; }
  body[data-mode="embedded"] #slot, body[data-mode="popup"] #slot {
    padding: 20px; border-radius: 12px; background: rgb(255 255 255 / 0.95); box-shadow: 0 8px 32px rgb(0 0 0 / 0.18);
  }
  /* The cookie bar the scan measured: fixed along the bottom, like the real one, so the chat
     button's lift finds it. */
  .scan-bar {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 1000; display: flex; align-items: center; padding: 0 16px;
    background: repeating-linear-gradient(135deg, rgb(31 41 55 / 0.88) 0 10px, rgb(55 65 81 / 0.88) 10px 20px);
    color: #fff; font: 600 13px/1.3 system-ui, sans-serif; box-sizing: border-box;
  }
  .scan-bar span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 2px 6px; border-radius: 4px; background: rgb(17 24 39 / 0.9); }
</style>
<script src="/arag-chat.js"></script>
</head>
<body>
${page.scan ? "" : '<div class="mock" aria-hidden="true"><div style="height:56px"></div><div style="height:220px"></div><div style="height:120px"></div></div>'}
<div id="slot"><arag-chat></arag-chat></div>
${bar}
<script>
  const chat = document.querySelector("arag-chat");
  const ask = { live: ${inline(`${base}/preview/ask`)}, sample: ${inline(`${base}/preview/sample`)} };

  // The site's web fonts: services' stylesheets, and faces from its own CSS. Hosts that only
  // serve their own domains refuse; the configurator labels those.
  const loading = ${inline(fonts)}.map((f) => {
    if (f.kind === "stylesheet") {
      return new Promise((done) => {
        const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: f.url, referrerPolicy: "no-referrer" });
        link.onload = link.onerror = done;
        document.head.append(link);
      });
    }
    const face = new FontFace(f.family, "url(" + JSON.stringify(f.url) + ")", { weight: f.weight || "normal", style: f.style || "normal" });
    return face.load().then((loaded) => document.fonts.add(loaded), () => {});
  });
  const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont|inherit|initial)$/i;
  const firstFamily = (stack) => (stack || "").split(",")[0].trim().replace(/^["']|["']$/g, "");
  const ctx = document.createElement("canvas").getContext("2d");
  const width = (font) => ((ctx.font = font), ctx.measureText("mmmmmmmmmmlli1WQ@#&").width);
  // A font is there when text set in it measures differently from every generic fallback.
  const available = (family) => ["monospace", "serif", "sans-serif"].some((g) => width('40px "' + family + '", ' + g) !== width("40px " + g));
  let checked = "";
  async function checkFonts(theme) {
    const families = [...new Set([firstFamily(theme.font.family), firstFamily(theme.font.headingFamily)])].filter((f) => f && !GENERIC.test(f));
    const key = families.join("|");
    if (key === checked) return;
    checked = key;
    await Promise.allSettled([...loading, ...families.map((f) => document.fonts.load('16px "' + f + '"'))]);
    parent.postMessage({ type: "arag-chat-fonts", missing: families.filter((f) => !available(f)) }, location.origin);
  }

  addEventListener("message", (e) => {
    if (e.origin !== location.origin || e.source !== parent) return;
    // The console asks again in case it missed the ready message below.
    if (e.data?.type === "arag-chat-preview-hello") return parent.postMessage({ type: "arag-chat-preview-ready" }, location.origin);
    if (e.data?.type !== "arag-chat-preview") return;
    const { answers, language, siteUrl } = e.data;
    const drafted = answers === "offline" ? { ...e.data.config, online: false } : e.data.config;
    const config = { ...drafted, strings: ${inline(allWidgetStrings())} };
    document.body.dataset.mode = config.settings.mode;
    // A person looking at the preview is a visitor with their browser's language: this frame's own
    // <html lang="en"> isn't the site's, and made an "auto" chat's text English, card included,
    // beside a German no-answer (round 7).
    chat.setAttribute("language", language || navigator.language || "en");
    // The sample route reads the kind of reply from the token the widget sends as ?eph-token=.
    const askUrl = new URL(answers === "live" ? ask.live : ask.sample, location.href).href;
    const token = answers === "none" ? "no-answer" : "preview";
    chat.preview(config, {
      open: true,
      siteUrl,
      fetchToken: async () => ({ token, askUrl, expiresIn: 3600, expiresAt: new Date(Date.now() + 3600000).toISOString() }),
    });
    void checkFonts(config.theme);
  });
  chat.addEventListener("arag-chat:event", (e) => parent.postMessage({ type: "arag-chat-event", event: e.detail }, location.origin));
  parent.postMessage({ type: "arag-chat-preview-ready" }, location.origin);
</script>
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "SAMEORIGIN" },
  });
}
