import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTheme } from "@launchpad/theme";
import { buttonPaint, deriveTheme, logoCandidates, proposeName, siteDetails, siteName } from "../src/derive.ts";
import type { RawButton, RawStyles } from "../src/extract.ts";

// Roughly what a Bootstrap-based Sitefinity site reports.
const raw: RawStyles = {
  rootVars: { "--bs-primary": "#0d6efd", "--bs-body-font-family": "Lato, sans-serif" },
  body: {
    color: "rgb(33, 37, 41)",
    background: "rgb(255, 255, 255)",
    fontFamily: "Lato, sans-serif",
    fontSize: "16px",
    lineHeight: "24px",
  },
  heading: { fontFamily: '"Playfair Display", serif', color: "rgb(0, 0, 0)" },
  linkColor: "rgb(0, 82, 155)",
  buttons: [
    {
      text: "Menu",
      background: "rgb(248, 249, 250)",
      backgroundImage: "none",
      color: "rgb(0, 0, 0)",
      borderRadius: "4px",
      fontWeight: "400",
      boxShadow: "none",
      width: 80,
      height: 32,
      count: 6,
    },
    {
      text: "Shop now",
      background: "rgb(227, 6, 19)",
      backgroundImage: "none",
      color: "rgb(255, 255, 255)",
      borderRadius: "24px",
      fontWeight: "700",
      boxShadow: "none",
      width: 160,
      height: 48,
      count: 4,
    },
  ],
  input: { borderColor: "rgb(206, 212, 218)", borderRadius: "6px" },
  loadedFonts: ["Lato", "Playfair Display"],
  icons: [],
};

describe("deriveTheme", () => {
  it("takes the primary color from the dominant brand-colored CTA, not grey UI buttons", () => {
    const { input, confidence, sources } = deriveTheme(raw);
    assert.equal(input.color?.primary, "#e30613");
    assert.equal(input.color?.onPrimary, "#ffffff");
    assert.equal(confidence["color.primary"], 0.9);
    assert.equal(sources["color.primary"], 'button "Shop now" ×4');
  });

  it("keeps pill buttons as pills and derives sane panel corners", () => {
    const { input } = deriveTheme(raw);
    assert.equal(input.shape?.buttonRadius, "999px");
    assert.equal(input.shape?.radius, "16px");
    assert.equal(input.shape?.inputRadius, "6px");
  });

  it("uses the site's fonts only when they actually loaded", () => {
    assert.equal(deriveTheme(raw).input.font?.family, "Lato, sans-serif");
    assert.equal(deriveTheme(raw).input.font?.headingFamily, '"Playfair Display", serif');
    assert.equal(deriveTheme({ ...raw, loadedFonts: [] }).input.font?.family, undefined);
    assert.equal(deriveTheme(raw).input.font?.lineHeight, "1.50");
  });

  it("falls back to a brand custom property when there is no CTA", () => {
    const { input, sources } = deriveTheme({ ...raw, buttons: [] });
    assert.equal(input.color?.primary, "#0d6efd");
    assert.equal(sources["color.primary"], "--bs-primary");
  });

  it("reads the finish off the CTA's background", () => {
    const cta = raw.buttons[1]!;
    const withCta = (patch: Partial<typeof cta>) => deriveTheme({ ...raw, buttons: [{ ...cta, ...patch }] });

    const flat = deriveTheme(raw);
    assert.equal(flat.input.finish?.style, "flat");
    assert.equal(flat.confidence["finish.style"], 0.6);

    // Gradient buttons usually report a transparent background-color.
    const gradient = withCta({
      background: "rgba(0, 0, 0, 0)",
      backgroundImage: "linear-gradient(90deg, rgb(124, 58, 237) 0%, rgb(219, 39, 119) 100%)",
    });
    assert.equal(gradient.input.color?.primary, "#7c3aed");
    assert.equal(gradient.input.finish?.style, "gradient");
    assert.equal(gradient.input.finish?.gradientEnd, "#db2777");

    const gloss = withCta({ backgroundImage: "linear-gradient(rgba(255, 255, 255, 0.3), rgba(255, 255, 255, 0) 50%)" });
    assert.equal(gloss.input.color?.primary, "#e30613");
    assert.equal(gloss.input.finish?.style, "gloss");
  });

  it("treats a gradient between near-identical stops as flat", () => {
    const paint = buttonPaint({ ...raw.buttons[1]!, backgroundImage: "linear-gradient(rgb(227, 6, 19), rgb(230, 8, 20))" });
    assert.equal(paint.finish, "flat");
  });

  it("produces a theme that survives sanitising and contrast checks", () => {
    const { theme, warnings } = resolveTheme(deriveTheme(raw).input);
    assert.deepEqual(warnings, []);
    assert.equal(theme.color.primary, "#e30613");
  });
});

describe("choosing the primary color", () => {
  const button = (patch: Partial<RawButton>): RawButton => ({
    text: "Go",
    background: "rgb(0, 82, 155)",
    backgroundImage: "none",
    color: "rgb(255, 255, 255)",
    borderRadius: "4px",
    fontWeight: "600",
    boxShadow: "none",
    width: 100,
    height: 36,
    count: 1,
    ...patch,
  });

  it("prefers the hero's big call to action over a small, repeated one in the navigation", () => {
    // What whatsupgold.com and kemptechnologies.com looked like in round 1.
    const nav = button({
      text: "Free Trial",
      background: "rgb(0, 112, 210)",
      width: 110,
      height: 40,
      count: 3,
      area: 4400,
      aboveFold: true,
    });
    const hero = button({
      text: "Get started",
      background: "rgb(230, 0, 126)",
      width: 240,
      height: 56,
      count: 1,
      area: 13440,
      aboveFold: true,
    });
    const { input, sources } = deriveTheme({ ...raw, buttons: [nav, hero] });
    assert.equal(input.color?.primary, "#e6007e");
    assert.equal(sources["color.primary"], 'button "Get started" ×1');
  });

  it("takes the hero's first call to action over a look repeated across the page", () => {
    // whatsupgold.com: "Download free trial" (pink) and "Launch demo" (blue) side by side in the
    // hero, the blue also in the navigation and further down.
    const blue = button({ text: "Free Trial", background: "rgb(34, 94, 255)", count: 9, area: 15120, aboveFold: true });
    const pink = button({ text: "Download Free Trial", background: "rgb(235, 2, 73)", count: 2, area: 15120, aboveFold: true, hero: true });
    assert.equal(deriveTheme({ ...raw, buttons: [blue, pink] }).input.color?.primary, "#eb0249");
  });

  it("weighs buttons above the fold over the same buttons further down", () => {
    const low = button({ text: "Footer", background: "rgb(0, 128, 0)", count: 2, area: 6000, aboveFold: false });
    const high = button({ text: "Header", background: "rgb(128, 0, 128)", count: 2, area: 6000, aboveFold: true });
    assert.equal(deriveTheme({ ...raw, buttons: [low, high] }).input.color?.primary, "#800080");
  });

  it("never rates a single button as high confidence", () => {
    const one = deriveTheme({ ...raw, buttons: [button({ background: "rgb(227, 6, 19)", count: 1 })] });
    assert.ok(one.confidence["color.primary"]! < 0.6, "flagged Check this");
    const two = deriveTheme({ ...raw, buttons: [button({ background: "rgb(227, 6, 19)", count: 2 })] });
    assert.equal(two.confidence["color.primary"], 0.7);
  });

  it("flags a primary color it couldn't find, like a guess", () => {
    // chef.io in round 1: no button qualified, and the default slate showed with no warning.
    const none = deriveTheme({ ...raw, rootVars: {}, linkColor: "rgb(20, 20, 20)", buttons: [] });
    assert.equal(none.input.color?.primary, undefined);
    assert.equal(none.confidence["color.primary"], 0.2);
    assert.equal(none.sources["color.primary"], "not found: the default");
    assert.equal(deriveTheme({ ...raw, loadedFonts: [] }).confidence["font.family"], 0.2);
  });
});

describe("proposeName", () => {
  const site = { title: "", jsonLdNames: [] as string[] };

  it("proposes the title's spelling and flags og:site_name's other spelling, with every source (whatsupgold.com)", () => {
    const proposed = proposeName(
      { ...site, title: "Network Monitoring Tools & Software - WhatsUp Gold", ogSiteName: "What's Up Gold" },
      "www.whatsupgold.com",
    );
    assert.equal(proposed.name, "WhatsUp Gold");
    assert.equal(proposed.check, true);
    assert.deepEqual(proposed.sources, [
      { source: "title", value: "WhatsUp Gold" },
      { source: "og:site_name", value: "What's Up Gold" },
      { source: "domain", value: "Whatsupgold" },
    ]);
  });

  it("takes the name most sources give, without flagging a longer form of it (progress.com)", () => {
    const proposed = proposeName(
      {
        ...site,
        title: "Unleash the Power of AI for Your Business | Progress Software",
        ogSiteName: "Progress.com",
        logoAlt: "Progress logo",
        jsonLdNames: ["Progress"],
      },
      "www.progress.com",
    );
    assert.equal(proposed.name, "Progress");
    assert.equal(proposed.check, false);
    assert.deepEqual(
      proposed.sources.map((s) => s.source),
      ["logo-alt", "title", "og:site_name", "structured-data", "domain"],
    );
  });

  it("reads the logo's alt text without the words around the name, and ignores alt text that names nothing", () => {
    assert.equal(proposeName({ ...site, title: "Home | Products, Coloring Pages", logoAlt: "Crayola" }, "www.crayola.com").name, "Crayola");
    const telerik = proposeName(
      {
        ...site,
        title: "Telerik & Kendo UI - .NET Components Suites & JavaScript UI Libraries",
        ogSiteName: "Telerik.com",
        logoAlt: "Go to Homepage",
      },
      "www.telerik.com",
    );
    assert.equal(telerik.name, "Telerik");
    assert.equal(telerik.check, false);
    assert.ok(!telerik.sources.some((s) => s.source === "logo-alt"));
  });

  it("flags a source that names something else", () => {
    const proposed = proposeName(
      { ...site, title: "Load Balancer - Kemp", ogSiteName: "Kemp", logoAlt: "Acme Partner Logo" },
      "kemptechnologies.com",
    );
    assert.equal(proposed.name, "Kemp");
    assert.equal(proposed.check, true);
  });

  it("treats all-caps styling as the same spelling", () => {
    assert.equal(proposeName({ ...site, title: "Crayola | Official Site", ogSiteName: "CRAYOLA" }, "www.crayola.com").check, false);
  });

  it("falls back to the domain, flagged", () => {
    const proposed = proposeName({ ...site, title: "Home page" }, "www.whatsupgold.com");
    assert.deepEqual(proposed, { name: "Whatsupgold", sources: [{ source: "domain", value: "Whatsupgold" }], check: true });
    assert.equal(siteName(undefined, "www.philips.co.uk"), "Philips");
  });
});

describe("logoCandidates", () => {
  it("offers header logos linking home first, then icons, and og:image only to check", () => {
    const candidates = logoCandidates({
      ...raw,
      logos: [{ url: "https://www.chef.io/logo.svg", width: 195, height: 32, alt: "Chef logo" }],
      iconLinks: [
        { url: "https://www.chef.io/favicon.ico", rel: "icon" },
        { url: "https://www.chef.io/icon-192.png", rel: "icon", size: 192 },
        { url: "https://www.chef.io/apple-touch-icon.png", rel: "apple-touch-icon", size: 180 },
      ],
      site: { title: "Chef", jsonLdNames: [], ogImage: "https://www.chef.io/social.png" },
    });
    assert.deepEqual(
      candidates.map((c) => [c.source, c.url.split("/").pop(), c.check ?? false]),
      [
        ["header-home", "logo.svg", false],
        ["apple-touch-icon", "apple-touch-icon.png", false],
        ["icon", "icon-192.png", false],
        ["icon", "favicon.ico", false],
        ["og:image", "social.png", true],
      ],
    );
  });

  it("gives each icon its size as loaded, ahead of the size it declares", () => {
    const candidates = logoCandidates({
      ...raw,
      logos: [{ url: "data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E", width: 232, height: 26, alt: "WhatsUp Gold" }],
      iconLinks: [
        { url: "https://www.whatsupgold.com/favicon.ico", rel: "icon", width: 48, height: 48 },
        { url: "https://www.whatsupgold.com/icon.png", rel: "icon", size: 16, width: 64, height: 64 },
      ],
    });
    assert.deepEqual(
      candidates.map((c) => [c.source, c.url.split("/").pop(), c.width, c.height]),
      [
        ["header-home", "svg+xml,%3Csvg%3E%3C%2Fsvg%3E", 232, 26],
        ["icon", "icon.png", 64, 64],
        ["icon", "favicon.ico", 48, 48],
      ],
    );
  });

  it("offers no content images: only what the page's header, icons and og:image give", () => {
    assert.deepEqual(logoCandidates({ ...raw, logos: [], iconLinks: [], site: { title: "", jsonLdNames: [] } }), []);
  });
});

describe("siteDetails", () => {
  it("lists the name and its sources, avatar options, the privacy notice, the contact page, the bottom bar, languages and https web fonts", () => {
    const details = siteDetails(
      {
        ...raw,
        site: { title: "Crayola | Official Site", jsonLdNames: [] },
        lang: "en-us",
        hreflang: ["en-us", "es-mx", "fr-ca"],
        fonts: [
          { kind: "stylesheet", url: "https://fonts.googleapis.com/css2?family=Open+Sans" },
          { kind: "face", family: "Omnes", url: "https://www.crayola.com/fonts/omnes.woff2" },
          { kind: "face", family: "Old", url: "http://insecure.example/old.woff" },
        ],
        logos: [{ url: "https://www.crayola.com/crayola.png", width: 228, height: 149, alt: "Crayola" }],
        privacy: { url: "https://www.crayola.com/privacy-policy", text: "Privacy Policy" },
        contact: { url: "https://www.crayola.com/contact-us", text: "Contact Us" },
        bottomBar: { height: 59, label: "OneTrust cookie banner" },
      },
      "https://www.crayola.com/",
    );
    assert.deepEqual(details, {
      siteName: "Crayola",
      nameSources: [
        { source: "title", value: "Crayola" },
        { source: "domain", value: "Crayola" },
      ],
      nameCheck: false,
      logoCandidates: [{ url: "https://www.crayola.com/crayola.png", source: "header-home", width: 228, height: 149, alt: "Crayola" }],
      privacyUrl: "https://www.crayola.com/privacy-policy",
      contactUrl: "https://www.crayola.com/contact-us",
      bottomBar: { height: 59, label: "OneTrust cookie banner" },
      pageLanguage: "en-us",
      languages: ["en-us", "es-mx", "fr-ca"],
      fonts: [
        { kind: "stylesheet", url: "https://fonts.googleapis.com/css2?family=Open+Sans" },
        { kind: "face", family: "Omnes", url: "https://www.crayola.com/fonts/omnes.woff2" },
      ],
    });
  });
});
