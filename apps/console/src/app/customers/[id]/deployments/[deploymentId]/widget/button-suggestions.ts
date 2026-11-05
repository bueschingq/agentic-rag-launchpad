// Ready-made call-to-action buttons from what the console already knows about the site: one
// for each intent key page (a quote, a demo, a trial, where to buy, contact) and for the trial,
// demo and quote links the pages carry, named the way the site's main button is when the scan
// read one ("Start Free Trial"). Each comes with its label, link and keywords in every served
// language, and one click adds it. Key pages too thin to answer from come first: a button is then
// the only way the chat can get visitors there (round 5: crayola.com's /products/where-to-buy has
// 28 words, so "Where can I buy your products?" was answered with no link; the demo had no demo
// or trial button, and writing three buttons by hand took the marketer 5 minutes).
//
// Pure, and safe in the browser: the server loads and filters the pages
// (button-suggestions-load.ts), the configurator turns a suggestion into a button (ctaFromSuggestion).

import { LANGUAGES, type Language, type LocalizedCopy, languageOf, type WidgetCta, type WidgetSettings } from "@launchpad/theme";

export type ButtonKind = "quote" | "pricing" | "where-to-buy" | "buy" | "demo" | "trial" | "contact";

// The order suggestions are offered in, after the thin key pages.
const KINDS: readonly ButtonKind[] = ["quote", "pricing", "where-to-buy", "buy", "demo", "trial", "contact"];

// A page a button could open: a key page (content_pages.keyIntent) or a link a page carries
// (content_pages.facts.links), already checked to be on the site and within the deployment's paths.
export interface ButtonPage {
  url: string;
  // The page's <html lang>, when known.
  lang?: string | null;
  // A key page's intent (price, buy, contact, support, trial, faq), or a link's (trial, demo, quote).
  intent: string;
  source: "key-page" | "link";
  // Key pages: their sync status and why they were left out.
  status?: string;
  detail?: string | null;
  // A link's own words ("Start Free Trial").
  label?: string | null;
}

export interface ButtonCopy {
  label: string;
  keywords: string[];
  // The page in this language, when the site has one.
  url?: string;
}

export interface ButtonSuggestion {
  kind: ButtonKind;
  // The page in the deployment's main language, else the first found.
  url: string;
  path: string;
  // Why it's offered, in a few words: "/products/where-to-buy has almost no text (28 words)".
  why: string;
  // A key page too thin to answer from: the button is the way there.
  thin: boolean;
  // Label, keywords and link in each of the widget's languages.
  copy: Partial<Record<Language, ButtonCopy>>;
}

const LABELS: Record<ButtonKind, Record<Language, string>> = {
  quote: {
    en: "Request a quote",
    es: "Solicitar presupuesto",
    fr: "Demander un devis",
    de: "Angebot anfordern",
    nl: "Offerte aanvragen",
    pt: "Solicitar orçamento",
    it: "Richiedi un preventivo",
  },
  pricing: {
    en: "See pricing",
    es: "Ver precios",
    fr: "Voir les tarifs",
    de: "Preise ansehen",
    nl: "Prijzen bekijken",
    pt: "Ver preços",
    it: "Vedi i prezzi",
  },
  "where-to-buy": {
    en: "Where to buy",
    es: "Dónde comprar",
    fr: "Où acheter",
    de: "Händler finden",
    nl: "Waar te koop",
    pt: "Onde comprar",
    it: "Dove acquistare",
  },
  buy: {
    en: "How to buy",
    es: "Cómo comprar",
    fr: "Comment acheter",
    de: "So kaufen Sie",
    nl: "Zo koopt u",
    pt: "Como comprar",
    it: "Come acquistare",
  },
  demo: {
    en: "Book a demo",
    es: "Solicitar una demo",
    fr: "Demander une démo",
    de: "Demo anfragen",
    nl: "Demo aanvragen",
    pt: "Agendar uma demonstração",
    it: "Prenota una demo",
  },
  trial: {
    en: "Start a free trial",
    es: "Prueba gratuita",
    fr: "Essai gratuit",
    de: "Kostenlos testen",
    nl: "Gratis proberen",
    pt: "Teste grátis",
    it: "Prova gratuita",
  },
  contact: {
    en: "Contact us",
    es: "Contáctenos",
    fr: "Nous contacter",
    de: "Kontakt",
    nl: "Contact opnemen",
    pt: "Fale conosco",
    it: "Contattaci",
  },
};

const SALES_LABELS: Record<Language, string> = {
  en: "Contact sales",
  es: "Contactar con ventas",
  fr: "Contacter le service commercial",
  de: "Vertrieb kontaktieren",
  nl: "Contact met verkoop",
  pt: "Fale com vendas",
  it: "Contatta le vendite",
};

// The words visitors use for each, whole words with plurals (the widget's "word" match). A button
// shows when the question or the answer mentions one: "Where can I buy your products?" (buy),
// "Can I see a demo?" (demo). The first is the one an existing button is matched by.
const KEYWORDS: Record<ButtonKind, Record<Language, string[]>> = {
  quote: {
    en: ["quote", "price", "pricing", "cost"],
    es: ["presupuesto", "precio", "cotización", "cuesta"],
    fr: ["devis", "prix", "tarif"],
    de: ["angebot", "preis", "preise", "kosten"],
    nl: ["offerte", "prijs", "kosten"],
    pt: ["orçamento", "preço", "custa"],
    it: ["preventivo", "prezzo", "costa"],
  },
  pricing: {
    en: ["price", "pricing", "cost", "plans"],
    es: ["precio", "precios", "cuesta", "planes"],
    fr: ["prix", "tarif", "tarifs", "coûte"],
    de: ["preis", "preise", "kosten", "kostet"],
    nl: ["prijs", "prijzen", "kosten", "kost"],
    pt: ["preço", "preços", "custa", "planos"],
    it: ["prezzo", "prezzi", "costa", "piani"],
  },
  "where-to-buy": {
    en: ["buy", "store", "retailer", "stockist"],
    es: ["comprar", "tienda", "distribuidor"],
    fr: ["acheter", "magasin", "revendeur"],
    de: ["kaufen", "händler", "geschäft"],
    nl: ["kopen", "winkel", "verkooppunt"],
    pt: ["comprar", "loja", "revendedor"],
    it: ["acquistare", "comprare", "negozio", "rivenditore"],
  },
  buy: {
    en: ["buy", "purchase", "order"],
    es: ["comprar", "compra", "pedido"],
    fr: ["acheter", "achat", "commander"],
    de: ["kaufen", "bestellen"],
    nl: ["kopen", "bestellen"],
    pt: ["comprar", "compra", "encomendar"],
    it: ["acquistare", "comprare", "ordinare"],
  },
  demo: {
    en: ["demo", "demonstration"],
    es: ["demo", "demostración"],
    fr: ["démo", "démonstration"],
    de: ["demo", "vorführung"],
    nl: ["demo", "demonstratie"],
    pt: ["demo", "demonstração"],
    it: ["demo", "dimostrazione"],
  },
  trial: {
    en: ["trial", "try", "free"],
    es: ["prueba", "probar", "gratis"],
    fr: ["essai", "essayer", "gratuit"],
    de: ["testversion", "testen", "kostenlos"],
    nl: ["proefversie", "proberen", "gratis"],
    pt: ["teste", "experimentar", "grátis"],
    it: ["prova", "provare", "gratis"],
  },
  contact: {
    en: ["contact", "sales", "talk"],
    es: ["contacto", "contactar", "ventas"],
    fr: ["contact", "contacter", "commercial"],
    de: ["kontakt", "kontaktieren", "vertrieb"],
    nl: ["contact", "verkoop"],
    pt: ["contato", "contatar", "vendas"],
    it: ["contatto", "contattare", "vendite"],
  },
};

const KIND_WORDS: Record<ButtonKind, string> = {
  quote: "quote page",
  pricing: "pricing page",
  "where-to-buy": "where-to-buy page",
  buy: "buying page",
  demo: "demo page",
  trial: "trial page",
  contact: "contact page",
};

const path = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};
// The address's words, accents and case aside.
const words = (url: string) => path(url).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

const QUOTE = /quote|devis|angebot|presupuesto|cotizacion|offerte|orcamento|cotacao|preventivo/;
const WHERE_TO_BUY =
  /where-?to-?buy|wo-kaufen|donde-comprar|ou-acheter|dove-acquistare|onde-comprar|store-?locator|find-a-(store|retailer|dealer)|retailers?|stockists?|dealers?|haendler|handler|distribuidor|revendeur|rivenditor/;
const SALES = /sales|vertrieb|ventas|commercial|verkoop|vendas|vendite/;

// What kind of button a page makes, if any. Support and FAQ pages make none: the handoff covers them.
export function buttonKind(page: Pick<ButtonPage, "url" | "intent">): ButtonKind | undefined {
  const w = words(page.url);
  switch (page.intent) {
    case "price":
    case "quote":
      // By its address: a link called a quote link that opens the price list is a pricing button.
      return QUOTE.test(w) ? "quote" : "pricing";
    case "buy":
      return WHERE_TO_BUY.test(w) ? "where-to-buy" : "buy";
    case "trial":
    case "demo":
      return /demo/.test(w) || page.intent === "demo" ? "demo" : "trial";
    case "contact":
      return "contact";
    default:
      return undefined;
  }
}

// The kind a button's words name: the scan's main button ("Start Free Trial"), or a link's.
export function kindOfLabel(label: string): ButtonKind | undefined {
  const w = label.toLowerCase();
  if (/demo/.test(w)) return "demo";
  if (/trial|try|test|essai|prueba|prova/.test(w)) return "trial";
  if (/quote|angebot|devis|presupuesto|preventivo|offerte/.test(w)) return "quote";
  if (/where to buy|find a (store|retailer|dealer)/.test(w)) return "where-to-buy";
  if (/\bbuy\b|shop|order|kaufen|comprar|acheter/.test(w)) return "buy";
  if (/pric|tarif|preis|precio/.test(w)) return "pricing";
  if (/contact|kontakt|contacto|talk to/.test(w)) return "contact";
  return undefined;
}

// The scan's main button, as its sources say: `button "Start Free Trial" ×3`.
export function scanButtonLabel(sources: Record<string, string> | undefined): string | undefined {
  const label = /^button "([^"]+)"/.exec(sources?.["color.primary"] ?? "")?.[1]?.trim();
  return label && label.length <= 40 ? label : undefined;
}

// A key page the chat can't answer from because it has almost no text: "Too little text to answer
// from (28 words)", as the sync words it.
const thinWords = (page: ButtonPage) =>
  page.source === "key-page" && page.status === "skipped"
    ? /^Too little text to answer from \((\d+) words?\)/.exec(page.detail ?? "")?.[1]
    : undefined;

// A page that exists and can be linked to: in the sync (or on its way), or a key page left out only
// for having too little text. Not one that's gone (404), an error page, a duplicate or a failure.
const usable = (page: ButtonPage) =>
  page.source === "link" || ["indexed", "queued", "processing"].includes(page.status ?? "") || thinWords(page) !== undefined;

const sameUrl = (a: string, b: string) => a.replace(/[?#].*$/, "").replace(/\/+$/, "") === b.replace(/[?#].*$/, "").replace(/\/+$/, "");

const bare = (host: string) => host.toLowerCase().replace(/^www\./, "");
// The site's own pages: its host, with or without www, and its subdomains.
function onSite(url: string, siteUrl: string): boolean {
  try {
    const [a, b] = [bare(new URL(url).host), bare(new URL(siteUrl).host)];
    return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
  } catch {
    return false;
  }
}

// A content_pages row, as the server reads it.
export interface PageRow {
  url: string;
  lang: string | null;
  keyIntent: string | null;
  status: string;
  detail: string | null;
  facts: { links?: { intent?: unknown; url?: unknown; label?: unknown }[] } | null;
}

// The pages buttons could open: key pages, and the links pages carry, on the site and within the
// deployment's own paths (`within`: content-plan.ts withinRules with its include and exclude
// patterns), so MOVEit, under /moveit, is never offered /contact-us. `language` reads a page's
// language from its address when it has no <html lang>.
export function buttonPages(
  rows: readonly PageRow[],
  siteUrl: string,
  within: (url: string) => boolean,
  language: (url: string) => string | undefined = () => undefined,
): ButtonPage[] {
  // Content about the intent isn't where a button should lead (round 6: teamleader.eu's
  // /fr/ebooks/devis became an "offerte" button).
  const content = /\/(?:e-?books?|blogs?|news|whitepapers?|articles?|resources|webinars?)(?:\/|$)/i;
  const inScope = (url: string) => {
    try {
      return onSite(url, siteUrl) && within(url) && !content.test(new URL(url).pathname);
    } catch {
      return false;
    }
  };
  const pages: ButtonPage[] = [];
  for (const r of rows) {
    if (r.keyIntent && inScope(r.url)) {
      pages.push({
        url: r.url,
        // A culture folder in the address (/es/, /nl-be/) says it first.
        lang: language(r.url) ?? r.lang,
        intent: r.keyIntent,
        source: "key-page",
        status: r.status,
        detail: r.detail,
      });
    }
    for (const link of r.facts?.links ?? []) {
      if (typeof link?.url === "string" && typeof link.intent === "string" && inScope(link.url)) {
        const label = typeof link.label === "string" ? link.label : null;
        // The language of the page linked to, by its address, before that of the page linking to it.
        pages.push({ url: link.url, lang: language(link.url) ?? r.lang, intent: link.intent, source: "link", label });
      }
    }
  }
  return pages;
}

export interface SuggestInput {
  pages: readonly ButtonPage[];
  // The deployment's main language.
  main: Language;
  // Buttons it already has: a kind one of them covers (same page, or its first keyword) isn't offered.
  existing: readonly WidgetCta[];
  // The site's main button as the scan read it ("Start Free Trial").
  scanButton?: string;
}

export function suggestButtons({ pages, main, existing, scanButton }: SuggestInput): ButtonSuggestion[] {
  const byKind = new Map<ButtonKind, ButtonPage[]>();
  for (const page of pages) {
    const kind = buttonKind(page);
    if (kind && usable(page)) byKind.set(kind, [...(byKind.get(kind) ?? []), page]);
  }
  const scanKind = scanButton ? kindOfLabel(scanButton) : undefined;
  const out: ButtonSuggestion[] = [];
  for (const [kind, found] of byKind) {
    const covered = existing.some(
      (cta) =>
        found.some((p) => cta.url && sameUrl(cta.url, p.url)) || cta.keywords.some((k) => k.trim().toLowerCase() === KEYWORDS[kind].en[0]),
    );
    if (covered) continue;
    // Per language, the page in it: a thin key page before the rest (it's why the button is
    // needed), then key pages before links, then the shortest address.
    const rank = (p: ButtonPage) => [thinWords(p) !== undefined ? 0 : 1, p.source === "key-page" ? 0 : 1, path(p.url).length];
    const sorted = [...found].sort((a, b) => {
      const [x, y] = [rank(a), rank(b)];
      return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
    });
    // Each language only ever opens its own language's page (round 6, teamleader.eu: the English and
    // German buttons opened /es/precio). A page whose language isn't known stands for the main
    // language on a site that marks none.
    const marked = sorted.some((p) => languageOf(p.lang));
    const inLanguage = (l: Language) => sorted.find((p) => languageOf(p.lang) === l) ?? (l === main && !marked ? sorted[0] : undefined);
    const first = inLanguage(main);
    // No page in the main language: no suggestion, rather than another language's page.
    if (!first) continue;
    const thin = thinWords(first);
    // The label is the button's intent in each language ("Book a demo"), never a page's title or a
    // link's words (round 6: "Sitefinity CMS Interactive Demos", "precio", "trial"); in the main
    // language, the site's own main button when the scan read one of a few words for this kind.
    const siteLabel = scanKind === kind && scanButton && /\s/.test(scanButton) ? scanButton : undefined;
    const copy: Partial<Record<Language, ButtonCopy>> = {};
    for (const { code } of LANGUAGES) {
      const page = inLanguage(code);
      if (!page) continue;
      const label =
        code === main && siteLabel
          ? siteLabel
          : kind === "contact" && SALES.test(words(page.url))
            ? SALES_LABELS[code]
            : LABELS[kind][code];
      copy[code] = { label, keywords: KEYWORDS[kind][code], url: page.url };
    }
    out.push({
      kind,
      url: first.url,
      path: path(first.url),
      why: thin
        ? `${path(first.url)} has almost no text (${thin} ${thin === "1" ? "word" : "words"}): the chat can't answer from it, so a button is the way there`
        : siteLabel
          ? `The site's own “${siteLabel}” button, and its ${KIND_WORDS[kind]}`
          : first.source === "link"
            ? "Linked from the site's pages"
            : `The site's ${KIND_WORDS[kind]}`,
      thin: thin !== undefined,
      copy,
    });
  }
  return out.sort((a, b) => Number(b.thin) - Number(a.thin) || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
}

// The button a suggestion makes in the deployment's main language, and its copy in each further
// served language that has its own page, paired with the button by position
// (settings.translations[language].ctas). A served language without one gets no copy, so the
// button isn't shown in it. Undefined when the main language has no page for it.
export function ctaFromSuggestion(
  s: ButtonSuggestion,
  served: readonly Language[],
): { cta: WidgetCta; translations: Partial<Record<Language, NonNullable<LocalizedCopy["ctas"]>[number]>> } | undefined {
  const own = s.copy[served[0] ?? "en"];
  if (!own?.url) return undefined;
  const translations: Partial<Record<Language, NonNullable<LocalizedCopy["ctas"]>[number]>> = {};
  for (const language of served.slice(1)) {
    const c = s.copy[language];
    if (c?.url) translations[language] = { label: c.label, keywords: c.keywords, url: c.url };
  }
  return { cta: { label: own.label, url: own.url, keywords: own.keywords }, translations };
}

// ---- saved buttons, as each language's visitors get them ----

// What fitting saved buttons to their languages changed, for the widget page to say.
export interface ButtonFit {
  index: number;
  language: Language;
  // Opens that language's own page now, or isn't shown in it (no such page).
  action: "relinked" | "hidden";
  url?: string;
}

// Saved buttons as each served language's visitors get them: a button whose link (its own in that
// language, else the main one) is a page in another of the site's languages opens the same kind of
// page in the visitor's language instead, or isn't shown in that language when the site has none.
// Round 6, teamleader.eu: buttons saved before per-language suggestions sent English ("precio") and
// German ("Preise ansehen") visitors to /es/precio. The public config serves the result; the main
// language's button, which every language's pairs with, is kept but given no keywords of its own
// when hidden, so it only shows where a translation matches. Pure.
export function fitCtasToLanguages<S extends WidgetSettings>(
  settings: S,
  pages: readonly ButtonPage[],
  main: Language,
  served: readonly Language[],
  language: (url: string) => string | undefined,
): { settings: S; fits: ButtonFit[] } {
  const ctas = settings.ctas ?? [];
  if (served.length < 2 || !ctas.length) return { settings, fits: [] };
  const kindOf = (url: string) => {
    const page = pages.find((p) => sameUrl(p.url, url));
    return page && buttonKind(page);
  };
  const pageFor = (kind: ButtonKind | undefined, l: Language) =>
    kind
      ? pages
          .filter((p) => buttonKind(p) === kind && languageOf(p.lang) === l && usable(p))
          .sort((a, b) => (a.source === b.source ? path(a.url).length - path(b.url).length : a.source === "key-page" ? -1 : 1))[0]
      : undefined;
  const langOf = (url: string) => languageOf(language(url));
  const fits: ButtonFit[] = [];
  const translations = { ...settings.translations };
  const fitted = ctas.map((cta, index) => {
    if (cta.action === "lead" || !cta.url) return cta;
    const kind = kindOf(cta.url);
    let out = cta;
    const ownLang = langOf(cta.url);
    if (ownLang && ownLang !== main) {
      const page = pageFor(kind, main);
      out = page ? { ...cta, url: page.url } : { ...cta, keywords: [] };
      fits.push({ index, language: main, action: page ? "relinked" : "hidden", ...(page && { url: page.url }) });
    }
    for (const l of served) {
      if (l === main) continue;
      const copy = translations[l];
      const local = copy?.ctas?.[index];
      if (!copy || !local?.label?.trim()) continue;
      // Hidden in the main language, its keywords no longer reach this one: take them along.
      const own = !out.keywords.length && !local.keywords?.length ? { ...local, keywords: cta.keywords } : local;
      const link = own.url?.trim() || out.url;
      const at = langOf(link);
      const page = at && at !== l ? pageFor(kind ?? kindOf(link), l) : undefined;
      const next = !at || at === l ? own : page ? { ...own, url: page.url } : { ...own, label: undefined };
      if (next !== local) {
        const list = [...(copy.ctas ?? [])];
        list[index] = next;
        translations[l] = { ...copy, ctas: list };
      }
      if (!at || at === l) continue;
      fits.push({ index, language: l, action: page ? "relinked" : "hidden", ...(page && { url: page.url }) });
    }
    return out;
  });
  return fits.length ? { settings: { ...settings, ctas: fitted, translations }, fits } : { settings, fits };
}
