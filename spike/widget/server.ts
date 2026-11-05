// Runs the real <arag-chat> source in a browser without a bundler or npm: Node strips the
// TypeScript on the fly. Stands in for the console's two public endpoints, minting real
// ephemeral tokens for the M0 spike KB, whose allowed_origins is http://localhost:4173.
//
//   node spike/widget/server.ts   → http://localhost:4173/?theme=brand&mode=floating&finish=gloss&lang=es
//
// mode: embedded | chat | popup | floating · finish: flat | gloss | gradient · theme: brand | default
// lang: en | es | fr | de | nl | pt | it | auto (the page's English copy is used for en only)

import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { normalize, sep } from "node:path";
import { KbClient, zoneApi } from "../../packages/par-client/src/index.ts";
import {
  defaultWidgetSettings,
  FINISHES,
  type Finish,
  LANGUAGES,
  languageSetting,
  type PublicTokenResponse,
  type PublicWidgetConfig,
  resolveTheme,
  type ThemeInput,
  WIDGET_MODES,
  widgetMode,
} from "../../packages/theme/src/index.ts";
import { ROOT, readSecrets, readState } from "../lib.ts";

const PORT = 4173;
const TOKEN_TTL = 900;

// The browser resolves these bare imports to source files served below.
const ALIASES: Record<string, string> = {
  "@launchpad/par-client/ask-stream": "/packages/par-client/src/ask-stream.ts",
  "@launchpad/par-client": "/packages/par-client/src/index.ts",
  "@launchpad/theme": "/packages/theme/src/index.ts",
};

// "brand" is what the sniffer might propose for a teal-branded clinic site.
const THEMES: Record<string, ThemeInput> = {
  default: {},
  brand: {
    color: { primary: "#0f766e", onPrimary: "#ffffff", surfaceAlt: "#f0fdfa", link: "#0f766e", focus: "#0f766e" },
    font: { family: 'Georgia, "Times New Roman", serif', size: "16px" },
    shape: { radius: "4px", bubbleRadius: "4px", buttonRadius: "999px", inputRadius: "999px" },
    launcher: { position: "bottom-left" },
  },
};

const LANGS = [...LANGUAGES.map((l) => l.code), "auto"];

const choice = (current: string, values: readonly string[], href: (v: string) => string) =>
  values.map((v) => (v === current ? `<b>${v}</b>` : `<a href="${href(v)}">${v}</a>`)).join(" · ");

const page = (theme: string, mode: string, finish: string, lang: string) => {
  const deployment = `spike-${theme}-${mode}-${finish}-${lang}`;
  const link = (t: string, m: string, f: string, l = lang) => `/?theme=${t}&amp;mode=${m}&amp;finish=${f}&amp;lang=${l}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harbor View Dental</title>
<style>
  body { margin: 0; font: 16px/1.6 Georgia, serif; color: #1f2937; background: #fff; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; background: #0f766e; color: #fff; padding: 16px 24px; }
  header b { font-size: 1.4rem; font-weight: normal; }
  header button { font: inherit; color: #0f766e; background: #fff; border: 0; border-radius: 999px; padding: 6px 16px; cursor: pointer; }
  nav { font: 13px/1.8 system-ui, sans-serif; padding: 8px 24px; background: #f0fdfa; border-bottom: 1px solid #ccfbf1; }
  nav span { color: #6b7280; margin-right: 6px; }
  main { max-width: 720px; margin: 0 auto; padding: 24px 16px 160px; }
  #slot { margin: 24px 0; }
</style></head>
<body>
  <header><b>Harbor View Dental</b><button type="button" data-arag-chat-open>Ask us</button></header>
  <nav>
    <div><span>mode</span>${choice(mode, WIDGET_MODES, (m) => link(theme, m, finish))}</div>
    <div><span>finish</span>${choice(finish, FINISHES, (f) => link(theme, mode, f))}</div>
    <div><span>theme</span>${choice(theme, Object.keys(THEMES), (t) => link(t, mode, finish))}</div>
    <div><span>lang</span>${choice(lang, LANGS, (l) => link(theme, mode, finish, l))}</div>
  </nav>
  <main>
    <h1>Gentle dentistry by the harbor</h1>
    <p>A stand-in customer page. The chat should look like it belongs here.</p>
    <div id="slot"></div>
    <p>More page content below the widget, to show what the popup covers and what embedded pushes down.</p>
  </main>
  <script type="module">
    import { AragChat } from "/packages/widget/src/element.ts";
    customElements.define("arag-chat", AragChat);
    const chat = document.createElement("arag-chat");
    chat.setAttribute("deployment", ${JSON.stringify(deployment)});
    chat.setAttribute("base-url", location.origin);
    (${JSON.stringify(mode)} === "floating" ? document.body : document.getElementById("slot")).append(chat);
  </script>
</body></html>`;
};

function serveSource(urlPath: string, res: ServerResponse) {
  const file = normalize(`${ROOT}${urlPath}`);
  if (!file.startsWith(`${ROOT}${sep}packages${sep}`) || !file.endsWith(".ts")) return send(res, 404, "text/plain", "Not found");
  let code = stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" });
  code = code.replace(/(from\s+|import\s*\(\s*)["'](@launchpad\/[^"']+)["']/g, (m, lead: string, spec: string) =>
    ALIASES[spec] ? `${lead}"${ALIASES[spec]}"` : m,
  );
  send(res, 200, "text/javascript; charset=utf-8", code);
}

function config(deployment: string): PublicWidgetConfig {
  const s = readState();
  const [, themeName = "default", mode, finish = "flat", lang = "en"] = deployment.split("-");
  const language = languageSetting(lang);
  // The clinic's own copy is English; other languages show the widget's defaults.
  const copy =
    language === "en"
      ? {
          welcome: "Hi! I can answer questions about our hours, insurance and first visits.",
          starters: ["When are you open on Friday?", "Do you take Aetna?", "What should new patients bring?"],
        }
      : {};
  return {
    deploymentId: deployment,
    zone: s.zone!,
    kbId: s.kbId!,
    searchConfig: s.searchConfig ?? "launchpad-default",
    theme: resolveTheme({ ...THEMES[themeName], finish: { style: finish as Finish } }).theme,
    settings: { ...defaultWidgetSettings, mode: widgetMode(mode), language, nickname: "Harbor View Dental", ...copy },
    online: true,
  };
}

async function token(): Promise<PublicTokenResponse> {
  const s = readState();
  const reader = readSecrets().reader;
  if (!s.zone || !s.kbId || !reader) throw new Error("Run the M0 spike's kb and keys steps first.");
  const kb = new KbClient({ zone: s.zone, kbId: s.kbId, credential: { kind: "key", token: reader } });
  const { token, expiresAt } = await kb.mintEphemeralToken(TOKEN_TTL);
  return { token, expiresIn: TOKEN_TTL, expiresAt: expiresAt.toISOString(), askUrl: `${zoneApi(s.zone)}/kb/${s.kbId}/ask` };
}

function send(res: ServerResponse, status: number, type: string, body: string) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      const pick = (name: string, values: readonly string[], fallback: string) => {
        const value = url.searchParams.get(name);
        return value && values.includes(value) ? value : fallback;
      };
      const theme = pick("theme", Object.keys(THEMES), "brand");
      const html = page(theme, pick("mode", WIDGET_MODES, "floating"), pick("finish", FINISHES, "flat"), pick("lang", LANGS, "en"));
      return send(res, 200, "text/html; charset=utf-8", html);
    }
    if (req.method === "GET" && url.pathname.startsWith("/packages/")) return serveSource(url.pathname, res);
    const m = /^\/api\/public\/deployments\/([\w-]+)\/(config|token)$/.exec(url.pathname);
    if (m?.[2] === "config" && req.method === "GET") return send(res, 200, "application/json", JSON.stringify(config(m[1]!)));
    if (m?.[2] === "token" && req.method === "POST") return send(res, 200, "application/json", JSON.stringify(await token()));
    send(res, 404, "text/plain", "Not found");
  } catch (err) {
    send(res, 500, "text/plain", err instanceof Error ? err.message : String(err));
  }
}).listen(PORT, "localhost", () => console.log(`widget dev page on http://localhost:${PORT}`));
