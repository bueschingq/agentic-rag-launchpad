import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultTheme, resolveTheme, type SiteScan } from "@launchpad/theme";
import { sampleStream } from "../src/lib/sample-answer.ts";
import { ScanError, scanSite, snifferSettings } from "../src/lib/sniffer.ts";
import {
  colorName,
  contactParts,
  contactUrl,
  cornerPreset,
  draftFor,
  handoffSuggestions,
  parseWidgetDraft,
  pixels,
  plainRepair,
  plainSource,
  SHADOW_PRESETS,
  safeLink,
  scanTarget,
  shadowPreset,
} from "../src/lib/widget-form.ts";

const draft = (settings: Record<string, unknown> = {}, theme: Record<string, unknown> = defaultTheme) =>
  JSON.stringify({ theme, settings });

const errorsOf = (json: string) => {
  const parsed = parseWidgetDraft(json);
  return "errors" in parsed ? parsed.errors : {};
};

describe("parseWidgetDraft", () => {
  it("keeps a full, valid configuration", () => {
    const parsed = parseWidgetDraft(
      draft(
        {
          mode: "chat",
          nickname: " Harbor Help ",
          avatar: "https://www.harborview.example/logo.svg",
          starters: ["Opening hours?", "  ", "Do you take new patients?"],
          welcome: "",
          showSources: false,
          handoff: {
            message: "Our front desk can help:",
            contacts: [
              { kind: "link", url: "tel:+1 (555) 123-4567" },
              { kind: "link", url: "mailto:", label: "" },
              { kind: "link", url: "https://www.harborview.example/contact", label: "Contact form" },
            ],
            show: ["no-answer", "header", "header"],
          },
          ctas: [{ label: "Book a visit", url: "https://www.harborview.example/book", keywords: ["appointment", " booking", ""] }],
          analytics: { googleAnalytics: true, measurementId: "g-abc123" },
          customCss: ".launcher { box-shadow: none; }",
          language: "es",
        },
        { ...defaultTheme, color: { ...defaultTheme.color, primary: "#0F766E" } },
      ),
    );
    assert.ok("value" in parsed, JSON.stringify(parsed));
    const { settings, theme } = parsed.value;
    assert.equal(theme.color?.primary, "#0F766E");
    assert.deepEqual(settings, {
      mode: "chat",
      nickname: "Harbor Help",
      avatar: "https://www.harborview.example/logo.svg",
      starters: ["Opening hours?", "Do you take new patients?"],
      showSources: false,
      poweredBy: false,
      handoff: {
        message: "Our front desk can help:",
        contacts: [
          { kind: "link", url: "tel:+15551234567" },
          { kind: "link", url: "https://www.harborview.example/contact", label: "Contact form" },
        ],
        show: ["no-answer", "header"],
      },
      ctas: [{ label: "Book a visit", url: "https://www.harborview.example/book", keywords: ["appointment", "booking"] }],
      analytics: { googleAnalytics: true, measurementId: "G-ABC123" },
      customCss: ".launcher { box-shadow: none; }",
    });
  });

  it("marks colors and lengths the theme would reject", () => {
    const errors = errorsOf(
      draft({}, { ...defaultTheme, color: { ...defaultTheme.color, primary: "blurple" }, shape: { radius: "1e9vw" } }),
    );
    assert.deepEqual(Object.keys(errors).sort(), ["theme.color.primary", "theme.shape.radius"]);
  });

  it("refuses links that could run script or aren't https", () => {
    const errors = errorsOf(
      draft({
        avatar: "http://insecure.example/logo.png",
        handoff: { contacts: [{ kind: "link", url: "javascript:alert(1)" }], show: [] },
        ctas: [{ label: "Go", url: "data:text/html,x", keywords: ["go"] }],
      }),
    );
    assert.ok(errors["settings.avatar"]);
    assert.ok(errors["settings.handoff.contacts.0.url"]);
    assert.ok(errors["settings.ctas.0.url"]);
  });

  it("needs a contact, or the contact form, before the handoff can show", () => {
    assert.ok(errorsOf(draft({ handoff: { contacts: [{ kind: "link", url: "tel:" }], show: ["header"] } }))["settings.handoff.show"]);
    const withForm = parseWidgetDraft(
      draft({
        handoff: { contacts: [], show: ["no-answer", "header"] },
        lead: { enabled: true, fields: ["name", "email", "nickname"], requiredFields: ["email", "phone"] },
      }),
    );
    assert.ok("value" in withForm, JSON.stringify(withForm));
    assert.deepEqual(withForm.value.settings.lead, { enabled: true, fields: ["name", "email"], requiredFields: ["email"] });
  });

  it("needs a way to reply to a lead", () => {
    assert.ok(errorsOf(draft({ lead: { enabled: true, fields: ["name", "message"], requiredFields: [] } }))["settings.lead.fields"]);
  });

  it("keeps how each button matches, and buttons that open the contact form", () => {
    const parsed = parseWidgetDraft(
      draft({
        lead: { enabled: true, fields: ["email"], requiredFields: ["email"] },
        ctas: [
          { label: "Rates", url: "https://a.example/rates", keywords: ["rate"], match: "contains" },
          { label: "Call me back", url: "ignored", keywords: ["callback"], action: "lead", match: "word" },
        ],
      }),
    );
    assert.ok("value" in parsed, JSON.stringify(parsed));
    assert.deepEqual(parsed.value.settings.ctas, [
      { label: "Rates", url: "https://a.example/rates", keywords: ["rate"], match: "contains" },
      { label: "Call me back", url: "", keywords: ["callback"], action: "lead" },
    ]);
    assert.ok(errorsOf(draft({ ctas: [{ label: "Call me", url: "", keywords: ["call"], action: "lead" }] }))["settings.ctas.0.action"]);
  });

  it("keeps rewordings, the privacy notice and the pages to stay off", () => {
    const parsed = parseWidgetDraft(
      draft({
        copy: { noAnswer: " Nothing on that, sorry. ", talkToPerson: "", bogus: "x" },
        privacyUrl: "https://www.harborview.example/privacy",
        exclude: ["/login", " /checkout/* ", "/login"],
      }),
    );
    assert.ok("value" in parsed, JSON.stringify(parsed));
    assert.deepEqual(parsed.value.settings.copy, { noAnswer: "Nothing on that, sorry." });
    assert.equal(parsed.value.settings.privacyUrl, "https://www.harborview.example/privacy");
    assert.deepEqual(parsed.value.settings.exclude, ["/login", "/checkout/*"]);
    assert.ok(errorsOf(draft({ privacyUrl: "http://plain.example/privacy" }))["settings.privacyUrl"]);
    assert.ok(errorsOf(draft({ exclude: ["login page"] }))["settings.exclude"]);
  });

  it("keeps copy per language, for the languages served after the first", () => {
    const parsed = parseWidgetDraft(
      draft({
        languages: ["en", "es", "klingon"],
        ctas: [{ label: "See pricing", url: "https://a.example/pricing", keywords: ["price"] }],
        translations: {
          es: {
            welcome: "¡Hola!",
            starters: ["¿Horario?", ""],
            ctas: [{ label: "Ver precios", keywords: ["precio"] }, { label: "extra" }],
          },
          en: { welcome: "ignored: the main copy is in English" },
          fr: { welcome: "ignored: not served" },
        },
      }),
    );
    assert.ok("value" in parsed, JSON.stringify(parsed));
    assert.deepEqual(parsed.value.settings.languages, ["en", "es"]);
    assert.deepEqual(parsed.value.settings.translations, {
      es: { welcome: "¡Hola!", starters: ["¿Horario?"], ctas: [{ label: "Ver precios", keywords: ["precio"] }] },
    });
    const errors = errorsOf(draft({ languages: ["en", "es"], ctas: [], translations: { es: { welcome: "x".repeat(600) } } }));
    assert.ok(errors["settings.translations.es.welcome"]);
  });

  it("keeps each language's own pages for its buttons and contacts, and checks them like the main ones", () => {
    const base = {
      languages: ["en", "de"],
      ctas: [
        { label: "Free trial", url: "https://www.whatsupgold.com/trial", keywords: ["trial"] },
        { label: "Get a quote", url: "", keywords: ["quote"], action: "lead" },
      ],
      lead: { enabled: true, fields: ["email"], requiredFields: ["email"] },
      handoff: { contacts: [{ kind: "link", url: "https://www.whatsupgold.com/contact" }], show: ["no-answer"] },
    };
    const parsed = parseWidgetDraft(
      draft({
        ...base,
        translations: {
          de: {
            ctas: [
              { label: "Kostenlose Testversion", keywords: ["test"], url: "https://www.whatsupgold.com/de/trial" },
              { label: "Angebot anfordern", keywords: ["angebot"], url: "https://ignored.example/" },
            ],
            handoffContacts: [{ url: "https://www.whatsupgold.com/de/kontakt", label: "Kontakt" }, { url: "https://extra.example/" }],
          },
        },
      }),
    );
    assert.ok("value" in parsed, JSON.stringify(parsed));
    assert.deepEqual(parsed.value.settings.translations?.de, {
      ctas: [
        { label: "Kostenlose Testversion", keywords: ["test"], url: "https://www.whatsupgold.com/de/trial" },
        { label: "Angebot anfordern", keywords: ["angebot"] },
      ],
      handoffContacts: [{ url: "https://www.whatsupgold.com/de/kontakt", label: "Kontakt" }],
    });
    const errors = errorsOf(
      draft({
        ...base,
        translations: {
          de: { ctas: [{ label: "Test", keywords: ["test"], url: "javascript:alert(1)" }], handoffContacts: [{ url: "http://x.example" }] },
        },
      }),
    );
    assert.ok(errors["settings.translations.de.ctas.0.url"]);
    assert.ok(errors["settings.translations.de.handoffContacts.0.url"]);
  });

  it("needs keywords for a button, and a label", () => {
    const errors = errorsOf(draft({ ctas: [{ label: "", url: "https://a.example/b", keywords: [" "] }] }));
    assert.ok(errors["settings.ctas.0.label"]);
    assert.ok(errors["settings.ctas.0.keywords"]);
    // A row left entirely blank is ignored.
    assert.deepEqual(errorsOf(draft({ ctas: [{ label: "", url: "", keywords: [] }] })), {});
  });

  it("checks the measurement ID and custom CSS", () => {
    assert.ok(errorsOf(draft({ analytics: { googleAnalytics: true, measurementId: "UA-12345-1" } }))["settings.analytics.measurementId"]);
    assert.ok(errorsOf(draft({ customCss: '@import url("https://evil.example/x.css");' }))["settings.customCss"]);
    assert.ok(errorsOf(draft({ customCss: "a{}".repeat(4000) }))["settings.customCss"]);
  });

  it("caps starter questions", () => {
    assert.ok(errorsOf(draft({ starters: ["a", "b", "c", "d", "e"] }))["settings.starters"]);
  });

  it("rejects anything that isn't a draft", () => {
    assert.ok(errorsOf("not json")._form);
    assert.ok(errorsOf(JSON.stringify({ theme: {} }))._form);
  });
});

describe("draftFor", () => {
  it("resolves every token and leaves the deployment's language out", () => {
    const d = draftFor({ color: { primary: "#0f766e" } }, { language: "es", mode: "popup" });
    assert.equal(d.theme.color.primary, "#0f766e");
    assert.equal(d.theme.font.family, defaultTheme.font.family);
    assert.deepEqual(d.settings, { mode: "popup" });
  });
});

describe("contact links", () => {
  it("round-trips a type and value through a URL, keeping the type when empty", () => {
    assert.equal(contactUrl("phone", " +1 555 "), "tel:+1 555");
    assert.deepEqual(contactParts(contactUrl("email", "")), { type: "email", value: "" });
    assert.deepEqual(contactParts("https://a.example/contact"), { type: "page", value: "https://a.example/contact" });
  });

  it("normalises phone numbers and checks emails", () => {
    assert.equal(safeLink("tel:+44 (20) 7946.0958"), "tel:+442079460958");
    assert.equal(safeLink("tel:call me"), undefined);
    assert.equal(safeLink("mailto:help@clinic.example"), "mailto:help@clinic.example");
    assert.equal(safeLink("mailto:nobody"), undefined);
    assert.equal(safeLink("http://plain.example"), undefined);
  });

  it("takes bare hosts as pages to scan", () => {
    assert.equal(scanTarget("www.progress.com"), "https://www.progress.com/");
    assert.equal(scanTarget("ftp://files.example"), undefined);
    assert.equal(scanTarget("localhost"), undefined);
  });
});

describe("handoffSuggestions", () => {
  const primary = { name: "Dana Ortiz", email: "dana@harborview.example", phone: "+1 555 0100" };

  it("suggests the site's shortest contact page, then the primary contact's phone and email", () => {
    const pages = [
      { url: "https://www.harborview.example/services/contact-lenses" },
      { url: "https://www.harborview.example/es/contacto" },
      { url: "https://www.harborview.example/contact-us/" },
      { url: "https://www.harborview.example/about" },
    ];
    assert.deepEqual(
      handoffSuggestions(pages, primary).map((s) => s.contact.url),
      ["https://www.harborview.example/es/contacto", "tel:+1 555 0100", "mailto:dana@harborview.example"],
    );
  });

  it("suggests nothing it can't stand behind", () => {
    assert.deepEqual(handoffSuggestions([{ url: "http://www.harborview.example/contact" }, { url: "not a url" }], undefined), []);
    assert.deepEqual(
      handoffSuggestions([], { ...primary, phone: null }).map((s) => s.contact.url),
      ["mailto:dana@harborview.example"],
    );
  });
});

describe("scanSite", () => {
  const settings = { url: "http://sniffer:4100", token: "t" };
  const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

  it("posts the page with the shared token", async () => {
    let seen: Request | undefined;
    const scan = { url: "https://a.example/" } as SiteScan;
    const result = await scanSite("https://a.example/", settings, async (input, init) => {
      seen = new Request(input, init);
      return new Response(JSON.stringify(scan));
    });
    assert.deepEqual(result, scan);
    assert.equal(seen?.url, "http://sniffer:4100/scan");
    assert.equal(seen?.headers.get("x-sniffer-token"), "t");
    assert.deepEqual(await seen?.json(), { url: "https://a.example/" });
  });

  it("explains each failure", async () => {
    await assert.rejects(scanSite("x", undefined), /SNIFFER_URL/);
    await assert.rejects(scanSite("x", settings, reply(400, { error: "Private address." })), /can't be scanned: Private address/);
    await assert.rejects(scanSite("x", settings, reply(401, {})), /SNIFFER_TOKEN/);
    await assert.rejects(scanSite("x", settings, reply(429, {})), /busy/);
    await assert.rejects(scanSite("x", settings, reply(502, {})), (err) => err instanceof ScanError && /didn't load/.test(err.message));
    await assert.rejects(
      scanSite("x", settings, async () => {
        throw new TypeError("fetch failed");
      }),
      /isn't reachable at http:\/\/sniffer:4100/,
    );
  });

  it("reads its settings without needing Agentic RAG credentials", () => {
    assert.deepEqual(snifferSettings({ SNIFFER_URL: "http://s:4100/", SNIFFER_TOKEN: " k " }), { url: "http://s:4100", token: "k" });
    assert.equal(snifferSettings({ SNIFFER_URL: "http://s:4100" }), undefined);
  });
});

describe("sampleStream", () => {
  it("streams a translated answer with sources on the customer's site", () => {
    const items = sampleStream("fr", "https://www.harborview.example/clinic", "answer").map((l) => JSON.parse(l).item);
    const resources = items[0].results.resources;
    assert.equal(resources["sample-home"].origin.url, "https://www.harborview.example/");
    const answer = items
      .filter((i) => i.type === "answer")
      .map((i) => i.text)
      .join("");
    assert.match(answer, /^Ceci est une réponse d'exemple/);
    assert.ok(items.some((i) => i.type === "citations"));
  });

  it("streams the nothing-found reply an empty KB gives", () => {
    const items = sampleStream("en", "https://a.example", "no-answer").map((l) => JSON.parse(l).item);
    assert.deepEqual(items[0], { type: "status", status: "no_retrieval_data", code: "-3" });
  });
});

describe("plain words", () => {
  it("says where a scanned value came from", () => {
    assert.equal(plainSource('button "View Guide" ×8'), "Taken from the site's “View Guide” button, used 8 times");
    assert.equal(plainSource('button "Shop now" ×1'), "Taken from the site's “Shop now” button");
    assert.equal(plainSource("--bs-primary"), "From the site's brand color setting (--bs-primary)");
    assert.equal(plainSource("body background"), "From the page's background");
    assert.equal(plainSource("not found: the default"), "Not found on the site, so this is the default");
    assert.equal(plainSource("something new"), "From something new");
  });

  it("names colors the way people do", () => {
    assert.equal(colorName("#ffcc33"), "yellow");
    assert.equal(colorName("#00502e"), "dark green");
    assert.equal(colorName("#000000"), "black");
    assert.equal(colorName("#ffffff"), "white");
    assert.equal(colorName("#6b7280"), "grey");
    assert.equal(colorName("#1d4ed8"), "blue");
  });

  it("explains each contrast repair", () => {
    const { theme, repairs } = resolveTheme({ color: { primary: "#ffcc33", onPrimary: "#ffffff", border: "#eeeeee" } });
    const words = repairs.map((r) => plainRepair(r, theme));
    assert.ok(words.includes("Button text changed to black so it's readable on yellow."), words.join(" | "));
    assert.ok(words.some((w) => w.startsWith("Borders darkened")));
    assert.ok(
      words.some((w) => /^The chat button gets a .* outline so it stands out on a white page\.$/.test(w)),
      words.join(" | "),
    );
  });
});

describe("presets", () => {
  it("recognises the corner and shadow presets, and values set by hand", () => {
    assert.equal(cornerPreset(defaultTheme.shape), "rounded");
    assert.equal(cornerPreset({ ...defaultTheme.shape, buttonRadius: "3px" }), undefined);
    assert.equal(shadowPreset(defaultTheme.shape.shadow), "soft");
    assert.equal(shadowPreset(SHADOW_PRESETS.none.value), "none");
    assert.equal(shadowPreset("0 1px 2px red"), undefined);
    assert.equal(pixels("72px"), 72);
    assert.equal(pixels("2rem"), undefined);
  });
});
