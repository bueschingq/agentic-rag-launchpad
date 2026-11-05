import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isLanguage,
  LANGUAGES,
  type Language,
  languageOf,
  languageSetting,
  pageLanguages,
  resolveLanguage,
  widgetStrings,
} from "../src/i18n.ts";
import { localizeSettings, type WidgetSettings } from "../src/settings.ts";

describe("widgetStrings", () => {
  it("has every piece of text, filled in, for every language", () => {
    const keys = Object.keys(widgetStrings("en")).sort();
    for (const { code } of LANGUAGES) {
      const strings = widgetStrings(code);
      assert.deepEqual(Object.keys(strings).sort(), keys, code);
      for (const [key, value] of Object.entries(strings)) assert.ok(value.trim(), `${code}.${key} is empty`);
    }
  });

  it("translates rather than copying English", () => {
    for (const { code } of LANGUAGES.filter((l) => l.code !== "en")) {
      assert.notEqual(widgetStrings(code).welcome, widgetStrings("en").welcome, code);
      assert.notEqual(widgetStrings(code).noAnswer, widgetStrings("en").noAnswer, code);
    }
  });
});

describe("register", () => {
  // Words that would mix the formal and the informal "you" into the register each language uses.
  const OTHER_REGISTER: Partial<Record<Language, RegExp>> = {
    es: /\b(usted|ustedes|Pregúntenos|Contáctenos|Llámenos|Escríbanos|Inténtelo|Haga|Déjenos|Envíenos|su (pregunta|opinión|mensaje|solicitud))\b/i,
    fr: /\b(tu|ton|ta|tes|toi)\b/i,
    de: /\b(du|dein\w*|dich|dir)\b/i,
    nl: /\b(je|jij|jou|jouw)\b/i,
    it: /\b(Lei|Sua|Suo)\b/,
    pt: /\b(tu|teu|tua|vos)\b/i,
  };

  for (const [code, pattern] of Object.entries(OTHER_REGISTER)) {
    it(`keeps one register in ${code}`, () => {
      for (const [key, value] of Object.entries(widgetStrings(code as Language))) assert.doesNotMatch(value, pattern, `${code}.${key}`);
    });
  }
});

describe("resolveLanguage", () => {
  it("keeps a fixed language whatever the browser says", () => {
    assert.equal(resolveLanguage("de", ["fr-FR"]), "de");
  });

  it("follows the first browser language it has text for when auto", () => {
    assert.equal(resolveLanguage("auto", ["es-MX", "en-US"]), "es");
    assert.equal(resolveLanguage("auto", ["ja-JP", "PT-br"]), "pt");
  });

  it("follows the snippet, then the page, then the browser", () => {
    assert.equal(resolveLanguage("auto", pageLanguages(null, "es", ["en-US"])), "es");
    assert.equal(resolveLanguage("auto", pageLanguages("fr", "es", ["en-US"])), "fr");
    assert.equal(resolveLanguage("auto", pageLanguages(" ", "", ["de-DE"])), "de");
    assert.equal(languageOf("pt_BR"), "pt");
    assert.equal(languageOf("x-default"), undefined);
  });

  it("keeps to the languages a deployment serves, else its main one", () => {
    assert.equal(resolveLanguage("auto", ["es-ES", "en"], ["en", "es"]), "es");
    assert.equal(resolveLanguage("auto", ["de-DE", "fr"], ["en", "es"]), "en");
    assert.equal(resolveLanguage("auto", [], ["nl", "fr"]), "nl");
  });

  it("falls back to English", () => {
    assert.equal(resolveLanguage("auto", ["ja-JP"]), "en");
    assert.equal(resolveLanguage("auto"), "en");
    assert.equal(resolveLanguage("klingon", ["de"]), "en");
    assert.equal(resolveLanguage(undefined), "en");
  });
});

describe("languageSetting", () => {
  it("accepts codes and auto, and turns anything else into English", () => {
    assert.equal(languageSetting("nl"), "nl");
    assert.equal(languageSetting("auto"), "auto");
    assert.equal(languageSetting("NL"), "en");
    assert.equal(languageSetting(null), "en");
    assert.equal(isLanguage("auto"), false);
  });
});

describe("localizeSettings", () => {
  const settings: WidgetSettings = {
    language: "auto",
    languages: ["en", "es"],
    nickname: "Harbor Help",
    welcome: "Hi! Ask about our clinic.",
    starters: ["Opening hours?"],
    offlineMessage: "Back soon.",
    copy: { talkToPerson: "Talk to our front desk" },
    handoff: {
      contacts: [
        { kind: "link", url: "tel:+15551234567" },
        { kind: "link", url: "https://a.example/contact", label: "Our contact page" },
      ],
      show: ["no-answer"],
      message: "Call us:",
    },
    ctas: [
      { label: "Book a visit", url: "https://a.example/book", keywords: ["appointment"] },
      { label: "Pricing", url: "https://a.example/pricing", keywords: ["price"] },
    ],
    translations: {
      es: {
        welcome: "¡Hola! Pregunta por nuestra clínica.",
        starters: ["¿Horario?"],
        ctas: [{ label: "Pide cita", keywords: ["cita"] }],
        copy: { talkToPerson: "Habla con recepción" },
      },
    },
  };

  it("uses the main copy in the main language", () => {
    const en = localizeSettings(settings, "en");
    assert.equal(en.welcome, settings.welcome);
    assert.equal(en.ctas?.length, 2);
    assert.equal(en.offlineMessage, "Back soon.");
  });

  it("swaps in the translation, and the widget's own text where there is none", () => {
    const es = localizeSettings(settings, "es");
    assert.equal(es.welcome, "¡Hola! Pregunta por nuestra clínica.");
    assert.deepEqual(es.starters, ["¿Horario?"]);
    // The main keywords match too: an English question on the Spanish page.
    assert.deepEqual(es.ctas, [{ label: "Pide cita", url: "https://a.example/book", keywords: ["cita", "appointment"] }]);
    assert.equal(es.copy?.talkToPerson, "Habla con recepción");
    assert.equal(es.handoff?.message, undefined, "the English intro isn't shown to Spanish visitors");
    assert.equal(es.offlineMessage, undefined);
    assert.equal(es.nickname, "Harbor Help");
    assert.deepEqual(
      es.handoff?.contacts.map((c) => [c.url, c.label]),
      [
        ["tel:+15551234567", undefined],
        ["https://a.example/contact", undefined],
      ],
      "the English label isn't shown to Spanish visitors",
    );
  });

  it("sends each language's buttons and contacts to its own pages", () => {
    const es = localizeSettings(
      {
        ...settings,
        translations: {
          es: {
            ctas: [{ label: "Pide cita", keywords: ["cita"], url: "https://a.example/es/cita" }, { label: "Precios" }],
            handoffContacts: [{}, { url: "https://a.example/es/contacto", label: "Contacto" }],
          },
        },
      },
      "es",
    );
    assert.deepEqual(
      es.ctas?.map((c) => c.url),
      ["https://a.example/es/cita", "https://a.example/pricing"],
    );
    assert.deepEqual(
      es.handoff?.contacts.map((c) => [c.url, c.label]),
      [
        ["tel:+15551234567", undefined],
        ["https://a.example/es/contacto", "Contacto"],
      ],
    );
    assert.equal(localizeSettings(settings, "en").handoff?.contacts[1]?.label, "Our contact page");
  });

  it("leaves single-language deployments alone", () => {
    const { languages: _, ...one } = settings;
    assert.equal(localizeSettings(one, "es").welcome, settings.welcome);
  });
});
