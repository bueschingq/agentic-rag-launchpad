import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTheme } from "@launchpad/theme";
import {
  applySuggestions,
  avatarUrl,
  consentGaps,
  customerSuggestions,
  draftFor,
  handoffSuggestions,
  parseWidgetDraft,
  plainSource,
  type ScanFindings,
  scanSuggestions,
  suggestionTopics,
  unapplied,
  withContactPage,
} from "../src/lib/widget-form.ts";

// telerik.com as scanned on 2026-10-30, trimmed to what suggestions use.
const telerik: ScanFindings = {
  theme: resolveTheme({ color: { primary: "#eb0249", onPrimary: "#ffffff" }, font: { family: "Metric, sans-serif" } }).theme,
  confidence: { "color.primary": 0.9, "color.onPrimary": 0.8, "font.family": 0.9, "font.size": 0.2 },
  sources: {
    "color.primary": 'button "Get A Free Trial" ×3',
    "color.onPrimary": 'button "Get A Free Trial" text',
    "font.family": "body font",
    "font.size": "not found: the default",
  },
  siteName: "Telerik",
  nameSources: [
    { source: "og:site_name", value: "Telerik" },
    { source: "title", value: "Telerik & Kendo UI" },
  ],
  nameCheck: false,
  logo: "data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E",
  logoCandidates: [
    { url: "data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E", source: "header-home", width: 147, height: 60 },
    { url: "https://www.telerik.com/favicon.ico", source: "icon" },
    { url: "https://www.telerik.com/social.png", source: "og:image", check: true },
  ],
  privacyUrl: "https://www.progress.com/legal/privacy-center",
  bottomBar: { height: 94, label: "OneTrust cookie banner" },
};

describe("the scan's suggestions", () => {
  const blank = draftFor({}, {});

  it("proposes only what the scan found, and the avatar that reads at the chat's size", () => {
    const keys = scanSuggestions(telerik).map((s) => s.key);
    assert.ok(keys.includes("color.primary"));
    assert.ok(!keys.includes("font.size"), "a default isn't a finding");
    assert.deepEqual(
      scanSuggestions(telerik)
        .filter((s) => !s.key.includes("."))
        .map((s) => [s.key, s.value]),
      [
        ["nickname", "Telerik"],
        // Not the 147×60 "Progress Telerik" lockup, 69×28 in the header: the site's icon.
        ["avatar", "https://www.telerik.com/favicon.ico"],
        ["privacyUrl", "https://www.progress.com/legal/privacy-center"],
        ["liftAboveBars", true],
      ],
    );
  });

  it("marks an icon of unknown size, and a wide logo when it's all there is, for a person to check", () => {
    const avatar = (scan: ScanFindings) => scanSuggestions(scan).find((s) => s.key === "avatar");
    // Scanned before icons were measured.
    assert.deepEqual(avatar(telerik), {
      key: "avatar",
      value: "https://www.telerik.com/favicon.ico",
      source: "logo icon unsized",
      low: true,
    });
    assert.equal(plainSource("logo icon unsized"), "The site's browser-tab icon: its size isn't known, so check it looks sharp");
    const measured = (telerik.logoCandidates ?? []).map((c) => (c.source === "icon" ? { ...c, width: 48, height: 48 } : c));
    assert.equal(avatar({ ...telerik, logoCandidates: measured })?.low, false);
    // whatsupgold.com links no icon: its 232×26 wordmark, flagged.
    const wug = avatar({
      ...telerik,
      logoCandidates: [{ url: "data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E", source: "header-home", width: 232, height: 26 }],
    });
    assert.deepEqual([wug?.source, wug?.low], ["logo header-home wide", true]);
    assert.match(plainSource("logo header-home wide"), /hard to read at the chat's size/);
  });

  it("proposes no avatar from a scan without candidates, or with only og:image", () => {
    const old = { ...telerik, logoCandidates: undefined, logo: "https://www.progress.com/usa-swimming-logo.svg" };
    assert.ok(!scanSuggestions(old).some((s) => s.key === "avatar"));
    const ogOnly = { ...telerik, logoCandidates: (telerik.logoCandidates ?? []).filter((c) => c.source === "og:image") };
    assert.ok(!scanSuggestions(ogOnly).some((s) => s.key === "avatar"));
  });

  it("suggests the customer's name visitors see ahead of the scan's name", () => {
    const sitefinity = { ...telerik, siteName: "Progress", nameSources: [{ source: "logo-alt" as const, value: "Progress" }] };
    const name = scanSuggestions(sitefinity, { displayName: "Progress Sitefinity" }).find((s) => s.key === "nickname");
    assert.deepEqual(name, { key: "nickname", value: "Progress Sitefinity", source: "customer display name", low: false });
    assert.equal(plainSource("customer display name"), "The customer's “Name visitors see”");
    assert.equal(scanSuggestions(sitefinity, { displayName: " " }).find((s) => s.key === "nickname")?.value, "Progress");
    // Before any scan, too.
    assert.deepEqual(
      customerSuggestions({ displayName: "Progress Sitefinity" }).map((s) => s.value),
      ["Progress Sitefinity"],
    );
    assert.deepEqual(customerSuggestions({ displayName: null }), []);
  });

  it("changes nothing until applied; Apply all gives the scanned primary, name and logo, and saves as such", () => {
    const suggestions = scanSuggestions(telerik);
    const pending = unapplied(blank, suggestions);
    assert.deepEqual(suggestionTopics(pending), ["colors", "fonts", "the chat name", "the logo", "the privacy notice"]);
    const applied = applySuggestions(blank, pending);
    assert.deepEqual(unapplied(applied, suggestions), []);
    const parsed = parseWidgetDraft(JSON.stringify(applied));
    assert.ok("value" in parsed, JSON.stringify(parsed));
    assert.equal(resolveTheme(parsed.value.theme).theme.color.primary, "#eb0249");
    assert.equal(parsed.value.settings.nickname, "Telerik");
    assert.equal(parsed.value.settings.avatar, "https://www.telerik.com/favicon.ico");
    assert.equal(parsed.value.settings.privacyUrl, "https://www.progress.com/legal/privacy-center");
    // The chat button's own place stays the partner's.
    assert.deepEqual(applied.theme.launcher, blank.theme.launcher);
  });

  it("applies one field on its own", () => {
    const name = scanSuggestions(telerik).filter((s) => s.key === "nickname");
    const applied = applySuggestions(blank, name);
    assert.equal(applied.settings.nickname, "Telerik");
    assert.equal(applied.theme.color.primary, blank.theme.color.primary);
  });

  it("flags a name the sources disagree on, and says where values came from", () => {
    const wug = scanSuggestions({
      ...telerik,
      siteName: "WhatsUp Gold",
      nameCheck: true,
      nameSources: [{ source: "title", value: "WhatsUp Gold" }],
    });
    assert.equal(wug.find((s) => s.key === "nickname")?.low, true);
    assert.equal(plainSource("name title"), "From the page title");
    assert.equal(plainSource("logo header-home"), "The logo in the page header, which links to home");
    assert.equal(plainSource("bottom bar OneTrust cookie banner"), "The page has a OneTrust cookie banner along the bottom of the window");
  });

  it("keeps the lift on unless it's turned off", () => {
    assert.equal(
      applySuggestions(draftFor({}, { liftAboveBars: false }), [{ key: "liftAboveBars", value: true, source: "", low: false }]).settings
        .liftAboveBars,
      undefined,
    );
    const parsed = parseWidgetDraft(JSON.stringify(draftFor({}, { liftAboveBars: false })));
    assert.ok("value" in parsed);
    assert.equal(parsed.value.settings.liftAboveBars, false);
  });
});

describe("the handoff's suggestions", () => {
  const primary = { name: "Ana", email: "ana@client.example", phone: null };

  it("offer the site's contact page from the scan first, ahead of the primary contact's email", () => {
    const fromPages = handoffSuggestions([{ url: "https://www.progress.com/contact" }], primary);
    assert.deepEqual(
      withContactPage(fromPages, "https://www.progress.com/sitefinity-cms/contact").map((s) => [s.contact.url, s.from]),
      [
        ["https://www.progress.com/sitefinity-cms/contact", "scan"],
        ["mailto:ana@client.example", "primary"],
      ],
    );
    assert.match(withContactPage([], "https://www.whatsupgold.com/contact")[0]!.why, /contact page, linked from its header or footer/);
  });

  it("keep the synced pages' guess when the scan found no contact page, and take only https", () => {
    const fromPages = handoffSuggestions([{ url: "https://www.client.example/contact" }], primary);
    assert.deepEqual(withContactPage(fromPages, undefined), fromPages);
    assert.deepEqual(withContactPage(fromPages, "javascript:alert(1)"), fromPages);
    assert.deepEqual(withContactPage(fromPages, "http://www.client.example/contact"), fromPages);
  });
});

describe("avatarUrl", () => {
  it("takes https images and the scan's inline SVGs, and nothing that could run or load elsewhere", () => {
    assert.equal(avatarUrl("https://www.client.example/logo.svg"), "https://www.client.example/logo.svg");
    assert.ok(avatarUrl("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E"));
    assert.ok(avatarUrl("data:image/png;base64,iVBORw0KGgo="));
    assert.equal(avatarUrl("http://www.client.example/logo.svg"), undefined);
    assert.equal(avatarUrl("data:text/html,<script>alert(1)</script>"), undefined);
    assert.equal(avatarUrl('data:image/svg+xml,<svg onload="x">'), undefined, "not percent-encoded");
    assert.equal(avatarUrl(`data:image/svg+xml,${"a".repeat(40_001)}`), undefined);
  });
});

describe("consentGaps", () => {
  const lead = { enabled: true, fields: ["email" as const], requiredFields: ["email" as const] };

  it("lists each served language whose consent wording is the generic default", () => {
    assert.deepEqual(consentGaps({ lead }, "de"), ["de"]);
    assert.deepEqual(consentGaps({ lead: { ...lead, consentText: "I agree." } }, "en"), []);
    const auto = {
      lead: { ...lead, consentText: "I agree." },
      languages: ["en" as const, "de" as const, "es" as const],
      translations: { es: { leadConsent: "Acepto." } },
    };
    assert.deepEqual(consentGaps(auto, "auto"), ["de"]);
    assert.deepEqual(consentGaps({ ...auto, lead: { ...lead, enabled: false } }, "auto"), []);
  });
});
