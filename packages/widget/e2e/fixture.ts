// A stand-in client site and console for the widget's browser tests (and the strict-CSP page
// under spike/csp): pages carrying the real embed snippet and arag-chat.js as built, the
// console's public config, token, events and lead endpoints, and an /ask that streams
// Agentic RAG's format. Pages are served under a strict Content Security Policy by default.
//
//   /page?mode=floating&lang=es&csp=strict|noconnect|none   a page with the snippet
//   /page?banner=onetrust                                     …with a 59 px cookie bar along the bottom
//   /page?dep=unpublished                                     …for a deployment not signed off yet
//   /page?dep=floating-wide                                   …a brand like whatsupgold.com's: its 232×26 wordmark
//                                                             as the avatar, "WhatsUp Gold", every language
//   /page?dep=floating-square, floating-long                 …a square logo; a name too long for any header
//   /page?dep=chat-multi                                      …a KB holding English and German pages
//   /page?dep=chat-ga&ga=1                                    …events into the page's Tag Manager dataLayer
//   /page?dep=chat-priced                                     …a confirmed price table (Gold $59, Platinum $189 per
//                                                             node, per year) and the synced pages' paths (round 6)
//   /page?dep=chat-locked&csp=none                            …answers from another origin, whose domain lock
//                                                             refuses the page until recorded.lockPending is false
//   /still                                                    a page with arag-chat.js and nothing else
//   /hours, /login, /home/Action/Edit                         more pages of the same site
//   /gtm?how=create|gtm                                       the snippet injected by script
//
// recorded.paused makes the status route say offline, as Pause does; recorded.lockPending keeps
// chat-locked's answers refused until the test lets the domain lock apply.

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  allWidgetStrings,
  defaultWidgetSettings,
  LANGUAGES,
  type PublicWidgetConfig,
  resolveTheme,
  type WidgetMode,
} from "@launchpad/theme";

export const PRIMARY = "#0f766e";
const BUNDLE = fileURLToPath(new URL("../dist/arag-chat.js", import.meta.url));

export const CSP = {
  strict:
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'",
  noconnect: "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self' data:; base-uri 'none'",
  none: "",
} as const;

export interface Recorded {
  events: { name: string; [param: string]: unknown }[];
  // Question events, as posted on their own ({type: "question", …}), with the Origin header sent.
  questions: { conversationId: string; questionHash: string; origin: string | undefined; contentType: string | undefined }[];
  // Hold the answer to question events, so they're still in flight when the page goes.
  holdQuestions: boolean;
  // Wait this long before an /ask's reply (ms): a price reply the widget holds, with nothing to show.
  slowAsk: number;
  leads: Record<string, unknown>[];
  asks: Record<string, unknown>[];
  configRequests: number;
  statusRequests: number;
  paused: boolean;
  // Agentic RAG hasn't applied the page's origin to the KB's domain lock yet (chat-locked).
  lockPending: boolean;
}

// Inline SVG logos as the scan writes them: percent-encoded, sized as shown on the site.
const svgLogo = (width: number, height: number, text: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${height}" height="${height}" fill="#5ac531"/><text x="${height + 4}" y="${height * 0.75}" font-family="Arial" font-size="${height * 0.7}" fill="#1f2937">${text}</text></svg>`,
  )}`;
export const WIDE_LOGO = svgLogo(232, 26, "Progress WhatsUp Gold");
const SQUARE_LOGO = svgLogo(64, 64, "");

// e2e-<mode>[-<brand>]: the brand's name, avatar and languages for the header's tests.
const BRANDS: Record<string, Partial<PublicWidgetConfig["settings"]>> = {
  wide: { nickname: "WhatsUp Gold", avatar: WIDE_LOGO, languages: LANGUAGES.map((l) => l.code), translations: {} },
  square: { nickname: "WhatsUp Gold", avatar: SQUARE_LOGO, languages: LANGUAGES.map((l) => l.code), translations: {} },
  long: { nickname: "Harbor View Dental's appointments and billing helper", avatar: WIDE_LOGO },
  // The site's Tag Manager dataLayer gets the chat's events (the page sets window.dataLayer with ?ga=1).
  ga: { analytics: { googleAnalytics: true } },
};

function config(origin: string, deployment: string): PublicWidgetConfig {
  const [, modeName = "floating", brand = ""] = deployment.split("-");
  const mode = modeName as WidgetMode;
  return {
    deploymentId: deployment,
    zone: "test",
    kbId: "kb",
    searchConfig: "",
    theme: resolveTheme({ color: { primary: PRIMARY } }).theme,
    settings: {
      ...defaultWidgetSettings,
      mode,
      language: "auto",
      languages: ["en", "es"],
      nickname: "Harbor Help",
      welcome: "Hi! Ask about our clinic.",
      starters: ["When are you open?", "Do you take new patients?"],
      handoff: { contacts: [{ kind: "link", url: "tel:+15551234567" }], show: ["no-answer", "header"] },
      ctas: [
        { label: "See pricing", url: `${origin}/pricing`, keywords: ["price", "cost"] },
        { label: "Get a quote", url: "", keywords: ["quote"], action: "lead" },
      ],
      lead: { enabled: true, fields: ["name", "email", "message"], requiredFields: ["email"] },
      privacyUrl: `${origin}/privacy`,
      exclude: ["/login", "/checkout/*"],
      analytics: { googleAnalytics: false },
      translations: {
        es: {
          welcome: "¡Hola! Pregunta por nuestra clínica.",
          starters: ["¿Cuándo abren?"],
          ctas: [{ label: "Ver precios", keywords: ["precio"], url: `${origin}/es/precios` }],
        },
      },
      ...BRANDS[brand],
    },
    online: true,
    ...(brand === "multi" && { contentLanguages: ["en", "de"] }),
    // Round 6: the confirmed price table, and the only pages a model-written link may open.
    ...(brand === "priced" && {
      priceTable: {
        rows: [
          {
            plan: "Gold",
            amount: "$59",
            value: 59,
            currency: "USD",
            unit: "per node",
            period: "year",
            url: `${origin}/pricing`,
            line: "Gold $59",
          },
          {
            plan: "Platinum",
            amount: "$189",
            value: 189,
            currency: "USD",
            unit: "per node",
            period: "year",
            url: `${origin}/pricing`,
            line: "Platinum $189",
          },
        ],
        pages: [`${origin}/pricing`],
        readAt: "2026-11-01T00:00:00Z",
        hash: "e2e",
      },
      pagePaths: ["/", "/pricing", "/hours", "/book", "/request-a-demo"],
    }),
    // Intent routing (round 5): price and events questions go to their own configurations first.
    ...(brand === "routed" && {
      contentLanguages: ["en", "de"],
      intentConfigs: { price: ROUTED.price, events: ROUTED.events },
      intentPages: { price: [UNLABELLED_PAGE] },
    }),
    // Build 8: a site with stored events, and only English events pages.
    ...(brand === "eventful" && {
      contentLanguages: ["en", "de", "es"],
      intentConfigs: { events: EVENTFUL },
      eventPages: ["/webinars"],
    }),
  };
}

export const EVENTFUL = "launchpad-default-eventful";
// chat-routed's intent configurations, and a key page sent before labels existed.
export const ROUTED = { price: "launchpad-default-price", events: "launchpad-default-events" };
export const UNLABELLED_PAGE = "0123456789abcdef0123456789abcdef";

// kemptechnologies.com's raw Agentic RAG stream for "What are your prices?" (round 5): a correct,
// cited answer whose best paragraph scored 0.0112, under the old floor.
const RAW_PRICES = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../test/fixtures/raw-ask-prices.json", import.meta.url)), "utf8")) as { body: string }[]
)[0]!.body;

const line = (item: Record<string, unknown>) => `${JSON.stringify({ item })}\n`;

// A band every page of the site repeats, which Agentic RAG cites like any passage.
const BAND = "Open Monday to Friday: book online or call us.";

// Agentic RAG's stream: an answer in markdown with reranked sources on the site, Agentic RAG's
// no-context reply for off-topic questions, and a failure for questions containing "fail". A
// question about the warranty is answered only when asked of every page without the
// conversation, as a follow-up whose rewrite misses the pricing page. Slime gets the reply UX
// saw on crayola.com in round 4 (a reworded no-answer, from well-matched pages), and "contact
// support" the two words SE saw on telerik.com, cited to a "Contact Support" link that every
// product page repeats.
function askStream(
  origin: string,
  query: string,
  attempt: number,
  asked: { filter_expression?: unknown; chat_history?: unknown[]; search_configuration?: unknown },
): { status: number; body: string } {
  if (/fail/i.test(query) && attempt === 1) return { status: 500, body: "" };
  if (/^what are your prices\??$/i.test(query.trim())) return { status: 200, body: RAW_PRICES };
  // chat-routed: "What does Gold cost?" is answered only from the pricing pages (the chef.io case),
  // "How much is Platinum?" only by the default configuration (its pages carry no labels yet), and
  // the events configuration isn't saved on the KB yet (a 400).
  const routed = asked.search_configuration === ROUTED.price || asked.search_configuration === ROUTED.events;
  if (asked.search_configuration === ROUTED.events) return { status: 400, body: '{"detail":"Search configuration not found"}' };
  const noRetrieval = {
    status: 200,
    body: [
      line({ type: "answer", text: "Not enough data to answer this." }),
      line({ type: "status", status: "no_retrieval_data", code: "-3" }),
    ].join(""),
  };
  const paragraph = (score: number, text = "…", id = "p") => ({
    "/t/text": { paragraphs: { [id]: { score, score_type: "RERANKER", text } } },
  });
  const page = (id: string, title: string, path: string, score: number, text = "…") => ({
    id,
    title,
    origin: { url: `${origin}${path}` },
    fields: paragraph(score, text, `${id}/t/text/0-50`),
  });
  const reply = (answer: string, pages: ReturnType<typeof page>[]) => ({
    status: 200,
    body: [
      line({ type: "answer", text: answer }),
      line({ type: "retrieval", results: { resources: Object.fromEntries(pages.map((p) => [p.id, p])) } }),
      line({ type: "citations", citations: Object.fromEntries(pages.map((p, i) => [`${p.id}/t/text/0-50`, [[i, i + 1]]])) }),
      line({ type: "status", status: "success", code: "0" }),
    ].join(""),
  });
  const noContext = {
    status: 200,
    body: [
      line({ type: "answer", text: "Not enough data to answer this." }),
      line({ type: "retrieval", results: { resources: { b1: page("b1", "Blog: open-source costs", "/blog/costs", 0.004) } } }),
      line({ type: "status", status: "no_context", code: "-2" }),
    ].join(""),
  };
  // Round 6: a blog's figure for a plan in the confirmed table (chat-priced replaces it), and
  // MOVEit's link written to a page name.
  if (/how much is the gold plan/i.test(query)) {
    return reply("The Gold plan costs **$99 per node, per year**, according to our guide.", [
      page("b2", "What does Gold really cost?", "/blog/gold-cost", 0.5, "Gold plans can run $99 per node, per year with support."),
    ]);
  }
  if (/book a demo/i.test(query)) {
    return reply(
      "Yes: [Request a Demo](Request a Demo), or try [Interactive demos](/interactive-demos). [Click here](javascript:alert(1)) [1].",
      [page("d1", "Request a Demo", "/request-a-demo", 0.6, "Request a Demo: fill in the form and we'll call you.")],
    );
  }
  if (/what does gold cost/i.test(query)) {
    // Answered from the pricing pages only, with a low score: grounding shows it.
    if (!routed) return noContext;
    return reply("Gold costs **$59 per node, per year**.", [
      page("p1", "Pricing & Plans", "/pricing", 0.005, "Gold: $59 per node, per year. Platinum: $189 per node, per year."),
    ]);
  }
  if (/platinum/i.test(query)) {
    if (routed) return noRetrieval;
    return reply("Platinum costs **$189 per node, per year**.", [
      page("p1", "Pricing & Plans", "/pricing", 0.4, "Gold: $59 per node, per year. Platinum: $189 per node, per year."),
    ]);
  }
  // Build 8: the false "no exact day" of round 7, and a site with no Spanish events page.
  if (/wann findet das webinar/i.test(query)) {
    return reply("Das nächste Webinar findet im November 2026 statt. Ein genaues Datum nennt die Seite nicht.", [
      page("w1", "Upcoming webinars", "/webinars", 0.5, "Upcoming Live Webinar: 5. November 2026."),
    ]);
  }
  if (/wann ist das seminar/i.test(query)) {
    return reply("Das Seminar findet am 5. November 2026 statt.", [
      page("w1", "Upcoming webinars", "/webinars", 0.5, "Upcoming Live Webinar: 5. November 2026."),
    ]);
  }
  if (/alg[uú]n webinar/i.test(query)) {
    if (asked.filter_expression !== undefined) return noRetrieval;
    return reply("El próximo webinar es el 5 de noviembre de 2026 (página en inglés).", [
      page("w1", "Upcoming webinars", "/webinars", 0.5, "Upcoming Live Webinar: 5 November 2026."),
    ]);
  }
  if (/next webinar/i.test(query)) {
    return reply("Our next webinar is on **Thursday, November 5, 2026**, at 11:00 AM.", [
      page("w1", "Upcoming webinars", "/webinars", 0.5, "Upcoming Live Webinar: Thursday, November 5, 2026, 11:00 AM."),
    ]);
  }
  if (/slime/i.test(query)) {
    return reply("For Crayola Goo on carpet, we don't have a carpet-specific removal method listed. Please contact us for help.", [
      page("g1", "Goo on Formica", "/stain-tips/goo-on-formica", 0.31, "Crayola Goo on Formica: scrape off what you can, then wipe."),
      page("g2", "Goo on Asphalt", "/stain-tips/goo-on-asphalt", 0.3, "Crayola Goo on asphalt: rinse with water."),
    ]);
  }
  if (/becoming a partner/i.test(query)) {
    return reply("Contact us to discuss becoming a partner.", [
      page("m1", "Partner program", "/partners", 0.6, "Our partner program helps clinics grow."),
    ]);
  }
  if (/contact sales/i.test(query)) {
    // whatsupgold.com's reply in the round-5 release check.
    return reply(
      "Contact our sales team by completing the contact form on our Contact Us page. A specialist will reply by email shortly.",
      [page("s1", "Contact Us", "/contact", 0.7, "Contact sales: fill in the form and a specialist will reply.")],
    );
  }
  if (/contact support/i.test(query)) {
    return reply("Contact Support.", [
      page("k1", "React Grid Overview", "/react/grid", 0.99, "Contact Support"),
      page("k2", "React Buttons Overview", "/react/buttons", 0.99, "Contact Support"),
    ]);
  }
  const narrowed = /warranty/i.test(query) && (asked.filter_expression !== undefined || Boolean(asked.chat_history?.length));
  if (/bicycle|bicicleta/i.test(query) || narrowed) {
    return {
      status: 200,
      body: [
        line({ type: "answer", text: "Not enough data to answer this." }),
        line({
          type: "retrieval",
          results: { resources: { r1: { id: "r1", title: "Hours", origin: { url: `${origin}/hours` }, fields: paragraph(0.001) } } },
        }),
        line({ type: "status", status: "no_context", code: "-2" }),
      ].join(""),
    };
  }
  const prices = /\b(prices?|precios?|costs?)\b/i.test(query) ? "\n\nPrices vary by visit." : "";
  const answer = [
    "We're open **Monday to Friday**:\n\n",
    "- 8am to 6pm\n",
    "- Saturdays by [appointment](",
    `${origin}/book)`,
    `.${prices}`,
  ];
  return {
    status: 200,
    body: [
      ...answer.map((text) => line({ type: "answer", text })),
      // Five pages cited: two that fit, a third that fits less (at most two are shown), and two
      // cited only for the "Book online or call us" band every page repeats.
      line({
        type: "retrieval",
        results: {
          resources: {
            r1: { id: "r1", title: "Opening hours", origin: { url: `${origin}/hours` }, fields: paragraph(0.42) },
            r2: {
              id: "r2",
              title: "Partner clinic opening hours",
              origin: { url: "https://partner-clinic.example/hours" },
              fields: paragraph(0.2),
            },
            r3: { id: "r3", title: "Holiday hours", origin: { url: `${origin}/holidays` }, fields: paragraph(0.2) },
            r4: { id: "r4", title: "Careers", origin: { url: `${origin}/careers` }, fields: paragraph(0.3, BAND, "r4/t/text/0-50") },
            r5: { id: "r5", title: "Parking", origin: { url: `${origin}/parking` }, fields: paragraph(0.3, BAND, "r5/t/text/0-50") },
          },
        },
      }),
      line({
        type: "citations",
        citations: {
          "r1/t/text/0-50": [[0, 10]],
          "r2/t/text/0-50": [[11, 20]],
          "r3/t/text/0-50": [[21, 30]],
          "r4/t/text/0-50": [[31, 40]],
          "r5/t/text/0-50": [[41, 50]],
        },
      }),
      line({ type: "status", status: "success", code: "0" }),
    ].join(""),
  };
}

function page(title: string, mode: string, lang: string, body = "", deployment = `e2e-${mode}`): string {
  const inPage = mode !== "floating";
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><link rel="stylesheet" href="/page.css">
<script src="/arag-chat.js" data-deployment="${deployment}" async></script>
<script src="/banner.js" defer></script></head>
<body><header><a href="/page?mode=${mode}">Harbor View Dental</a></header>
<main><h1>${title}</h1><p>A stand-in client page.</p>${inPage ? `<arag-chat deployment="${deployment}"></arag-chat>` : ""}${body}
<p><a href="/hours?mode=${mode}">Opening hours</a></p></main></body></html>`;
}

// A OneTrust-style cookie bar: 59 px, fixed along the bottom, with its buttons on the right
// where the chat button sits, and a small close button in the corner, right under it. Accept
// and close both close it.
const BANNER = `<div id="onetrust-banner-sdk" role="region" aria-label="Cookie banner"><p>We use cookies to improve your visit.</p>
<div class="ot-buttons"><button type="button" id="onetrust-pc-btn-handler">Cookie Settings</button><button type="button" id="onetrust-accept-btn-handler">Accept All Cookies</button>
<button type="button" class="onetrust-close-btn-handler" aria-label="Close">×</button></div></div>`;

const PAGE_CSS = `body { margin: 0; font: 16px/1.5 Georgia, serif; } header, main { padding: 16px 24px; } main { max-width: 720px; }
#onetrust-banner-sdk { position: fixed; left: 0; right: 0; bottom: 0; height: 59px; box-sizing: border-box; display: flex; align-items: center;
  justify-content: space-between; gap: 8px; padding: 0 12px; background: #1f2937; color: #fff; font: 14px/1.2 system-ui, sans-serif; z-index: 1000; }
#onetrust-banner-sdk p { margin: 0; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#onetrust-banner-sdk .ot-buttons { display: flex; gap: 8px; }
#onetrust-banner-sdk button { min-height: 36px; padding: 0 10px; border: 0; border-radius: 4px; background: #fff; color: #1f2937; font: inherit; }
#onetrust-banner-sdk .onetrust-close-btn-handler { min-height: 0; width: 28px; height: 28px; padding: 0; background: transparent; color: #fff; font-size: 20px; }`;

// Added by script, as consent platforms do, and gone on Accept. With ?ga=1, the page also has Tag
// Manager's dataLayer, as a client's site would.
const BANNER_JS = `(() => {
  if (new URLSearchParams(location.search).get("ga") === "1") window.dataLayer = [];
  if (new URLSearchParams(location.search).get("banner") !== "onetrust") return;
  const holder = document.createElement("div");
  holder.innerHTML = ${JSON.stringify(BANNER)};
  const banner = holder.firstElementChild;
  document.body.append(banner);
  for (const b of banner.querySelectorAll("#onetrust-accept-btn-handler, .onetrust-close-btn-handler")) b.addEventListener("click", () => banner.remove());
})();`;

// The snippet as a Tag Manager Custom HTML tag adds it: parsed from the tag's HTML, then each
// script re-created with its attributes, since scripts set through innerHTML never run.
const GTM_INJECT = `(() => {
  const how = new URLSearchParams(location.search).get("how");
  const html = '<script src="/arag-chat.js" data-deployment="e2e-floating" async><\\/script>';
  if (how === "create") {
    const s = document.createElement("script");
    s.src = "/arag-chat.js";
    s.setAttribute("data-deployment", "e2e-floating");
    s.async = true;
    document.head.appendChild(s);
    return;
  }
  // Tag Manager fires Custom HTML tags once the page has a body (DOM ready, or later).
  addEventListener("DOMContentLoaded", () => {
    const template = document.createElement("template");
    template.innerHTML = html;
    for (const original of template.content.querySelectorAll("script")) {
      const s = document.createElement("script");
      for (const { name, value } of original.attributes) s.setAttribute(name, value);
      document.body.appendChild(s);
    }
  });
})();`;

export async function startFixture(port = 0): Promise<{ origin: string; recorded: Recorded; close: () => Promise<void> }> {
  const recorded: Recorded = {
    events: [],
    questions: [],
    holdQuestions: false,
    slowAsk: 0,
    leads: [],
    asks: [],
    configRequests: 0,
    statusRequests: 0,
    paused: false,
    lockPending: true,
  };
  const attempts = new Map<string, number>();
  const read = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  };
  const server = createServer(async (req, res: ServerResponse) => {
    const origin = `http://${req.headers.host}`;
    const url = new URL(req.url ?? "/", origin);
    const csp = CSP[(url.searchParams.get("csp") ?? "strict") as keyof typeof CSP] ?? CSP.strict;
    const html = (body: string) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...(csp && { "Content-Security-Policy": csp }) });
      res.end(body);
    };
    const mode = url.searchParams.get("mode") ?? "floating";
    const lang = url.searchParams.get("lang") ?? "en";
    const api = /^\/api\/public\/deployments\/([\w-]+)\/(config|token|events|lead|status)$/.exec(url.pathname);

    if (url.pathname === "/arag-chat.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      return res.end(readFileSync(BUNDLE));
    }
    if (url.pathname === "/page.css") {
      res.writeHead(200, { "Content-Type": "text/css" });
      return res.end(PAGE_CSS);
    }
    if (url.pathname === "/banner.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      return res.end(BANNER_JS);
    }
    if (url.pathname === "/gtm.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      return res.end(GTM_INJECT);
    }
    if (url.pathname === "/still") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP.strict });
      return res.end(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Stills</title><script src="/arag-chat.js"></script></head><body></body></html>`,
      );
    }
    if (url.pathname === "/gtm") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(
        `<!doctype html><html lang="en"><head><title>Tag Manager</title><script src="/gtm.js"></script></head><body><p>Tag Manager page</p></body></html>`,
      );
    }
    if (api?.[2] === "config") {
      recorded.configRequests += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify(api[1] === "e2e-unpublished" ? { published: false } : { ...config(origin, api[1]!), strings: allWidgetStrings() }),
      );
    }
    if (api?.[2] === "status") {
      recorded.statusRequests += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ online: !recorded.paused }));
    }
    if (api?.[2] === "token") {
      // chat-locked answers from another origin (localhost rather than 127.0.0.1), as Agentic RAG does.
      const askOrigin = api[1]!.endsWith("-locked") ? origin.replace("127.0.0.1", "localhost") : origin;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ token: "t", expiresIn: 900, expiresAt: new Date().toISOString(), askUrl: `${askOrigin}/ask` }));
    }
    if (api?.[2] === "events") {
      const body = JSON.parse(await read(req)) as {
        events?: Recorded["events"];
        type?: string;
        conversationId?: string;
        questionHash?: string;
      };
      if (body.type === "question") {
        recorded.questions.push({
          conversationId: body.conversationId ?? "",
          questionHash: body.questionHash ?? "",
          origin: req.headers.origin,
          contentType: req.headers["content-type"],
        });
        if (recorded.holdQuestions) await new Promise((resolve) => setTimeout(resolve, 3000));
      } else recorded.events.push(...(body.events ?? []));
      res.writeHead(204);
      return res.end();
    }
    if (api?.[2] === "lead") {
      recorded.leads.push(JSON.parse(await read(req)));
      res.writeHead(202, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (url.pathname === "/ask") {
      // From another origin, the domain lock: CORS for the page only once it's applied.
      const from = req.headers.origin;
      const crossOrigin = Boolean(from && from !== origin);
      const cors = crossOrigin && !recorded.lockPending ? { "Access-Control-Allow-Origin": from! } : {};
      if (req.method === "OPTIONS") {
        const preflight = { ...cors, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "content-type" };
        res.writeHead(crossOrigin && recorded.lockPending ? 403 : 204, crossOrigin && !recorded.lockPending ? preflight : {});
        return res.end();
      }
      if (req.method !== "POST") {
        res.writeHead(405);
        return res.end();
      }
      const body = JSON.parse(await read(req)) as { query: string; filter_expression?: unknown; chat_history?: unknown[] };
      recorded.asks.push(body);
      if (recorded.slowAsk) await new Promise((resolve) => setTimeout(resolve, recorded.slowAsk));
      const n = (attempts.get(body.query) ?? 0) + 1;
      attempts.set(body.query, n);
      // The partner's Agentic RAG account blocked for budget (round 6): every ask refused.
      if (/budget block/i.test(body.query)) {
        res.writeHead(402, { "Content-Type": "application/json", ...cors });
        return res.end(JSON.stringify({ detail: "Access denied, as account x has an active 'AccountBlockingState.BUDGET' blockage" }));
      }
      // A stream that starts and then goes quiet (round 6: a Dutch answer sat at the cursor for 93 s).
      if (/stalls/i.test(body.query)) {
        res.writeHead(200, { "Content-Type": "application/x-ndjson", ...cors });
        res.write(line({ type: "answer", text: "" }));
        setTimeout(() => res.end(), 40_000).unref();
        return;
      }
      const { status, body: stream } = askStream(origin, body.query, n, body);
      res.writeHead(status, { "Content-Type": "application/x-ndjson", ...cors });
      return res.end(stream);
    }
    if (url.pathname === "/page" || url.pathname === "/hours" || url.pathname === "/login" || url.pathname === "/home/Action/Edit") {
      const dep = url.searchParams.get("dep");
      return html(page(url.pathname === "/hours" ? "Opening hours" : "Harbor View Dental", mode, lang, "", dep ? `e2e-${dep}` : undefined));
    }
    res.writeHead(404);
    res.end("Not found");
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    recorded,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
