import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answerLanguage, detectLanguage, MIN_DISTINCTIVE_WORDS } from "../src/index.ts";

// Short English answers that state a price, opening hours or a date: the answers round 3 failed
// as "Italian" (the executive's three come first, then telerik.com's DevCraft answer), and the
// kinds of answers the partners' clients get asked for most. Each must read as English or as
// unknown, never as another language.
const ENGLISH = [
  "Teeth whitening costs $350 per session.",
  "Plans start at $29 per user per month.",
  "Parking: $5 per hour, $20 per day.",
  "Telerik DevCraft Complete costs $1,299 per developer, per year.",
  "DevCraft UI costs $1,149 per developer, per year.",
  "Kendo UI costs $899 per developer per year.",
  "Telerik UI for ASP.NET Core starts at $849 per developer, per year.",
  "The Business plan starts at $1,229 per year for 50 devices.",
  "Enterprise: $2,049. Enterprise Plus: $3,469.",
  "A cleaning costs $120 per visit.",
  "Membership is €45 per month, or €480 per year.",
  "Delivery is free on orders over £50.",
  "Shipping costs $7.99 per order.",
  "The annual fee is $95, waived in the first year.",
  "Rates start at 4.25% APR.",
  "Tickets cost $18 per adult and $9 per child.",
  "A 64-count box costs $5.49.",
  "Prices start at $12 per seat per month, billed annually.",
  "The course fee is CHF 1,200 per person.",
  "Room rates start at $189 per night.",
  "Our basic checkup costs $75.",
  "Consultations cost $150 per hour.",
  "Storage is $0.02 per GB per month.",
  "Support costs 20% of the license price per year.",
  "Premium: $499 per installation.",
  "Open Monday to Friday, 8 am to 6 pm.",
  "Hours: Mon–Fri 9:00–17:00, Sat 10:00–14:00.",
  "We're open 8 to 6, Monday to Friday.",
  "Open daily from 10 am to 10 pm.",
  "Closed on Sundays and public holidays.",
  "Saturday: 9 am – 1 pm.",
  "Branch hours are 9 am to 5 pm, Monday through Friday.",
  "Lunch is served 11:30 am to 2 pm.",
  "Phone support: 24/7.",
  "Office hours: 8:30 am – 4:30 pm EST.",
  "Open late on Thursdays until 9 pm.",
  "Check-in from 3 pm, check-out by 11 am.",
  "Visiting hours: 2 pm to 8 pm daily.",
  "The webinar was on 3 December 2025.",
  "Registration closes on March 15, 2026.",
  "Support for version 13.3 ended on December 1, 2024.",
  "The next release is planned for Q2 2026.",
  "Applications are due by 30 June 2026.",
  "The event runs 12–14 May 2026 in Boston.",
  "Enrollment opens on 1 November.",
  "The offer ends 31 December 2026.",
  "Classes start September 8, 2026.",
  "Renewals are due 30 days before expiry.",
  "Telerik UI for Silverlight was retired in May 2023.",
  "DevReach 2026: October 14–15, Sofia.",
];

// Short answers in the other languages the widget serves: each reads as its own language or as
// unknown, never as another.
const OTHER: Record<string, string[]> = {
  de: [
    "WhatsUp Gold kostet ab 1.229 $ pro Jahr.",
    "Die Lizenz kostet 1.299 € pro Entwickler und Jahr.",
    "Wir haben montags bis freitags von 8 bis 18 Uhr geöffnet.",
    "Das Webinar fand am 3. Dezember 2025 statt.",
    "Ja. Sie können WhatsUp Gold 30 Tage kostenlos testen.",
  ],
  es: [
    "WhatsUp Gold cuesta desde $1,229 al año.",
    "Abrimos de 8 a 18, de lunes a viernes.",
    "El plan Business cuesta $1,229 para 50 dispositivos.",
    "La inscripción cierra el 15 de marzo de 2026.",
    "Sí. Puede probar WhatsUp Gold gratis durante 30 días.",
  ],
  fr: [
    "La licence coûte 1 299 € par développeur et par an.",
    "Nous sommes ouverts du lundi au vendredi, de 8 h à 18 h.",
    "Oui, nous proposons un essai gratuit de 30 jours.",
    "L'inscription se termine le 15 mars 2026.",
  ],
  it: [
    "La licenza costa 1.299 € per sviluppatore all'anno.",
    "Siamo aperti dal lunedì al venerdì, dalle 8 alle 18.",
    "Sì, offriamo una prova gratuita di 30 giorni.",
    "Il prezzo parte da 29 € per utente al mese.",
  ],
};

describe("an answer's language, as validation judges it", () => {
  it("reads 50 short English answers stating a price, hours or a date as English or unknown", () => {
    assert.equal(ENGLISH.length, 50);
    for (const text of ENGLISH) {
      const read = answerLanguage(text);
      assert.ok(read === undefined || read.language === "en", `${text} → ${read?.language}`);
      // The widget's question reading never calls them another language either.
      const asked = detectLanguage(text);
      assert.ok(asked === undefined || asked === "en", `${text} → ${asked} (detectLanguage)`);
    }
  });

  it("decides nothing from figures, currency, units and shared short words", () => {
    // Round 3: "per" alone made these Italian.
    for (const text of ENGLISH.slice(0, 4)) assert.equal(answerLanguage(text), undefined, text);
    assert.notEqual(detectLanguage("Plans start at $29 per user per month."), "it");
    assert.equal(answerLanguage("$ 1,299 per 50 km in 2 h"), undefined);
  });

  for (const [language, texts] of Object.entries(OTHER)) {
    it(`reads short ${language} answers as ${language} or unknown`, () => {
      for (const text of texts) {
        const read = answerLanguage(text);
        assert.ok(read === undefined || read.language === language, `${text} → ${read?.language}`);
      }
    });
  }

  it("is sure of the German answer to an English question the check was added for (whatsupgold.com)", () => {
    const read = answerLanguage("Ja. Wir überwachen AWS- und Azure-Cloud-Ressourcen über deren APIs.");
    assert.equal(read?.language, "de");
    assert.equal(read?.confident, true);
    // The right answer is too short to judge, so it never fails on its language.
    assert.ok([undefined, "en"].includes(answerLanguage("Yes. We monitor AWS and Azure resources through their APIs.")?.language));
  });

  it("is sure of longer answers in each language", () => {
    const LONG: Record<string, string> = {
      en: "You can start a free 30-day trial on the product page, and our team will help you with the setup.",
      de: "Sie können die Testversion 30 Tage nutzen, und unser Team hilft Ihnen gern bei der Einrichtung.",
      es: "Puede descargar la versión de prueba y nuestro equipo le ayudará con la instalación cuando lo necesite.",
      fr: "Vous pouvez télécharger la version d'essai, et notre équipe vous aidera pour l'installation.",
      it: "Può scaricare la versione di prova e il nostro team la aiuterà con l'installazione quando vuole.",
    };
    for (const [language, text] of Object.entries(LONG)) {
      const read = answerLanguage(text);
      assert.equal(read?.language, language, text);
      assert.equal(read?.confident, true, text);
    }
  });

  it("goes by the answer's own words, not a title it quotes, and is unsure when two languages are close", () => {
    const quoting = answerLanguage(
      "You can find it on our page “Preise und Lizenzen für Unternehmen”, which lists the prices for each plan.",
    );
    assert.equal(quoting?.language, "en");
    const half = answerLanguage("Sie können die Testversion 30 Tage nutzen. You can try it for free.");
    assert.equal(half?.confident, false);
    assert.equal(MIN_DISTINCTIVE_WORDS, 4);
  });
});
