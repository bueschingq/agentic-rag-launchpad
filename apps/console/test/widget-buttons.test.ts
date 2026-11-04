// Round 5, item 8: ready-made call-to-action buttons from the key pages and the scan, on the
// widget page. The acceptance cases: crayola.com's thin where-to-buy page, the demo's demo and
// trial pages, and MOVEit's section address.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Language, localizeSettings } from "@launchpad/theme";
import { matchCtas } from "../../../packages/widget/src/links.ts";
import {
  buttonKind,
  buttonPages,
  ctaFromSuggestion,
  fitCtasToLanguages,
  kindOfLabel,
  type PageRow,
  scanButtonLabel,
  suggestButtons,
} from "../src/app/customers/[id]/deployments/[deploymentId]/widget/button-suggestions.ts";
import { pathLanguage, withinRules } from "../src/lib/content-plan.ts";

const row = (
  url: string,
  keyIntent: string | null,
  status = "indexed",
  detail: string | null = null,
  extra: Partial<PageRow> = {},
): PageRow => ({
  url,
  lang: "en",
  keyIntent,
  status,
  detail,
  facts: null,
  ...extra,
});

describe("button suggestions", () => {
  it("offers Where to buy for crayola.com's thin where-to-buy page, first, and it shows for “Where can I buy your products?”", () => {
    const pages = buttonPages(
      [
        row("https://www.crayola.com/products/where-to-buy", "buy", "skipped", "Too little text to answer from (28 words)."),
        row("https://www.crayola.com/contact-us", "contact"),
        row("https://www.crayola.com/faq", "faq"),
        row("https://www.crayola.com/support", "support"),
      ],
      "https://www.crayola.com",
      () => true,
    );
    const [first, ...rest] = suggestButtons({ pages, main: "en", existing: [] });
    assert.equal(first?.kind, "where-to-buy");
    assert.equal(first?.path, "/products/where-to-buy");
    assert.ok(first?.thin);
    assert.match(first!.why, /has almost no text \(28 words\)/);
    assert.deepEqual(
      rest.map((s) => s.kind),
      ["contact"],
      "no button for FAQ or support pages",
    );
    const { cta } = ctaFromSuggestion(first!, ["en"])!;
    assert.equal(cta.label, "Where to buy");
    assert.equal(cta.url, "https://www.crayola.com/products/where-to-buy");
    assert.deepEqual(
      matchCtas([cta], "Where can I buy your products?", "Use our Where to Buy tool to find a store near you.").map((c) => c.label),
      ["Where to buy"],
    );
  });

  it("offers the demo's Book a demo, and names its trial button the way the site's main button reads", () => {
    const pages = buttonPages(
      [
        row("https://www.progress.com/sitefinity-cms/request-a-quote", "price"),
        row("https://www.progress.com/sitefinity-cms/demo", "trial"),
        row("https://www.progress.com/sitefinity-cms/free-trials", "trial"),
      ],
      "https://www.progress.com",
      () => true,
    );
    const scanButton = scanButtonLabel({ "color.primary": 'button "Start Free Trial" ×3' });
    assert.equal(scanButton, "Start Free Trial");
    const offered = suggestButtons({ pages, main: "en", existing: [], scanButton });
    assert.deepEqual(
      offered.map((s) => [s.kind, s.path]),
      [
        ["quote", "/sitefinity-cms/request-a-quote"],
        ["demo", "/sitefinity-cms/demo"],
        ["trial", "/sitefinity-cms/free-trials"],
      ],
    );
    const demo = ctaFromSuggestion(offered[1]!, ["en"])!.cta;
    assert.equal(demo.label, "Book a demo");
    assert.deepEqual(
      matchCtas([demo], "Can I see a demo?", "").map((c) => c.label),
      ["Book a demo"],
    );
    assert.equal(ctaFromSuggestion(offered[2]!, ["en"])!.cta.label, "Start Free Trial");
    assert.match(offered[2]!.why, /The site's own “Start Free Trial” button/);
  });

  it("keeps MOVEit's buttons to its section: quote, demo and trial from its key pages, nothing outside /moveit", () => {
    const include = ["/moveit"];
    const rows = [
      row("https://www.progress.com/moveit/request-a-quote", "price"),
      row("https://www.progress.com/moveit/request-a-demo", "trial"),
      row("https://www.progress.com/moveit/free-trial", "trial"),
      row("https://www.progress.com/moveit/contact-sales", "contact", "skipped", "Too little text to answer from (14 words)."),
      // Another section's, and another site's.
      row("https://www.progress.com/contact-us", "contact"),
      row("https://www.ipswitch.com/moveit/free-trial", "trial"),
      // A link on a MOVEit page to the site-wide trial form.
      row("https://www.progress.com/moveit/features", null, "indexed", null, {
        facts: { links: [{ intent: "trial", url: "https://www.progress.com/trial-center", label: "Try it free" }] },
      }),
    ];
    const pages = buttonPages(rows, "https://www.progress.com/moveit", (url) => withinRules(url, include, []), pathLanguage);
    assert.ok(pages.every((p) => new URL(p.url).pathname.startsWith("/moveit/")));
    const offered = suggestButtons({ pages, main: "en", existing: [] });
    assert.deepEqual(
      offered.map((s) => [s.kind, s.path]),
      [
        ["contact", "/moveit/contact-sales"],
        ["quote", "/moveit/request-a-quote"],
        ["demo", "/moveit/request-a-demo"],
        ["trial", "/moveit/free-trial"],
      ],
    );
    assert.equal(ctaFromSuggestion(offered[0]!, ["en"])!.cta.label, "Contact sales");
  });

  it("fills in each served language, with that language's page when the site has one", () => {
    const pages = buttonPages(
      [
        row("https://kemptechnologies.com/pricing", "price"),
        row("https://kemptechnologies.com/de/pricing", "price", "indexed", null, { lang: "de-de" }),
        row("https://kemptechnologies.com/es/pricing", "price", "indexed", null, { lang: null }),
      ],
      "https://kemptechnologies.com",
      () => true,
      pathLanguage,
    );
    const [pricing] = suggestButtons({ pages, main: "en", existing: [] });
    const { cta, translations } = ctaFromSuggestion(pricing!, ["en", "de", "es", "fr"])!;
    assert.deepEqual(cta, {
      label: "See pricing",
      url: "https://kemptechnologies.com/pricing",
      keywords: ["price", "pricing", "cost", "plans"],
    });
    assert.deepEqual(translations.de, {
      label: "Preise ansehen",
      keywords: ["preis", "preise", "kosten", "kostet"],
      url: "https://kemptechnologies.com/de/pricing",
    });
    assert.equal(translations.es?.url, "https://kemptechnologies.com/es/pricing");
    // No French page: no French button, rather than another language's page (round 6).
    assert.equal(translations.fr, undefined);
    assert.deepEqual(
      matchCtas(
        [{ ...cta, label: translations.de!.label, keywords: [...translations.de!.keywords, ...cta.keywords] }],
        "Was kostet LoadMaster?",
        "",
      ).map((c) => c.label),
      ["Preise ansehen"],
    );
  });

  it("gives each language its own page and label, and none where it has no page (round 6, teamleader.eu)", () => {
    const rows = [
      // Spanish and Flemish pricing pages; nothing in English, German or French.
      row("https://www.teamleader.eu/es/precio", "price", "indexed", null, { lang: "en" }),
      row("https://www.teamleader.eu/nl-be/prijs", "price", "indexed", null, { lang: null }),
      // An e-book about quotes is no buying page, and a link's own words are no label.
      row("https://www.teamleader.eu/fr/ebooks/devis", "price", "indexed", null, { lang: "fr" }),
      row("https://www.teamleader.eu/es/pagina", null, "indexed", null, {
        lang: "es",
        facts: { links: [{ intent: "quote", url: "https://www.teamleader.eu/es/precio", label: "precio" }] },
      }),
    ];
    const pages = buttonPages(rows, "https://www.teamleader.eu", () => true, pathLanguage);
    assert.ok(pages.every((p) => !p.url.includes("/ebooks/")));
    // English main language with no English pricing page: nothing offered, never /es/precio.
    assert.deepEqual(suggestButtons({ pages, main: "en", existing: [] }), []);
    // Spanish main: its own page and label; Dutch gets /nl-be/prijs; English and German get no button.
    const [pricing] = suggestButtons({ pages, main: "es", existing: [] });
    const made = ctaFromSuggestion(pricing!, ["es", "en", "de", "nl"])!;
    assert.deepEqual(made.cta, {
      label: "Ver precios",
      url: "https://www.teamleader.eu/es/precio",
      keywords: ["precio", "precios", "cuesta", "planes"],
    });
    assert.deepEqual(Object.keys(made.translations), ["nl"]);
    assert.equal(made.translations.nl?.url, "https://www.teamleader.eu/nl-be/prijs");
    assert.equal(made.translations.nl?.label, "Prijzen bekijken");
    // A deployment whose main language has no page for it gets nothing from the suggestion.
    assert.equal(ctaFromSuggestion(pricing!, ["en", "es"]), undefined);
  });

  it("labels a button by its intent, never the page's or link's words (round 6: “Sitefinity CMS Interactive Demos”)", () => {
    const pages = buttonPages(
      [
        row("https://www.progress.com/sitefinity-cms/interactive-demo", "trial"),
        row("https://www.progress.com/try-now/trial", null, "indexed", null, {
          facts: { links: [{ intent: "trial", url: "https://www.progress.com/try-now/trial", label: "trial" }] },
        }),
        row("https://www.progress.com/sitefinity-cms/contact", "contact"),
      ],
      "https://www.progress.com",
      () => true,
      pathLanguage,
    );
    const labels = suggestButtons({ pages, main: "en", existing: [] }).map((s) => ctaFromSuggestion(s, ["en"])!.cta.label);
    assert.deepEqual(labels, ["Book a demo", "Start a free trial", "Contact us"]);
    // The scan's main button names its kind only when it reads like a button, not a single word.
    const scanned = suggestButtons({ pages, main: "en", existing: [], scanButton: "Trial" }).map(
      (s) => ctaFromSuggestion(s, ["en"])!.cta.label,
    );
    assert.ok(scanned.includes("Start a free trial"));
  });

  it("doesn't offer what a button already covers, or pages that are gone", () => {
    const pages = buttonPages(
      [
        row("https://www.example.com/pricing", "price"),
        row("https://www.example.com/request-a-quote", "price"),
        row("https://www.example.com/demo", "trial", "skipped", "Answered 404: not on the site."),
        row("https://www.example.com/contact", "contact", "failed", "Timed out."),
      ],
      "https://www.example.com",
      () => true,
    );
    const offered = suggestButtons({
      pages,
      main: "en",
      existing: [
        { label: "See prices", url: "https://www.example.com/pricing/", keywords: ["price"] },
        { label: "Get a quote", url: "", keywords: ["quote"], action: "lead" },
      ],
    });
    assert.deepEqual(offered, []);
  });

  it("reads a page's kind from its intent and address", () => {
    assert.equal(buttonKind({ url: "https://a.example/de/angebot-anfordern", intent: "price" }), "quote");
    assert.equal(buttonKind({ url: "https://a.example/preise", intent: "price" }), "pricing");
    assert.equal(buttonKind({ url: "https://a.example/store-locator", intent: "buy" }), "where-to-buy");
    assert.equal(buttonKind({ url: "https://a.example/shop", intent: "buy" }), "buy");
    assert.equal(buttonKind({ url: "https://a.example/support", intent: "support" }), undefined);
    assert.equal(kindOfLabel("Kostenlos testen"), "trial");
    assert.equal(kindOfLabel("Shop now"), "buy");
    assert.equal(scanButtonLabel({ "color.primary": "--brand custom property" }), undefined);
  });
});

describe("saved buttons, as each language's visitors get them (round 6 re-check, teamleader.eu)", () => {
  const pages = buttonPages(
    [
      row("https://www.teamleader.eu/es/precio", "price", "indexed", null, { lang: "es" }),
      row("https://www.teamleader.eu/nl-be/prijs", "price", "indexed", null, { lang: "nl-be" }),
      row("https://www.teamleader.eu/fr/prix", "price", "indexed", null, { lang: "fr" }),
    ],
    "https://www.teamleader.eu",
    () => true,
    pathLanguage,
  );
  // As saved before per-language suggestions: English main labelled "precio", German with no link.
  const saved = {
    languages: ["en", "de", "fr", "es", "nl"] as Language[],
    ctas: [{ label: "precio", url: "https://www.teamleader.eu/es/precio", keywords: ["precio", "price"] }],
    translations: {
      de: { ctas: [{ label: "Preise ansehen", keywords: ["preis"] }] },
      fr: { ctas: [{ label: "Voir les tarifs", keywords: ["prix"], url: "https://www.teamleader.eu/fr/prix" }] },
      es: { ctas: [{ label: "Ver precios", keywords: ["precio"], url: "https://www.teamleader.eu/es/precio" }] },
      nl: { ctas: [{ label: "Prijzen bekijken", keywords: ["prijs"] }] },
    },
  };

  it("never sends English or German visitors to /es/precio, and sends the Dutch to /nl-be/prijs", () => {
    const { settings, fits } = fitCtasToLanguages(saved, pages, "en", saved.languages, pathLanguage);
    const visitor = (l: Language) => localizeSettings(settings, l).ctas ?? [];
    // English: the button stays, for the others to pair with, but never matches here.
    assert.deepEqual(matchCtas(visitor("en"), "What are your prices? precio", ""), []);
    assert.deepEqual(visitor("de"), [], "German: no German pricing page, no button");
    assert.deepEqual(
      visitor("fr").map((c) => c.url),
      ["https://www.teamleader.eu/fr/prix"],
    );
    assert.deepEqual(
      visitor("es").map((c) => c.url),
      ["https://www.teamleader.eu/es/precio"],
    );
    assert.deepEqual(
      visitor("nl").map((c) => c.url),
      ["https://www.teamleader.eu/nl-be/prijs"],
    );
    assert.deepEqual(
      matchCtas(visitor("nl"), "Wat zijn jullie prijzen? prijs", "").map((c) => c.label),
      ["Prijzen bekijken"],
    );
    assert.deepEqual(
      fits.map((f) => [f.language, f.action]),
      [
        ["en", "hidden"],
        ["de", "hidden"],
        ["nl", "relinked"],
      ],
    );
  });

  it("leaves buttons alone where each language already opens its own page, and single-language deployments", () => {
    const fine = {
      ...saved,
      ctas: [{ label: "Ver precios", url: "https://www.teamleader.eu/es/precio", keywords: ["precio"] }],
      languages: ["es", "fr"] as Language[],
    };
    assert.deepEqual(fitCtasToLanguages(fine, pages, "es", ["es", "fr"], pathLanguage).fits, []);
    assert.deepEqual(fitCtasToLanguages(saved, pages, "en", ["en"], pathLanguage).fits, []);
  });
});
